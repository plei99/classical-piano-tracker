package tui

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/plei99/classical-piano-tracker/internal/db"
	"github.com/plei99/classical-piano-tracker/internal/syncer"
)

func TestUpdateTracksLoadedSelectsFirstTrackWithCachedRating(t *testing.T) {
	t.Parallel()

	model := NewModel(nil, nil, nil)
	msg := tracksLoadedMsg{
		tracks: []db.Track{
			{ID: 3, TrackName: "Track Three", Artists: `["Artist Three"]`, LastPlayedAt: 100},
			{ID: 1, TrackName: "Track One", Artists: `["Artist One"]`, LastPlayedAt: 200},
			{ID: 2, TrackName: "Track Two", Artists: `["Artist Two"]`, LastPlayedAt: 100},
		},
		ratings: map[int64]db.Rating{1: {TrackID: 1, Stars: 4}},
	}

	updated, cmd := model.Update(msg)
	got := updated.(Model)
	if got.loadingTracks {
		t.Fatal("loadingTracks should be false after tracksLoadedMsg")
	}
	if len(got.tracks) != 3 || got.tracks[0].ID != 1 || got.tracks[1].ID != 3 || got.tracks[2].ID != 2 {
		t.Fatalf("tracks should be sorted by recent desc, got %+v", got.tracks)
	}
	if rating := got.selectedRating(); rating == nil || rating.Stars != 4 {
		t.Fatalf("selectedRating() = %+v, want cached 4-star rating", rating)
	}
	if cmd != nil {
		t.Fatal("selecting a loaded track should not need a follow-up DB command")
	}
}

func TestUpdateTracksLoadedPreservesSelectedTrackAcrossReload(t *testing.T) {
	t.Parallel()

	model := Model{
		tracks:        []db.Track{{ID: 7}, {ID: 9}},
		selectedIndex: 1,
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
		t.Fatal("reloading tracks should not need a follow-up DB command")
	}
}

func TestMoveSelectionReadsRatingFromCache(t *testing.T) {
	t.Parallel()

	model := Model{
		width:   120,
		height:  28,
		tracks:  []db.Track{{ID: 1, TrackName: "One", Artists: `["A"]`}, {ID: 2, TrackName: "Two", Artists: `["B"]`}},
		ratings: map[int64]db.Rating{2: {TrackID: 2, Stars: 5, UpdatedAt: 10}},
	}

	updated, cmd := model.Update(textKey("j"))
	got := updated.(Model)
	if cmd != nil {
		t.Fatal("moving the selection should not issue a DB command")
	}
	if !strings.Contains(got.View().Content, "Rating: 5/5") {
		t.Fatalf("View() = %q, want cached rating for track 2", got.View().Content)
	}

	updated, _ = got.Update(textKey("k"))
	got = updated.(Model)
	if !strings.Contains(got.View().Content, "Rating: none") {
		t.Fatalf("View() = %q, want no rating for track 1", got.View().Content)
	}
}

