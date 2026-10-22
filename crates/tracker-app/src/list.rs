//! The list the model browses. The model needs only a count, a row lookup,
//! and an index-of-track; how the rows get there differs per front end:
//!
//! - [`LocalTracks`] (the terminal) holds the whole library in memory and
//!   sorts and filters it synchronously, so every frame shows a finished
//!   list.
//! - [`crate::remote::RemoteTracks`] (the browser) holds a window of rows
//!   that `tracker web` sorted and filtered; changing the order or the query
//!   is a fetch.
//!
//! Both order and filter rows with [`sort_by_mode`] and [`search_needle`],
//! and so does the web server, so the three always agree.

use std::collections::HashMap;

use tracker_core::{Rating, Track};

use crate::api::ViewResponse;
use crate::model::{Cmd, SortMode, TrackRow, TracksLoaded};
use crate::remote::{ViewOutcome, ViewRequest};

/// What [`TrackList::refresh`] did.
#[derive(Debug, PartialEq, Eq)]
pub enum Refresh {
    /// The list now shows the new order and filter; the selected track's
    /// new index, if it still matches.
    Done(Option<usize>),
    /// The list fetches the new order and filter; the answer arrives as a
    /// message.
    Pending(Cmd),
}

/// The rows the model browses, in display order.
pub trait TrackList {
    /// Rows that pass the current filter.
    fn len(&self) -> usize;

    fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Every track in the library.
    fn total(&self) -> usize;

    /// The row at `index` in display order, or `None` while it is not
    /// loaded (or past the end).
    fn row(&self, index: usize) -> Option<&TrackRow>;

    fn rating(&self, track_id: i64) -> Option<&Rating>;

    /// Where a loaded track is in display order.
    fn index_of(&self, track_id: i64) -> Option<usize>;

    /// Orders and filters the rows for `sort` and `query`, keeping track
    /// `selected` when it still matches.
    fn refresh(&mut self, sort: SortMode, query: &str, selected: i64) -> Refresh;

    /// The command that loads the library, re-reading the database first
    /// when `reread` is set.
    fn load(&mut self, reread: bool, sort: SortMode, query: &str, selected: i64) -> Cmd;

    /// Records a saved rating for `track_id`. Returns whether the list must
    /// be refreshed to stay correct.
    fn rating_saved(&mut self, track_id: i64, rating: Rating, sort: SortMode) -> bool;

    /// The order and query the rows reflect, when they can lag behind the
    /// model's (a fetch in flight). `None` means always the model's.
    fn applied(&self) -> Option<(SortMode, &str)> {
        None
    }

    /// Makes row `index` available; `None` when it already is or is on
    /// its way.
    fn fetch(&mut self, _index: usize) -> Option<Cmd> {
        None
    }

    /// A whole library read from the database.
    fn tracks_loaded(&mut self, _loaded: TracksLoaded) {}

    /// A fetched window; `selected` is the track selected now.
    fn view_loaded(
        &mut self,
        _request: &ViewRequest,
        _result: anyhow::Result<ViewResponse>,
        _selected: i64,
    ) -> ViewOutcome {
        ViewOutcome::Stale
    }

    /// Rows `first..last` are on screen: the fetch that keeps rows ahead of
    /// them loaded, if one is due.
    fn viewport(&mut self, _first: usize, _last: usize) -> Option<Cmd> {
        None
    }
}

/// Sorts `items` into `mode`'s order. Every order ends with the track ID, so
/// it is total and stability does not matter.
pub fn sort_by_mode<T>(items: &mut [T], mode: SortMode, ratings: &HashMap<i64, Rating>, track: impl Fn(&T) -> &Track) {
    match mode {
        SortMode::RecentDesc => items.sort_unstable_by(|left, right| {
            let (left, right) = (track(left), track(right));
            (right.last_played_at, right.id).cmp(&(left.last_played_at, left.id))
        }),
        SortMode::IdAsc => items.sort_unstable_by_key(|item| track(item).id),
        SortMode::TopPlayed => items.sort_unstable_by(|left, right| {
            let (left, right) = (track(left), track(right));
            (right.play_count, right.last_played_at, right.id).cmp(&(left.play_count, left.last_played_at, left.id))
        }),
        SortMode::UnratedFirst => {
            // Cache the rated flag so the comparator does no map lookups.
            items.sort_by_cached_key(|item| {
                let track = track(item);
                (ratings.contains_key(&track.id), std::cmp::Reverse(track.last_played_at), std::cmp::Reverse(track.id))
            });
        }
    }
}

