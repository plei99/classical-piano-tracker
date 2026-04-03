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
	if cmd != nil {
		t.Fatal("rating should not reload when the preserved selection already has known rating state")
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
	if !footerHasNotificationLine(got.footerView(), "Sync complete.") {
		t.Fatalf("footerView() = %q, want sync completion on a separate line", got.footerView())
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
	if !footerHasNotificationLine(got.footerView(), "Error: Sync failed: bad token") {
		t.Fatalf("footerView() = %q, want sync error on a separate line", got.footerView())
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

func TestGoToTopAndBottomKeysMoveSelection(t *testing.T) {
	t.Parallel()

	model := Model{
		tracks: []db.Track{
			{ID: 11},
			{ID: 22},
			{ID: 33},
		},
		selectedIndex: 1,
		ratingKnown:   true,
	}

	updated, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'g'}})
	got := updated.(Model)
	if got.selectedIndex != 0 || got.selectedTrack() == nil || got.selectedTrack().ID != 11 {
		t.Fatalf("after g selectedIndex=%d selectedTrack=%+v, want first track", got.selectedIndex, got.selectedTrack())
	}
	if !got.loadingRating || cmd == nil {
		t.Fatal("g should trigger rating load for the first track")
	}

	got.loadingRating = false
	got.ratingKnown = true
	updated, cmd = got.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'G'}})
	got = updated.(Model)
	if got.selectedIndex != 2 || got.selectedTrack() == nil || got.selectedTrack().ID != 33 {
		t.Fatalf("after G selectedIndex=%d selectedTrack=%+v, want last track", got.selectedIndex, got.selectedTrack())
	}
	if !got.loadingRating || cmd == nil {
		t.Fatal("G should trigger rating load for the last track")
	}
}

func TestSearchFiltersTracksAndEnterExitsSearchMode(t *testing.T) {
	t.Parallel()

	model := Model{
		allTracks: []db.Track{
			{ID: 3, TrackName: "Ballade No. 1", AlbumName: "Chopin", Artists: `["Martha Argerich"]`, LastPlayedAt: 300},
			{ID: 2, TrackName: "Images", AlbumName: "Debussy", Artists: `["Seong-Jin Cho"]`, LastPlayedAt: 200},
			{ID: 1, TrackName: "Etudes", AlbumName: "Ligeti", Artists: `["Yuja Wang"]`, LastPlayedAt: 100},
		},
		tracks: []db.Track{
			{ID: 3, TrackName: "Ballade No. 1", AlbumName: "Chopin", Artists: `["Martha Argerich"]`, LastPlayedAt: 300},
			{ID: 2, TrackName: "Images", AlbumName: "Debussy", Artists: `["Seong-Jin Cho"]`, LastPlayedAt: 200},
			{ID: 1, TrackName: "Etudes", AlbumName: "Ligeti", Artists: `["Yuja Wang"]`, LastPlayedAt: 100},
		},
		ratingKnown: true,
	}

	updated, _ := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'/'}})
	got := updated.(Model)
	if !got.searching {
		t.Fatal("searching should be true after pressing /")
	}

	updated, cmd := got.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("yuja")})
	got = updated.(Model)
	if got.searchQuery != "yuja" {
		t.Fatalf("searchQuery = %q, want yuja", got.searchQuery)
	}
	if len(got.tracks) != 1 || got.tracks[0].ID != 1 {
		t.Fatalf("filtered tracks = %+v, want only Yuja Wang track", got.tracks)
	}
	if got.selectedTrack() == nil || got.selectedTrack().ID != 1 {
		t.Fatalf("selectedTrack() = %+v, want ID 1", got.selectedTrack())
	}
	if cmd == nil {
		t.Fatal("expected rating reload command after search selection changed")
	}

	updated, _ = got.Update(tea.KeyMsg{Type: tea.KeyEnter})
	got = updated.(Model)
	if got.searching {
		t.Fatal("searching should be false after pressing enter")
	}
	if !footerHasNotificationLine(got.footerView(), "Filter /yuja (1/3)") {
		t.Fatalf("footerView() = %q, want active filter summary on a separate line", got.footerView())
	}
}

func TestSearchEscClearsFilterAndRestoresTracks(t *testing.T) {
	t.Parallel()

	model := Model{
		searching:   true,
		searchQuery: "yuja",
		allTracks: []db.Track{
			{ID: 2, TrackName: "Images", AlbumName: "Debussy", Artists: `["Seong-Jin Cho"]`, LastPlayedAt: 200},
			{ID: 1, TrackName: "Etudes", AlbumName: "Ligeti", Artists: `["Yuja Wang"]`, LastPlayedAt: 100},
		},
		tracks: []db.Track{
			{ID: 1, TrackName: "Etudes", AlbumName: "Ligeti", Artists: `["Yuja Wang"]`, LastPlayedAt: 100},
		},
		ratingKnown: true,
	}

	updated, cmd := model.Update(tea.KeyMsg{Type: tea.KeyEsc})
	got := updated.(Model)
	if got.searching {
		t.Fatal("searching should be false after esc")
	}
	if got.searchQuery != "" {
		t.Fatalf("searchQuery = %q, want cleared query", got.searchQuery)
	}
	if len(got.tracks) != 2 {
		t.Fatalf("tracks len = %d, want restored full list", len(got.tracks))
	}
	if cmd != nil {
		t.Fatal("rating should not reload when clearing search preserves the current selection")
	}
}

func TestSearchNoMatchesView(t *testing.T) {
	t.Parallel()

	model := Model{
		width:       100,
		height:      28,
		searchQuery: "zzz",
		allTracks: []db.Track{
			{ID: 1, TrackName: "Etudes", AlbumName: "Ligeti", Artists: `["Yuja Wang"]`, LastPlayedAt: 100},
		},
		ratingKnown: true,
	}

	view := model.View()
	if !strings.Contains(view, "No tracks match /zzz") {
		t.Fatalf("View() = %q, want no-match message", view)
	}
	if !footerHasNotificationLine(view, "Filter /zzz (0/1)") {
		t.Fatalf("View() = %q, want filter count in status line", view)
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
		allTracks: []db.Track{
			{ID: 1, TrackName: "One", Artists: `["A"]`, LastPlayedAt: 100},
			{ID: 2, TrackName: "Two", Artists: `["B"]`, LastPlayedAt: 100},
			{ID: 3, TrackName: "Three", Artists: `["C"]`, LastPlayedAt: 100},
			{ID: 4, TrackName: "Four", Artists: `["D"]`, LastPlayedAt: 100},
			{ID: 5, TrackName: "Five", Artists: `["E"]`, LastPlayedAt: 100},
			{ID: 6, TrackName: "Six", Artists: `["F"]`, LastPlayedAt: 100},
		},
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

func footerHasNotificationLine(rendered string, want string) bool {
	lines := strings.Split(rendered, "\n")
	for idx, line := range lines {
		if strings.Contains(line, want) && idx+1 < len(lines) && strings.Contains(lines[idx+1], "j/k or arrows: move") {
			return true
		}
	}

	return false
}