func TestSyncKeyStartsAsyncSync(t *testing.T) {
	t.Parallel()

	model := NewModel(nil, func(context.Context) (syncer.Stats, error) {
		return syncer.Stats{Fetched: 5, Accepted: 2, Inserted: 1, Updated: 1}, nil
	}, nil)
	model.tracks = []db.Track{{ID: 1}}

	updated, cmd := model.Update(textKey("s"))
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
		queries: newTestQueries(t),
		tracks:  []db.Track{{ID: 1}},
		syncing: true,
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
		tracks:  []db.Track{{ID: 1}},
		syncing: true,
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
	}

	updated, _ := model.Update(textKey("o"))
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
	}

	updated, cmd := model.Update(textKey("g"))
	got := updated.(Model)
	if got.selectedIndex != 0 || got.selectedTrack() == nil || got.selectedTrack().ID != 11 {
		t.Fatalf("after g selectedIndex=%d selectedTrack=%+v, want first track", got.selectedIndex, got.selectedTrack())
	}
	if cmd != nil {
		t.Fatal("g should not issue a DB command")
	}

	updated, cmd = got.Update(textKey("G"))
	got = updated.(Model)
	if got.selectedIndex != 2 || got.selectedTrack() == nil || got.selectedTrack().ID != 33 {
		t.Fatalf("after G selectedIndex=%d selectedTrack=%+v, want last track", got.selectedIndex, got.selectedTrack())
	}
	if cmd != nil {
		t.Fatal("G should not issue a DB command")
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
	}

	updated, _ := model.Update(textKey("/"))
	got := updated.(Model)
	if !got.searching {
		t.Fatal("searching should be true after pressing /")
	}

	updated, cmd := got.Update(textKey("yuja"))
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
	if cmd != nil {
		t.Fatal("search should not issue a DB command")
	}

	updated, _ = got.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
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
	}

	updated, cmd := model.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
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
	}

	view := model.View().Content
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
		ratings:       map[int64]db.Rating{9: {TrackID: 9, Stars: 2}},
		sortMode:      sortModeUnratedFirst,
		selectedIndex: 0,
	}

	updated, _ := model.Update(ratingSavedMsg{
		trackID: 4,
		rating:  &db.Rating{TrackID: 4, Stars: 5, UpdatedAt: 10},
	})
	got := updated.(Model)
	if _, ok := got.ratings[4]; !ok {
		t.Fatal("track 4 should be marked as rated after save")
	}
	if got.selectedTrack() == nil || got.selectedTrack().ID != 4 {
		t.Fatalf("selectedTrack() = %+v, want track 4", got.selectedTrack())
	}
	if got.tracks[0].ID != 4 || got.tracks[1].ID != 9 {
		t.Fatalf("tracks after unrated-first resort = %+v, want selected track preserved with deterministic order", got.tracks)
	}
	if _, ok := model.ratings[4]; ok {
		t.Fatal("saving should not mutate the ratings map of the previous model value")
	}
}

func TestEnterStartsRatingEditorWithExistingRating(t *testing.T) {
	t.Parallel()

	model := Model{
		tracks:  []db.Track{{ID: 1, TrackName: "One", Artists: `["A"]`}},
		ratings: map[int64]db.Rating{1: {TrackID: 1, Stars: 4, Opinion: "Warm"}},
	}

	updated, _ := model.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
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

	updated, _ := model.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	got := updated.(Model)
	if !got.editingRating {
		t.Fatal("editor should open")
	}

	updated, _ = got.Update(textKey("5"))
	got = updated.(Model)
	updated, _ = got.Update(textKey("Great"))
	got = updated.(Model)

	updated, cmd := got.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
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
		tracks:       []db.Track{{ID: 9}},
		savingRating: true,
	}

	updated, _ := model.Update(ratingSavedMsg{
		trackID: 9,
		rating:  &db.Rating{TrackID: 9, Stars: 3, Opinion: "Good", UpdatedAt: 10},
	})
	got := updated.(Model)
	if got.savingRating {
		t.Fatal("savingRating should be false after ratingSavedMsg")
	}
	if rating := got.selectedRating(); rating == nil || rating.Stars != 3 {
		t.Fatalf("selectedRating() = %+v, want saved rating", rating)
	}
}

func TestFormatTrackArtists(t *testing.T) {
	t.Parallel()

	got := formatTrackArtists(`["Martha Argerich","Daniil Trifonov"]`)
	if got != "Martha Argerich, Daniil Trifonov" {
		t.Fatalf("formatTrackArtists() = %q", got)
	}
}

