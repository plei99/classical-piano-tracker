//! The `tracker tui` browser: list, search, sort, sync, and rate tracks.
//!
//! The model is the shared state machine from [`tracker_app`], which never
//! blocks; database reads, syncs, and rating writes run on background
//! threads through the injected [`Deps`] and report back as messages.

use std::sync::Arc;

use anyhow::Result;
use tracker_core::{Rating, SyncStats, Track, UpsertRatingParams};

mod app;
mod terminal;
mod text;
mod view;

/// Loads every track and rating (called on a background thread).
pub type LoadFn = Arc<dyn Fn() -> Result<(Vec<Track>, Vec<Rating>)> + Send + Sync>;
/// Runs a Spotify sync (called on a background thread).
pub type SyncFn = Arc<dyn Fn() -> Result<SyncStats> + Send + Sync>;
/// Persists one rating (called on a background thread).
pub type SaveRatingFn = Arc<dyn Fn(UpsertRatingParams) -> Result<Rating> + Send + Sync>;

/// I/O callbacks injected by the CLI, so the TUI never touches the network
/// or the database on its event loop.
#[derive(Clone)]
pub struct Deps {
    pub load: LoadFn,
    pub sync: SyncFn,
    pub save_rating: SaveRatingFn,
}

/// Takes over the terminal (alternate screen, raw mode) until the user quits.
pub fn run(deps: Deps) -> Result<()> {
    terminal::run(deps)
}

/// The model and message types, exposed for benchmarks. Not a stable API.
#[doc(hidden)]
pub mod internals {
    pub use tracker_app::{Cmd, KeyPress, Model, Msg, Services, TrackRow, TracksLoaded};

    pub use crate::app::{execute, fetch_tracks, key_press};
    pub use crate::view::Draw;
}
