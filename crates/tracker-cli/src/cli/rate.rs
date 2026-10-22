//! `tracker rate` (flag-driven) and `tracker rate-prompt` (line-oriented
//! interactive selection), which share the save-and-print path.

use std::io::{BufRead, Write};

use anyhow::{Context, Result, anyhow, bail};
use clap::Args;
use jiff::Timestamp;
use tracker_core::db::Queries;
use tracker_core::{Db, Track, UpsertRatingParams, artists};

use super::timefmt::local_date_time;
use super::{Io, RootOptions, read_line, write_prompt};

const DEFAULT_RATE_SELECTION_LIMIT: i64 = 10;

#[derive(Debug, Args)]
pub(crate) struct RateArgs {
    #[arg(long, default_value_t = 0, allow_negative_numbers = true, help = "local track ID to rate")]
    track_id: i64,

    #[arg(long, default_value = "", help = "Spotify track ID to rate")]
    spotify_id: String,

    #[arg(long, default_value_t = 0, allow_negative_numbers = true, help = "star rating to save (1-5)")]
    stars: i64,

    #[arg(long, default_value = "", help = "free-form opinion to store with the rating")]
    opinion: String,
}

#[derive(Debug, Args)]
pub(crate) struct RatePromptArgs {
    #[arg(long, help = "select from unrated tracks instead of recent tracks")]
    unrated: bool,

    #[arg(
        long,
        default_value_t = DEFAULT_RATE_SELECTION_LIMIT,
        allow_negative_numbers = true,
        help = "number of candidate tracks to list for interactive selection"
    )]
    limit: i64,
}

pub(crate) fn run_rate(args: &RateArgs, opts: &RootOptions, io: &mut Io<'_>) -> Result<()> {
    validate_strict_rate_input(args.track_id, &args.spotify_id, args.stars)?;

    let db = Db::open(&opts.resolve_db_path()?)?;
    let conn = db.conn();
    let track = resolve_track_by_identifier(&*conn, args.track_id, &args.spotify_id)?;
    save_and_print_rating(&*conn, io.out, &track, args.stars, &args.opinion)
}

pub(crate) fn run_rate_prompt(args: &RatePromptArgs, opts: &RootOptions, io: &mut Io<'_>) -> Result<()> {
    if args.limit < 1 {
        bail!("limit must be at least 1, got {}", args.limit);
    }

    let db = Db::open(&opts.resolve_db_path()?)?;
    let conn = db.conn();
    let track = choose_track_for_rating(&*conn, io.input, io.out, args.unrated, args.limit)?;
    let (stars, opinion) = prompt_rating(io.input, io.out)?;
    save_and_print_rating(&*conn, io.out, &track, stars, &opinion)
}

fn validate_strict_rate_input(track_id: i64, spotify_id: &str, stars: i64) -> Result<()> {
    let has_spotify_id = !spotify_id.trim().is_empty();
    if track_id != 0 && has_spotify_id {
        bail!("only one of --track-id or --spotify-id may be provided");
    }
    if track_id == 0 && !has_spotify_id {
        bail!("one of --track-id or --spotify-id is required");
    }
    if !(1..=5).contains(&stars) {
        bail!("stars must be between 1 and 5, got {stars}");
    }
    Ok(())
}

fn resolve_track_by_identifier(conn: &dyn Queries, track_id: i64, spotify_id: &str) -> Result<Track> {
    if track_id != 0 {
        return conn
            .track_by_id(track_id)
            .with_context(|| format!("lookup track {track_id}"))?
            .ok_or_else(|| anyhow!("track {track_id} not found"));
    }
    if !spotify_id.trim().is_empty() {
        return conn
            .track_by_spotify_id(spotify_id)
            .with_context(|| format!("lookup track {spotify_id:?}"))?
            .ok_or_else(|| anyhow!("track with spotify_id {spotify_id:?} not found"));
    }
    bail!("track identifier is required")
}

fn save_and_print_rating(
    conn: &dyn Queries,
    out: &mut dyn Write,
    track: &Track,
    stars: i64,
    opinion: &str,
) -> Result<()> {
    let rating = conn
        .upsert_rating(&UpsertRatingParams {
            track_id: track.id,
            stars,
            opinion: opinion.to_string(),
            updated_at: Timestamp::now().as_second(),
        })
        .with_context(|| format!("save rating for track {}", track.id))?;

    writeln!(out, "saved rating for track {}", track.id)?;
    writeln!(out, "title: {}", track.track_name)?;
    writeln!(out, "artists: {}", artists::format(&track.artists))?;
    writeln!(out, "stars: {}", rating.stars)?;
    if !rating.opinion.is_empty() {
        writeln!(out, "opinion: {}", rating.opinion)?;
    }
    Ok(())
}

