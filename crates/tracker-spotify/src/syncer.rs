//! The sync workflow that sits between Spotify playback history and SQLite:
//! fetch recent plays, drop what an earlier sync already saw, filter by the
//! config's artist lists, and upsert what remains.

use std::collections::HashSet;

use anyhow::{Context, Result};
use jiff::Timestamp;
use tracker_core::artists;
use tracker_core::config::Config;
use tracker_core::db::Queries;
use tracker_core::{Db, SyncStats, UpsertTrackParams};

use crate::client::{Client, RecentTrack};

/// Source of recent plays; implemented by `Client` and by test fakes.
pub trait TrackSource {
    fn recent_tracks(&self, limit: usize) -> Result<Vec<RecentTrack>>;
}

impl TrackSource for Client {
    fn recent_tracks(&self, limit: usize) -> Result<Vec<RecentTrack>> {
        Client::recent_tracks(self, limit)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Accept,
    Block,
    Skip,
}

/// Whether a track passes the allowlist/blocklist filters.
pub fn decide(cfg: &Config, track: &RecentTrack) -> Decision {
    Filters::new(cfg).decide(track)
}

/// Normalized lookup sets built once per sync rather than once per track.
struct Filters {
    allowlist: HashSet<String>,
    blocklist: HashSet<String>,
}

impl Filters {
    fn new(cfg: &Config) -> Filters {
        Filters { allowlist: name_set(&cfg.pianists_allowlist), blocklist: name_set(&cfg.artists_blocklist) }
    }

