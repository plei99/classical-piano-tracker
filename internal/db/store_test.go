package db

import (
	"context"
	"strings"
	"testing"
)

func TestInitAndQueryFlow(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	path := t.TempDir() + "/tracker.db"

	conn, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer conn.Close()

	if err := Init(ctx, conn); err != nil {
		t.Fatalf("Init() error = %v", err)
	}

	if err := Init(ctx, conn); err != nil {
		t.Fatalf("Init() second call error = %v", err)
	}

	q := New(conn)

	firstTrack, err := q.UpsertTrack(ctx, UpsertTrackParams{
		SpotifyID:    "spotify-track-1",
		TrackName:    "Piano Sonata No. 14",
		AlbumName:    "Beethoven Favorites",
		Artists:      `["Martha Argerich"]`,
		LastPlayedAt: 100,
	})
	if err != nil {
		t.Fatalf("UpsertTrack(first) error = %v", err)
	}

	if firstTrack.PlayCount != 1 {
		t.Fatalf("first track play_count = %d, want 1", firstTrack.PlayCount)
	}

	updatedTrack, err := q.UpsertTrack(ctx, UpsertTrackParams{
		SpotifyID:    "spotify-track-1",
		TrackName:    "Piano Sonata No. 14",
		AlbumName:    "Beethoven Favorites (Remastered)",
		Artists:      `["Martha Argerich"]`,
		LastPlayedAt: 200,
	})
	if err != nil {
		t.Fatalf("UpsertTrack(update) error = %v", err)
	}

	if updatedTrack.ID != firstTrack.ID {
		t.Fatalf("updated track id = %d, want %d", updatedTrack.ID, firstTrack.ID)
	}
	if updatedTrack.PlayCount != 2 {
		t.Fatalf("updated track play_count = %d, want 2", updatedTrack.PlayCount)
	}
	if updatedTrack.LastPlayedAt != 200 {
		t.Fatalf("updated track last_played_at = %d, want 200", updatedTrack.LastPlayedAt)
	}
	if updatedTrack.AlbumName != "Beethoven Favorites (Remastered)" {
		t.Fatalf("updated track album_name = %q, want remastered title", updatedTrack.AlbumName)
	}

	secondTrack, err := q.UpsertTrack(ctx, UpsertTrackParams{
		SpotifyID:    "spotify-track-2",
		TrackName:    "Piano Concerto No. 2",
		AlbumName:    "Rachmaninoff",
		Artists:      `["Daniil Trifonov"]`,
		LastPlayedAt: 150,
	})
	if err != nil {
		t.Fatalf("UpsertTrack(second) error = %v", err)
	}

	byID, err := q.GetTrackByID(ctx, firstTrack.ID)
	if err != nil {
		t.Fatalf("GetTrackByID() error = %v", err)
	}
	if byID.SpotifyID != "spotify-track-1" {
		t.Fatalf("GetTrackByID() spotify_id = %q, want spotify-track-1", byID.SpotifyID)
	}

	bySpotifyID, err := q.GetTrackBySpotifyID(ctx, "spotify-track-2")
	if err != nil {
		t.Fatalf("GetTrackBySpotifyID() error = %v", err)
	}
	if bySpotifyID.ID != secondTrack.ID {
		t.Fatalf("GetTrackBySpotifyID() id = %d, want %d", bySpotifyID.ID, secondTrack.ID)
	}

	recentTracks, err := q.ListRecentTracks(ctx, 10)
	if err != nil {
		t.Fatalf("ListRecentTracks() error = %v", err)
	}
	if len(recentTracks) != 2 {
		t.Fatalf("ListRecentTracks() len = %d, want 2", len(recentTracks))
	}
	if recentTracks[0].SpotifyID != "spotify-track-1" {
		t.Fatalf("ListRecentTracks()[0] = %q, want spotify-track-1", recentTracks[0].SpotifyID)
	}

	topPlayedTracks, err := q.ListTopPlayedTracks(ctx, 10)
	if err != nil {
		t.Fatalf("ListTopPlayedTracks() error = %v", err)
	}
	if len(topPlayedTracks) != 2 {
		t.Fatalf("ListTopPlayedTracks() len = %d, want 2", len(topPlayedTracks))
	}
	if topPlayedTracks[0].PlayCount != 2 {
		t.Fatalf("ListTopPlayedTracks()[0].play_count = %d, want 2", topPlayedTracks[0].PlayCount)
	}

	unratedTracks, err := q.ListUnratedTracks(ctx, 10)
	if err != nil {
		t.Fatalf("ListUnratedTracks() error = %v", err)
	}
	if len(unratedTracks) != 2 {
		t.Fatalf("ListUnratedTracks() len = %d, want 2", len(unratedTracks))
	}

	rating, err := q.UpsertRating(ctx, UpsertRatingParams{
		TrackID:   firstTrack.ID,
		Stars:     5,
		Opinion:   "A benchmark recording.",
		UpdatedAt: 300,
	})
	if err != nil {
		t.Fatalf("UpsertRating() error = %v", err)
	}
	if rating.Stars != 5 {
		t.Fatalf("UpsertRating() stars = %d, want 5", rating.Stars)
	}

	storedRating, err := q.GetRatingByTrackID(ctx, firstTrack.ID)
	if err != nil {
		t.Fatalf("GetRatingByTrackID() error = %v", err)
	}
	if storedRating.Opinion != "A benchmark recording." {
		t.Fatalf("GetRatingByTrackID() opinion = %q, want benchmark opinion", storedRating.Opinion)
	}

	unratedAfterRating, err := q.ListUnratedTracks(ctx, 10)
	if err != nil {
		t.Fatalf("ListUnratedTracks() after rating error = %v", err)
	}
	if len(unratedAfterRating) != 1 {
		t.Fatalf("ListUnratedTracks() after rating len = %d, want 1", len(unratedAfterRating))
	}
	if unratedAfterRating[0].ID != secondTrack.ID {
		t.Fatalf("remaining unrated track id = %d, want %d", unratedAfterRating[0].ID, secondTrack.ID)
	}
}

func TestOpenEnablesForeignKeys(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	path := t.TempDir() + "/tracker.db"

	conn, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer conn.Close()

	if err := Init(ctx, conn); err != nil {
		t.Fatalf("Init() error = %v", err)
	}

	q := New(conn)

	_, err = q.UpsertRating(ctx, UpsertRatingParams{
		TrackID:   999,
		Stars:     4,
		Opinion:   "Missing parent track.",
		UpdatedAt: 123,
	})
	if err == nil {
		t.Fatal("UpsertRating() error = nil, want foreign key failure")
	}

	if !strings.Contains(strings.ToLower(err.Error()), "foreign key") {
		t.Fatalf("UpsertRating() error = %q, want foreign key failure", err)
	}
}
