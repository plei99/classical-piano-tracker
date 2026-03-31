package tui

import (
	"context"
	"errors"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/plei99/classical-piano-tracker/internal/db"
)

func TestUpdateTracksLoadedTriggersRatingLoad(t *testing.T) {
	t.Parallel()

	model := NewModel(nil)
	msg := tracksLoadedMsg{
		tracks: []db.Track{
			{ID: 1, TrackName: "Track One", Artists: `["Artist One"]`, LastPlayedAt: 100},
		},
	}

	updated, cmd := model.Update(msg)
	got := updated.(Model)
	if got.loadingTracks {
		t.Fatal("loadingTracks should be false after tracksLoadedMsg")
	}
	if !got.loadingRating {
		t.Fatal("loadingRating should be true after selecting the first track")
	}
	if cmd == nil {
		t.Fatal("expected rating load command")
	}
}

func TestUpdateRatingLoadedIgnoresStaleTrack(t *testing.T) {
	t.Parallel()

	model := Model{
		tracks: []db.Track{{ID: 2}},
	}

	updated, _ := model.Update(ratingLoadedMsg{
		trackID: 1,
		rating:  &db.Rating{TrackID: 1, Stars: 5},
	})
	got := updated.(Model)
	if got.selectedRating != nil {
		t.Fatal("stale rating should be ignored")
	}
}

func TestUpdateRatingLoadedHandlesNoRows(t *testing.T) {
	t.Parallel()

	model := Model{
		tracks:        []db.Track{{ID: 2}},
		loadingRating: true,
	}

	updated, _ := model.Update(ratingLoadedMsg{trackID: 2, rating: nil})
	got := updated.(Model)
	if got.loadingRating {
		t.Fatal("loadingRating should be false after ratingLoadedMsg")
	}
	if !got.ratingKnown {
		t.Fatal("ratingKnown should be true when nil rating is returned")
	}
}

func TestFormatTrackArtists(t *testing.T) {
	t.Parallel()

	got := formatTrackArtists(`["Martha Argerich","Daniil Trifonov"]`)
	if got != "Martha Argerich, Daniil Trifonov" {
		t.Fatalf("formatTrackArtists() = %q", got)
	}
}

func TestRenderErrorState(t *testing.T) {
	t.Parallel()

	model := Model{err: errors.New("boom")}
	view := model.View()
	if !strings.Contains(view, "Error: boom") {
		t.Fatalf("View() = %q, want error text", view)
	}
}

func TestLoadRatingCmdNoRows(t *testing.T) {
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

	model := Model{
		queries: db.New(conn),
	}

	msg := model.loadRatingCmd(7)()
	ratingMsg, ok := msg.(ratingLoadedMsg)
	if !ok {
		t.Fatalf("loadRatingCmd() returned %T, want ratingLoadedMsg", msg)
	}
	if ratingMsg.trackID != 7 || ratingMsg.rating != nil || ratingMsg.err != nil {
		t.Fatalf("unexpected ratingLoadedMsg: %+v", ratingMsg)
	}
}

var _ tea.Model = Model{}
