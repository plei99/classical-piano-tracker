//! The track browser's state machine. `Model::update` is the only place state
//! changes, and it never blocks: I/O is returned as a [`Cmd`] for the front
//! end to execute, mirroring Bubble Tea's Elm architecture. The terminal runs
//! commands on background threads and the browser as fetches; either way the
//! result re-enters `update` as a message.

use std::collections::HashMap;

use anyhow::Result;
use jiff::Timestamp;
use jiff::tz::TimeZone;
use tracker_core::{Rating, SyncStats, Track, UpsertRatingParams, artists};

use crate::api::{InitialState, ViewResponse};
use crate::list::{LocalTracks, Refresh, TrackList};
use crate::remote::{RemoteTracks, ViewKind, ViewOutcome, ViewRequest};

/// Track orderings, cycled with `o`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SortMode {
    #[default]
    RecentDesc,
    IdAsc,
    TopPlayed,
    UnratedFirst,
}

const SORT_MODE_CYCLE: [SortMode; 4] =
    [SortMode::RecentDesc, SortMode::IdAsc, SortMode::TopPlayed, SortMode::UnratedFirst];

impl SortMode {
    /// Every order, in the order `o` cycles through them.
    pub const ALL: [SortMode; 4] = SORT_MODE_CYCLE;

    pub fn label(self) -> &'static str {
        match self {
            SortMode::RecentDesc => "recent",
            SortMode::IdAsc => "id",
            SortMode::TopPlayed => "top played",
            SortMode::UnratedFirst => "unrated first",
        }
    }

    fn next(self) -> SortMode {
        let index = SORT_MODE_CYCLE.iter().position(|mode| *mode == self).unwrap_or(0);
        SORT_MODE_CYCLE[(index + 1) % SORT_MODE_CYCLE.len()]
    }

    /// The name in the web API's `sort` parameter.
    pub fn param(self) -> &'static str {
        match self {
            SortMode::RecentDesc => "recentDesc",
            SortMode::IdAsc => "idAsc",
            SortMode::TopPlayed => "topPlayed",
            SortMode::UnratedFirst => "unratedFirst",
        }
    }

    pub fn from_param(param: &str) -> Option<SortMode> {
        SORT_MODE_CYCLE.into_iter().find(|mode| mode.param() == param)
    }
}

/// A track plus the strings derived from its artists JSON, computed once so
/// rendering and search never re-decode it per frame or per keystroke.
#[derive(Debug, Clone)]
pub struct TrackRow {
    pub track: Track,
    /// Display label, e.g. "Frédéric Chopin, Krystian Zimerman".
    pub artists: String,
    /// Lowercased name, artists, and album for substring search. NUL
    /// separators keep a pasted query from matching across fields.
    pub search: String,
}

impl TrackRow {
    pub fn new(track: Track) -> TrackRow {
        let artists = artists::format(&track.artists);
        let search = format!("{}\0{}\0{}", track.track_name, artists, track.album_name).to_lowercase();
        TrackRow { track, artists, search }
    }

    /// Whether the row matches a [`crate::list::search_needle`].
    #[inline]
    pub fn matches(&self, needle: &str) -> bool {
        self.search.contains(needle)
    }
}

/// Result of the initial (or post-sync) DB read, prepared off the event loop.
#[derive(Clone)]
pub struct TracksLoaded {
    pub rows: Vec<TrackRow>,
    /// Ratings keyed by track ID, so moving the selection is a map lookup
    /// rather than a DB round trip per keypress.
    pub ratings: HashMap<i64, Rating>,
}

impl TracksLoaded {
    /// Indexes ratings and derives each row's display and search text. The
    /// terminal runs this on its load thread.
    pub fn new(tracks: Vec<Track>, ratings: Vec<Rating>) -> TracksLoaded {
        let ratings = ratings.into_iter().map(|rating| (rating.track_id, rating)).collect();
        TracksLoaded { rows: tracks.into_iter().map(TrackRow::new).collect(), ratings }
    }
}

