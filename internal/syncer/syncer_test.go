package syncer

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/plei99/classical-piano-tracker/internal/config"
	"github.com/plei99/classical-piano-tracker/internal/db"
	"github.com/plei99/classical-piano-tracker/internal/spotify"
)

func TestDecide(t *testing.T) {
	t.Parallel()

	cfg := &config.Config{
		PianistsAllowlist: []string{"Martha Argerich"},
		ArtistsBlocklist:  []string{"Yiruma"},
	}

	tests := []struct {
		name  string
		track spotify.RecentTrack
		want  Decision
	}{
		{
			name: "accepts allowlisted artist",
			track: spotify.RecentTrack{
				Artists: []spotify.Artist{{Name: "Martha Argerich"}},
			},
			want: DecisionAccept,
		},
		{
			name: "blocks blocklisted artist",
			track: spotify.RecentTrack{
				Artists: []spotify.Artist{{Name: "Yiruma"}, {Name: "Martha Argerich"}},
			},
			want: DecisionBlock,
		},
		{
			name: "skips unknown artist",
			track: spotify.RecentTrack{
				Artists: []spotify.Artist{{Name: "Unknown Pianist"}},
			},
			want: DecisionSkip,
		},
		{
			name: "matches case-insensitively",
			track: spotify.RecentTrack{
				Artists: []spotify.Artist{{Name: "martha argerich"}},
			},
			want: DecisionAccept,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := Decide(cfg, tt.track); got != tt.want {
				t.Fatalf("Decide() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestRun(t *testing.T) {
	t.Parallel()

	cfg := &config.Config{
		PianistsAllowlist: []string{"Martha Argerich", "Daniil Trifonov"},
		ArtistsBlocklist:  []string{"Yiruma"},
	}

	now := time.Date(2026, time.April, 1, 10, 0, 0, 0, time.UTC)
	source := fakeSource{
		tracks: []spotify.RecentTrack{
			{
				SpotifyID: "accepted-new",
				Name:      "Track One",
				AlbumName: "Album One",
				Artists:   []spotify.Artist{{Name: "Martha Argerich"}},
				PlayedAt:  now,
			},
			{
				SpotifyID: "blocked",
				Name:      "Track Two",
				AlbumName: "Album Two",
				Artists:   []spotify.Artist{{Name: "Yiruma"}},
				PlayedAt:  now,
			},
			{
				SpotifyID: "skipped",
				Name:      "Track Three",
				AlbumName: "Album Three",
				Artists:   []spotify.Artist{{Name: "Unknown Artist"}},
				PlayedAt:  now,
			},
			{
				SpotifyID: "accepted-update",
				Name:      "Track Four",
				AlbumName: "Album Four",
				Artists:   []spotify.Artist{{Name: "Daniil Trifonov"}},
				PlayedAt:  now,
			},
		},
	}
	store := &fakeStore{
		checkpoint: 0,
		results: []db.Track{
			{PlayCount: 1},
			{PlayCount: 2},
		},
	}

	stats, err := Run(context.Background(), cfg, source, store, 50)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	if stats.Fetched != 4 || stats.AlreadySynced != 0 || stats.Blocked != 1 || stats.Skipped != 1 || stats.Accepted != 2 || stats.Inserted != 1 || stats.Updated != 1 {
		t.Fatalf("Run() stats = %+v, want fetched=4 already_synced=0 blocked=1 skipped=1 accepted=2 inserted=1 updated=1", stats)
	}
	if len(store.calls) != 2 {
		t.Fatalf("store.UpsertTrack() calls = %d, want 2", len(store.calls))
	}
	if store.calls[0].Artists != `["Martha Argerich"]` {
		t.Fatalf("encoded artists = %q, want JSON array", store.calls[0].Artists)
	}
	if store.checkpoint != now.UnixNano() {
		t.Fatalf("checkpoint = %d, want %d", store.checkpoint, now.UnixNano())
	}
}

func TestRunSkipsAlreadySyncedRecentPlays(t *testing.T) {
	t.Parallel()

	cfg := &config.Config{
		PianistsAllowlist: []string{"Martha Argerich"},
	}

	base := time.Date(2026, time.April, 1, 10, 0, 0, 0, time.UTC)
	source := fakeSource{
		tracks: []spotify.RecentTrack{
			{
				SpotifyID: "older",
				Name:      "Older",
				AlbumName: "Album",
				Artists:   []spotify.Artist{{Name: "Martha Argerich"}},
				PlayedAt:  base,
			},
			{
				SpotifyID: "newer",
				Name:      "Newer",
				AlbumName: "Album",
				Artists:   []spotify.Artist{{Name: "Martha Argerich"}},
				PlayedAt:  base.Add(2 * time.Minute),
			},
		},
	}
	store := &fakeStore{
		checkpoint: base.Add(time.Minute).UnixNano(),
		results: []db.Track{
			{PlayCount: 3},
		},
	}

	stats, err := Run(context.Background(), cfg, source, store, 50)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	if stats.Fetched != 2 || stats.AlreadySynced != 1 || stats.Accepted != 1 || stats.Updated != 1 {
		t.Fatalf("Run() stats = %+v, want fetched=2 already_synced=1 accepted=1 updated=1", stats)
	}
	if len(store.calls) != 1 {
		t.Fatalf("store.UpsertTrack() calls = %d, want 1", len(store.calls))
	}
	if store.calls[0].SpotifyID != "newer" {
		t.Fatalf("synced spotify_id = %q, want newer", store.calls[0].SpotifyID)
	}
	if store.checkpoint != base.Add(2*time.Minute).UnixNano() {
		t.Fatalf("checkpoint = %d, want %d", store.checkpoint, base.Add(2*time.Minute).UnixNano())
	}
}

type fakeSource struct {
	tracks []spotify.RecentTrack
}

func (f fakeSource) RecentTracks(_ context.Context, _ int) ([]spotify.RecentTrack, error) {
	return f.tracks, nil
}

type fakeStore struct {
	checkpoint int64
	results    []db.Track
	calls      []db.UpsertTrackParams
}

func (f *fakeStore) GetRecentPlayCheckpoint(_ context.Context) (int64, error) {
	if f.checkpoint == 0 {
		return 0, sql.ErrNoRows
	}
	return f.checkpoint, nil
}

func (f *fakeStore) UpsertRecentPlayCheckpoint(_ context.Context, value int64) error {
	f.checkpoint = value
	return nil
}

func (f *fakeStore) UpsertTrack(_ context.Context, arg db.UpsertTrackParams) (db.Track, error) {
	f.calls = append(f.calls, arg)
	result := f.results[0]
	f.results = f.results[1:]
	return result, nil
}
