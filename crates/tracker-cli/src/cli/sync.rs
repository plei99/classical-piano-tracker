//! `tracker sync`: pull recent Spotify plays into SQLite, and report when
//! that last happened.

use anyhow::{Context, Result};
use clap::{Args, Subcommand};
use tracker_core::Db;
use tracker_core::config;
use tracker_core::db::Queries;

use super::spotify_cmd::recent_track_limit;
use super::timefmt::local_long_date_time_nanos;
use super::{Io, RootOptions, created_config_error, spotify_client, validate_sync_config};

#[derive(Debug, Args)]
pub(crate) struct SyncArgs {
    #[arg(
        long,
        default_value_t = 50,
        allow_negative_numbers = true,
        help = "maximum number of recent plays to fetch from Spotify (1-50)"
    )]
    limit: i64,

    #[command(subcommand)]
    command: Option<SyncCommand>,
}

#[derive(Debug, Subcommand)]
enum SyncCommand {
    #[command(
        about = "Print the timestamp of the last successful sync checkpoint",
        after_help = "Examples:
  tracker sync status
  tracker --db ~/custom-tracker.db sync status"
    )]
    Status,
}

pub(crate) fn run(args: SyncArgs, opts: &RootOptions, io: &mut Io<'_>) -> Result<()> {
    match args.command {
        Some(SyncCommand::Status) => status(opts, io),
        None => sync(args.limit, opts, io),
    }
}

fn sync(limit: i64, opts: &RootOptions, io: &mut Io<'_>) -> Result<()> {
    let config_path = opts.resolve_config_path()?;
    let (cfg, created) = config::ensure_loaded(&config_path)?;
    if created {
        return Err(created_config_error(
            &config_path,
            &format!(
                "set spotify.client_id and spotify.client_secret, run `tracker --config {config_path:?} spotify login`, then rerun `tracker sync`"
            ),
        ));
    }
    validate_sync_config(&cfg, &config_path)?;

    let db_path = opts.resolve_db_path()?;
    let client = spotify_client(&cfg, &config_path)?;
    let db = Db::open(&db_path)?;
    let stats = tracker_spotify::syncer::run(&cfg, &client, &db, recent_track_limit(limit)?)?;

    let out = &mut *io.out;
    writeln!(out, "database: {}", db_path.display())?;
    writeln!(out, "fetched: {}", stats.fetched)?;
    writeln!(out, "already_synced: {}", stats.already_synced)?;
    writeln!(out, "blocked: {}", stats.blocked)?;
    writeln!(out, "skipped: {}", stats.skipped)?;
    writeln!(out, "accepted: {}", stats.accepted)?;
    writeln!(out, "inserted: {}", stats.inserted)?;
    writeln!(out, "updated: {}", stats.updated)?;
    Ok(())
}

fn status(opts: &RootOptions, io: &mut Io<'_>) -> Result<()> {
    let db = Db::open(&opts.resolve_db_path()?)?;
    let checkpoint = db.conn().recent_play_checkpoint().context("load recent play checkpoint")?;
    match checkpoint {
        Some(nanos) => writeln!(io.out, "Last sync: {}", local_long_date_time_nanos(nanos))?,
        None => writeln!(io.out, "Last sync: never")?,
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use jiff::tz::TimeZone;
    use tracker_core::Db;
    use tracker_core::db::Queries;

    use super::super::testutil::{path_str, run, save_config, temp_path};
    use super::super::timefmt::long_date_time;

    #[test]
    fn sync_status_prints_never_without_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = temp_path(&dir, "tracker.db");
        let (result, out) = run(&["--db", path_str(&db_path), "sync", "status"]);
        result.unwrap();
        assert_eq!(out.trim(), "Last sync: never");
    }

    #[test]
    fn sync_status_prints_checkpoint_timestamp() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = temp_path(&dir, "tracker.db");
        let checkpoint: Timestamp = "2026-04-03T14:30:00Z".parse().unwrap();
        let nanos = i64::try_from(checkpoint.as_nanosecond()).unwrap();
        Db::open(&db_path).unwrap().conn().upsert_recent_play_checkpoint(nanos).unwrap();

        let (result, out) = run(&["--db", path_str(&db_path), "sync", "status"]);
        result.unwrap();
        let want = format!("Last sync: {}", long_date_time(&checkpoint.to_zoned(TimeZone::system())));
        assert_eq!(out.trim(), want);
    }

    #[test]
    fn sync_requires_filled_config_and_login() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = temp_path(&dir, "config.json");
        let db_path = temp_path(&dir, "tracker.db");
        let args = ["--config", path_str(&config_path), "--db", path_str(&db_path), "sync"];

        let (result, _) = run(&args);
        let message = result.unwrap_err().to_string();
        assert!(message.ends_with("then rerun `tracker sync`"), "{message}");

        let (result, _) = run(&args);
        let message = format!("{:#}", result.unwrap_err());
        assert!(message.starts_with(&format!("invalid config {config_path:?}: ")), "{message}");

        save_config(&config_path, &["Martha Argerich"], &[]);
        let (result, _) = run(&args);
        assert_eq!(
            format!("{:#}", result.unwrap_err()),
            format!("spotify login required for {config_path:?}: spotify.token is required")
        );
        assert!(!db_path.exists(), "the database is only opened once the config is usable");
    }
}
