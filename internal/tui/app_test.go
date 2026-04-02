package tui

import (
	"context"
	"errors"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/plei99/classical-piano-tracker/internal/db"
	"github.com/plei99/classical-piano-tracker/internal/syncer"
)

func TestUpdateTracksLoadedTriggersRatingLoad(t *testing.T) {
	t.Parallel()

	model := NewModel(nil, nil, nil)
	msg := tracksLoadedMsg{
		tracks: []db.Track{
			{ID: 3, TrackName: "Track Three", Artists: `["Artist Three"]`, LastPlayedAt: 100},
			{ID: 1, TrackName: "Track One", Artists: `["Artist One"]`, LastPlayedAt: 200},
			{ID: 2, TrackName: "Track Two", Artists: `["Artist Two"]`, LastPlayedAt: 100},
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
	if len(got.tracks) != 3 || got.tracks[0].ID != 1 || got.tracks[1].ID != 3 || got.tracks[2].ID != 2 {
		t.Fatalf("tracks should be sorted by recent desc, got %+v", got.tracks)
	}
	if cmd == nil {
		t.Fatal("expected rating load command")
	}
}

func TestUpdateTracksLoadedPreservesSelectedTrackAcrossReload(t *testing.T) {
	t.Parallel()

	model := Model{
		tracks:         []db.Track{{ID: 7}, {ID: 9}},
		selectedIndex:  1,
		selectedRating: &db.Rating{TrackID: 9, Stars: 4},
		ratingKnown:    true,
	}

	updated, cmd := model.Update(tracksLoadedMsg{
		tracks: []db.Track{
			{ID: 5, TrackName: "Five", Artists: `["Artist Five"]`, LastPlayedAt: 300},
			{ID: 9, TrackName: "Nine", Artists: `["Artist Nine"]`, LastPlayedAt: 200},
			{ID: 7, TrackName: "Seven", Artists: `["Artist Seven"]`, LastPlayedAt: 100},
		},
	})
	got := updated.(Model)
	if got.selectedTrack() == nil || got.selectedTrack().ID != 9 {
		t.Fatalf("selected track after reload = %+v, want track 9", got.selectedTrack())
	}
	if cmd == nil {
		t.Fatal("expected rating load command for preserved selection")
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

func TestSyncKeyStartsAsyncSync(t *testing.T) {
	t.Parallel()

	model := NewModel(nil, func(context.Context) (syncer.Stats, error) {
		return syncer.Stats{Fetched: 5, Accepted: 2, Inserted: 1, Updated: 1}, nil
	}, nil)
	model.tracks = []db.Track{{ID: 1}}
	model.ratingKnown = true

	updated, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'s'}})
	got := updated.(Model)
	if !got.syncing {
		t.Fatal("syncing should be true after pressing s")
	}
	if cmd == nil {
		t.Fatal("expected sync command")
	}

	msg, ok := cmd().(syncFinishedMsg)
	if !ok {
		t.Fatalf("sync command returned %T, want syncFinishedMsg", msg)
	}
	if msg.stats.Fetched != 5 || msg.err != nil {
		t.Fatalf("unexpected syncFinishedMsg: %+v", msg)
	}
}

func TestSyncFinishedReloadsTracks(t *testing.T) {
	t.Parallel()

	model := Model{
		queries:     newTestQueries(t),
		tracks:      []db.Track{{ID: 1}},
		syncing:     true,
		ratingKnown: true,
	}

	updated, cmd := model.Update(syncFinishedMsg{
		stats: syncer.Stats{Fetched: 5, Accepted: 2, Inserted: 1, Updated: 1},
	})
	got := updated.(Model)
	if got.syncing {
		t.Fatal("syncing should be false after syncFinishedMsg")
	}
	if !got.loadingTracks {
		t.Fatal("loadingTracks should be true while refreshing after sync")
	}
	if !strings.Contains(got.statusLine(), "Sync complete.") {
		t.Fatalf("statusLine() = %q, want sync completion", got.statusLine())
	}
	if cmd == nil {
		t.Fatal("expected track reload command after successful sync")
	}
}

func TestSyncFinishedErrorSetsStatus(t *testing.T) {
	t.Parallel()

	model := Model{
		tracks:      []db.Track{{ID: 1}},
		syncing:     true,
		ratingKnown: true,
	}

	updated, _ := model.Update(syncFinishedMsg{err: errors.New("bad token")})
	got := updated.(Model)
	if got.syncing {
		t.Fatal("syncing should be false after a failed sync")
	}
	if !got.statusIsError {
		t.Fatal("status should be marked as error after failed sync")
	}
	if !strings.Contains(got.statusLine(), "Sync failed: bad token") {
		t.Fatalf("statusLine() = %q, want sync error text", got.statusLine())
	}
}

func TestSortKeyCyclesOrderAndPreservesSelectedTrack(t *testing.T) {
	t.Parallel()

	model := Model{
		tracks: []db.Track{
			{ID: 10, LastPlayedAt: 300, PlayCount: 2},
			{ID: 7, LastPlayedAt: 200, PlayCount: 8},
			{ID: 4, LastPlayedAt: 100, PlayCount: 1},
		},
		sortMode:      sortModeRecentDesc,
		selectedIndex: 1,
		ratingKnown:   true,
	}

	updated, _ := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'o'}})
	got := updated.(Model)
	if got.sortMode != sortModeIDAsc {
		t.Fatalf("sortMode = %v, want sortModeIDAsc", got.sortMode)
	}
	if got.selectedTrack() == nil || got.selectedTrack().ID != 7 {
		t.Fatalf("selectedTrack() = %+v, want ID 7", got.selectedTrack())
	}
	if got.tracks[0].ID != 4 || got.tracks[1].ID != 7 || got.tracks[2].ID != 10 {
		t.Fatalf("tracks after ID sort = %+v, want IDs 4,7,10", got.tracks)
	}
}