/// A key press reduced to what the handlers match on, following Bubble Tea's
/// conventions: `name` is "ctrl+c", "shift+tab", "enter", or the typed text
/// itself ("j", "G"), and `text` is set only for plain typing. Each front end
/// translates its own key events into this.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyPress {
    pub name: String,
    pub text: Option<char>,
    /// The space bar, which Bubble Tea names "space" but which still types.
    pub is_space: bool,
}

impl KeyPress {
    /// A key that types nothing, e.g. "enter" or "ctrl+u".
    pub fn named(name: impl Into<String>) -> KeyPress {
        KeyPress { name: name.into(), text: None, is_space: false }
    }

    /// A key that types `c`; its name is the character itself.
    pub fn typed(c: char) -> KeyPress {
        KeyPress { name: c.to_string(), text: Some(c), is_space: false }
    }
}

/// The rating editor's two fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditorField {
    Stars,
    Opinion,
}

/// Everything that can change the model: input and the results of
/// background work.
pub enum Msg {
    Key(KeyPress),
    /// Bracketed paste arrives separately from key presses.
    Paste(String),
    Resize {
        width: u16,
        height: u16,
    },
    TracksLoaded(Result<TracksLoaded>),
    SyncFinished(Result<SyncStats>),
    RatingSaved {
        track_id: i64,
        result: Result<Rating>,
    },

    // Intents from front ends with a pointer and form fields (the web UI).
    // The keyboard flow stays the source of truth; these are the clicks and
    // text fields that stand in for it, with the same guards as the keys.
    /// Clicking a row selects that track.
    Select {
        track_id: i64,
    },
    /// Typing in the search field replaces the whole query.
    SetSearch(String),
    /// Clicking a star in the rating editor.
    SetDraftStars(i64),
    /// Editing the opinion text field.
    SetDraftOpinion(String),
    /// Focusing an editor field.
    FocusField(EditorField),

    // Front ends whose list is fetched in windows (the web UI).
    /// The answer to a [`Cmd::FetchView`].
    ViewLoaded {
        request: ViewRequest,
        result: Result<ViewResponse>,
    },
    /// Rows `first..last` are on screen.
    Viewport {
        first: usize,
        last: usize,
    },
}

/// Work requested by `update`. Each command except `Quit` answers with one
/// message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cmd {
    Quit,
    /// Read every track and rating; answers with [`Msg::TracksLoaded`].
    LoadTracks,
    /// Run one Spotify sync; answers with [`Msg::SyncFinished`].
    Sync,
    /// Save a rating; answers with [`Msg::RatingSaved`].
    SaveRating(UpsertRatingParams),
    /// Fetch a window of the list (and, for [`ViewKind::Reload`], re-read
    /// the database first); answers with [`Msg::ViewLoaded`].
    FetchView(ViewRequest),
}

/// The optional services a front end provides. Without one, the matching
/// action reports that it is unavailable, as Go's nil callbacks did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Services {
    pub sync: bool,
    pub save_rating: bool,
}

impl Services {
    pub const ALL: Services = Services { sync: true, save_rating: true };
}

/// The terminal's model: the whole library in memory.
pub type Model = BrowserModel<LocalTracks>;
/// The web client's model: windows of a library the server holds.
pub type WebModel = BrowserModel<RemoteTracks>;

/// The root model, over the list it browses.
#[derive(Clone)]
pub struct BrowserModel<L> {
    pub services: Services,
    pub width: u16,
    pub height: u16,
    pub loading_tracks: bool,
    pub syncing: bool,
    pub saving_rating: bool,
    pub searching: bool,
    pub search_query: String,
    /// The tracks, filtered by `search_query` and ordered by `sort_mode`
    /// (once any fetch in flight has arrived).
    pub list: L,
    pub sort_mode: SortMode,
    /// The selected row. In the web UI it may not be loaded yet (after a
    /// jump); it is drawn as a placeholder until its window arrives.
    pub selected_index: usize,
    pub editing_rating: bool,
    /// Moves focus from the stars field to the opinion, where digits are
    /// ordinary text instead of star ratings.
    pub editing_opinion: bool,
    pub draft_stars: i64,
    pub draft_opinion: String,
    pub status_message: String,
    pub status_is_error: bool,
    pub err: Option<String>,
    /// Looked up once; timestamps render in local time like Go's time.Unix.
    pub time_zone: TimeZone,
}

