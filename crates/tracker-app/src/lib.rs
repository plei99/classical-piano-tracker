//! The track browser of `tracker tui`: an Elm-style state machine
//! ([`model`]) over a list abstraction ([`list`]) and what it shows
//! ([`presenter`]), plus the HTTP contract between `tracker web`'s server and
//! its browser client ([`api`]), which the client's TypeScript types are
//! generated from. The web server also uses the presenter to render a page's
//! first screen, so it shows the terminal's wording.
//!
//! Nothing here performs I/O. `Model::update` returns background work as
//! [`model::Cmd`] values; the terminal runs them on threads and feeds the
//! results back as messages.

pub mod api;
pub mod list;
pub mod model;
pub mod presenter;

pub use list::{LocalTracks, TrackList};
pub use model::{BrowserModel, Cmd, KeyPress, Model, Msg, Services, SortMode, TrackRow, TracksLoaded, Zone};