func TestRatingSavedResortsUnratedFirst(t *testing.T) {
	t.Parallel()

	model := Model{
		tracks: []db.Track{
			{ID: 4, LastPlayedAt: 300},
			{ID: 9, LastPlayedAt: 200},
		},
		ratedTrackIDs:  map[int64]struct{}{9: {}},
		sortMode:       sortModeUnratedFirst,
		selectedIndex:  0,
		ratingKnown:    true,
		selectedRating: nil,
	}

	updated, _ := model.Update(ratingSavedMsg{
		trackID: 4,
		rating:  &db.Rating{TrackID: 4, Stars: 5, UpdatedAt: 10},
	})
	got := updated.(Model)
	if _, ok := got.ratedTrackIDs[4]; !ok {
		t.Fatal("track 4 should be marked as rated after save")
	}
	if got.selectedTrack() == nil || got.selectedTrack().ID != 4 {
		t.Fatalf("selectedTrack() = %+v, want track 4", got.selectedTrack())
	}
	if got.tracks[0].ID != 4 || got.tracks[1].ID != 9 {
		t.Fatalf("tracks after unrated-first resort = %+v, want selected track preserved with deterministic order", got.tracks)
	}
}

func TestEnterStartsRatingEditorWithExistingRating(t *testing.T) {
	t.Parallel()

	model := Model{
		tracks:         []db.Track{{ID: 1, TrackName: "One", Artists: `["A"]`}},
		selectedRating: &db.Rating{TrackID: 1, Stars: 4, Opinion: "Warm"},
		ratingKnown:    true,
	}

	updated, _ := model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	got := updated.(Model)
	if !got.editingRating {
		t.Fatal("editingRating should be true after pressing enter")
	}
	if got.draftStars != 4 || got.draftOpinion != "Warm" {
		t.Fatalf("unexpected rating draft: stars=%d opinion=%q", got.draftStars, got.draftOpinion)
	}
}

func TestRatingEditorHandlesInputAndSave(t *testing.T) {
	t.Parallel()

	model := NewModel(nil, nil, func(_ context.Context, arg db.UpsertRatingParams) (db.Rating, error) {
		return db.Rating{
			TrackID:   arg.TrackID,
			Stars:     arg.Stars,
			Opinion:   arg.Opinion,
			UpdatedAt: arg.UpdatedAt,
		}, nil
	})
	model.tracks = []db.Track{{ID: 7, TrackName: "One", Artists: `["A"]`}}
	model.ratingKnown = true

	updated, _ := model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	got := updated.(Model)
	if !got.editingRating {
		t.Fatal("editor should open")
	}

	updated, _ = got.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'5'}})
	got = updated.(Model)
	updated, _ = got.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("Great")})
	got = updated.(Model)

	updated, cmd := got.Update(tea.KeyMsg{Type: tea.KeyEnter})
	got = updated.(Model)
	if got.editingRating {
		t.Fatal("editor should close when save starts")
	}
	if !got.savingRating {
		t.Fatal("savingRating should be true while save command is in flight")
	}
	if cmd == nil {
		t.Fatal("expected save command")
	}

	msg, ok := cmd().(ratingSavedMsg)
	if !ok {
		t.Fatalf("save command returned %T, want ratingSavedMsg", msg)
	}
	if msg.trackID != 7 || msg.rating == nil || msg.rating.Stars != 5 || msg.rating.Opinion != "Great" {
		t.Fatalf("unexpected ratingSavedMsg: %+v", msg)
	}
}

