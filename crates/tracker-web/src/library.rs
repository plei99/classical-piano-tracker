//! The library `tracker web` serves. It is read from the database once (and
//! again on reload and after a sync), with each row's display and search
//! text and all four sort orders computed up front, and answers windowed
//! queries ([`tracker_app::api::VIEW_PATH`]) so a page never downloads the whole library.
//! Sorting and matching are `tracker_app`'s, the code the terminal UI runs,
//! so both always show the same order and the same matches.
//!
//! A `Library` is immutable; a saved rating produces the next version.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use tracker_app::api::{Artwork, MAX_VIEW_LIMIT, Row, ViewResponse};
use tracker_app::list::{search_needle, sort_by_mode};
use tracker_app::remote::CHUNK;
use tracker_app::{SortMode, TrackRow, TracksLoaded};
use tracker_core::{Rating, Track};
use url::Url;

/// How many filtered lists each version keeps, so scrolling through search
/// results does not filter again for every window.
const FILTER_CACHE: usize = 8;

/// Reports the album art already known for each Spotify ID (`None` when
/// unknown, `Some(None)` when the track has none), without looking anything
/// up.
pub type KnownArt<'a> = &'a dyn Fn(&[&str]) -> Vec<Option<Option<Artwork>>>;

/// A filtered list: its order, the search needle, and the matching rows.
type Filtered = (SortMode, String, Arc<Vec<u32>>);

/// One [`tracker_app::api::VIEW_PATH`] request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewQuery {
    pub sort: SortMode,
    pub query: String,
    pub offset: usize,
    pub limit: usize,
    pub around: Option<i64>,
}

impl ViewQuery {
    /// What a page shows first: the most recent plays, unfiltered.
    pub fn initial() -> ViewQuery {
        ViewQuery { sort: SortMode::default(), query: String::new(), offset: 0, limit: CHUNK, around: None }
    }

    /// Reads the query string, as strictly as the TypeScript server: `sort`
    /// and `limit` are required, `offset` defaults to 0, and numbers are
    /// plain digits.
    pub fn parse(url: &Url) -> Result<ViewQuery, String> {
        let mut params: HashMap<String, String> = HashMap::new();
        for (name, value) in url.query_pairs() {
            params.entry(name.into_owned()).or_insert_with(|| value.into_owned());
        }
        let param = |name: &str| params.get(name).map(String::as_str);
        let sort = param("sort").and_then(SortMode::from_param).ok_or_else(|| {
            let names: Vec<&str> = SortMode::ALL.iter().map(|mode| mode.param()).collect();
            format!("sort must be one of {}", names.join(", "))
        })?;
        let limit_message = format!("limit must be an integer from 1 to {MAX_VIEW_LIMIT}");
        let limit = integer(param("limit"), &limit_message)?
            .filter(|limit| (1..=MAX_VIEW_LIMIT as u64).contains(limit))
            .ok_or(limit_message)? as usize;
        let offset = integer(param("offset"), "offset must be a non-negative integer")?.unwrap_or(0) as usize;
        let around_message = "around must be a positive track ID";
        let around = match integer(param("around"), around_message)? {
            None => None,
            Some(0) => return Err(around_message.into()),
            Some(id) => Some(id as i64),
        };
        Ok(ViewQuery { sort, query: param("q").unwrap_or_default().to_string(), offset, limit, around })
    }
}

/// A parameter of 1 to 15 digits (so it is a safe integer in JavaScript),
/// `None` when absent, or `message` for anything else.
fn integer(value: Option<&str>, message: &str) -> Result<Option<u64>, String> {
    let Some(value) = value else { return Ok(None) };
    if value.is_empty() || value.len() > 15 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(message.to_string());
    }
    value.parse().map(Some).map_err(|_| message.to_string())
}

/// Every track and rating, ready to answer [`ViewQuery`]s.
pub struct Library {
    version: u64,
    rows: Arc<Vec<TrackRow>>,
    ratings: Arc<HashMap<i64, Rating>>,
    /// Indexes into `rows` in each [`SortMode::ALL`] order.
    orders: [Arc<Vec<u32>>; 4],
    /// Recently filtered lists: order, needle, matching indexes.
    filtered: Mutex<VecDeque<Filtered>>,
}

