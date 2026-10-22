//! The track browser shared by `tracker tui` and `tracker web`: an Elm-style
//! state machine ([`model`]) over a list abstraction ([`list`]), what it
//! shows ([`presenter`]), and the HTTP contract between the web server and
//! its browser client ([`api`]).
//!
//! Nothing here performs I/O. `Model::update` returns background work as
//! [`model::Cmd`] values; the terminal runs them on threads and the browser
//! as fetches, and both feed the results back as messages. The terminal's
//! list holds the whole library ([`list::LocalTracks`]); the browser's holds
//! windows the server sorted and filtered ([`remote::RemoteTracks`]).

pub mod api;
pub mod list;
pub mod model;
pub mod presenter;
pub mod remote;

pub use list::{LocalTracks, TrackList};
pub use model::{
    BrowserModel, Cmd, EditorField, KeyPress, Model, Msg, Services, SortMode, TrackRow, TracksLoaded, WebModel, Zone,
};
pub use remote::{RemoteTracks, ViewKind, ViewRequest};