func TestFormatTrackArtistsMatchesJSONDecoding(t *testing.T) {
	t.Parallel()

	for _, raw := range []string{
		`["Frédéric Chopin","Víkingur Ólafsson"]`,
		`["Solo"]`,
		`["A",""]`,
		`[""]`,
		`["Quote \"Nickname\" Pianist","B"]`,
		`["Tom \u0026 Jerry"]`,
		`["Spaced", "Out"]`,
		`[]`,
		`not json`,
	} {
		want := raw
		var artists []string
		if err := json.Unmarshal([]byte(raw), &artists); err == nil && len(artists) > 0 {
			want = strings.Join(artists, ", ")
		}
		if got := formatTrackArtists(raw); got != want {
			t.Errorf("formatTrackArtists(%s) = %q, want %q", raw, got, want)
		}
	}
}

func TestRenderErrorState(t *testing.T) {
	t.Parallel()

	model := Model{err: errors.New("boom")}
	view := model.View().Content
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
	}

	view := model.View().Content
	if !strings.Contains(view, "Local track history") {
		t.Fatalf("View() = %q, want main header", view)
	}
	if !strings.Contains(view, "sort: recent") {
		t.Fatalf("View() = %q, want sort indicator", view)
	}
}

// openRatingEditor returns a model with the editor open on a fresh track.
func openRatingEditor(t *testing.T) Model {
	t.Helper()
	model := Model{tracks: []db.Track{{ID: 1, TrackName: "One", Artists: `["A"]`}}}
	updated, _ := model.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	got := updated.(Model)
	if !got.editingRating || got.editingOpinion {
		t.Fatalf("editor should open on the stars field: editing=%v opinion=%v", got.editingRating, got.editingOpinion)
	}
	return got
}

func typeKeys(m Model, keys ...tea.KeyPressMsg) Model {
	for _, key := range keys {
		updated, _ := m.Update(key)
		m = updated.(Model)
	}
	return m
}

func typeText(m Model, text string) Model {
	for _, r := range text {
		m = typeKeys(m, textKey(string(r)))
	}
	return m
}

func TestRatingEditorDigitsInOpinionAfterStars(t *testing.T) {
	t.Parallel()

	got := typeText(openRatingEditor(t), "5")
	if got.draftStars != 5 || !got.editingOpinion {
		t.Fatalf("after 5: stars=%d editingOpinion=%v, want 5 and focus on opinion", got.draftStars, got.editingOpinion)
	}

	got = typeText(got, "Op. 25 No. 1")
	if got.draftOpinion != "Op. 25 No. 1" {
		t.Fatalf("draftOpinion = %q, want digits kept as text", got.draftOpinion)
	}
	if got.draftStars != 5 {
		t.Fatalf("draftStars = %d, digits in the opinion should not change stars", got.draftStars)
	}
}

func TestRatingEditorTextOnStarsFieldStartsOpinion(t *testing.T) {
	t.Parallel()

	got := typeText(openRatingEditor(t), "7th")
	if got.draftStars != 0 || got.draftOpinion != "7th" || !got.editingOpinion {
		t.Fatalf("stars=%d opinion=%q editingOpinion=%v, want unset stars and opinion %q", got.draftStars, got.draftOpinion, got.editingOpinion, "7th")
	}
}

func TestRatingEditorTabSwitchesField(t *testing.T) {
	t.Parallel()

	got := typeText(openRatingEditor(t), "4Lovely")
	got = typeKeys(got, tea.KeyPressMsg{Code: tea.KeyTab, Mod: tea.ModShift})
	if got.editingOpinion {
		t.Fatal("shift+tab should move focus to the stars field")
	}

	got = typeText(got, "2")
	if got.draftStars != 2 || got.draftOpinion != "Lovely" || !got.editingOpinion {
		t.Fatalf("stars=%d opinion=%q editingOpinion=%v, want stars changed and focus back on opinion", got.draftStars, got.draftOpinion, got.editingOpinion)
	}

	got = typeKeys(got, tea.KeyPressMsg{Code: tea.KeyTab})
	if got.editingOpinion {
		t.Fatal("tab should toggle focus back to the stars field")
	}
}

