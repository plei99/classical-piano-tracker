//! `tracker tui`: injects database and sync callbacks into the TUI, so the
//! TUI never constructs clients or touches the database on its event loop.

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use tracker_core::db::Queries;
use tracker_core::{Db, SyncStats, config};
use tracker_tui::{Deps, LoadFn, SaveRatingFn, SyncFn};

use super::{RootOptions, created_config_error, spotify_client, validate_sync_config};

pub(crate) fn run(opts: &RootOptions) -> Result<()> {
    let config_path = opts.resolve_config_path()?;
    let db = Arc::new(Db::open(&opts.resolve_db_path()?)?);

    let load_db = Arc::clone(&db);
    let load: LoadFn = Arc::new(move || {
        let conn = load_db.conn();
        Ok((conn.list_all_tracks()?, conn.list_all_ratings()?))
    });

    let save_db = Arc::clone(&db);
    let save_rating: SaveRatingFn = Arc::new(move |params| save_db.conn().upsert_rating(&params));

    let sync_db = Arc::clone(&db);
    let sync: SyncFn = Arc::new(move || tui_sync(&config_path, &sync_db, "the TUI"));

    tracker_tui::run(Deps { load, sync, save_rating }).context("run tracker TUI")
}

/// The CLI's sync path (config loading, validation, token persistence),
/// re-read on every TUI sync so config edits made while it is open apply.
/// `surface` names the UI in the first-run hint (`tracker web` shares this).
pub(crate) fn tui_sync(config_path: &Path, db: &Db, surface: &str) -> Result<SyncStats> {
    let (cfg, created) = config::ensure_loaded(config_path)?;
    if created {
        return Err(created_config_error(
            config_path,
            &format!(
                "set spotify.client_id and spotify.client_secret, run `tracker --config {config_path:?} spotify login`, then retry sync from {surface}"
            ),
        ));
    }
    validate_sync_config(&cfg, config_path)?;

    let client = spotify_client(&cfg, config_path)?;
    tracker_spotify::syncer::run(&cfg, &client, db, 50)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tui_sync_reports_created_config() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.json");
        let db = Db::open_in_memory().unwrap();
        let message = tui_sync(&config_path, &db, "the TUI").unwrap_err().to_string();
        assert!(message.ends_with("then retry sync from the TUI"), "{message}");
        let message = format!("{:#}", tui_sync(&config_path, &db, "the TUI").unwrap_err());
        assert!(message.starts_with(&format!("invalid config {config_path:?}")), "{message}");
    }
}
