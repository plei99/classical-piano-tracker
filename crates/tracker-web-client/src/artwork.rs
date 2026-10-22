//! Album art, fetched lazily for the rows on screen and the selected track.
//! Requests from many rows in the same frame are batched (Spotify looks up
//! at most 50 tracks per call) and each ID is asked for once per page load.
//! At most [`MAX_IN_FLIGHT`] batches are out at once: a lookup the server
//! has to make on Spotify can take seconds, and the browser's few
//! connections per host must stay free for the list's own fetches.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;

use leptos::prelude::*;
use tracker_app::api::{ARTWORK_BATCH, ARTWORK_PATH, Artwork, ArtworkResponse, Row, encode_uri_component};

use crate::deps;

/// How long requests collect before a batch goes out.
const BATCH_DELAY: Duration = Duration::from_millis(16);

/// Batches on their way at once.
pub const MAX_IN_FLIGHT: usize = 2;

/// The bookkeeping behind [`ArtworkStore`], free of timers and fetches.
#[derive(Debug, Default)]
pub struct ArtworkQueue {
    requested: HashSet<String>,
    queue: Vec<String>,
    flush_scheduled: bool,
    /// Batches waiting for a free slot; the newest (rows on screen now) go
    /// first.
    waiting: VecDeque<Vec<String>>,
    in_flight: usize,
}

impl ArtworkQueue {
    /// Queues the IDs not already known or on the way. Returns true when the
    /// caller must schedule a flush.
    pub fn request<'a>(&mut self, ids: impl IntoIterator<Item = &'a str>) -> bool {
        for id in ids {
            if !id.is_empty() && self.requested.insert(id.to_string()) {
                self.queue.push(id.to_string());
            }
        }
        if self.queue.is_empty() || self.flush_scheduled {
            return false;
        }
        self.flush_scheduled = true;
        true
    }

    /// Everything queued, in batches the server accepts: those to send now,
    /// while fewer than [`MAX_IN_FLIGHT`] are out. The rest wait for
    /// [`ArtworkQueue::finished`].
    pub fn take_batches(&mut self) -> Vec<Vec<String>> {
        self.flush_scheduled = false;
        let queued = std::mem::take(&mut self.queue);
        self.waiting.extend(queued.chunks(ARTWORK_BATCH).map(<[String]>::to_vec));
        let mut ready = Vec::new();
        while let Some(batch) = self.next_batch() {
            ready.push(batch);
        }
        ready
    }

    /// A batch came back; the next one to send, if any.
    pub fn finished(&mut self) -> Option<Vec<String>> {
        self.in_flight = self.in_flight.saturating_sub(1);
        self.next_batch()
    }

    fn next_batch(&mut self) -> Option<Vec<String>> {
        if self.in_flight >= MAX_IN_FLIGHT {
            return None;
        }
        let batch = self.waiting.pop_back()?;
        self.in_flight += 1;
        Some(batch)
    }

    /// Records IDs whose art arrived another way, so they are never asked for.
    pub fn known<'a>(&mut self, ids: impl IntoIterator<Item = &'a str>) {
        for id in ids {
            self.requested.insert(id.to_string());
        }
    }

    /// Lets a later render ask again rather than caching a transient failure.
    pub fn forget(&mut self, ids: &[String]) {
        for id in ids {
            self.requested.remove(id);
        }
    }
}

/// The lookup URL for one batch.
pub fn batch_url(ids: &[String]) -> String {
    let encoded: Vec<String> = ids.iter().map(|id| encode_uri_component(id)).collect();
    format!("{ARTWORK_PATH}?ids={}", encoded.join(","))
}

/// Art by Spotify ID: absent while unknown, `None` when Spotify has none.
/// Reading it from a reactive closure re-runs the closure when art arrives.
#[derive(Clone, Copy)]
pub struct ArtworkStore {
    art: RwSignal<HashMap<String, Option<Artwork>>>,
    queue: StoredValue<ArtworkQueue>,
}

impl ArtworkStore {
    pub fn new() -> ArtworkStore {
        ArtworkStore { art: RwSignal::new(HashMap::new()), queue: StoredValue::new(ArtworkQueue::default()) }
    }

