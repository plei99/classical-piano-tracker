//! `tracker recommend`: the deterministic favorites/profile views and the
//! LLM-backed summary and discovery flows, kept under one namespace without
//! mixing their implementation details.

use anyhow::{Context, Result, bail};
use clap::{Args, Subcommand};
use tracker_core::config::{self, Config};
use tracker_core::db::Queries;
use tracker_core::{Db, Rating, Track};
use tracker_recommend::TasteSummary;

use super::format::{
    output_width, print_favorite_pianists, print_taste_profile, print_validated_pianists, print_wrapped_field,
};
use super::{Io, RootOptions, created_config_error, spotify_client, validate_sync_config};

#[derive(Debug, Subcommand)]
pub(crate) enum RecommendCommand {
    #[command(
        about = "Rank favorite pianists from local ratings and replay counts",
        after_help = "Examples:
  tracker recommend favorites
  tracker recommend favorites --limit 15"
    )]
    Favorites(FavoritesArgs),

    #[command(
        about = "Use an LLM plus Spotify validation to recommend new pianists",
        after_help = "Examples:
  tracker recommend pianists
  LLM_MODEL=gpt-5.4 tracker recommend pianists --limit 5"
    )]
    Pianists(PianistsArgs),

    #[command(
        about = "Print the local taste profile used for recommendations",
        after_help = "Examples:
  tracker recommend profile
  tracker --config /custom/config.json --db /custom/tracker.db recommend profile"
    )]
    Profile,

    #[command(
        about = "Ask the active LLM profile to summarize your local taste profile",
        after_help = "Examples:
  tracker recommend summary
  LLM_PROFILE=anthropic tracker recommend summary"
    )]
    Summary,
}

#[derive(Debug, Args)]
pub(crate) struct FavoritesArgs {
    #[arg(
        long,
        default_value_t = 10,
        allow_negative_numbers = true,
        help = "maximum number of favorite pianists to print"
    )]
    limit: i64,
}

#[derive(Debug, Args)]
pub(crate) struct PianistsArgs {
    #[arg(
        long,
        default_value_t = 5,
        allow_negative_numbers = true,
        help = "maximum number of new pianist recommendations to request"
    )]
    limit: i64,
}

pub(crate) fn run(command: RecommendCommand, opts: &RootOptions, io: &mut Io<'_>) -> Result<()> {
    match command {
        RecommendCommand::Favorites(args) => favorites(args.limit, opts, io),
        RecommendCommand::Pianists(args) => pianists(args.limit, opts, io),
        RecommendCommand::Profile => {
            let (_, summary) = load_taste_summary(opts)?;
            let width = output_width(io);
            print_taste_profile(io.out, &summary, width)?;
            Ok(())
        }
        RecommendCommand::Summary => summary(opts, io),
    }
}

fn favorites(limit: i64, opts: &RootOptions, io: &mut Io<'_>) -> Result<()> {
    let limit = validate_limit(limit)?;
    let cfg = load_recommendation_config(opts)?;
    if cfg.pianists_allowlist.is_empty() {
        bail!("config has an empty pianists_allowlist");
    }

    let (tracks, ratings) = load_recommendation_data(opts)?;
    let mut profiles = tracker_recommend::build_pianist_profiles(&tracks, &ratings, &cfg.pianists_allowlist)?;
    if profiles.is_empty() {
        writeln!(io.out, "no favorite pianists could be derived from the local database")?;
        return Ok(());
    }

    profiles.truncate(limit);
    print_favorite_pianists(io.out, &profiles)?;
    Ok(())
}

fn summary(opts: &RootOptions, io: &mut Io<'_>) -> Result<()> {
    let (cfg, summary) = load_taste_summary(opts)?;
    tracker_recommend::validate_discovery_input(&summary)
        .context("not enough local rating data for taste summary generation yet")?;

    let llm = recommendation_llm_client(&cfg)?;
    let text = llm.summarize_taste(&summary)?;
    let width = output_width(io);
    print_wrapped_field(io.out, "Summary: ", "", &text, width)?;
    Ok(())
}