fn mode_index(mode: SortMode) -> usize {
    SortMode::ALL.iter().position(|candidate| *candidate == mode).unwrap_or(0)
}

fn order(rows: &[TrackRow], ratings: &HashMap<i64, Rating>, mode: SortMode) -> Arc<Vec<u32>> {
    let mut sorted: Vec<(u32, &TrackRow)> = (0..).zip(rows).collect();
    sort_by_mode(&mut sorted, mode, ratings, |(_, row)| &row.track);
    Arc::new(sorted.into_iter().map(|(index, _)| index).collect())
}

impl Library {
    pub fn new(version: u64, tracks: Vec<Track>, ratings: Vec<Rating>) -> Library {
        let loaded = TracksLoaded::new(tracks, ratings);
        let (rows, ratings) = (loaded.rows, loaded.ratings);
        let orders = SortMode::ALL.map(|mode| order(&rows, &ratings, mode));
        Library {
            version,
            rows: Arc::new(rows),
            ratings: Arc::new(ratings),
            orders,
            filtered: Mutex::new(VecDeque::new()),
        }
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn total(&self) -> usize {
        self.rows.len()
    }

    /// The next version, with `rating` saved. Only the unrated-first order
    /// depends on ratings, so only it is sorted again.
    pub fn with_rating(&self, version: u64, rating: Rating) -> Library {
        let mut ratings = (*self.ratings).clone();
        ratings.insert(rating.track_id, rating);
        let mut orders = self.orders.clone();
        let unrated = mode_index(SortMode::UnratedFirst);
        orders[unrated] = order(&self.rows, &ratings, SortMode::UnratedFirst);
        Library {
            version,
            rows: Arc::clone(&self.rows),
            ratings: Arc::new(ratings),
            orders,
            filtered: Mutex::new(VecDeque::new()),
        }
    }

    /// The tracks matching `query`, in `sort` order, as indexes into `rows`.
    fn matched(&self, sort: SortMode, query: &str) -> Arc<Vec<u32>> {
        let all = &self.orders[mode_index(sort)];
        let needle = search_needle(query);
        if needle.is_empty() {
            return Arc::clone(all);
        }
        let mut cache = self.filtered.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((_, _, matched)) = cache.iter().find(|(mode, cached, _)| *mode == sort && *cached == needle) {
            return Arc::clone(matched);
        }
        let matched: Arc<Vec<u32>> =
            Arc::new(all.iter().copied().filter(|&index| self.rows[index as usize].matches(&needle)).collect());
        if cache.len() == FILTER_CACHE {
            cache.pop_back();
        }
        cache.push_front((sort, needle, Arc::clone(&matched)));
        matched
    }

    /// One window, with the art `art` already knows.
    pub fn view(&self, query: &ViewQuery, art: KnownArt<'_>) -> ViewResponse {
        let matched = self.matched(query.sort, &query.query);
        let index = query
            .around
            .and_then(|track_id| matched.iter().position(|&row| self.rows[row as usize].track.id == track_id));
        let offset = match index {
            // Centered on the track, but never past either end.
            Some(index) => index.saturating_sub(query.limit / 2).min(matched.len().saturating_sub(query.limit)),
            None => query.offset,
        };
        let window: Vec<&TrackRow> =
            matched.iter().skip(offset).take(query.limit).map(|&row| &self.rows[row as usize]).collect();
        let ids: Vec<&str> = window.iter().map(|row| row.track.spotify_id.as_str()).collect();
        let mut known = art(&ids).into_iter();
        let rows = window
            .into_iter()
            .map(|row| Row {
                track: row.track.clone(),
                rating: self.ratings.get(&row.track.id).cloned(),
                artists: row.artists.clone(),
                art: known.next().flatten(),
            })
            .collect();
        ViewResponse { version: self.version, total: self.rows.len(), matched: matched.len(), offset, rows, index }
    }
}

#[cfg(test)]
mod tests;
