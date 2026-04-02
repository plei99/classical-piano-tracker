package syncer

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/plei99/classical-piano-tracker/internal/config"
	"github.com/plei99/classical-piano-tracker/internal/db"
	"github.com/plei99/classical-piano-tracker/internal/spotify"
)

// TrackSource fetches recent Spotify plays.
type TrackSource interface {
	RecentTracks(ctx context.Context, limit int) ([]spotify.RecentTrack, error)
}

// TrackStore persists accepted tracks.
type TrackStore interface {
	GetRecentPlayCheckpoint(ctx context.Context) (int64, error)
	UpsertRecentPlayCheckpoint(ctx context.Context, value int64) error
	UpsertTrack(ctx context.Context, arg db.UpsertTrackParams) (db.Track, error)
}

type Decision string

const (
	DecisionAccept Decision = "accept"
	DecisionBlock  Decision = "block"
	DecisionSkip   Decision = "skip"
)

// Stats captures the outcome of a sync run.
type Stats struct {
	Fetched       int
	Blocked       int
	Skipped       int
	Accepted      int
	Inserted      int
	Updated       int
	AlreadySynced int
}

// Decide reports whether a track should be synced based on the config filters.
func Decide(cfg *config.Config, track spotify.RecentTrack) Decision {
	allowlist := stringSet(cfg.PianistsAllowlist)
	blocklist := stringSet(cfg.ArtistsBlocklist)

	allowed := false
	for _, artist := range track.Artists {
		name := normalizeName(artist.Name)
		if name == "" {
			continue
		}

		if _, blocked := blocklist[name]; blocked {
			return DecisionBlock
		}
		if _, ok := allowlist[name]; ok {
			allowed = true
		}
	}

	if allowed {
		return DecisionAccept
	}

	return DecisionSkip
}

// Run fetches recent Spotify plays, filters them, and persists accepted tracks.
func Run(ctx context.Context, cfg *config.Config, source TrackSource, store TrackStore, limit int) (Stats, error) {
	var stats Stats

	tracks, err := source.RecentTracks(ctx, limit)
	if err != nil {
		return stats, err
	}

	stats.Fetched = len(tracks)
	checkpointNS, err := store.GetRecentPlayCheckpoint(ctx)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return stats, fmt.Errorf("load recent play checkpoint: %w", err)
	}

	maxProcessedNS := checkpointNS

	for _, track := range tracks {
		playedAtNS := track.PlayedAt.UnixNano()
		if playedAtNS > maxProcessedNS {
			maxProcessedNS = playedAtNS
		}
		if checkpointNS != 0 && !track.PlayedAt.After(time.Unix(0, checkpointNS)) {
			stats.AlreadySynced++
			continue
		}

		switch Decide(cfg, track) {
		case DecisionBlock:
			stats.Blocked++
			continue
		case DecisionSkip:
			stats.Skipped++
			continue
		}

		artistsJSON, err := encodeArtists(track.ArtistNames())
		if err != nil {
			return stats, fmt.Errorf("encode artists for %q: %w", track.Name, err)
		}

		row, err := store.UpsertTrack(ctx, db.UpsertTrackParams{
			SpotifyID:    track.SpotifyID,
			TrackName:    track.Name,
			AlbumName:    track.AlbumName,
			Artists:      artistsJSON,
			LastPlayedAt: track.PlayedAt.Unix(),
		})
		if err != nil {
			return stats, fmt.Errorf("upsert track %q (%s): %w", track.Name, track.SpotifyID, err)
		}

		stats.Accepted++
		if row.PlayCount == 1 {
			stats.Inserted++
		} else {
			stats.Updated++
		}
	}

	if maxProcessedNS > checkpointNS {
		if err := store.UpsertRecentPlayCheckpoint(ctx, maxProcessedNS); err != nil {
			return stats, fmt.Errorf("persist recent play checkpoint: %w", err)
		}
	}

	return stats, nil
}

// encodeArtists serializes the normalized artist list exactly once at the sync
// boundary so downstream DB queries can treat it as opaque JSON text.
func encodeArtists(artists []string) (string, error) {
	return marshalArtists(artists)
}

func marshalArtists(artists []string) (string, error) {
	data, err := json.Marshal(artists)
	if err != nil {
		return "", err
	}

	return string(data), nil
}

// stringSet normalizes config artist names into a lookup set shared by the
// allowlist and blocklist checks.
func stringSet(items []string) map[string]struct{} {
	result := make(map[string]struct{}, len(items))
	for _, item := range items {
		name := normalizeName(item)
		if name == "" {
			continue
		}
		result[name] = struct{}{}
	}
	return result
}

// normalizeName keeps filtering case-insensitive and resilient to stray spaces.
func normalizeName(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}