fn pianists(limit: i64, opts: &RootOptions, io: &mut Io<'_>) -> Result<()> {
    let limit = validate_limit(limit)?;

    let config_path = opts.resolve_config_path()?;
    let (cfg, created) = config::ensure_loaded(&config_path)?;
    if created {
        return Err(created_config_error(
            &config_path,
            &format!(
                "set spotify.client_id and spotify.client_secret, run `tracker --config {config_path:?} spotify login`, then rerun this command"
            ),
        ));
    }
    if cfg.pianists_allowlist.is_empty() {
        bail!("config {config_path:?} has an empty pianists_allowlist");
    }
    validate_sync_config(&cfg, &config_path)?;

    let (tracks, ratings) = load_recommendation_data(opts)?;
    let summary = tracker_recommend::build_taste_summary(&tracks, &ratings, &cfg.pianists_allowlist)?;
    tracker_recommend::validate_discovery_input(&summary)
        .context("not enough local rating data for pianist recommendations yet")?;

    let llm = recommendation_llm_client(&cfg)?;
    let discovery = llm.suggest_new_pianists(&summary, discovery_request_limit(limit))?;

    let spotify = spotify_client(&cfg, &config_path)?;
    let mut validated = tracker_recommend::validate_suggested_pianists(
        &spotify,
        &summary.known_pianists,
        &discovery.recommendations,
        discovery_search_limit(limit),
    )?;
    validated.truncate(limit);

    if validated.is_empty() {
        writeln!(io.out, "Summary: {}", discovery.summary)?;
        writeln!(io.out, "No validated pianist recommendations were found.")?;
        return Ok(());
    }

    let width = output_width(io);
    print_validated_pianists(io.out, &discovery.summary, &validated, width)?;
    Ok(())
}

fn validate_limit(limit: i64) -> Result<usize> {
    match usize::try_from(limit) {
        Ok(limit) if limit >= 1 => Ok(limit),
        _ => bail!("limit must be at least 1, got {limit}"),
    }
}

/// Keeps the recommendation commands on the same config-loading and
/// first-run semantics used elsewhere in the CLI.
fn load_recommendation_config(opts: &RootOptions) -> Result<Config> {
    let path = opts.resolve_config_path()?;
    let (cfg, _) = config::ensure_loaded(&path)?;
    Ok(cfg)
}

/// Reads the complete local corpus: recommendation scoring needs every
/// track and rating, not a paginated subset.
fn load_recommendation_data(opts: &RootOptions) -> Result<(Vec<Track>, Vec<Rating>)> {
    let db = Db::open(&opts.resolve_db_path()?)?;
    let conn = db.conn();
    let tracks = conn.list_all_tracks().context("list all tracks")?;
    let ratings = conn.list_all_ratings().context("list all ratings")?;
    Ok((tracks, ratings))
}

fn load_taste_summary(opts: &RootOptions) -> Result<(Config, TasteSummary)> {
    let cfg = load_recommendation_config(opts)?;
    if cfg.pianists_allowlist.is_empty() {
        bail!("config has an empty pianists_allowlist");
    }
    let (tracks, ratings) = load_recommendation_data(opts)?;
    let summary = tracker_recommend::build_taste_summary(&tracks, &ratings, &cfg.pianists_allowlist)?;
    Ok((cfg, summary))
}

fn recommendation_llm_client(cfg: &Config) -> Result<tracker_llm::Client> {
    Ok(tracker_llm::Client::new(tracker_llm::providers::from_config(cfg)?))
}

/// Asks the LLM for more candidates than requested, since some will fail
/// Spotify validation or turn out to be already known.
fn discovery_request_limit(limit: usize) -> usize {
    if limit < 5 { 10 } else { limit * 2 }
}

