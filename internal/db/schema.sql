PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY,
    spotify_id TEXT NOT NULL UNIQUE,
    track_name TEXT NOT NULL,
    album_name TEXT NOT NULL,
    artists TEXT NOT NULL,
    play_count INTEGER NOT NULL DEFAULT 1 CHECK (play_count > 0),
    last_played_at INTEGER NOT NULL CHECK (last_played_at > 0),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()) CHECK (created_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_tracks_last_played_at
    ON tracks (last_played_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_tracks_play_count
    ON tracks (play_count DESC, last_played_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS ratings (
    track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    opinion TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL CHECK (updated_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_ratings_updated_at
    ON ratings (updated_at DESC, track_id DESC);
