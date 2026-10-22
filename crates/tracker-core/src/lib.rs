//! Shared foundation for the tracker crates: on-disk locations, the JSON
//! config, the SQLite store, and the plain data types passed between crates.

pub mod artists;
pub mod config;
pub mod db;
pub mod model;
pub mod paths;

pub use db::Db;
pub use model::{ArtistSearcher, CatalogArtist, Rating, SyncStats, Track, UpsertRatingParams, UpsertTrackParams};