/// The search text a query matches against [`TrackRow::search`]; empty
/// matches everything.
pub fn search_needle(query: &str) -> String {
    query.trim().to_lowercase()
}

/// The terminal's list: the whole library, sorted and filtered in place.
#[derive(Debug, Clone, Default)]
pub struct LocalTracks {
    /// Every loaded track, ordered by `sorted_by` when `sorted` is true.
    pub all_tracks: Vec<TrackRow>,
    /// Indexes into `all_tracks` that pass the search filter, in display
    /// order. Indexes avoid copying track strings on every keystroke.
    pub tracks: Vec<usize>,
    /// Ratings keyed by track ID, so moving the selection is a map lookup
    /// rather than a DB round trip per keypress.
    pub ratings: HashMap<i64, Rating>,
    /// Lets search keystrokes skip a full re-sort when the order is current.
    pub sorted_by: SortMode,
    pub sorted: bool,
}

impl LocalTracks {
    /// Every track, in the order the rows were given and unfiltered.
    pub fn new(rows: Vec<TrackRow>, ratings: HashMap<i64, Rating>) -> LocalTracks {
        LocalTracks { tracks: (0..rows.len()).collect(), all_tracks: rows, ratings, ..LocalTracks::default() }
    }

    fn sort(&mut self, mode: SortMode) {
        sort_by_mode(&mut self.all_tracks, mode, &self.ratings, |row| &row.track);
        self.sorted_by = mode;
        self.sorted = true;
    }

    fn filter(&mut self, query: &str) {
        self.tracks.clear();
        let needle = search_needle(query);
        if needle.is_empty() {
            self.tracks.extend(0..self.all_tracks.len());
            return;
        }
        self.tracks
            .extend(self.all_tracks.iter().enumerate().filter(|(_, row)| row.matches(&needle)).map(|(index, _)| index));
    }
}

impl TrackList for LocalTracks {
    #[inline]
    fn len(&self) -> usize {
        self.tracks.len()
    }

    fn total(&self) -> usize {
        self.all_tracks.len()
    }

    #[inline]
    fn row(&self, index: usize) -> Option<&TrackRow> {
        self.tracks.get(index).map(|&index| &self.all_tracks[index])
    }

    fn rating(&self, track_id: i64) -> Option<&Rating> {
        self.ratings.get(&track_id)
    }

    fn index_of(&self, track_id: i64) -> Option<usize> {
        self.tracks.iter().position(|&index| self.all_tracks[index].track.id == track_id)
    }

    fn refresh(&mut self, sort: SortMode, query: &str, selected: i64) -> Refresh {
        if !self.sorted || self.sorted_by != sort {
            self.sort(sort);
        }
        self.filter(query);
        Refresh::Done(self.index_of(selected))
    }

    fn load(&mut self, _reread: bool, _sort: SortMode, _query: &str, _selected: i64) -> Cmd {
        Cmd::LoadTracks
    }

    fn rating_saved(&mut self, track_id: i64, rating: Rating, sort: SortMode) -> bool {
        self.ratings.insert(track_id, rating);
        if sort == SortMode::UnratedFirst {
            self.sorted = false;
            return true;
        }
        false
    }

    fn tracks_loaded(&mut self, loaded: TracksLoaded) {
        self.all_tracks = loaded.rows;
        self.ratings = loaded.ratings;
        self.sorted = false;
    }
}