impl<L: Default> Default for BrowserModel<L> {
    fn default() -> BrowserModel<L> {
        BrowserModel {
            services: Services::default(),
            width: 0,
            height: 0,
            loading_tracks: false,
            syncing: false,
            saving_rating: false,
            searching: false,
            search_query: String::new(),
            list: L::default(),
            sort_mode: SortMode::default(),
            selected_index: 0,
            editing_rating: false,
            editing_opinion: false,
            draft_stars: 0,
            draft_opinion: String::new(),
            status_message: String::new(),
            status_is_error: false,
            err: None,
            time_zone: TimeZone::system(),
        }
    }
}

impl<L: TrackList + Default> BrowserModel<L> {
    /// Constructs the root model; it starts in the loading state because
    /// [`BrowserModel::init`] immediately requests the library.
    pub fn new(services: Services) -> BrowserModel<L> {
        BrowserModel { services, loading_tracks: true, ..BrowserModel::default() }
    }
}

impl WebModel {
    /// The state a server-rendered page starts in: the first window of the
    /// default view, the error screen, or loading.
    pub fn from_initial(services: Services, initial: InitialState) -> WebModel {
        let mut model = WebModel::new(services);
        if let Some(view) = initial.view {
            model.loading_tracks = false;
            model.list = RemoteTracks::from_view(model.sort_mode, &model.search_query, view);
        } else if let Some(error) = initial.error {
            model.loading_tracks = false;
            model.err = Some(error);
        }
        model
    }
}

impl<L: TrackList> BrowserModel<L> {
    /// The command to run at startup: an asynchronous library read. A page
    /// that has to fetch its first list asks the server to re-read the
    /// database, so a failure shows the error screen with Retry.
    pub fn init(&mut self) -> Option<Cmd> {
        Some(self.load(true))
    }

    fn load(&mut self, reread: bool) -> Cmd {
        let selected_track_id = self.selected_track_id();
        self.list.load(reread, self.sort_mode, &self.search_query, selected_track_id)
    }

