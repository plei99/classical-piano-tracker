//! The list the model browses: a count, a row lookup, and an index-of-track.
//! The terminal's [`LocalTracks`] holds the whole library in memory and
//! sorts and filters it synchronously, so every frame shows a finished list;
//! the web server's first render of a page browses the window it sends
//! (tracker-web's `page`).
//!
//! The terminal and the web server order and filter rows with
//! [`sort_by_mode`] and [`search_needle`] (and the web client receives what
//! the server sorted), so both front ends always agree.

use std::collections::HashMap;

use tracker_core::{Rating, Track};

use crate::model::{SortMode, TrackRow, TracksLoaded};

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

    /// Orders and filters the rows for `sort` and `query`; the new index of
    /// track `selected`, when it still matches.
    fn refresh(&mut self, sort: SortMode, query: &str, selected: i64) -> Option<usize>;

    /// Records a saved rating for `track_id`. Returns whether the list must
    /// be refreshed to stay correct.
    fn rating_saved(&mut self, track_id: i64, rating: Rating, sort: SortMode) -> bool;

    /// A whole library read from the database.
    fn tracks_loaded(&mut self, _loaded: TracksLoaded) {}
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

    fn refresh(&mut self, sort: SortMode, query: &str, selected: i64) -> Option<usize> {
        if !self.sorted || self.sorted_by != sort {
            self.sort(sort);
        }
        self.filter(query);
        self.index_of(selected)
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
