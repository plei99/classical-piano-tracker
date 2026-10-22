//! `tracker web`: a local HTTP server for the browser UI (`web/`, TypeScript
//! and Preact, embedded by the build script). The server owns the database,
//! the library (sorted, filtered, and sent a window at a time), the first
//! render of the page ([`page`]), and the Spotify wiring; the client keeps
//! the UI state and speaks the JSON API in `tracker_app::api`, whose types it
//! is generated from.

pub mod artwork;
pub mod assets;
pub mod compress;
pub mod library;
pub mod page;
pub mod server;

pub use artwork::{
    ARTWORK_CACHE_FILE, ArtworkApi, ArtworkService, ArtworkServiceOptions, OEMBED_BASE_URL, artwork_cache_path,
    config_artwork_api,
};
pub use server::{
    APP_PLACEHOLDER, Asset, Assets, CONTENT_SECURITY_POLICY, INITIAL_PLACEHOLDER, MAX_BODY_BYTES, PRESENCE_GRACE,
    THEME_PLACEHOLDER, TOKEN_PLACEHOLDER, WebServer, WebServerOptions, start,
};
