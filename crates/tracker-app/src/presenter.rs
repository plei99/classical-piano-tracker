//! What the track browser shows, independent of how it is drawn. The
//! terminal UI lays these strings out on a character grid (matched cell for
//! cell against the Go build); the web UI lays the same content out with
//! CSS. Keeping every user-visible decision here means both front ends
//! always say the same thing.

use tracker_core::{Rating, Track};

use crate::list::TrackList;
use crate::model::BrowserModel;

pub const TITLE: &str = "Classical Piano Tracker";
pub const SUBTITLE: &str = "Local track history";
pub const LOADING_TEXT: &str = "Loading local tracks...";
pub const RETRY_TEXT: &str = "Press r to retry or q to quit.";
pub const NO_TRACKS_TEXT: &str = "No local tracks found. Run `tracker sync` first.";
pub const TRACKS_HEADING: &str = "Tracks";
pub const DETAILS_HEADING: &str = "Track Details";
pub const EDITOR_HEADING: &str = "Rating Editor";
pub const NO_SELECTION_TEXT: &str = "No track selected.";
pub const RATING_NONE_TEXT: &str = "Rating: none";
pub const RATING_SAVING_TEXT: &str = "Rating: saving...";
pub const OPINION_LABEL: &str = "Opinion:";
pub const EDITOR_HELP: [&str; 2] =
    ["1-5 sets stars, then type your opinion.", "Tab switches field. Enter saves. Esc cancels."];

/// One entry in the key help.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hint {
    /// The keys as the terminal prints them, e.g. "j/k or arrows".
    pub keys: &'static str,
    pub label: &'static str,
    /// The key a click on this hint sends, for front ends with a pointer.
    /// Hints that describe typing or a family of keys have none.
    pub key: Option<&'static str>,
    /// Only meaningful in a terminal (quitting a browser tab is the
    /// browser's job).
    pub terminal_only: bool,
}

const fn hint(keys: &'static str, label: &'static str, key: Option<&'static str>) -> Hint {
    Hint { keys, label, key, terminal_only: false }
}

const BROWSING_HINTS: [Hint; 7] = [
    hint("j/k or arrows", "move", None),
    hint("g/G", "top/bottom", None),
    hint("o", "sort", Some("o")),
    hint("s", "sync", Some("s")),
    hint("enter/e", "rate", Some("e")),
    hint("r", "reload", Some("r")),
    Hint { keys: "q", label: "quit", key: Some("q"), terminal_only: true },
];

const EDITING_HINTS: [Hint; 5] = [
    hint("1-5", "stars", None),
    hint("tab", "switch field", Some("tab")),
    hint("ctrl+u", "clear opinion", Some("ctrl+u")),
    hint("enter", "save", Some("enter")),
    hint("esc", "cancel", Some("esc")),
];

const SEARCH_HINTS: [Hint; 4] = [
    hint("type", "search", None),
    hint("backspace", "delete", None),
    hint("enter", "apply", Some("enter")),
    hint("esc", "clear", Some("esc")),
];

/// The key help for the current mode.
pub fn hints<L: TrackList>(m: &BrowserModel<L>) -> &'static [Hint] {
    if m.searching {
        &SEARCH_HINTS
    } else if m.editing_rating {
        &EDITING_HINTS
    } else {
        &BROWSING_HINTS
    }
}

/// A hint as the terminal prints it, e.g. "o: sort".
pub fn hint_text(hint: &Hint) -> String {
    format!("{}: {}", hint.keys, hint.label)
}

/// Which screen to show.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Loading,
    Error,
    Empty,
    NoMatch,
    Browse,
}

pub fn screen<L: TrackList>(m: &BrowserModel<L>) -> Screen {
    if m.loading_tracks {
        Screen::Loading
    } else if m.err.is_some() {
        Screen::Error
    } else if m.list.total() == 0 {
        Screen::Empty
    } else if m.list.is_empty() {
        Screen::NoMatch
    } else {
        Screen::Browse
    }
}

pub fn error_text<L: TrackList>(m: &BrowserModel<L>) -> String {
    format!("Error: {}", m.err.as_deref().unwrap_or_default())
}

pub fn no_match_text<L: TrackList>(m: &BrowserModel<L>) -> String {
    format!("No tracks match /{}", m.shown_query().trim())
}

