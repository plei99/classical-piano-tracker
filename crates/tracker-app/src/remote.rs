//! The web client's list: a sparse cache of the rows `tracker web` sorted
//! and filtered, filled one window at a time. Changing the order or the
//! query, reloading, and jumping to rows that are not loaded are fetches
//! ([`Cmd::FetchView`]); moving within loaded rows never touches the
//! network, and [`RemoteTracks::viewport`] fetches ahead of the rows on
//! screen so scrolling rarely reaches rows that are not loaded.
//!
//! Answers that arrive out of order are dropped: a new order or query
//! supersedes every earlier one ([`ViewRequest::seq`]), and windows belong to
//! the list they extend ([`ViewRequest::generation`]). When an answer shows
//! the library changed (a newer [`ViewResponse::version`]), the list is
//! fetched again around the selected track and replaced in one step, so the
//! page never flashes empty.

use std::collections::HashMap;
use std::ops::Range;

use anyhow::Result;
use tracker_core::Rating;

use crate::api::{self, MAX_VIEW_LIMIT, Row, ViewResponse};
use crate::list::{Refresh, TrackList};
use crate::model::{Cmd, SortMode, TrackRow};

/// Rows per fetch, and in the page's first window.
pub const CHUNK: usize = 100;

/// Why a window is fetched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewKind {
    /// Re-read the database first (`r`, after a sync), then fetch a new list.
    Reload,
    /// A new list: another order or query, or the library changed.
    Refresh,
    /// More rows of the list on screen.
    Window,
}

/// One fetch of [`api::VIEW_PATH`], as the model asked for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewRequest {
    pub kind: ViewKind,
    /// Issue order; only the latest new list counts.
    pub seq: u64,
    /// The list a [`ViewKind::Window`] extends.
    pub generation: u64,
    pub sort: SortMode,
    pub query: String,
    pub offset: usize,
    pub limit: usize,
    pub around: Option<i64>,
}

impl ViewRequest {
    pub fn url(&self) -> String {
        api::view_url(self.sort, &self.query, self.offset, self.limit, self.around)
    }
}

/// What an answer did to the list.
#[derive(Debug)]
pub enum ViewOutcome {
    /// Out of date or superseded; nothing changed.
    Stale,
    /// A new list. The selected track's index in it, if it matches.
    Replaced(Option<usize>),
    /// The selection moved somewhere this new list does not show while it
    /// was on its way; nothing changed, fetch it again around the
    /// selection.
    Retarget,
    /// More rows of the same list.
    Merged,
    /// The library changed since the list was fetched; nothing changed,
    /// fetch it again around the selection.
    Outdated,
    Failed(anyhow::Error),
}

#[derive(Debug, Clone)]
struct Entry {
    row: TrackRow,
    rating: Option<Rating>,
}

impl Entry {
    fn new(row: Row) -> Entry {
        // The server already matched the search text; rows never need it.
        Entry { row: TrackRow { track: row.track, artists: row.artists, search: String::new() }, rating: row.rating }
    }
}

/// See the module docs.
#[derive(Debug, Clone, Default)]
pub struct RemoteTracks {
    version: u64,
    total: usize,
    /// The order and query `rows` reflect.
    sort: SortMode,
    query: String,
    /// One slot per matched track; `None` until fetched.
    rows: Vec<Option<Box<Entry>>>,
    by_id: HashMap<i64, usize>,
    /// Bumped whenever `rows` is replaced.
    generation: u64,
    next_seq: u64,
    /// The new list on its way, if any; answers to earlier ones are stale.
    awaited: Option<u64>,
    /// Windows on their way for this generation, by request.
    inflight: Vec<(u64, Range<usize>)>,
    /// A refetch after a version change is on its way.
    outdated: bool,
}