    /// The best URL for a cover of `size`, tracked.
    pub fn url(&self, spotify_id: &str, large: bool) -> Option<String> {
        self.art.with(|art| {
            let art = art.get(spotify_id)?.as_ref()?;
            if large { art.large_url() } else { art.small_url() }.map(str::to_string)
        })
    }

    /// Takes the art the server sent along with rows (only for tracks whose
    /// art it already knew).
    pub fn seed(&self, rows: &[Row]) {
        let known: Vec<(&str, &Option<Artwork>)> =
            rows.iter().filter_map(|row| Some((row.track.spotify_id.as_str(), row.art.as_ref()?))).collect();
        if known.is_empty() {
            return;
        }
        self.queue.update_value(|queue| queue.known(known.iter().map(|(id, _)| *id)));
        let fresh = self.art.with_untracked(|art| known.iter().any(|(id, found)| art.get(*id) != Some(*found)));
        if fresh {
            self.art.update(|art| {
                for (id, found) in known {
                    art.insert(id.to_string(), found.clone());
                }
            });
        }
    }

    /// Asks for art for these tracks unless already known or on the way.
    pub fn request<'a>(&self, ids: impl IntoIterator<Item = &'a str>) {
        if self.queue.try_update_value(|queue| queue.request(ids)).unwrap_or(false) {
            let store = *self;
            set_timeout(move || store.flush(), BATCH_DELAY);
        }
    }

    fn flush(self) {
        let Some(batches) = self.queue.try_update_value(ArtworkQueue::take_batches) else { return };
        for ids in batches {
            self.send(ids);
        }
    }

    fn send(self, ids: Vec<String>) {
        leptos::task::spawn_local(async move {
            match deps::get_json::<ArtworkResponse>(&batch_url(&ids)).await {
                Ok(found) => {
                    let mut found: HashMap<String, Option<Artwork>> = found.0.into_iter().collect();
                    self.art.update(|art| {
                        for id in ids {
                            let entry = found.remove(&id).flatten();
                            art.insert(id, entry);
                        }
                    });
                }
                Err(_) => self.queue.update_value(|queue| queue.forget(&ids)),
            }
            if let Some(Some(next)) = self.queue.try_update_value(ArtworkQueue::finished) {
                self.send(next);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batches_new_ids_once_per_page() {
        let mut queue = ArtworkQueue::default();
        assert!(queue.request(["a", "b", "", "a"]), "the first request schedules a flush");
        assert!(!queue.request(["c", "b"]), "later requests in the same frame join it");
        assert_eq!(queue.take_batches(), [vec!["a".to_string(), "b".into(), "c".into()]]);
        assert!(!queue.request(["a", "c"]), "known IDs are not asked for again");
        assert!(queue.take_batches().is_empty());

        queue.forget(&["a".to_string()]);
        assert!(queue.request(["a"]), "a failed ID is asked for again");
        assert_eq!(queue.take_batches(), [vec!["a".to_string()]]);
    }

    #[test]
    fn encodes_ids_like_encode_uri_component() {
        assert_eq!(
            batch_url(&["4uLU6hMCjMI75M1A2tKUQC".into(), "a b,c/é".into(), "x-_.!~*'()".into()]),
            "/api/artwork?ids=4uLU6hMCjMI75M1A2tKUQC,a%20b%2Cc%2F%C3%A9,x-_.!~*'()"
        );
    }

    #[test]
    fn splits_batches_at_the_server_limit_and_keeps_two_out_at_once() {
        let mut queue = ArtworkQueue::default();
        let ids: Vec<String> = (0..120).map(|i| format!("id{i}")).collect();
        queue.request(ids.iter().map(String::as_str));
        let mut batches = queue.take_batches();
        assert_eq!(batches.iter().map(Vec::len).collect::<Vec<_>>(), [20, 50], "the newest first, two at most");
        assert!(queue.request(["late"]));
        assert_eq!(queue.take_batches(), Vec::<Vec<String>>::new(), "both slots are taken");
        let next = queue.finished().unwrap();
        assert_eq!(next, ["late"], "the rows on screen now go before older ones");
        batches.push(next);
        batches.push(queue.finished().unwrap());
        assert_eq!(queue.finished(), None);
        assert_eq!(queue.finished(), None);
        let mut all = batches.concat();
        all.sort();
        let mut want = ids.clone();
        want.push("late".into());
        want.sort();
        assert_eq!(all, want);
    }
}