fn discovery_search_limit(limit: usize) -> usize {
    limit.max(5)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    use jiff::{Timestamp, ToSpan};
    use tracker_core::config::{LlmConfig, LlmProfile, SpotifyConfig, Token};
    use tracker_core::{UpsertRatingParams, UpsertTrackParams};

    use super::super::testutil::{path_str, run, save_config, temp_path};
    use super::*;

    fn test_recommendation_config(openai_key: &str) -> Config {
        Config {
            spotify: SpotifyConfig {
                client_id: "client-id".into(),
                client_secret: "client-secret".into(),
                token: Some(Token {
                    access_token: "access-token".into(),
                    token_type: "Bearer".into(),
                    expiry: Some(Timestamp::now() + 1.hour()),
                    ..Token::default()
                }),
            },
            llm: LlmConfig {
                active_profile: "openai".into(),
                profiles: BTreeMap::from([(
                    "openai".into(),
                    LlmProfile {
                        provider: "openai".into(),
                        model: "gpt-5.4".into(),
                        api_key: openai_key.into(),
                        ..LlmProfile::default()
                    },
                )]),
            },
            pianists_allowlist: vec!["Martha Argerich".into()],
            ..Config::default()
        }
    }

    fn save_track_with_rating(
        db_path: &Path,
        spotify_id: &str,
        track_name: &str,
        album_name: &str,
        stars: i64,
        opinion: &str,
    ) -> Track {
        let db = Db::open(db_path).unwrap();
        let conn = db.conn();
        let track = conn
            .upsert_track(&UpsertTrackParams {
                spotify_id: spotify_id.into(),
                track_name: track_name.into(),
                album_name: album_name.into(),
                artists: r#"["Martha Argerich"]"#.into(),
                last_played_at: Timestamp::now().as_second(),
            })
            .unwrap();
        conn.upsert_rating(&UpsertRatingParams {
            track_id: track.id,
            stars,
            opinion: opinion.into(),
            updated_at: Timestamp::now().as_second(),
        })
        .unwrap();
        track
    }

    #[test]
    fn recommend_favorites_prints_empty_state() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = temp_path(&dir, "config.json");
        save_config(&config_path, &["Martha Argerich"], &[]);
        let db_path = temp_path(&dir, "tracker.db");

        let (result, out) =
            run(&["--config", path_str(&config_path), "--db", path_str(&db_path), "recommend", "favorites"]);
        result.unwrap();
        assert!(out.contains("no favorite pianists could be derived"), "output = {out:?}, want empty-state message");
    }

    #[test]
    fn recommend_pianists_rejects_sparse_ratings_with_actionable_message() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = temp_path(&dir, "config.json");
        config::save(&config_path, &test_recommendation_config("")).unwrap();
        let db_path = temp_path(&dir, "tracker.db");
        save_track_with_rating(&db_path, "track-1", "Track One", "Album One", 5, "Excellent");

        let (result, _) =
            run(&["--config", path_str(&config_path), "--db", path_str(&db_path), "recommend", "pianists"]);
        let message = format!("{:#}", result.expect_err("want sparse-data failure"));
        assert!(
            message.contains("not enough local rating data for pianist recommendations yet"),
            "error = {message:?}, want actionable sparse-data prefix"
        );
    }

    // Needs OPENAI_API_KEY cleared, so it runs the binary as a subprocess:
    // see `recommend_pianists_requires_openai_key_after_data_check` in
    // tests/binary.rs.

    #[test]
    fn recommend_profile_prints_local_taste_summary() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = temp_path(&dir, "config.json");
        save_config(&config_path, &["Martha Argerich"], &[]);
        let db_path = temp_path(&dir, "tracker.db");
        let track = save_track_with_rating(&db_path, "track-1", "Scarbo", "Ravel", 5, "Electrifying.");

        let (result, out) =
            run(&["--config", path_str(&config_path), "--db", path_str(&db_path), "recommend", "profile"]);
        result.unwrap();
        for want in [
            "Tracks: 1",
            "Ratings: 1",
            "Comments: 1",
            "Favorite Pianists",
            "Martha Argerich",
            "Loved Tracks",
            "[1] Scarbo",
            "Matched: Martha Argerich",
            "Opinion: Electrifying.",
            "Known Pianists: Martha Argerich",
        ] {
            assert!(out.contains(want), "output = {out:?}, want {want:?}");
        }
        assert!(!out.contains("Discovery Guidance:"), "output = {out:?}, did not expect discovery guidance");
        assert_eq!(track.id, 1);
    }

    /// Serves a fixed chat-completions response on loopback, recording the
    /// request paths (Go used httptest.Server).
    fn serve_chat_completion(body: &'static str) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let paths = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&paths);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                reader.read_line(&mut request_line).unwrap();
                let path = request_line.split_whitespace().nth(1).unwrap_or_default().to_string();
                seen.lock().unwrap().push(path);
                let mut content_length = 0;
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header.trim().is_empty() {
                        break;
                    }
                    if let Some((name, value)) = header.split_once(':')
                        && name.eq_ignore_ascii_case("content-length")
                    {
                        content_length = value.trim().parse().unwrap();
                    }
                }
                let mut request_body = vec![0; content_length];
                reader.read_exact(&mut request_body).unwrap();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        (url, paths)
    }

    #[test]
    fn recommend_summary_uses_llm_provider_without_spotify_validation() {
        let (server_url, paths) = serve_chat_completion(
            r#"{"choices":[{"message":{"content":"{\"summary\":\"You like high-voltage clarity and sharply voiced modern repertoire.\"}"}}]}"#,
        );

        let dir = tempfile::tempdir().unwrap();
        let config_path = temp_path(&dir, "config.json");
        let cfg = Config {
            spotify: SpotifyConfig {
                client_id: "client-id".into(),
                client_secret: "client-secret".into(),
                token: None,
            },
            llm: LlmConfig {
                active_profile: "test".into(),
                profiles: BTreeMap::from([(
                    "test".into(),
                    LlmProfile {
                        provider: "openai_compat".into(),
                        model: "test-model".into(),
                        base_url: format!("{server_url}/v1"),
                        ..LlmProfile::default()
                    },
                )]),
            },
            pianists_allowlist: vec!["Martha Argerich".into()],
            ..Config::default()
        };
        config::save(&config_path, &cfg).unwrap();

        let db_path = temp_path(&dir, "tracker.db");
        save_track_with_rating(&db_path, "track-1", "Track One", "Album One", 5, "Brilliant.");
        save_track_with_rating(&db_path, "track-2", "Track Two", "Album Two", 4, "Clear.");
        save_track_with_rating(&db_path, "track-3", "Track Three", "Album Three", 5, "Incisive.");

        let (result, out) =
            run(&["--config", path_str(&config_path), "--db", path_str(&db_path), "recommend", "summary"]);
        result.unwrap();
        assert!(
            out.contains("Summary: You like high-voltage clarity and sharply voiced modern repertoire."),
            "output = {out:?}, want LLM summary"
        );
        for path in paths.lock().unwrap().iter() {
            assert_eq!(path, "/v1/chat/completions");
        }
    }

    #[test]
    fn discovery_request_limit_over_requests_for_validation_headroom() {
        for (limit, want) in [(1, 10), (5, 10), (7, 14), (10, 20)] {
            assert_eq!(discovery_request_limit(limit), want, "discovery_request_limit({limit})");
        }
        assert_eq!(discovery_search_limit(1), 5);
        assert_eq!(discovery_search_limit(8), 8);
    }

    #[test]
    fn recommend_commands_validate_inputs_before_touching_data() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = temp_path(&dir, "config.json");
        let db_path = temp_path(&dir, "tracker.db");
        let base = ["--config", path_str(&config_path), "--db", path_str(&db_path), "recommend"];

        let (result, _) = run(&[&base[..], &["favorites", "--limit", "0"]].concat());
        assert_eq!(result.unwrap_err().to_string(), "limit must be at least 1, got 0");

        let (result, _) = run(&[&base[..], &["pianists"]].concat());
        let message = result.unwrap_err().to_string();
        assert!(message.starts_with(&format!("created default config at {config_path:?}; set spotify.client_id")));

        save_config(&config_path, &[], &[]);
        let (result, _) = run(&[&base[..], &["profile"]].concat());
        assert_eq!(result.unwrap_err().to_string(), "config has an empty pianists_allowlist");
        let (result, _) = run(&[&base[..], &["pianists"]].concat());
        assert_eq!(result.unwrap_err().to_string(), format!("config {config_path:?} has an empty pianists_allowlist"));

        save_config(&config_path, &["Martha Argerich"], &[]);
        let (result, _) = run(&[&base[..], &["pianists"]].concat());
        assert_eq!(
            format!("{:#}", result.unwrap_err()),
            format!("spotify login required for {config_path:?}: spotify.token is required")
        );
    }
}