func TestRatingEditorBackspaceEditsFocusedField(t *testing.T) {
	t.Parallel()

	got := typeText(openRatingEditor(t), "3ab")
	got = typeKeys(got, tea.KeyPressMsg{Code: tea.KeyBackspace})
	if got.draftOpinion != "a" || got.draftStars != 3 {
		t.Fatalf("stars=%d opinion=%q, want backspace to delete from the opinion", got.draftStars, got.draftOpinion)
	}

	got = typeKeys(got, tea.KeyPressMsg{Code: tea.KeyTab}, tea.KeyPressMsg{Code: tea.KeyBackspace})
	if got.draftStars != 0 || got.draftOpinion != "a" {
		t.Fatalf("stars=%d opinion=%q, want backspace on the stars field to clear stars only", got.draftStars, got.draftOpinion)
	}
}

func TestViewShowsRatingEditorFocus(t *testing.T) {
	t.Parallel()

	model := Model{
		width:  120,
		height: 28,
		tracks: []db.Track{{ID: 1, TrackName: "One", Artists: `["A"]`}},
	}
	model.startRatingEditor()
	model.draftOpinion = "Op. 10"

	if view := model.View().Content; !strings.Contains(view, "> Stars: not set") || strings.Contains(view, "Op. 10_") {
		t.Fatalf("View() = %q, want focus marker on stars and no opinion cursor", view)
	}

	model = typeText(model, "4")
	if view := model.View().Content; !strings.Contains(view, "> Opinion:") || !strings.Contains(view, "Stars: 4/5") || !strings.Contains(view, "Op. 10_") {
		t.Fatalf("View() = %q, want focus marker and cursor on the opinion", view)
	}
}

func TestViewShowsRatingEditor(t *testing.T) {
	t.Parallel()

	model := Model{
		width:         120,
		height:        28,
		tracks:        []db.Track{{ID: 1, TrackName: "One", Artists: `["A"]`}},
		editingRating: true,
		draftStars:    5,
		draftOpinion:  "Very good",
	}

	view := model.View().Content
	if !strings.Contains(view, "Rating Editor") {
		t.Fatalf("View() = %q, want rating editor", view)
	}
	if !strings.Contains(view, "Stars: 5/5") {
		t.Fatalf("View() = %q, want draft stars", view)
	}
}

func TestViewFitsSmallWindowWithStatusFooter(t *testing.T) {
	t.Parallel()

	model := Model{
		width:  92,
		height: 30,
		tracks: []db.Track{
			{
				ID:           49,
				SpotifyID:    "4WlRUx1NuFSR1Oc7ksBBIm",
				TrackName:    "Transcendental Etudes, S. 139: No. 4, Mazeppa - Live",
				Artists:      `["Franz Liszt","Yunchan Lim"]`,
				AlbumName:    "Live from The Cliburn - Liszt: Transcendental Etudes",
				PlayCount:    1,
				LastPlayedAt: 1780000000000000000,
			},
		},
		statusMessage: "Sync complete. fetched=10 accepted=10 inserted=0 updated=10",
	}

	view := model.View().Content
	if got := lipgloss.Height(view); got > model.height {
		t.Fatalf("View() height = %d, want <= %d", got, model.height)
	}
}

func TestLoadTracksCmdReturnsRatingsByTrackID(t *testing.T) {
	t.Parallel()

	queries := newTestQueries(t)
	ctx := context.Background()
	track, err := queries.UpsertTrack(ctx, db.UpsertTrackParams{
		SpotifyID: "sp-1", TrackName: "One", AlbumName: "Album", Artists: `["A"]`, LastPlayedAt: 100,
	})
	if err != nil {
		t.Fatalf("UpsertTrack() error = %v", err)
	}
	if _, err := queries.UpsertRating(ctx, db.UpsertRatingParams{TrackID: track.ID, Stars: 4, Opinion: "Warm", UpdatedAt: 10}); err != nil {
		t.Fatalf("UpsertRating() error = %v", err)
	}

	msg, ok := Model{queries: queries}.loadTracksCmd()().(tracksLoadedMsg)
	if !ok {
		t.Fatal("loadTracksCmd() should return tracksLoadedMsg")
	}
	if msg.err != nil || len(msg.tracks) != 1 {
		t.Fatalf("unexpected tracksLoadedMsg: %+v", msg)
	}
	if rating := msg.ratings[track.ID]; rating.Stars != 4 || rating.Opinion != "Warm" {
		t.Fatalf("ratings[%d] = %+v, want the saved rating", track.ID, rating)
	}
}

