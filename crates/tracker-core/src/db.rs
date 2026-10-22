//! SQLite access. The SQL lives in the same `schema.sql` and `query.sql` files
//! the Go build feeds to sqlc; queries are looked up by their `-- name:`
//! annotation, so there is one source of truth for every statement.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, Row, named_params};

use crate::model::{Rating, Track, UpsertRatingParams, UpsertTrackParams};

const SCHEMA_SQL: &str = include_str!("../sql/schema.sql");
const QUERY_SQL: &str = include_str!("../sql/query.sql");

static QUERIES: LazyLock<HashMap<&'static str, String>> = LazyLock::new(|| parse_queries(QUERY_SQL));

/// Splits an sqlc query file into named statements and rewrites
/// `sqlc.arg(name)` into SQLite's `:name` parameter syntax.
fn parse_queries(source: &'static str) -> HashMap<&'static str, String> {
    let mut queries = HashMap::new();
    let mut current: Option<(&'static str, String)> = None;
    for line in source.lines() {
        if let Some(annotation) = line.strip_prefix("-- name:") {
            if let Some((name, sql)) = current.take() {
                queries.insert(name, sql);
            }
            let name = annotation.split_whitespace().next().expect("query annotation has a name");
            current = Some((name, String::new()));
            continue;
        }
        if line.trim_start().starts_with("--") {
            continue;
        }
        if let Some((_, sql)) = current.as_mut() {
            sql.push_str(line);
            sql.push('\n');
        }
    }
    if let Some((name, sql)) = current {
        queries.insert(name, sql);
    }
    for sql in queries.values_mut() {
        while let Some(start) = sql.find("sqlc.arg(") {
            let end = start + sql[start..].find(')').expect("sqlc.arg is closed");
            let param = sql[start + "sqlc.arg(".len()..end].trim().to_string();
            sql.replace_range(start..=end, &format!(":{param}"));
        }
    }
    queries
}

fn query(name: &str) -> &'static str {
    QUERIES.get(name).unwrap_or_else(|| panic!("query {name} missing from query.sql"))
}

/// One SQLite connection behind a mutex, shared by the CLI and the TUI's
/// background workers. Like the Go build, the app uses a single connection.
pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// Opens (creating directories as needed) and initializes the schema.
    pub fn open(path: &Path) -> Result<Db> {
        let raw = path.to_string_lossy();
        if !raw.is_empty()
            && raw != ":memory:"
            && !raw.starts_with("file:")
            && let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty())
        {
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
            builder.create(parent).with_context(|| format!("create sqlite directory for {path:?}"))?;
        }
        let conn = Connection::open(path).with_context(|| format!("open sqlite database {path:?}"))?;
        Self::init(conn).with_context(|| format!("initialize sqlite database {path:?}"))
    }

    pub fn open_in_memory() -> Result<Db> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Db> {
        conn.execute_batch("PRAGMA foreign_keys = ON").context("enable foreign keys")?;
        // The hourly launchd sync can write while the TUI is open.
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA_SQL).context("initialize sqlite schema")?;
        Ok(Db { conn: Mutex::new(conn) })
    }

    /// Locks the connection. The guard derefs to `Connection`, so all
    /// [`Queries`] methods are available on it, and `transaction()` works
    /// through `&mut *guard`.
    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn track_from_row(row: &Row<'_>) -> rusqlite::Result<Track> {
    Ok(Track {
        id: row.get("id")?,
        spotify_id: row.get("spotify_id")?,
        track_name: row.get("track_name")?,
        album_name: row.get("album_name")?,
        artists: row.get("artists")?,
        play_count: row.get("play_count")?,
        last_played_at: row.get("last_played_at")?,
        created_at: row.get("created_at")?,
    })
}

fn rating_from_row(row: &Row<'_>) -> rusqlite::Result<Rating> {
    Ok(Rating {
        track_id: row.get("track_id")?,
        stars: row.get("stars")?,
        opinion: row.get("opinion")?,
        updated_at: row.get("updated_at")?,
    })
}