/// The status line above the key help.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub text: String,
    pub is_error: bool,
}

/// The status line, or `None` when there is nothing to report.
pub fn status<L: TrackList>(m: &BrowserModel<L>) -> Option<Status> {
    let (text, is_error) = if m.syncing {
        ("Syncing with Spotify...".to_string(), false)
    } else if m.saving_rating {
        ("Saving rating...".to_string(), false)
    } else if !m.status_message.is_empty() {
        let text = if m.status_is_error { format!("Error: {}", m.status_message) } else { m.status_message.clone() };
        (text, m.status_is_error)
    } else if m.searching {
        (format!("Search /{}_ ({}/{})", m.shown_query(), m.list.len(), m.total_track_count()), false)
    } else if !m.shown_query().trim().is_empty() {
        (format!("Filter /{} ({}/{})", m.shown_query().trim(), m.list.len(), m.total_track_count()), false)
    } else {
        return None;
    };
    Some(Status { text, is_error })
}

/// e.g. "543 loaded · sort: recent", or "12/543 shown · sort: recent" while
/// filtered.
pub fn track_list_summary<L: TrackList>(m: &BrowserModel<L>) -> String {
    let label = m.shown_sort_mode().label();
    if m.shown_query().trim().is_empty() {
        return format!("{} loaded · sort: {label}", m.list.len());
    }
    format!("{}/{} shown · sort: {label}", m.list.len(), m.total_track_count())
}

pub fn rating_draft_stars_label<L: TrackList>(m: &BrowserModel<L>) -> String {
    if (1..=5).contains(&m.draft_stars) { format!("{}/5", m.draft_stars) } else { "not set".into() }
}

/// The stars field's label, e.g. "Stars: 4/5".
pub fn stars_field_label<L: TrackList>(m: &BrowserModel<L>) -> String {
    format!("Stars: {}", rating_draft_stars_label(m))
}

/// Shows the text cursor only while the opinion has focus.
pub fn draft_opinion_line<L: TrackList>(m: &BrowserModel<L>) -> String {
    if m.editing_opinion { format!("{}_", m.draft_opinion) } else { m.draft_opinion.clone() }
}

/// One label/value line of the detail pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    pub label: &'static str,
    pub value: String,
}

/// The selected track's rating as the detail pane shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RatingView<'a> {
    /// A save is in flight.
    Saving,
    Unrated,
    Rated(&'a Rating),
}

/// The selected track with everything the detail pane shows about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Details<'a> {
    pub track: &'a Track,
    pub artists: &'a str,
    /// In display order.
    pub fields: [Field; 5],
    pub rating: RatingView<'a>,
}

pub fn details<L: TrackList>(m: &BrowserModel<L>) -> Option<Details<'_>> {
    let row = m.selected_row()?;
    let track = &row.track;
    let rating = match m.selected_rating() {
        _ if m.saving_rating => RatingView::Saving,
        None => RatingView::Unrated,
        Some(rating) => RatingView::Rated(rating),
    };
    Some(Details {
        track,
        artists: &row.artists,
        fields: [
            Field { label: "ID", value: track.id.to_string() },
            Field { label: "Spotify ID", value: track.spotify_id.clone() },
            Field { label: "Album", value: track.album_name.clone() },
            Field { label: "Play Count", value: track.play_count.to_string() },
            Field { label: "Last Played", value: m.format_time(track.last_played_at) },
        ],
        rating,
    })
}

/// A field as the terminal prints it, e.g. "Play Count: 3".
pub fn field_text(field: &Field) -> String {
    format!("{}: {}", field.label, field.value)
}

/// e.g. "Rating: 4/5".
pub fn rating_text(rating: &Rating) -> String {
    format!("Rating: {}/5", rating.stars)
}

pub fn opinion_text(rating: &Rating) -> String {
    format!("Opinion: {}", rating.opinion)
}

/// When the rating was last saved, e.g. "Updated: 2026-03-31T12:00:00Z".
pub fn updated_text<L: TrackList>(m: &BrowserModel<L>, rating: &Rating) -> String {
    format!("Updated: {}", m.format_time(rating.updated_at))
}

#[cfg(test)]
mod tests;