/// One line per candidate track, shared by `list` and `rate-prompt`.
pub(crate) fn format_track_choice(track: &Track) -> String {
    format!(
        "{} | {} | {} | play_count={} | id={}",
        local_date_time(track.last_played_at),
        track.track_name,
        artists::format(&track.artists),
        track.play_count,
        track.id,
    )
}

fn choose_track_for_rating(
    conn: &dyn Queries,
    input: &mut dyn BufRead,
    out: &mut dyn Write,
    unrated: bool,
    limit: i64,
) -> Result<Track> {
    let (label, candidates) =
        if unrated { ("unrated", conn.list_unrated_tracks(limit)) } else { ("recent", conn.list_recent_tracks(limit)) };
    let mut candidates = candidates.with_context(|| format!("list {label} tracks"))?;

    match candidates.len() {
        0 => bail!("no {label} tracks available to rate"),
        1 => {
            let track = candidates.remove(0);
            writeln!(out, "selected only available {label} track: {}", format_track_choice(&track))?;
            Ok(track)
        }
        _ => {
            writeln!(out, "select a {label} track to rate:")?;
            for (idx, track) in candidates.iter().enumerate() {
                writeln!(out, "{}. {}", idx + 1, format_track_choice(track))?;
            }
            prompt_track_selection(input, out, candidates)
        }
    }
}

fn prompt_track_selection(input: &mut dyn BufRead, out: &mut dyn Write, mut candidates: Vec<Track>) -> Result<Track> {
    let count = candidates.len();
    loop {
        write_prompt(out, &format!("enter choice [1-{count}]: "))?;
        let (line, eof) = read_line(input).context("read track selection")?;
        if eof {
            bail!("rating selection aborted");
        }

        match line.trim().parse::<usize>() {
            Ok(choice) if (1..=count).contains(&choice) => return Ok(candidates.swap_remove(choice - 1)),
            _ => writeln!(out, "invalid choice, enter a number between 1 and {count}")?,
        }
    }
}

