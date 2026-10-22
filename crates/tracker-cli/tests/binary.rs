//! Process-level behavior: which stream output goes to, exit codes, and
//! tests that need a controlled environment.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::{Command, Output};

use jiff::{Timestamp, ToSpan};
use tracker_core::config::{self, Config, LlmConfig, LlmProfile, SpotifyConfig, Token};
use tracker_core::db::Queries;
use tracker_core::{Db, UpsertRatingParams, UpsertTrackParams};

fn tracker(args: &[&str]) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_tracker"));
    cmd.args(args);
    cmd
}

fn run(args: &[&str]) -> Output {
    tracker(args).output().expect("run tracker")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).expect("utf-8 output")
}

fn path_str(path: &Path) -> &str {
    path.to_str().expect("utf-8 temp path")
}

#[test]
fn command_output_goes_to_stdout() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("config.json");
    let output = run(&["--config", path_str(&config_path), "config", "path"]);
    assert!(output.status.success());
    assert_eq!(text(&output.stdout), format!("{}\n", config_path.display()));
    assert_eq!(text(&output.stderr), "");
}

#[test]
fn errors_print_one_line_to_stderr_and_exit_1() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("tracker.db");

    let output = run(&["--db", path_str(&db_path), "show", "abc"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(text(&output.stdout), "");
    assert_eq!(text(&output.stderr), "track ID must be a positive integer, got \"abc\"\n");

    let output = run(&["--db", path_str(&db_path), "bogus"]);
    assert_eq!(output.status.code(), Some(1));
    let stderr = text(&output.stderr);
    assert_eq!(stderr.lines().count(), 1, "{stderr}");
    assert!(stderr.contains("bogus"), "{stderr}");
    assert!(!stderr.contains("Usage"), "{stderr}");
}

#[test]
fn help_and_version_exit_0() {
    let output = run(&["--version"]);
    assert!(output.status.success());
    assert!(text(&output.stdout).starts_with("tracker "));
    assert_eq!(text(&output.stdout).lines().count(), 1);

    let output = run(&[]);
    assert!(output.status.success());
    assert!(text(&output.stdout).contains("Examples:"));

    let output = run(&["list"]);
    assert!(output.status.success());
    assert!(text(&output.stdout).contains("unrated"));
}

#[test]
fn recommend_pianists_requires_openai_key_after_data_check() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("config.json");
    let cfg = Config {
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
                LlmProfile { provider: "openai".into(), model: "gpt-5.4".into(), ..LlmProfile::default() },
            )]),
        },
        pianists_allowlist: vec!["Martha Argerich".into()],
        ..Config::default()
    };
    config::save(&config_path, &cfg).unwrap();

    let db_path = dir.path().join("tracker.db");
    {
        let db = Db::open(&db_path).unwrap();
        let conn = db.conn();
        for spotify_id in ["track-1", "track-2", "track-3"] {
            let track = conn
                .upsert_track(&UpsertTrackParams {
                    spotify_id: spotify_id.into(),
                    track_name: "Track".into(),
                    album_name: "Album".into(),
                    artists: r#"["Martha Argerich"]"#.into(),
                    last_played_at: Timestamp::now().as_second(),
                })
                .unwrap();
            conn.upsert_rating(&UpsertRatingParams {
                track_id: track.id,
                stars: 5,
                opinion: "Excellent".into(),
                updated_at: Timestamp::now().as_second(),
            })
            .unwrap();
        }
    }

    let output = tracker(&["--config", path_str(&config_path), "--db", path_str(&db_path), "recommend", "pianists"])
        .env("OPENAI_API_KEY", "")
        .env_remove("LLM_PROFILE")
        .env_remove("LLM_PROVIDER")
        .env_remove("LLM_MODEL")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1), "want missing OpenAI key failure");
    let stderr = text(&output.stderr);
    assert!(stderr.contains("API key is required"), "error = {stderr:?}, want missing key message");
}