    /// Applies one message and returns any follow-up work.
    pub fn update(&mut self, msg: Msg) -> Option<Cmd> {
        match msg {
            Msg::Resize { width, height } => {
                self.width = width;
                self.height = height;
                None
            }
            Msg::TracksLoaded(result) => {
                self.loading_tracks = false;
                let loaded = match result {
                    Ok(loaded) => loaded,
                    Err(err) => {
                        self.err = Some(format!("{err:#}"));
                        return None;
                    }
                };
                let selected_track_id = self.selected_track_id();
                self.err = None;
                self.list.tracks_loaded(loaded);
                self.refresh_track_list(selected_track_id)
            }
            Msg::SyncFinished(result) => {
                self.syncing = false;
                let stats = match result {
                    Ok(stats) => stats,
                    Err(err) => {
                        self.set_status(format!("Sync failed: {err:#}"), true);
                        return None;
                    }
                };
                self.set_status(
                    format!(
                        "Sync complete. fetched={} accepted={} inserted={} updated={}",
                        stats.fetched, stats.accepted, stats.inserted, stats.updated
                    ),
                    false,
                );
                self.loading_tracks = true;
                // The web server re-reads the database itself after a sync.
                Some(self.load(false))
            }
            Msg::RatingSaved { track_id, result } => {
                self.saving_rating = false;
                let rating = match result {
                    Ok(rating) => rating,
                    Err(err) => {
                        self.set_status(format!("Save failed: {err:#}"), true);
                        return None;
                    }
                };
                let stars = rating.stars;
                let cmd = if self.list.rating_saved(track_id, rating, self.sort_mode) {
                    self.refresh_track_list(track_id)
                } else {
                    None
                };
                self.set_status(format!("Saved {stars}/5 rating for track {track_id}"), false);
                cmd
            }
            Msg::Key(key) => {
                if self.editing_rating {
                    self.handle_rating_editor_key(&key)
                } else if self.searching {
                    self.handle_search_key(&key)
                } else {
                    self.handle_browsing_key(&key)
                }
            }
            Msg::Paste(content) => {
                // Terminals send line breaks in pastes as carriage returns.
                let content = content.replace("\r\n", "\n").replace('\r', "\n");
                if self.editing_rating {
                    self.draft_opinion.push_str(&content);
                    self.editing_opinion = true;
                } else if self.searching {
                    self.search_query.push_str(&content);
                    self.clear_status();
                    return self.refresh_track_list(self.selected_track_id());
                }
                None
            }
            Msg::Select { track_id } => {
                if self.syncing || self.saving_rating || self.editing_rating {
                    return None;
                }
                let index = self.list.index_of(track_id)?;
                self.move_selection_to(index)
            }
            Msg::SetSearch(query) => {
                if self.syncing || self.saving_rating || self.editing_rating || query == self.search_query {
                    return None;
                }
                let selected_track_id = self.selected_track_id();
                self.search_query = query;
                self.clear_status();
                self.refresh_track_list(selected_track_id)
            }
            Msg::SetDraftStars(stars) => {
                if self.editing_rating && (0..=5).contains(&stars) {
                    self.draft_stars = stars;
                }
                None
            }
            Msg::SetDraftOpinion(text) => {
                if self.editing_rating {
                    self.draft_opinion = text;
                    self.editing_opinion = true;
                }
                None
            }
            Msg::FocusField(field) => {
                if self.editing_rating {
                    self.editing_opinion = field == EditorField::Opinion;
                }
                None
            }
            Msg::ViewLoaded { request, result } => self.view_loaded(&request, result),
            Msg::Viewport { first, last } => self.list.viewport(first, last),
        }
    }

    /// Applies a fetched window, with the terminal's selection rules for a
    /// new list.
    fn view_loaded(&mut self, request: &ViewRequest, result: Result<ViewResponse>) -> Option<Cmd> {
        let selected_track_id = self.selected_track_id();
        match self.list.view_loaded(request, result, selected_track_id) {
            ViewOutcome::Stale => None,
            ViewOutcome::Replaced(index) => {
                self.loading_tracks = false;
                self.err = None;
                self.select_after_refresh(index);
                None
            }
            ViewOutcome::Retarget | ViewOutcome::Outdated => self.refresh_track_list(selected_track_id),
            ViewOutcome::Merged => None,
            ViewOutcome::Failed(err) => {
                self.loading_tracks = false;
                // Only a re-read (`r`, Retry, the first load) replaces the
                // list with the error screen; otherwise the rows stay.
                if request.kind == ViewKind::Reload {
                    self.err = Some(format!("{err:#}"));
                } else {
                    self.set_status(format!("{err:#}"), true);
                }
                None
            }
        }
    }