fn prompt_rating(input: &mut dyn BufRead, out: &mut dyn Write) -> Result<(i64, String)> {
    let stars = loop {
        write_prompt(out, "enter stars [1-5]: ")?;
        let (line, eof) = read_line(input).context("read stars")?;
        if eof {
            bail!("rating prompt aborted");
        }

        match line.trim().parse::<i64>() {
            Ok(value) if (1..=5).contains(&value) => break value,
            _ => writeln!(out, "invalid rating, enter a number between 1 and 5")?,
        }
    };

    write_prompt(out, "enter opinion (optional): ")?;
    // A missing trailing newline is fine here: the opinion is optional.
    let (opinion, _) = read_line(input).context("read opinion")?;
    Ok((stars, opinion.trim().to_string()))
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use tracker_core::{Db, UpsertTrackParams};

    use super::*;

    #[test]
    fn validate_rate_input() {
        validate_strict_rate_input(1, "", 5).unwrap();

        let cases = [
            ("conflicting identifiers", validate_strict_rate_input(1, "spotify-id", 5)),
            ("stars too low", validate_strict_rate_input(0, "", 0)),
            ("missing identifiers", validate_strict_rate_input(0, "", 5)),
        ];
        for (name, result) in cases {
            assert!(result.is_err(), "{name}: expected validation error");
        }
        assert_eq!(
            validate_strict_rate_input(3, "", 6).unwrap_err().to_string(),
            "stars must be between 1 and 5, got 6"
        );
    }

    #[test]
    fn prompt_rating_retries_until_valid() {
        let mut out = Vec::new();
        let (stars, opinion) = prompt_rating(&mut Cursor::new("0\n4\nExcellent\n"), &mut out).unwrap();
        assert_eq!(stars, 4);
        assert_eq!(opinion, "Excellent");
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains("invalid rating"), "output = {out:?}, want invalid rating prompt");
    }

    #[test]
    fn prompt_rating_aborts_on_eof() {
        let err = prompt_rating(&mut Cursor::new("4"), &mut Vec::new()).unwrap_err();
        assert_eq!(err.to_string(), "rating prompt aborted");
        // The opinion may end without a newline.
        let (stars, opinion) = prompt_rating(&mut Cursor::new("5\nlast words"), &mut Vec::new()).unwrap();
        assert_eq!((stars, opinion.as_str()), (5, "last words"));
    }

    #[test]
    fn prompt_track_selection_retries_until_valid() {
        let now = Timestamp::now().as_second();
        let candidates = vec![
            Track {
                id: 1,
                track_name: "Track One".into(),
                artists: r#"["Artist One"]"#.into(),
                last_played_at: now,
                ..Track::default()
            },
            Track {
                id: 2,
                track_name: "Track Two".into(),
                artists: r#"["Artist Two"]"#.into(),
                last_played_at: now,
                ..Track::default()
            },
        ];

        let mut out = Vec::new();
        let got = prompt_track_selection(&mut Cursor::new("x\n2\n"), &mut out, candidates.clone()).unwrap();
        assert_eq!(got.id, 2);
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains("invalid choice"), "output = {out:?}, want invalid choice prompt");

        let err = prompt_track_selection(&mut Cursor::new("3\n"), &mut Vec::new(), candidates).unwrap_err();
        assert_eq!(err.to_string(), "rating selection aborted");
    }

    #[test]
    fn choose_track_for_rating_single_candidate() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("tracker.db")).unwrap();
        let conn = db.conn();
        let track = conn
            .upsert_track(&UpsertTrackParams {
                spotify_id: "spotify-track-1".into(),
                track_name: "Track One".into(),
                album_name: "Album One".into(),
                artists: r#"["Artist One"]"#.into(),
                last_played_at: 100,
            })
            .unwrap();

        let mut out = Vec::new();
        let got = choose_track_for_rating(&*conn, &mut Cursor::new(""), &mut out, false, 10).unwrap();
        assert_eq!(got.id, track.id);

        let got = choose_track_for_rating(&*conn, &mut Cursor::new(""), &mut out, true, 10).unwrap();
        assert_eq!(got.id, track.id, "track is unrated until a rating is saved");
        let rating = UpsertRatingParams { track_id: track.id, stars: 3, opinion: String::new(), updated_at: 1 };
        conn.upsert_rating(&rating).unwrap();
        let err = choose_track_for_rating(&*conn, &mut Cursor::new(""), &mut out, true, 10).unwrap_err();
        assert_eq!(err.to_string(), "no unrated tracks available to rate");
    }

    #[test]
    fn format_track_artists_joins_names() {
        assert_eq!(artists::format(r#"["Martha Argerich","Daniil Trifonov"]"#), "Martha Argerich, Daniil Trifonov");
    }

    #[test]
    fn rate_prompt_command_saves_selected_rating() {
        use super::super::testutil::{path_str, run_with};

        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("tracker.db");
        {
            let db = Db::open(&db_path).unwrap();
            for id in ["a", "b"] {
                db.conn()
                    .upsert_track(&UpsertTrackParams {
                        spotify_id: id.into(),
                        track_name: format!("Track {id}"),
                        album_name: "Album".into(),
                        artists: r#"["Artist"]"#.into(),
                        last_played_at: if id == "a" { 100 } else { 200 },
                    })
                    .unwrap();
            }
        }

        let deps = super::super::Deps::default();
        let (result, out) = run_with(&["--db", path_str(&db_path), "rate-prompt"], "1\n5\n  Superb  \n", &deps);
        result.unwrap();
        assert!(out.starts_with("select a recent track to rate:\n1. "), "{out}");
        assert!(
            out.ends_with("saved rating for track 2\ntitle: Track b\nartists: Artist\nstars: 5\nopinion: Superb\n"),
            "{out}"
        );

        let (result, out) =
            run_with(&["--db", path_str(&db_path), "rate", "--spotify-id", "a", "--stars", "3"], "", &deps);
        result.unwrap();
        assert_eq!(out, "saved rating for track 1\ntitle: Track a\nartists: Artist\nstars: 3\n");

        let (result, _) = run_with(&["--db", path_str(&db_path), "rate", "--track-id", "9", "--stars", "3"], "", &deps);
        assert_eq!(result.unwrap_err().to_string(), "track 9 not found");
        let (result, _) =
            run_with(&["--db", path_str(&db_path), "rate", "--spotify-id", "zz", "--stars", "3"], "", &deps);
        assert_eq!(result.unwrap_err().to_string(), "track with spotify_id \"zz\" not found");
    }
}
