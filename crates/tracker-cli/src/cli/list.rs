//! `tracker list`: print locally synced tracks with their IDs, so they can be
//! passed to `show` and `rate`.

use anyhow::{Result, bail};
use clap::{Args, Subcommand};
use tracker_core::Db;
use tracker_core::Track;
use tracker_core::db::Queries;

use super::rate::format_track_choice;
use super::{Io, RootOptions};

#[derive(Debug, Subcommand)]
pub(crate) enum ListCommand {
    #[command(
        about = "List recent local tracks",
        after_help = "Examples:
  tracker list recent
  tracker --db ~/tmp/tracker.db list recent --limit 25"
    )]
    Recent(LimitArgs),

    #[command(
        about = "List top-played local tracks",
        after_help = "Examples:
  tracker list top
  tracker list top --limit 20"
    )]
    Top(LimitArgs),

    #[command(
        about = "List unrated local tracks",
        after_help = "Examples:
  tracker list unrated
  tracker list unrated --limit 15"
    )]
    Unrated(LimitArgs),
}

#[derive(Debug, Args)]
pub(crate) struct LimitArgs {
    #[arg(long, default_value_t = 10, allow_negative_numbers = true, help = "maximum number of tracks to list")]
    limit: i64,
}

/// The query behind each list view.
type ListQuery = fn(&dyn Queries, i64) -> Result<Vec<Track>>;

pub(crate) fn run(command: ListCommand, opts: &RootOptions, io: &mut Io<'_>) -> Result<()> {
    let (limit, list): (i64, ListQuery) = match command {
        ListCommand::Recent(args) => (args.limit, |conn, limit| conn.list_recent_tracks(limit)),
        ListCommand::Top(args) => (args.limit, |conn, limit| conn.list_top_played_tracks(limit)),
        ListCommand::Unrated(args) => (args.limit, |conn, limit| conn.list_unrated_tracks(limit)),
    };
    if limit < 1 {
        bail!("limit must be at least 1, got {limit}");
    }

    let db = Db::open(&opts.resolve_db_path()?)?;
    let tracks = list(&*db.conn(), limit)?;
    if tracks.is_empty() {
        writeln!(io.out, "no tracks found")?;
        return Ok(());
    }
    for track in &tracks {
        writeln!(io.out, "{}", format_track_choice(track))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use tracker_core::db::Queries;
    use tracker_core::{Db, UpsertTrackParams};

    use super::super::testutil::{path_str, run, temp_path};

    #[test]
    fn list_prints_tracks_or_empty_state() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = temp_path(&dir, "tracker.db");

        let (result, out) = run(&["--db", path_str(&db_path), "list", "recent"]);
        result.unwrap();
        assert_eq!(out, "no tracks found\n");

        let db = Db::open(&db_path).unwrap();
        for (id, played) in [("a", 100), ("b", 200), ("b", 300)] {
            db.conn()
                .upsert_track(&UpsertTrackParams {
                    spotify_id: id.into(),
                    track_name: format!("Track {id}"),
                    album_name: "Album".into(),
                    artists: r#"["Martha Argerich","Daniil Trifonov"]"#.into(),
                    last_played_at: played,
                })
                .unwrap();
        }

        let (result, out) = run(&["--db", path_str(&db_path), "list", "top", "--limit", "1"]);
        result.unwrap();
        assert_eq!(out.lines().count(), 1, "{out}");
        assert!(out.contains("| Track b | Martha Argerich, Daniil Trifonov | play_count=2 | id=2"), "{out}");

        let (result, out) = run(&["--db", path_str(&db_path), "list", "unrated"]);
        result.unwrap();
        assert_eq!(out.lines().count(), 2, "{out}");

        let (result, _) = run(&["--db", path_str(&db_path), "list", "recent", "--limit", "0"]);
        assert_eq!(result.unwrap_err().to_string(), "limit must be at least 1, got 0");
    }
}
