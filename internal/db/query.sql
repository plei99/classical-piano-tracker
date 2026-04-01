-- Sync writes use a single UPSERT so replayed tracks increment play_count
-- instead of generating duplicate rows.
-- name: UpsertTrack :one
INSERT INTO tracks (
    spotify_id,
    track_name,
    album_name,
    artists,
    last_played_at
) VALUES (
    sqlc.arg(spotify_id),
    sqlc.arg(track_name),
    sqlc.arg(album_name),
    sqlc.arg(artists),
    sqlc.arg(last_played_at)
)
ON CONFLICT (spotify_id) DO UPDATE SET
    track_name = excluded.track_name,
    album_name = excluded.album_name,
    artists = excluded.artists,
    play_count = tracks.play_count + 1,
    last_played_at = excluded.last_played_at
RETURNING *;

-- name: GetTrackByID :one
SELECT *
FROM tracks
WHERE id = sqlc.arg(id)
LIMIT 1;

-- name: GetTrackBySpotifyID :one
SELECT *
FROM tracks
WHERE spotify_id = sqlc.arg(spotify_id)
LIMIT 1;

-- name: ListRecentTracks :many
SELECT *
FROM tracks
ORDER BY last_played_at DESC, id DESC
LIMIT sqlc.arg(limit);

-- name: ListTopPlayedTracks :many
SELECT *
FROM tracks
ORDER BY play_count DESC, last_played_at DESC, id DESC
LIMIT sqlc.arg(limit);

-- Recommendation and TUI flows need the full local corpus, so these "all"
-- queries remain explicit instead of overloading the paginated list queries.
-- name: ListAllTracks :many
SELECT *
FROM tracks
ORDER BY id ASC;

-- name: ListUnratedTracks :many
SELECT t.*
FROM tracks AS t
LEFT JOIN ratings AS r ON r.track_id = t.id
WHERE r.track_id IS NULL
ORDER BY t.last_played_at DESC, t.id DESC
LIMIT sqlc.arg(limit);

-- name: UpsertRating :one
INSERT INTO ratings (
    track_id,
    stars,
    opinion,
    updated_at
) VALUES (
    sqlc.arg(track_id),
    sqlc.arg(stars),
    sqlc.arg(opinion),
    sqlc.arg(updated_at)
)
ON CONFLICT (track_id) DO UPDATE SET
    stars = excluded.stars,
    opinion = excluded.opinion,
    updated_at = excluded.updated_at
RETURNING *;

-- name: GetRatingByTrackID :one
SELECT *
FROM ratings
WHERE track_id = sqlc.arg(track_id)
LIMIT 1;

-- name: ListAllRatings :many
SELECT *
FROM ratings
ORDER BY updated_at DESC, track_id DESC;