    fn handle_browsing_key(&mut self, key: &KeyPress) -> Option<Cmd> {
        let busy = self.syncing || self.saving_rating;
        let last = self.list.len().saturating_sub(1);
        match key.name.as_str() {
            "q" | "ctrl+c" => Some(Cmd::Quit),
            "r" => {
                self.loading_tracks = true;
                self.err = None;
                self.clear_status();
                Some(self.load(true))
            }
            "s" => {
                if self.syncing {
                    return None;
                }
                if !self.services.sync {
                    self.set_status("Sync is unavailable in this view.".into(), true);
                    return None;
                }
                self.syncing = true;
                self.clear_status();
                Some(Cmd::Sync)
            }
            "o" => {
                if self.list.is_empty() || busy {
                    return None;
                }
                self.clear_status();
                self.cycle_sort_mode()
            }
            "/" => {
                if busy {
                    return None;
                }
                self.searching = true;
                self.clear_status();
                None
            }
            "esc" => {
                if self.search_query.trim().is_empty() || busy {
                    return None;
                }
                self.search_query.clear();
                self.clear_status();
                self.refresh_track_list(self.selected_track_id())
            }
            "e" | "enter" => {
                if self.selected_track().is_none() || self.saving_rating {
                    return None;
                }
                self.start_rating_editor();
                None
            }
            "up" | "k" => {
                if self.list.is_empty() || self.selected_index == 0 || busy {
                    return None;
                }
                self.move_selection_to(self.selected_index - 1)
            }
            "down" | "j" => {
                if self.list.is_empty() || self.selected_index >= last || busy {
                    return None;
                }
                self.move_selection_to(self.selected_index + 1)
            }
            "g" | "home" => {
                if self.list.is_empty() || self.selected_index == 0 || busy {
                    return None;
                }
                self.move_selection_to(0)
            }
            "G" | "end" => {
                if self.list.is_empty() || self.selected_index >= last || busy {
                    return None;
                }
                self.move_selection_to(last)
            }
            _ => None,
        }
    }

    fn handle_search_key(&mut self, key: &KeyPress) -> Option<Cmd> {
        match key.name.as_str() {
            "ctrl+c" => return Some(Cmd::Quit),
            "enter" => {
                self.searching = false;
                self.clear_status();
                return None;
            }
            "esc" => {
                self.searching = false;
                self.search_query.clear();
            }
            "backspace" => {
                self.search_query.pop();
            }
            "ctrl+u" => self.search_query.clear(),
            _ if key.is_space => self.search_query.push(' '),
            _ => self.search_query.push(key.text?),
        }
        self.clear_status();
        self.refresh_track_list(self.selected_track_id())
    }

    fn handle_rating_editor_key(&mut self, key: &KeyPress) -> Option<Cmd> {
        match key.name.as_str() {
            "esc" => {
                self.editing_rating = false;
                self.set_status("Rating edit canceled.".into(), false);
                return None;
            }
            "enter" => return self.submit_rating(),
            "tab" | "shift+tab" => {
                self.editing_opinion = !self.editing_opinion;
                return None;
            }
            "backspace" => {
                if self.editing_opinion {
                    self.draft_opinion.pop();
                } else {
                    self.draft_stars = 0;
                }
                return None;
            }
            "ctrl+u" => {
                self.draft_opinion.clear();
                return None;
            }
            _ => {}
        }

        if !self.editing_opinion
            && let Some(digit @ '1'..='5') = key.text
        {
            // The stars field takes a single digit and then hands focus to
            // the opinion, so the usual "5, then type" flow needs no extra key.
            self.draft_stars = i64::from(digit as u8 - b'0');
            self.editing_opinion = true;
            return None;
        }

        // Any other text starts (or continues) the opinion.
        let typed = if key.is_space { Some(' ') } else { key.text };
        if let Some(c) = typed {
            self.draft_opinion.push(c);
            self.editing_opinion = true;
        }
        None
    }

    fn submit_rating(&mut self) -> Option<Cmd> {
        let track_id = self.selected_track()?.id;
        if self.saving_rating {
            return None;
        }
        if !(1..=5).contains(&self.draft_stars) {
            self.set_status("Choose a star rating from 1 to 5 before saving.".into(), true);
            return None;
        }
        if !self.services.save_rating {
            self.set_status("Saving ratings is unavailable in this view.".into(), true);
            return None;
        }
        let params = UpsertRatingParams {
            track_id,
            stars: self.draft_stars,
            opinion: self.draft_opinion.trim().to_string(),
            updated_at: Timestamp::now().as_second(),
        };
        self.editing_rating = false;
        self.saving_rating = true;
        self.clear_status();
        Some(Cmd::SaveRating(params))
    }

    pub fn selected_row(&self) -> Option<&TrackRow> {
        self.list.row(self.selected_index)
    }

    pub fn selected_track(&self) -> Option<&Track> {
        self.selected_row().map(|row| &row.track)
    }

