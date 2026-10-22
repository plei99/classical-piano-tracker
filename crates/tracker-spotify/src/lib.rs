//! Spotify OAuth, the Web API client, and the sync pipeline that filters
//! recent plays into the local database.
//!
//! The Go build used zmb3/spotify and golang.org/x/oauth2; this crate talks
//! to the Web API directly but keeps their observable behavior (refresh
//! timing, retry on 429, error wording).

pub mod auth;
pub mod client;
mod oauth;
pub mod syncer;
/// A mock HTTP server for tests, also used by the web server's tests.
#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub mod test_support;

pub use auth::{DEFAULT_REDIRECT_URL, login};
pub use client::{
    API_BASE_URL, AlbumArt, ApiError, Artist, Client, MAX_TRACK_BATCH, RecentTrack, TokenPersister, pick_album_art,
};
pub use oauth::ACCOUNTS_BASE_URL;
