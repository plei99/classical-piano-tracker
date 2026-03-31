package syncer

import (
	"context"
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
		results: []db.Track{
			{PlayCount: 1},
			{PlayCount: 2},
		},
	}

	stats, err := Run(context.Background(), cfg, source, store, 50)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	if stats.Fetched != 4 || stats.Blocked != 1 || stats.Skipped != 1 || stats.Accepted != 2 || stats.Inserted != 1 || stats.Updated != 1 {
		t.Fatalf("Run() stats = %+v, want fetched=4 blocked=1 skipped=1 accepted=2 inserted=1 updated=1", stats)
	}
	if len(store.calls) != 2 {
		t.Fatalf("store.UpsertTrack() calls = %d, want 2", len(store.calls))
	}
	if store.calls[0].Artists != `["Martha Argerich"]` {
		t.Fatalf("encoded artists = %q, want JSON array", store.calls[0].Artists)
	}
}

type fakeSource struct {
	tracks []spotify.RecentTrack
}

func (f fakeSource) RecentTracks(_ context.Context, _ int) ([]spotify.RecentTrack, error) {
	return f.tracks, nil
}

type fakeStore struct {
	results []db.Track
	calls   []db.UpsertTrackParams
}

func (f *fakeStore) UpsertTrack(_ context.Context, arg db.UpsertTrackParams) (db.Track, error) {
	f.calls = append(f.calls, arg)
	result := f.results[0]
	f.results = f.results[1:]
	return result, nil
}