    /// The saved rating for the selected track, if any.
    pub fn selected_rating(&self) -> Option<&Rating> {
        self.list.rating(self.selected_track()?.id)
    }

    /// The selected track's ID, or 0 (never a real ID) when nothing is
    /// selected.
    pub fn selected_track_id(&self) -> i64 {
        self.selected_track().map_or(0, |track| track.id)
    }

    /// The loaded tracks that pass the filter, in display order.
    pub fn visible_rows(&self) -> impl Iterator<Item = &TrackRow> + '_ {
        (0..self.list.len()).filter_map(|index| self.list.row(index))
    }

    /// The order the list shows: the model's, or for a fetched list the one
    /// it was fetched with until the next arrives.
    pub fn shown_sort_mode(&self) -> SortMode {
        self.list.applied().map_or(self.sort_mode, |(sort, _)| sort)
    }

    /// The query the list shows; see [`BrowserModel::shown_sort_mode`].
    pub fn shown_query(&self) -> &str {
        self.list.applied().map_or(&self.search_query, |(_, query)| query)
    }

    fn move_selection_to(&mut self, index: usize) -> Option<Cmd> {
        if self.list.is_empty() {
            return None;
        }
        let index = index.min(self.list.len() - 1);
        if index != self.selected_index {
            self.selected_index = index;
            self.clear_status();
        }
        // A row not fetched yet shows as a placeholder until it arrives.
        self.list.fetch(index)
    }

    /// Opens the rating editor on the stars field, prefilled from the saved
    /// rating.
    pub fn start_rating_editor(&mut self) {
        self.editing_rating = true;
        self.editing_opinion = false;
        self.clear_status();
        let (stars, opinion) =
            self.selected_rating().map_or((0, String::new()), |rating| (rating.stars, rating.opinion.clone()));
        self.draft_stars = stars;
        self.draft_opinion = opinion;
    }

    fn set_status(&mut self, message: String, is_error: bool) {
        self.status_message = message;
        self.status_is_error = is_error;
    }

    fn clear_status(&mut self) {
        self.status_message.clear();
        self.status_is_error = false;
    }

    fn cycle_sort_mode(&mut self) -> Option<Cmd> {
        let selected_track_id = self.selected_track_id();
        self.sort_mode = self.sort_mode.next();
        self.refresh_track_list(selected_track_id)
    }

    /// Re-sorts if needed, re-applies the search filter, and keeps the
    /// selection on `selected_track_id` when it is still visible. A fetched
    /// list does this when the answer arrives.
    pub fn refresh_track_list(&mut self, selected_track_id: i64) -> Option<Cmd> {
        match self.list.refresh(self.sort_mode, &self.search_query, selected_track_id) {
            Refresh::Done(index) => {
                self.select_after_refresh(index);
                None
            }
            Refresh::Pending(cmd) => Some(cmd),
        }
    }

    /// Selects the kept track, or the first row (closing the editor) when it
    /// no longer matches.
    fn select_after_refresh(&mut self, index: Option<usize>) {
        if self.list.is_empty() {
            self.selected_index = 0;
            self.editing_rating = false;
            return;
        }
        if let Some(index) = index {
            self.selected_index = index;
            return;
        }
        self.selected_index = 0;
        self.editing_rating = false;
    }

    pub fn total_track_count(&self) -> usize {
        self.list.total()
    }

    /// Formats a Unix timestamp like Go's `time.Unix(s, 0).Format(time.RFC3339)`
    /// in the model's zone.
    pub fn format_time(&self, seconds: i64) -> String {
        let Ok(timestamp) = Timestamp::from_second(seconds) else {
            // Outside jiff's supported range (years beyond ±9999).
            return seconds.to_string();
        };
        let zoned = timestamp.to_zoned(self.time_zone.clone());
        if zoned.offset().seconds() == 0 {
            zoned.strftime("%Y-%m-%dT%H:%M:%SZ").to_string()
        } else {
            zoned.strftime("%Y-%m-%dT%H:%M:%S%:z").to_string()
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