/// The application's queries, one method per `-- name:` in query.sql.
/// Implemented for `Connection`, so it works on a locked [`Db`] and on a
/// `rusqlite::Transaction` alike.
pub trait Queries {
    fn upsert_track(&self, arg: &UpsertTrackParams) -> Result<Track>;
    /// `None` when no sync has completed yet.
    fn recent_play_checkpoint(&self) -> Result<Option<i64>>;
    fn upsert_recent_play_checkpoint(&self, value: i64) -> Result<()>;
    fn track_by_id(&self, id: i64) -> Result<Option<Track>>;
    fn track_by_spotify_id(&self, spotify_id: &str) -> Result<Option<Track>>;
    fn list_recent_tracks(&self, limit: i64) -> Result<Vec<Track>>;
    fn list_top_played_tracks(&self, limit: i64) -> Result<Vec<Track>>;
    fn list_all_tracks(&self) -> Result<Vec<Track>>;
    fn list_unrated_tracks(&self, limit: i64) -> Result<Vec<Track>>;
    fn upsert_rating(&self, arg: &UpsertRatingParams) -> Result<Rating>;
    fn rating_by_track_id(&self, track_id: i64) -> Result<Option<Rating>>;
    fn list_all_ratings(&self) -> Result<Vec<Rating>>;
}

impl Queries for Connection {
    fn upsert_track(&self, arg: &UpsertTrackParams) -> Result<Track> {
        Ok(self.prepare_cached(query("UpsertTrack"))?.query_row(
            named_params! {
                ":spotify_id": arg.spotify_id,
                ":track_name": arg.track_name,
                ":album_name": arg.album_name,
                ":artists": arg.artists,
                ":last_played_at": arg.last_played_at,
            },
            track_from_row,
        )?)
    }

    fn recent_play_checkpoint(&self) -> Result<Option<i64>> {
        Ok(self.prepare_cached(query("GetRecentPlayCheckpoint"))?.query_row([], |row| row.get(0)).optional()?)
    }

    fn upsert_recent_play_checkpoint(&self, value: i64) -> Result<()> {
        self.prepare_cached(query("UpsertRecentPlayCheckpoint"))?.execute(named_params! { ":value": value })?;
        Ok(())
    }

    fn track_by_id(&self, id: i64) -> Result<Option<Track>> {
        Ok(self
            .prepare_cached(query("GetTrackByID"))?
            .query_row(named_params! { ":id": id }, track_from_row)
            .optional()?)
    }

    fn track_by_spotify_id(&self, spotify_id: &str) -> Result<Option<Track>> {
        Ok(self
            .prepare_cached(query("GetTrackBySpotifyID"))?
            .query_row(named_params! { ":spotify_id": spotify_id }, track_from_row)
            .optional()?)
    }

    fn list_recent_tracks(&self, limit: i64) -> Result<Vec<Track>> {
        collect(self, "ListRecentTracks", named_params! { ":limit": limit }, track_from_row)
    }

    fn list_top_played_tracks(&self, limit: i64) -> Result<Vec<Track>> {
        collect(self, "ListTopPlayedTracks", named_params! { ":limit": limit }, track_from_row)
    }

    fn list_all_tracks(&self) -> Result<Vec<Track>> {
        collect(self, "ListAllTracks", named_params! {}, track_from_row)
    }

    fn list_unrated_tracks(&self, limit: i64) -> Result<Vec<Track>> {
        collect(self, "ListUnratedTracks", named_params! { ":limit": limit }, track_from_row)
    }

    fn upsert_rating(&self, arg: &UpsertRatingParams) -> Result<Rating> {
        Ok(self.prepare_cached(query("UpsertRating"))?.query_row(
            named_params! {
                ":track_id": arg.track_id,
                ":stars": arg.stars,
                ":opinion": arg.opinion,
                ":updated_at": arg.updated_at,
            },
            rating_from_row,
        )?)
    }

    fn rating_by_track_id(&self, track_id: i64) -> Result<Option<Rating>> {
        Ok(self
            .prepare_cached(query("GetRatingByTrackID"))?
            .query_row(named_params! { ":track_id": track_id }, rating_from_row)
            .optional()?)
    }

    fn list_all_ratings(&self) -> Result<Vec<Rating>> {
        collect(self, "ListAllRatings", named_params! {}, rating_from_row)
    }
}