impl RemoteTracks {
    /// The list a server-rendered page shows.
    pub fn from_view(sort: SortMode, query: &str, view: ViewResponse) -> RemoteTracks {
        let mut list = RemoteTracks::default();
        list.replace(sort, query, view);
        list
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    /// Whether row `index` is loaded.
    pub fn is_loaded(&self, index: usize) -> bool {
        self.rows.get(index).is_some_and(Option::is_some)
    }

    /// The rows in `range` that are loaded.
    pub fn loaded_count(&self, range: Range<usize>) -> usize {
        self.rows.get(range).map_or(0, |rows| rows.iter().filter(|row| row.is_some()).count())
    }

    fn pending(&self, index: usize) -> bool {
        self.is_loaded(index) || self.inflight.iter().any(|(_, range)| range.contains(&index))
    }

    fn request(
        &mut self,
        kind: ViewKind,
        sort: SortMode,
        query: &str,
        offset: usize,
        limit: usize,
        around: Option<i64>,
    ) -> ViewRequest {
        self.next_seq += 1;
        ViewRequest {
            kind,
            seq: self.next_seq,
            generation: self.generation,
            sort,
            query: query.to_string(),
            offset,
            limit,
            around,
        }
    }

    /// A new list, around `selected` (when it is a track).
    fn new_list(&mut self, kind: ViewKind, sort: SortMode, query: &str, selected: i64) -> Cmd {
        let around = (selected != 0).then_some(selected);
        let request = self.request(kind, sort, query, 0, CHUNK, around);
        self.awaited = Some(request.seq);
        Cmd::FetchView(request)
    }

    /// Fetches `range` (at most [`MAX_VIEW_LIMIT`] rows) of this list.
    fn window(&mut self, range: Range<usize>) -> Cmd {
        let limit = range.len().clamp(1, MAX_VIEW_LIMIT);
        let request = self.request(ViewKind::Window, self.sort, &self.query.clone(), range.start, limit, None);
        self.inflight.push((request.seq, range.start..range.start + limit));
        Cmd::FetchView(request)
    }

    fn replace(&mut self, sort: SortMode, query: &str, view: ViewResponse) {
        self.generation += 1;
        self.version = view.version;
        self.total = view.total;
        self.sort = sort;
        self.query = query.to_string();
        self.rows = Vec::new();
        self.rows.resize_with(view.matched, || None);
        self.by_id.clear();
        self.inflight.clear();
        self.outdated = false;
        self.merge(view.offset, view.rows);
    }

    fn merge(&mut self, offset: usize, rows: Vec<Row>) {
        for (index, row) in (offset..).zip(rows) {
            let Some(slot) = self.rows.get_mut(index) else { break };
            self.by_id.insert(row.track.id, index);
            *slot = Some(Box::new(Entry::new(row)));
        }
    }

    /// The `CHUNK`-row range to fetch so that `missing` (rows not loaded)
    /// gets loaded, extending away from the loaded rows next to it.
    fn chunk_for(&self, missing: Range<usize>) -> Range<usize> {
        let len = self.rows.len();
        if missing.len() >= CHUNK {
            return missing.start..(missing.start + MAX_VIEW_LIMIT).min(missing.end);
        }
        let above = missing.start > 0 && self.is_loaded(missing.start - 1);
        let below = missing.end < len && self.is_loaded(missing.end);
        let start = if above && !below {
            // Scrolling down: fetch on from the last loaded row.
            missing.start
        } else if below && !above {
            // Scrolling up.
            missing.end.saturating_sub(CHUNK)
        } else {
            // A jump: center on the gap.
            (missing.start + missing.len() / 2).saturating_sub(CHUNK / 2)
        };
        let end = (start + CHUNK).min(len);
        end.saturating_sub(CHUNK).min(start)..end
    }
}

impl TrackList for RemoteTracks {
    #[inline]
    fn len(&self) -> usize {
        self.rows.len()
    }

    fn total(&self) -> usize {
        self.total
    }

    #[inline]
    fn row(&self, index: usize) -> Option<&TrackRow> {
        self.rows.get(index)?.as_deref().map(|entry| &entry.row)
    }

