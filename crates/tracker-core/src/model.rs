//! Plain data shared across crates. Field names mirror the SQLite columns;
//! the JSON forms (the web API) use the camelCase names of the TypeScript
//! build, so either build's web client can talk to either server.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub spotify_id: String,
    pub track_name: String,
    pub album_name: String,
    /// JSON array of artist names, kept as text exactly as stored.
    pub artists: String,
    pub play_count: i64,
    pub last_played_at: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rating {
    pub track_id: i64,
    pub stars: i64,
    pub opinion: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpsertTrackParams {
    pub spotify_id: String,
    pub track_name: String,
    pub album_name: String,
    pub artists: String,
    pub last_played_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertRatingParams {
    pub track_id: i64,
    pub stars: i64,
    pub opinion: String,
    pub updated_at: i64,
}

/// Outcome of one sync run. Lives here (not in the spotify crate) so the TUI
/// can report sync results without depending on the network stack.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStats {
    pub fetched: usize,
    pub blocked: usize,
    pub skipped: usize,
    pub accepted: usize,
    pub inserted: usize,
    pub updated: usize,
    pub already_synced: usize,
}

/// One artist from a catalog search. Produced by the Spotify client and
/// consumed by recommendation validation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CatalogArtist {
    pub name: String,
    pub id: String,
    pub popularity: i64,
    pub genres: Vec<String>,
}

/// Catalog lookup used to validate recommendations. Defined here so the
/// Spotify client can implement it without depending on the recommend crate.
pub trait ArtistSearcher {
    fn search_artists(&self, query: &str, limit: usize) -> anyhow::Result<Vec<CatalogArtist>>;
}