fn collect<T>(
    conn: &Connection,
    name: &str,
    params: &[(&str, &dyn rusqlite::ToSql)],
    map: fn(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>> {
    let mut stmt = conn.prepare_cached(query(name))?;
    let rows = stmt.query_map(params, map)?;
    Ok(rows.collect::<rusqlite::Result<Vec<T>>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track_params(spotify_id: &str, last_played_at: i64) -> UpsertTrackParams {
        UpsertTrackParams {
            spotify_id: spotify_id.into(),
            track_name: format!("Track {spotify_id}"),
            album_name: "Album".into(),
            artists: r#"["Martha Argerich"]"#.into(),
            last_played_at,
        }
    }

    #[test]
    fn every_go_query_is_parsed() {
        let mut names: Vec<_> = QUERIES.keys().copied().collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "GetRatingByTrackID",
                "GetRecentPlayCheckpoint",
                "GetTrackByID",
                "GetTrackBySpotifyID",
                "ListAllRatings",
                "ListAllTracks",
                "ListRecentTracks",
                "ListTopPlayedTracks",
                "ListUnratedTracks",
                "UpsertRating",
                "UpsertRecentPlayCheckpoint",
                "UpsertTrack",
            ]
        );
        assert!(QUERIES.values().all(|sql| !sql.contains("sqlc.")));
    }

    #[test]
    fn init_and_query_flow() {
        let db = Db::open_in_memory().unwrap();
        let conn = db.conn();

        assert_eq!(conn.recent_play_checkpoint().unwrap(), None);
        conn.upsert_recent_play_checkpoint(42).unwrap();
        conn.upsert_recent_play_checkpoint(43).unwrap();
        assert_eq!(conn.recent_play_checkpoint().unwrap(), Some(43));

        let first = conn.upsert_track(&track_params("a", 100)).unwrap();
        assert_eq!(first.play_count, 1);
        let again = conn.upsert_track(&UpsertTrackParams { last_played_at: 50, ..track_params("a", 0) }).unwrap();
        assert_eq!(again.id, first.id);
        assert_eq!(again.play_count, 2);
        assert_eq!(again.last_played_at, 100, "last_played_at keeps the max");
        let second = conn.upsert_track(&track_params("b", 200)).unwrap();
        conn.upsert_track(&track_params("b", 300)).unwrap();
        conn.upsert_track(&track_params("b", 300)).unwrap();

        assert_eq!(conn.track_by_id(first.id).unwrap().unwrap().spotify_id, "a");
        assert_eq!(conn.track_by_spotify_id("b").unwrap().unwrap().id, second.id);
        assert!(conn.track_by_id(999).unwrap().is_none());

        let ids = |tracks: Vec<Track>| tracks.iter().map(|t| t.spotify_id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(conn.list_recent_tracks(10).unwrap()), vec!["b", "a"]);
        assert_eq!(ids(conn.list_top_played_tracks(1).unwrap()), vec!["b"]);
        assert_eq!(ids(conn.list_all_tracks().unwrap()), vec!["a", "b"]);

        let rating = conn
            .upsert_rating(&UpsertRatingParams {
                track_id: first.id,
                stars: 4,
                opinion: "Op. 25".into(),
                updated_at: 10,
            })
            .unwrap();
        assert_eq!(rating.stars, 4);
        conn.upsert_rating(&UpsertRatingParams {
            track_id: first.id,
            stars: 5,
            opinion: String::new(),
            updated_at: 11,
        })
        .unwrap();
        assert_eq!(conn.rating_by_track_id(first.id).unwrap().unwrap().stars, 5);
        assert!(conn.rating_by_track_id(second.id).unwrap().is_none());
        assert_eq!(ids(conn.list_unrated_tracks(10).unwrap()), vec!["b"]);
        assert_eq!(conn.list_all_ratings().unwrap().len(), 1);

        let bad = conn.upsert_rating(&UpsertRatingParams {
            track_id: first.id,
            stars: 6,
            opinion: String::new(),
            updated_at: 1,
        });
        assert!(bad.is_err(), "stars CHECK constraint");
    }

    #[test]
    fn open_enables_foreign_keys_and_creates_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("tracker.db");
        let db = Db::open(&path).unwrap();
        let conn = db.conn();
        let enabled: i64 = conn.query_row("PRAGMA foreign_keys", [], |row| row.get(0)).unwrap();
        assert_eq!(enabled, 1);
        let orphan =
            conn.upsert_rating(&UpsertRatingParams { track_id: 404, stars: 3, opinion: String::new(), updated_at: 1 });
        assert!(orphan.is_err(), "rating for a missing track must violate the foreign key");
    }

    #[test]
    fn transactions_work_through_the_guard() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.conn();
        let tx = conn.transaction().unwrap();
        tx.upsert_track(&track_params("a", 1)).unwrap();
        tx.commit().unwrap();
        assert_eq!(conn.list_all_tracks().unwrap().len(), 1);
    }
}