func TestSearchMatchesArtistsAndAlbum(t *testing.T) {
	t.Parallel()

	model := Model{
		allTracks: []db.Track{
			{ID: 1, TrackName: "Etudes", AlbumName: "Ligeti", Artists: `["Yuja Wang"]`, LastPlayedAt: 100},
			{ID: 2, TrackName: "Nocturne", AlbumName: "Chopin: Nocturnes", Artists: `["Frédéric Chopin","Víkingur Ólafsson"]`, LastPlayedAt: 200},
		},
	}
	model.trackText = buildTrackText(model.allTracks)

	for _, query := range []string{"ólafsson", "NOCTURNES", "ligeti"} {
		model.searchQuery = query
		model.refreshTrackList(0)
		if len(model.tracks) != 1 {
			t.Fatalf("query %q matched %d tracks, want 1", query, len(model.tracks))
		}
	}

	model.searchQuery = "wang ligeti"
	model.refreshTrackList(0)
	if len(model.tracks) != 0 {
		t.Fatalf("query spanning two fields matched %+v, want no match", model.tracks)
	}
}

func TestTruncateKeepsUTF8Intact(t *testing.T) {
	t.Parallel()

	got := truncate("Víkingur Ólafsson, Frédéric Chopin", 12)
	if !utf8.ValidString(got) {
		t.Fatalf("truncate() = %q, want valid UTF-8", got)
	}
	if w := lipgloss.Width(got); w != 12 {
		t.Fatalf("truncate() width = %d (%q), want 12", w, got)
	}
	if !strings.HasSuffix(got, "...") {
		t.Fatalf("truncate() = %q, want ellipsis", got)
	}
}

func TestPasteAppendsToSearchAndOpinion(t *testing.T) {
	t.Parallel()

	model := Model{
		searching: true,
		allTracks: []db.Track{
			{ID: 1, TrackName: "Etudes", AlbumName: "Ligeti", Artists: `["Yuja Wang"]`, LastPlayedAt: 100},
			{ID: 2, TrackName: "Images", AlbumName: "Debussy", Artists: `["Seong-Jin Cho"]`, LastPlayedAt: 200},
		},
	}

	updated, _ := model.Update(tea.PasteMsg{Content: "yuja"})
	got := updated.(Model)
	if got.searchQuery != "yuja" || len(got.tracks) != 1 || got.tracks[0].ID != 1 {
		t.Fatalf("after paste searchQuery=%q tracks=%+v, want only the Yuja Wang track", got.searchQuery, got.tracks)
	}

	got.searching = false
	got.editingRating = true
	updated, _ = got.Update(tea.PasteMsg{Content: "Op. 111"})
	got = updated.(Model)
	if got.draftOpinion != "Op. 111" || got.draftStars != 0 || !got.editingOpinion {
		t.Fatalf("draftOpinion=%q stars=%d editingOpinion=%v, want pasted text in the opinion", got.draftOpinion, got.draftStars, got.editingOpinion)
	}
}

func TestViewUsesAltScreen(t *testing.T) {
	t.Parallel()

	if !(Model{loadingTracks: true}).View().AltScreen {
		t.Fatal("View() should request the alternate screen")
	}
}

// textKey builds the key press Bubble Tea v2 reports for typed text.
func textKey(s string) tea.KeyPressMsg {
	code, _ := utf8.DecodeRuneInString(s)
	return tea.KeyPressMsg{Code: code, Text: s}
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