    fn rating(&self, track_id: i64) -> Option<&Rating> {
        let index = *self.by_id.get(&track_id)?;
        self.rows[index].as_deref()?.rating.as_ref()
    }

    fn index_of(&self, track_id: i64) -> Option<usize> {
        self.by_id.get(&track_id).copied()
    }

    fn refresh(&mut self, sort: SortMode, query: &str, selected: i64) -> Refresh {
        Refresh::Pending(self.new_list(ViewKind::Refresh, sort, query, selected))
    }

    fn load(&mut self, reread: bool, sort: SortMode, query: &str, selected: i64) -> Cmd {
        self.new_list(if reread { ViewKind::Reload } else { ViewKind::Refresh }, sort, query, selected)
    }

    fn rating_saved(&mut self, track_id: i64, rating: Rating, _sort: SortMode) -> bool {
        if let Some(&index) = self.by_id.get(&track_id)
            && let Some(entry) = self.rows[index].as_deref_mut()
        {
            entry.rating = Some(rating);
        }
        // The server's library moved to a new version (and, sorted unrated
        // first, a new order); fetch the list again so later windows match.
        true
    }

    fn applied(&self) -> Option<(SortMode, &str)> {
        Some((self.sort, &self.query))
    }

    fn fetch(&mut self, index: usize) -> Option<Cmd> {
        if index >= self.rows.len() || self.pending(index) {
            return None;
        }
        let range = self.chunk_for(index..index + 1);
        Some(self.window(range))
    }

    fn view_loaded(&mut self, request: &ViewRequest, result: Result<ViewResponse>, selected: i64) -> ViewOutcome {
        if request.kind != ViewKind::Window {
            if self.awaited != Some(request.seq) {
                return ViewOutcome::Stale;
            }
            let view = match result {
                Ok(view) => view,
                Err(err) => {
                    self.awaited = None;
                    return ViewOutcome::Failed(err);
                }
            };
            // The selection moved while this was on its way: keep it if the
            // new list shows it, otherwise ask again around it.
            let moved = selected != 0 && request.around != Some(selected);
            let index = if moved {
                match view.rows.iter().position(|row| row.track.id == selected) {
                    Some(position) => Some(view.offset + position),
                    None if view.matched > 0 => return ViewOutcome::Retarget,
                    None => None,
                }
            } else {
                view.index
            };
            self.awaited = None;
            self.replace(request.sort, &request.query, view);
            return ViewOutcome::Replaced(index);
        }

        let Some(position) = self.inflight.iter().position(|(seq, _)| *seq == request.seq) else {
            // Its list was replaced meanwhile.
            return ViewOutcome::Stale;
        };
        self.inflight.swap_remove(position);
        // A failed window stays unloaded; the next scroll asks again.
        let Ok(view) = result else { return ViewOutcome::Stale };
        if request.generation != self.generation || view.version < self.version {
            return ViewOutcome::Stale;
        }
        if view.version > self.version || view.matched != self.rows.len() {
            if self.outdated || self.awaited.is_some() {
                // A new list is already on its way.
                return ViewOutcome::Stale;
            }
            self.outdated = true;
            return ViewOutcome::Outdated;
        }
        self.merge(view.offset, view.rows);
        ViewOutcome::Merged
    }

    fn viewport(&mut self, first: usize, last: usize) -> Option<Cmd> {
        let len = self.rows.len();
        let last = last.min(len);
        let first = first.min(last);
        let screen = (last - first).max(1);
        // Keep at least a screen loaded on each side of the viewport...
        let near = first.saturating_sub(screen)..(last + screen).min(len);
        if near.clone().all(|index| self.pending(index)) {
            return None;
        }
        // ...by fetching up to two screens ahead.
        let ahead = first.saturating_sub(2 * screen)..(last + 2 * screen).min(len);
        let start = ahead.clone().find(|&index| !self.pending(index))?;
        let end = ahead.rev().find(|&index| !self.pending(index))? + 1;
        let range = self.chunk_for(start..end);
        Some(self.window(range))
    }
}

#[cfg(test)]
mod tests;
