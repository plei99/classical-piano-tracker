package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/plei99/classical-piano-tracker/internal/db"
)

func TestValidateRateInput(t *testing.T) {
	t.Parallel()

	if err := validateStrictRateInput(1, "", 5); err != nil {
		t.Fatalf("validateStrictRateInput() error = %v, want nil", err)
	}

	tests := []struct {
		name string
		err  error
	}{
		{
			name: "conflicting identifiers",
			err:  validateStrictRateInput(1, "spotify-id", 5),
		},
		{
			name: "stars too low",
			err:  validateStrictRateInput(0, "", 0),
		},
		{
			name: "missing identifiers",
			err:  validateStrictRateInput(0, "", 5),
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if tt.err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestPromptRating(t *testing.T) {
	t.Parallel()

	var out bytes.Buffer
	stars, opinion, err := promptRating(strings.NewReader("0\n4\nExcellent\n"), &out)
	if err != nil {
		t.Fatalf("promptRating() error = %v", err)
	}
	if stars != 4 {
		t.Fatalf("promptRating() stars = %d, want 4", stars)
	}
	if opinion != "Excellent" {
		t.Fatalf("promptRating() opinion = %q, want Excellent", opinion)
	}
	if !strings.Contains(out.String(), "invalid rating") {
		t.Fatalf("promptRating() output = %q, want invalid rating prompt", out.String())
	}
}

func TestPromptTrackSelection(t *testing.T) {
	t.Parallel()

	candidates := []db.Track{
		{ID: 1, TrackName: "Track One", Artists: `["Artist One"]`, LastPlayedAt: time.Now().Unix()},
		{ID: 2, TrackName: "Track Two", Artists: `["Artist Two"]`, LastPlayedAt: time.Now().Unix()},
	}

	var out bytes.Buffer
	got, err := promptTrackSelection(strings.NewReader("x\n2\n"), &out, candidates)
	if err != nil {
		t.Fatalf("promptTrackSelection() error = %v", err)
	}
	if got.ID != 2 {
		t.Fatalf("promptTrackSelection() id = %d, want 2", got.ID)
	}
	if !strings.Contains(out.String(), "invalid choice") {
		t.Fatalf("promptTrackSelection() output = %q, want invalid choice prompt", out.String())
	}
}

func TestChooseTrackForRatingSingleCandidate(t *testing.T) {
	t.Parallel()

	path := t.TempDir() + "/tracker.db"
	conn, err := db.Open(path)
	if err != nil {
		t.Fatalf("db.Open() error = %v", err)
	}
	defer conn.Close()

	if err := db.Init(context.Background(), conn); err != nil {
		t.Fatalf("db.Init() error = %v", err)
	}

	queries := db.New(conn)
	track, err := queries.UpsertTrack(context.Background(), db.UpsertTrackParams{
		SpotifyID:    "spotify-track-1",
		TrackName:    "Track One",
		AlbumName:    "Album One",
		Artists:      `["Artist One"]`,
		LastPlayedAt: 100,
	})
	if err != nil {
		t.Fatalf("UpsertTrack() error = %v", err)
	}

	var out bytes.Buffer
	got, err := chooseTrackForRating(context.Background(), queries, strings.NewReader(""), &out, false, 10)
	if err != nil {
		t.Fatalf("chooseTrackForRating() error = %v", err)
	}
	if got.ID != track.ID {
		t.Fatalf("chooseTrackForRating() id = %d, want %d", got.ID, track.ID)
	}
}

func TestFormatTrackArtists(t *testing.T) {
	t.Parallel()

	track := db.Track{Artists: `["Martha Argerich","Daniil Trifonov"]`}
	got := formatTrackArtists(track)
	if got != "Martha Argerich, Daniil Trifonov" {
		t.Fatalf("formatTrackArtists() = %q", got)
	}
}