    /// Any blocklisted artist blocks the track outright, even when another
    /// credited artist is allowlisted.
    fn decide(&self, track: &RecentTrack) -> Decision {
        let mut allowed = false;
        for artist in &track.artists {
            let name = normalize_name(&artist.name);
            if name.is_empty() {
                continue;
            }
            if self.blocklist.contains(&name) {
                return Decision::Block;
            }
            if self.allowlist.contains(&name) {
                allowed = true;
            }
        }
        if allowed { Decision::Accept } else { Decision::Skip }
    }
}

/// Fetches recent plays, filters them, and upserts accepted tracks. The DB
/// lock is only taken after the network fetch completes.
///
/// The checkpoint is the newest `played_at` processed, in Unix nanoseconds
/// (Go's `UnixNano`), so databases written by the Go build stay compatible.
/// Plays at or before it are counted as already synced; without this, every
/// sync would re-count the same 50 recent plays.
pub fn run(cfg: &Config, source: &dyn TrackSource, db: &Db, limit: usize) -> Result<SyncStats> {
    let tracks = source.recent_tracks(limit)?;
    let mut stats = SyncStats { fetched: tracks.len(), ..SyncStats::default() };
    let filters = Filters::new(cfg);

    let conn = db.conn();
    let checkpoint_ns = conn.recent_play_checkpoint().context("load recent play checkpoint")?.unwrap_or(0);
    let mut max_processed_ns = checkpoint_ns;

    for track in &tracks {
        let played_at_ns = unix_nanos(track.played_at);
        max_processed_ns = max_processed_ns.max(played_at_ns);
        if checkpoint_ns != 0 && played_at_ns <= checkpoint_ns {
            stats.already_synced += 1;
            continue;
        }

        match filters.decide(track) {
            Decision::Block => {
                stats.blocked += 1;
                continue;
            }
            Decision::Skip => {
                stats.skipped += 1;
                continue;
            }
            Decision::Accept => {}
        }

        let row = conn
            .upsert_track(&UpsertTrackParams {
                spotify_id: track.spotify_id.clone(),
                track_name: track.name.clone(),
                album_name: track.album_name.clone(),
                artists: artists::encode(&track.artist_names()),
                last_played_at: track.played_at.as_second(),
            })
            .with_context(|| format!("upsert track {:?} ({})", track.name, track.spotify_id))?;

        stats.accepted += 1;
        if row.play_count == 1 {
            stats.inserted += 1;
        } else {
            stats.updated += 1;
        }
    }

    if max_processed_ns > checkpoint_ns {
        conn.upsert_recent_play_checkpoint(max_processed_ns).context("persist recent play checkpoint")?;
    }

    Ok(stats)
}

/// Go's `UnixNano`, saturating outside the years 1678..2262 where an i64 of
/// nanoseconds cannot represent the instant.
fn unix_nanos(ts: Timestamp) -> i64 {
    let nanos = ts.as_nanosecond();
    i64::try_from(nanos).unwrap_or(if nanos < 0 { i64::MIN } else { i64::MAX })
}

/// Normalizes config artist names into a lookup set shared by the allowlist
/// and blocklist checks.
fn name_set(items: &[String]) -> HashSet<String> {
    items.iter().map(|item| normalize_name(item)).filter(|name| !name.is_empty()).collect()
}

/// Keeps filtering case-insensitive and resilient to stray spaces.
fn normalize_name(name: &str) -> String {
    name.trim().to_lowercase()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use anyhow::anyhow;
    use jiff::SignedDuration;

    use super::*;
    use crate::client::Artist;

    fn track(spotify_id: &str, artists: &[&str], played_at: Timestamp) -> RecentTrack {
        RecentTrack {
            spotify_id: spotify_id.into(),
            name: format!("Track {spotify_id}"),
            album_name: format!("Album {spotify_id}"),
            artists: artists.iter().map(|name| Artist { id: String::new(), name: (*name).into() }).collect(),
            duration_ms: 0,
            played_at,
        }
    }

    fn config(allow: &[&str], block: &[&str]) -> Config {
        Config {
            pianists_allowlist: allow.iter().map(|name| (*name).into()).collect(),
            artists_blocklist: block.iter().map(|name| (*name).into()).collect(),
            ..Config::default()
        }
    }

    fn base() -> Timestamp {
        "2026-04-01T10:00:00Z".parse().unwrap()
    }

    struct FakeSource(Vec<RecentTrack>);

    impl TrackSource for FakeSource {
        fn recent_tracks(&self, _limit: usize) -> Result<Vec<RecentTrack>> {
            Ok(self.0.clone())
        }
    }

    #[test]
    fn decide_applies_filters() {
        let cfg = config(&["Martha Argerich"], &["Yiruma"]);
        let cases = [
            ("accepts allowlisted artist", vec!["Martha Argerich"], Decision::Accept),
            ("blocks blocklisted artist", vec!["Yiruma", "Martha Argerich"], Decision::Block),
            ("skips unknown artist", vec!["Unknown Pianist"], Decision::Skip),
            ("matches case-insensitively", vec!["martha argerich"], Decision::Accept),
            ("trims stray spaces", vec!["  Martha Argerich "], Decision::Accept),
            ("ignores blank names", vec!["", "  "], Decision::Skip),
        ];
        for (name, artists, want) in cases {
            assert_eq!(decide(&cfg, &track("t", &artists, base())), want, "{name}");
        }
    }

    #[test]
    fn run_filters_and_counts() {
        let cfg = config(&["Martha Argerich", "Daniil Trifonov"], &["Yiruma"]);
        let now = base();
        let source = FakeSource(vec![
            track("accepted-new", &["Martha Argerich"], now),
            track("blocked", &["Yiruma"], now),
            track("skipped", &["Unknown Artist"], now),
            track("accepted-update", &["Daniil Trifonov"], now),
        ]);
        let db = Db::open_in_memory().unwrap();
        // An earlier play makes the second accepted track an update.
        db.conn()
            .upsert_track(&UpsertTrackParams {
                spotify_id: "accepted-update".into(),
                track_name: "Track accepted-update".into(),
                album_name: "Album accepted-update".into(),
                artists: r#"["Daniil Trifonov"]"#.into(),
                last_played_at: now.as_second() - 3600,
            })
            .unwrap();

        let stats = run(&cfg, &source, &db, 50).unwrap();
        assert_eq!(
            stats,
            SyncStats { fetched: 4, already_synced: 0, blocked: 1, skipped: 1, accepted: 2, inserted: 1, updated: 1 }
        );

        let conn = db.conn();
        let tracks = conn.list_all_tracks().unwrap();
        assert_eq!(tracks.len(), 2, "blocked and skipped tracks are not stored");
        let inserted = conn.track_by_spotify_id("accepted-new").unwrap().unwrap();
        assert_eq!(inserted.artists, r#"["Martha Argerich"]"#);
        assert_eq!(inserted.track_name, "Track accepted-new");
        assert_eq!(inserted.album_name, "Album accepted-new");
        assert_eq!(inserted.last_played_at, now.as_second());
        assert_eq!(conn.track_by_spotify_id("accepted-update").unwrap().unwrap().play_count, 2);
        assert_eq!(conn.recent_play_checkpoint().unwrap(), Some(now.as_nanosecond() as i64));
    }

    #[test]
    fn run_skips_already_synced_recent_plays() {
        let cfg = config(&["Martha Argerich"], &[]);
        let older = base();
        let newer = base().checked_add(SignedDuration::from_mins(2)).unwrap();
        let checkpoint = base().checked_add(SignedDuration::from_mins(1)).unwrap();
        let source =
            FakeSource(vec![track("older", &["Martha Argerich"], older), track("newer", &["Martha Argerich"], newer)]);
        let db = Db::open_in_memory().unwrap();
        {
            let conn = db.conn();
            conn.upsert_recent_play_checkpoint(unix_nanos(checkpoint)).unwrap();
            for _ in 0..2 {
                conn.upsert_track(&UpsertTrackParams {
                    spotify_id: "newer".into(),
                    artists: r#"["Martha Argerich"]"#.into(),
                    last_played_at: older.as_second(),
                    ..UpsertTrackParams::default()
                })
                .unwrap();
            }
        }

        let stats = run(&cfg, &source, &db, 50).unwrap();
        assert_eq!(stats, SyncStats { fetched: 2, already_synced: 1, accepted: 1, updated: 1, ..SyncStats::default() });

        let conn = db.conn();
        assert!(conn.track_by_spotify_id("older").unwrap().is_none(), "already-synced play is not stored");
        assert_eq!(conn.track_by_spotify_id("newer").unwrap().unwrap().play_count, 3);
        assert_eq!(conn.recent_play_checkpoint().unwrap(), Some(unix_nanos(newer)));
    }

    #[test]
    fn checkpoint_has_nanosecond_precision_and_never_moves_backwards() {
        let cfg = config(&["Martha Argerich"], &[]);
        let checkpoint = base();
        let just_after = checkpoint.checked_add(SignedDuration::from_nanos(1)).unwrap();
        let earlier = checkpoint.checked_sub(SignedDuration::from_hours(1)).unwrap();
        let db = Db::open_in_memory().unwrap();
        db.conn().upsert_recent_play_checkpoint(unix_nanos(checkpoint)).unwrap();

        let stats = run(&cfg, &FakeSource(vec![track("same", &["Martha Argerich"], checkpoint)]), &db, 50).unwrap();
        assert_eq!(stats.already_synced, 1, "a play exactly at the checkpoint was already synced");

        let stats = run(&cfg, &FakeSource(vec![track("next", &["Martha Argerich"], just_after)]), &db, 50).unwrap();
        assert_eq!(stats.inserted, 1, "one nanosecond later is new");
        assert_eq!(db.conn().recent_play_checkpoint().unwrap(), Some(unix_nanos(just_after)));

        run(&cfg, &FakeSource(vec![track("old", &["Martha Argerich"], earlier)]), &db, 50).unwrap();
        assert_eq!(db.conn().recent_play_checkpoint().unwrap(), Some(unix_nanos(just_after)));
    }

    #[test]
    fn checkpoint_advances_past_filtered_plays() {
        let cfg = config(&["Martha Argerich"], &["Yiruma"]);
        let db = Db::open_in_memory().unwrap();
        let stats = run(&cfg, &FakeSource(vec![track("b", &["Yiruma"], base())]), &db, 50).unwrap();
        assert_eq!(stats, SyncStats { fetched: 1, blocked: 1, ..SyncStats::default() });
        assert_eq!(db.conn().recent_play_checkpoint().unwrap(), Some(unix_nanos(base())));
    }

    #[test]
    fn fetch_errors_are_returned_unwrapped_and_leave_db_untouched() {
        struct Failing;
        impl TrackSource for Failing {
            fn recent_tracks(&self, _limit: usize) -> Result<Vec<RecentTrack>> {
                Err(anyhow!("spotify is down"))
            }
        }
        let db = Db::open_in_memory().unwrap();
        let err = run(&config(&[], &[]), &Failing, &db, 50).unwrap_err();
        assert_eq!(format!("{err:#}"), "spotify is down");
        assert_eq!(db.conn().recent_play_checkpoint().unwrap(), None);
    }

    #[test]
    fn database_is_not_locked_during_fetch() {
        /// Locks the DB from another thread mid-fetch; if `run` already held
        /// the lock this would time out instead of deadlocking the test.
        struct LockProbe(Arc<Db>);
        impl TrackSource for LockProbe {
            fn recent_tracks(&self, _limit: usize) -> Result<Vec<RecentTrack>> {
                let (tx, rx) = mpsc::channel();
                let db = Arc::clone(&self.0);
                thread::spawn(move || {
                    let _guard = db.conn();
                    let _ = tx.send(());
                });
                rx.recv_timeout(Duration::from_secs(5)).map_err(|_| anyhow!("database locked during fetch"))?;
                Ok(Vec::new())
            }
        }
        let db = Arc::new(Db::open_in_memory().unwrap());
        let stats = run(&config(&[], &[]), &LockProbe(Arc::clone(&db)), &db, 50).unwrap();
        assert_eq!(stats, SyncStats::default());
    }

    #[test]
    fn passes_limit_through_to_source() {
        struct LimitProbe(std::sync::Mutex<Option<usize>>);
        impl TrackSource for LimitProbe {
            fn recent_tracks(&self, limit: usize) -> Result<Vec<RecentTrack>> {
                *self.0.lock().unwrap() = Some(limit);
                Ok(Vec::new())
            }
        }
        let probe = LimitProbe(std::sync::Mutex::new(None));
        run(&config(&[], &[]), &probe, &Db::open_in_memory().unwrap(), 17).unwrap();
        assert_eq!(*probe.0.lock().unwrap(), Some(17));
    }
}