func TestRatingSavedUpdatesSelection(t *testing.T) {
	t.Parallel()

	model := Model{
		tracks:         []db.Track{{ID: 9}},
		savingRating:   true,
		ratingKnown:    false,
		selectedRating: nil,
	}

	updated, _ := model.Update(ratingSavedMsg{
		trackID: 9,
		rating:  &db.Rating{TrackID: 9, Stars: 3, Opinion: "Good", UpdatedAt: 10},
	})
	got := updated.(Model)
	if got.savingRating {
		t.Fatal("savingRating should be false after ratingSavedMsg")
	}
	if got.selectedRating == nil || got.selectedRating.Stars != 3 {
		t.Fatalf("selectedRating = %+v, want saved rating", got.selectedRating)
	}
	if !got.ratingKnown {
		t.Fatal("ratingKnown should be true after a successful save")
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

func TestLayoutUsesVerticalModeForNarrowWindows(t *testing.T) {
	t.Parallel()

	model := Model{width: 70, height: 24}
	layout := model.layout()
	if !layout.vertical {
		t.Fatal("layout() should use vertical mode for narrow widths")
	}
	if layout.listWidth != layout.detailWidth {
		t.Fatal("vertical layout should use the same pane width")
	}
}

func TestLayoutUsesHorizontalModeForWideWindows(t *testing.T) {
	t.Parallel()

	model := Model{width: 140, height: 30}
	layout := model.layout()
	if layout.vertical {
		t.Fatal("layout() should use horizontal mode for wide widths")
	}
	if layout.listHeight != layout.detailHeight {
		t.Fatal("horizontal layout should use the full height for both panes")
	}
}

func TestVisibleTracksCentersSelection(t *testing.T) {
	t.Parallel()

	model := Model{
		tracks:        make([]db.Track, 12),
		selectedIndex: 6,
	}

	visible, offset, hiddenAbove, hiddenBelow := model.visibleTracks(11)
	if len(visible) == 0 {
		t.Fatal("visibleTracks() should return visible rows")
	}
	if offset == 0 {
		t.Fatal("visibleTracks() should scroll when selection is in the middle")
	}
	if !hiddenAbove || !hiddenBelow {
		t.Fatal("visibleTracks() should report hidden rows above and below")
	}
}

func TestViewIncludesScrollableHint(t *testing.T) {
	t.Parallel()

	model := Model{
		width:  80,
		height: 16,
		tracks: []db.Track{
			{ID: 1, TrackName: "One", Artists: `["A"]`, LastPlayedAt: 100},
			{ID: 2, TrackName: "Two", Artists: `["B"]`, LastPlayedAt: 100},
			{ID: 3, TrackName: "Three", Artists: `["C"]`, LastPlayedAt: 100},
			{ID: 4, TrackName: "Four", Artists: `["D"]`, LastPlayedAt: 100},
			{ID: 5, TrackName: "Five", Artists: `["E"]`, LastPlayedAt: 100},
			{ID: 6, TrackName: "Six", Artists: `["F"]`, LastPlayedAt: 100},
		},
		ratingKnown: true,
	}

	view := model.View()
	if !strings.Contains(view, "Local track history") {
		t.Fatalf("View() = %q, want main header", view)
	}
	if !strings.Contains(view, "sort: recent") {
		t.Fatalf("View() = %q, want sort indicator", view)
	}
}

func TestViewShowsRatingEditor(t *testing.T) {
	t.Parallel()

	model := Model{
		width:         120,
		height:        28,
		tracks:        []db.Track{{ID: 1, TrackName: "One", Artists: `["A"]`}},
		ratingKnown:   true,
		editingRating: true,
		draftStars:    5,
		draftOpinion:  "Very good",
	}

	view := model.View()
	if !strings.Contains(view, "Rating Editor") {
		t.Fatalf("View() = %q, want rating editor", view)
	}
	if !strings.Contains(view, "Stars: 5/5") {
		t.Fatalf("View() = %q, want draft stars", view)
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

func newTestQueries(t *testing.T) *db.Queries {
	t.Helper()

	path := t.TempDir() + "/tracker.db"
	conn, err := db.Open(path)
	if err != nil {
		t.Fatalf("db.Open() error = %v", err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
	})

	if err := db.Init(context.Background(), conn); err != nil {
		t.Fatalf("db.Init() error = %v", err)
	}

	return db.New(conn)
}

var _ tea.Model = Model{}
