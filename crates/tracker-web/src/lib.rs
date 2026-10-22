//! `tracker web`: a local HTTP server for the browser UI, which runs the
//! same state machine as the terminal UI (`tracker_app`) compiled to
//! WebAssembly. The server owns the database, the library (sorted, filtered,
//! and sent a window at a time), the first render of the page, and the
//! Spotify wiring; the client keeps the UI state and speaks the JSON API in
//! `tracker_app::api`.

pub mod artwork;
pub mod assets;
pub mod compress;
pub mod library;
pub mod server;

pub use artwork::{
    ARTWORK_CACHE_FILE, ArtworkApi, ArtworkService, ArtworkServiceOptions, OEMBED_BASE_URL, artwork_cache_path,
    config_artwork_api,
};
pub use server::{
    APP_PLACEHOLDER, Asset, Assets, CONTENT_SECURITY_POLICY, INITIAL_PLACEHOLDER, MAX_BODY_BYTES, PRESENCE_GRACE,
    THEME_PLACEHOLDER, TOKEN_PLACEHOLDER, WebServer, WebServerOptions, start,
};
