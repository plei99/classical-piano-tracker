//! Shared foundation for the tracker crates: on-disk locations, the JSON
//! config, the SQLite store, and the plain data types passed between crates.
//!
//! The store, config, and paths sit behind the default `native` feature, so
//! the data types also build for the browser client.

pub mod artists;
#[cfg(feature = "native")]
pub mod config;
#[cfg(feature = "native")]
pub mod db;
pub mod model;
#[cfg(feature = "native")]
pub mod paths;

#[cfg(feature = "native")]
pub use db::Db;
pub use model::{ArtistSearcher, CatalogArtist, Rating, SyncStats, Track, UpsertRatingParams, UpsertTrackParams};
