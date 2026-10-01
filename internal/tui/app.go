package tui

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/plei99/classical-piano-tracker/internal/db"
	"github.com/plei99/classical-piano-tracker/internal/syncer"
)

const (
	minPaneContentHeight   = 8
	verticalLayoutWidthCut = 90
	// appPadding is the blank margin around the whole frame, in cells.
	appPadding = 1
)

var (
	titleStyle = lipgloss.NewStyle().
			Bold(true)

	mutedStyle = lipgloss.NewStyle().
			Faint(true)

	highlightStyle = lipgloss.NewStyle().
			Bold(true)

	selectedRowStyle = lipgloss.NewStyle().
				Reverse(true).
				Padding(0, 1)

	listPaneStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			Padding(1)

	detailPaneStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			Padding(1)

	statusBarStyle = lipgloss.NewStyle().
			Faint(true)

	errorStyle = lipgloss.NewStyle().
			Bold(true)
)

type SyncFunc func(context.Context) (syncer.Stats, error)

type SaveRatingFunc func(context.Context, db.UpsertRatingParams) (db.Rating, error)

type sortMode int

const (
	sortModeRecentDesc sortMode = iota
	sortModeIDAsc
	sortModeTopPlayed
	sortModeUnratedFirst
)

var sortModeCycle = []sortMode{
	sortModeRecentDesc,
	sortModeIDAsc,
	sortModeTopPlayed,
	sortModeUnratedFirst,
}

// Model is the root Bubble Tea model for the tracker TUI.
type Model struct {
	queries       *db.Queries
	runSync       SyncFunc
	saveRating    SaveRatingFunc
	width         int
	height        int
	loadingTracks bool
	syncing       bool
	savingRating  bool
	searching     bool
	searchQuery   string
	allTracks     []db.Track
	tracks        []db.Track
	// ratings is loaded alongside the tracks so moving the selection is a map
	// lookup rather than a DB round trip per keypress.
	ratings map[int64]db.Rating
	// trackText caches strings derived from each track's artists JSON so
	// rendering and search never re-decode it per frame or per keystroke.
	trackText map[int64]trackText
	sortMode  sortMode
	// allTracks is already ordered by sortedBy when sorted is true, letting
	// search keystrokes skip a full re-sort.
	sortedBy      sortMode
	sorted        bool
	selectedIndex int
	editingRating bool
	// editingOpinion moves focus from the stars field to the opinion, where
	// digits are ordinary text instead of star ratings.
	editingOpinion bool
	draftStars     int
	draftOpinion   string
	statusMessage  string
	statusIsError  bool
	err            error
}

type trackText struct {
	artists string // display label, e.g. "Frédéric Chopin, Krystian Zimerman"
	search  string // lowercased name, artists, and album for substring search
}

type tracksLoadedMsg struct {
	tracks    []db.Track
	ratings   map[int64]db.Rating
	trackText map[int64]trackText
	err       error
}

type syncFinishedMsg struct {
	stats syncer.Stats
	err   error
}

type ratingSavedMsg struct {
	trackID int64
	rating  *db.Rating
	err     error
}

// NewModel constructs the root TUI model.
func NewModel(queries *db.Queries, runSync SyncFunc, saveRating SaveRatingFunc) Model {
	return Model{
		queries:       queries,
		runSync:       runSync,
		saveRating:    saveRating,
		loadingTracks: true,
	}
}

// Init starts the Bubble Tea program with an asynchronous DB read.
func (m Model) Init() tea.Cmd {
	return m.loadTracksCmd()
}

// Update handles messages for the root TUI model.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil
	case tracksLoadedMsg:
		m.loadingTracks = false
		if msg.err != nil {
			m.err = msg.err
			return m, nil
		}

		var selectedTrackID int64
		if track := m.selectedTrack(); track != nil {
			selectedTrackID = track.ID
		}

		m.err = nil
		m.allTracks = msg.tracks
		m.ratings = msg.ratings
		m.trackText = msg.trackText
		m.sorted = false
		m.refreshTrackList(selectedTrackID)
		return m, nil
	case syncFinishedMsg:
		m.syncing = false
		if msg.err != nil {
			m.setStatus("Sync failed: "+msg.err.Error(), true)
			return m, nil
		}

		m.setStatus(
			fmt.Sprintf(
				"Sync complete. fetched=%d accepted=%d inserted=%d updated=%d",
				msg.stats.Fetched,
				msg.stats.Accepted,
				msg.stats.Inserted,
				msg.stats.Updated,
			),
			false,
		)
		m.loadingTracks = true
		return m, m.loadTracksCmd()
	case ratingSavedMsg:
		m.savingRating = false
		if msg.err != nil {
			m.setStatus("Save failed: "+msg.err.Error(), true)
			return m, nil
		}
		if msg.rating != nil {
			// Copy before writing: Bubble Tea may still hold the previous
			// Model value, which shares this map.
			ratings := make(map[int64]db.Rating, len(m.ratings)+1)
			for id, rating := range m.ratings {
				ratings[id] = rating
			}
			ratings[msg.trackID] = *msg.rating
			m.ratings = ratings
			if m.sortMode == sortModeUnratedFirst {
				m.sorted = false
				m.refreshTrackList(msg.trackID)
			}
		}
		m.setStatus(fmt.Sprintf("Saved %d/5 rating for track %d", msg.rating.Stars, msg.trackID), false)
		return m, nil
	case tea.KeyPressMsg:
		if m.editingRating {
			return m.handleRatingEditorKey(msg)
		}
		if m.searching {
			return m.handleSearchKey(msg)
		}
		return m.handleBrowsingKey(msg)
	case tea.PasteMsg:
		// Bubble Tea v2 delivers bracketed paste separately from key presses.
		if m.editingRating {
			m.draftOpinion += msg.Content
			m.editingOpinion = true
			return m, nil
		}
		if m.searching {
			m.searchQuery += msg.Content
			m.clearStatus()
			m.refreshTrackList(m.selectedTrackID())
		}
		return m, nil
	}

	return m, nil
}

// View renders the TUI in the alternate screen.
func (m Model) View() tea.View {
	view := tea.NewView(m.render())
	view.AltScreen = true
	return view
}

// render draws a track browser with recent tracks, details, sync, and rating actions.
func (m Model) render() string {
	if m.loadingTracks {
		return padFrame(titleStyle.Render("Classical Piano Tracker") + "\n\nLoading local tracks...")
	}

	if m.err != nil {
		return padFrame(
			titleStyle.Render("Classical Piano Tracker") + "\n\n" +
				errorStyle.Render("Error: "+m.err.Error()) + "\n\n" +
				statusBarStyle.Render("Press r to retry or q to quit."),
		)
	}

	if len(m.allTracks) == 0 && len(m.tracks) == 0 {
		return padFrame(
			titleStyle.Render("Classical Piano Tracker") + "\n\n" +
				mutedStyle.Render("No local tracks found. Run `tracker sync` first.") + "\n\n" +
				m.footerView(),
		)
	}

	if len(m.tracks) == 0 {
		return padFrame(
			titleStyle.Render("Classical Piano Tracker") + "\n" +
				mutedStyle.Render("Local track history") + "\n\n" +
				mutedStyle.Render(fmt.Sprintf("No tracks match /%s", strings.TrimSpace(m.searchQuery))) + "\n\n" +
				m.footerView(),
		)
	}

	layout := m.layout()
	listPane := renderPane(listPaneStyle, layout.listWidth, layout.listHeight, m.renderList(layout.listWidth, layout.listHeight))
	detailPane := renderPane(detailPaneStyle, layout.detailWidth, layout.detailHeight, m.renderDetails(layout.detailWidth, layout.detailHeight))

	var body string
	if layout.vertical {
		body = lipgloss.JoinVertical(lipgloss.Left, listPane, detailPane)
	} else {
		body = lipgloss.JoinHorizontal(lipgloss.Top, listPane, detailPane)
	}

	return padFrame(
		titleStyle.Render("Classical Piano Tracker") + "\n" +
			mutedStyle.Render("Local track history") + "\n\n" +
			body + "\n\n" +
			m.footerView(),
	)
}

// padFrame adds the outer margin by hand. A lipgloss Padding style would
// re-measure and re-pad every line of the already laid-out frame, which was
// about a third of View's cost; margins don't need that alignment.
func padFrame(frame string) string {
	// Match lipgloss, which expands tabs before rendering.
	frame = strings.ReplaceAll(frame, "\t", "    ")
	vertical := strings.Repeat("\n", appPadding)
	horizontal := strings.Repeat(" ", appPadding)
	return vertical + horizontal + strings.ReplaceAll(frame, "\n", "\n"+horizontal) + vertical
}

// renderPane sizes a bordered pane by its inner box. Lip Gloss v2 counts the
// border inside Width/Height, so it is added back to keep layout() unchanged.
func renderPane(style lipgloss.Style, width int, height int, content string) string {
	return style.
		Width(width + style.GetHorizontalBorderSize()).
		Height(height + style.GetVerticalBorderSize()).
		Render(content)
}

type layout struct {
	vertical     bool
	listWidth    int
	detailWidth  int
	listHeight   int
	detailHeight int
}

func (m Model) layout() layout {
	width := m.width
	if width <= 0 {
		width = 100
	}

	height := m.height
	if height <= 0 {
		height = 28
	}

	availableWidth := max(40, width-2*appPadding)
	footerHeight := lipgloss.Height(m.footerView())
	headerHeight := 4
	bodyHeight := max(
		0,
		height-2*appPadding-headerHeight-footerHeight,
	)

	if availableWidth < verticalLayoutWidthCut {
		paneWidth := max(30, availableWidth-detailPaneStyle.GetHorizontalFrameSize())
		listFrameHeight := listPaneStyle.GetVerticalFrameSize()
		detailFrameHeight := detailPaneStyle.GetVerticalFrameSize()
		usableListHeight := max(0, bodyHeight/2-listFrameHeight)
		usableDetailHeight := max(0, bodyHeight-bodyHeight/2-detailFrameHeight)
		listHeight := clampPaneHeight(usableListHeight, usableListHeight)
		detailHeight := clampPaneHeight(usableDetailHeight, usableDetailHeight)

		return layout{
			vertical:     true,
			listWidth:    paneWidth,
			detailWidth:  paneWidth,
			listHeight:   listHeight,
			detailHeight: detailHeight,
		}
	}

	listWidth := min(44, availableWidth/2)
	detailWidth := max(34, availableWidth-listWidth-1-detailPaneStyle.GetHorizontalFrameSize())
	listWidth = max(28, listWidth-listPaneStyle.GetHorizontalFrameSize())
	listHeight := clampPaneHeight(
		bodyHeight-listPaneStyle.GetVerticalFrameSize(),
		bodyHeight-listPaneStyle.GetVerticalFrameSize(),
	)
	detailHeight := clampPaneHeight(
		bodyHeight-detailPaneStyle.GetVerticalFrameSize(),
		bodyHeight-detailPaneStyle.GetVerticalFrameSize(),
	)

	return layout{
		listWidth:    listWidth,
		detailWidth:  detailWidth,
		listHeight:   listHeight,
		detailHeight: detailHeight,
	}
}

func clampPaneHeight(height int, availableHeight int) int {
	if availableHeight <= 0 {
		return 0
	}
	if availableHeight < minPaneContentHeight {
		return availableHeight
	}
	return max(minPaneContentHeight, height)
}

func (m Model) renderList(width int, height int) string {
	lines := []string{
		titleStyle.Render("Tracks"),
		mutedStyle.Render(m.trackListSummary()),
		"",
	}

	visibleTracks, offset, hiddenAbove, hiddenBelow := m.visibleTracks(height)
	if hiddenAbove {
		lines = append(lines, mutedStyle.Render(fmt.Sprintf("... %d earlier", offset)))
	}

	titleWidth := max(10, width-8)
	artistWidth := max(10, width-6)

	for idx, track := range visibleTracks {
		absoluteIndex := offset + idx
		line := fmt.Sprintf("%2d  %s", track.ID, truncate(track.TrackName, titleWidth))
		subtitle := mutedStyle.Render(fmt.Sprintf("    %s", truncate(m.textFor(track).artists, artistWidth)))

		if absoluteIndex == m.selectedIndex {
			lines = append(lines, selectedRowStyle.Render(line))
			lines = append(lines, selectedRowStyle.Render(subtitle))
			continue
		}

		lines = append(lines, line)
		lines = append(lines, subtitle)
	}

	if hiddenBelow {
		lines = append(lines, mutedStyle.Render(fmt.Sprintf("... %d more", len(m.tracks)-(offset+len(visibleTracks)))))
	}

	return strings.Join(lines, "\n")
}

func (m Model) renderDetails(width int, height int) string {
	track := m.selectedTrack()
	if track == nil {
		return titleStyle.Render("Track Details") + "\n\n" + mutedStyle.Render("No track selected.")
	}

	if m.editingRating {
		lines := []string{
			titleStyle.Render("Rating Editor"),
			"",
			highlightStyle.Render(truncate(track.TrackName, max(16, width-2))),
			mutedStyle.Render(truncate(m.textFor(*track).artists, max(16, width-2))),
			"",
			editorFieldLabel("Stars: "+m.ratingDraftStarsLabel(), !m.editingOpinion),
			editorFieldLabel("Opinion:", m.editingOpinion),
		}
		lines = append(lines, trimLines(wrapText(m.draftOpinionLine(), max(16, width-2)), max(1, height-len(lines)-2))...)
		lines = append(lines, "")
		lines = append(lines, mutedStyle.Render("1-5 sets stars, then type your opinion."))
		lines = append(lines, mutedStyle.Render("Tab switches field. Enter saves. Esc cancels."))
		return strings.Join(trimLines(lines, height), "\n")
	}

	lines := []string{
		titleStyle.Render("Track Details"),
		"",
		highlightStyle.Render(truncate(track.TrackName, max(16, width-2))),
		mutedStyle.Render(truncate(m.textFor(*track).artists, max(16, width-2))),
		"",
		fmt.Sprintf("ID: %d", track.ID),
		truncate(fmt.Sprintf("Spotify ID: %s", track.SpotifyID), max(16, width-2)),
		truncate(fmt.Sprintf("Album: %s", track.AlbumName), max(16, width-2)),
		fmt.Sprintf("Play Count: %d", track.PlayCount),
		truncate(fmt.Sprintf("Last Played: %s", time.Unix(track.LastPlayedAt, 0).Format(time.RFC3339)), max(16, width-2)),
	}

	rating := m.selectedRating()
	switch {
	case m.savingRating:
		lines = append(lines, "", mutedStyle.Render("Rating: saving..."))
	case rating == nil:
		lines = append(lines, "", mutedStyle.Render("Rating: none"))
	default:
		lines = append(lines, "", fmt.Sprintf("Rating: %d/5", rating.Stars))
		if rating.Opinion != "" {
			lines = append(lines, trimLines(wrapText(fmt.Sprintf("Opinion: %s", rating.Opinion), max(16, width-2)), 3)...)
		}
		lines = append(lines, mutedStyle.Render(fmt.Sprintf(
			"Updated: %s",
			time.Unix(rating.UpdatedAt, 0).Format(time.RFC3339),
		)))
	}

	lines = trimLines(lines, height)
	return strings.Join(lines, "\n")
}

func (m Model) handleBrowsingKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "r":
		m.loadingTracks = true
		m.err = nil
		m.clearStatus()
		return m, m.loadTracksCmd()
	case "s":
		if m.syncing {
			return m, nil
		}
		if m.runSync == nil {
			m.setStatus("Sync is unavailable in this view.", true)
			return m, nil
		}
		m.syncing = true
		m.clearStatus()
		return m, m.syncCmd()
	case "o":
		if len(m.tracks) == 0 || m.syncing || m.savingRating {
			return m, nil
		}
		m.clearStatus()
		m.cycleSortMode()
		return m, nil
	case "/":
		if m.syncing || m.savingRating {
			return m, nil
		}
		m.searching = true
		m.clearStatus()
		return m, nil
	case "esc":
		if strings.TrimSpace(m.searchQuery) == "" || m.syncing || m.savingRating {
			return m, nil
		}
		m.searchQuery = ""
		m.clearStatus()
		m.refreshTrackList(m.selectedTrackID())
		return m, nil
	case "e", "enter":
		if m.selectedTrack() == nil || m.savingRating {
			return m, nil
		}
		m.startRatingEditor()
		return m, nil
	case "up", "k":
		if len(m.tracks) == 0 || m.selectedIndex == 0 || m.syncing || m.savingRating {
			return m, nil
		}
		return m.moveSelectionTo(0 + m.selectedIndex - 1)
	case "down", "j":
		if len(m.tracks) == 0 || m.selectedIndex >= len(m.tracks)-1 || m.syncing || m.savingRating {
			return m, nil
		}
		return m.moveSelectionTo(m.selectedIndex + 1)
	case "g", "home":
		if len(m.tracks) == 0 || m.selectedIndex == 0 || m.syncing || m.savingRating {
			return m, nil
		}
		return m.moveSelectionTo(0)
	case "G", "end":
		if len(m.tracks) == 0 || m.selectedIndex >= len(m.tracks)-1 || m.syncing || m.savingRating {
			return m, nil
		}
		return m.moveSelectionTo(len(m.tracks) - 1)
	}

	return m, nil
}

func (m Model) handleSearchKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c":
		return m, tea.Quit
	case "enter":
		m.searching = false
		m.clearStatus()
		return m, nil
	case "esc":
		m.searching = false
		m.searchQuery = ""
		m.clearStatus()
		m.refreshTrackList(m.selectedTrackID())
		return m, nil
	case "backspace":
		if m.searchQuery != "" {
			_, size := utf8.DecodeLastRuneInString(m.searchQuery)
			m.searchQuery = m.searchQuery[:len(m.searchQuery)-size]
		}
		m.clearStatus()
		m.refreshTrackList(m.selectedTrackID())
		return m, nil
	case "ctrl+u":
		m.searchQuery = ""
		m.clearStatus()
		m.refreshTrackList(m.selectedTrackID())
		return m, nil
	}

	if msg.Code == tea.KeySpace {
		m.searchQuery += " "
		m.clearStatus()
		m.refreshTrackList(m.selectedTrackID())
		return m, nil
	}

	if msg.Text != "" {
		m.searchQuery += msg.Text
		m.clearStatus()
		m.refreshTrackList(m.selectedTrackID())
		return m, nil
	}

	return m, nil
}

func (m Model) handleRatingEditorKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.editingRating = false
		m.setStatus("Rating edit canceled.", false)
		return m, nil
	case "enter":
		if m.selectedTrack() == nil || m.savingRating {
			return m, nil
		}
		if m.draftStars < 1 || m.draftStars > 5 {
			m.setStatus("Choose a star rating from 1 to 5 before saving.", true)
			return m, nil
		}
		if m.saveRating == nil {
			m.setStatus("Saving ratings is unavailable in this view.", true)
			return m, nil
		}
		trackID := m.selectedTrack().ID
		stars := m.draftStars
		opinion := strings.TrimSpace(m.draftOpinion)
		m.editingRating = false
		m.savingRating = true
		m.clearStatus()
		return m, m.saveRatingCmd(trackID, stars, opinion)
	case "tab", "shift+tab":
		m.editingOpinion = !m.editingOpinion
		return m, nil
	case "backspace":
		if !m.editingOpinion {
			m.draftStars = 0
			return m, nil
		}
		if m.draftOpinion != "" {
			_, size := utf8.DecodeLastRuneInString(m.draftOpinion)
			m.draftOpinion = m.draftOpinion[:len(m.draftOpinion)-size]
		}
		return m, nil
	case "ctrl+u":
		m.draftOpinion = ""
		return m, nil
	}

	if !m.editingOpinion {
		// The stars field takes a single digit and then hands focus to the
		// opinion, so the usual "5, then type" flow needs no extra key.
		switch msg.String() {
		case "1", "2", "3", "4", "5":
			m.draftStars = int(msg.Code - '0')
			m.editingOpinion = true
			return m, nil
		}
	}

	// Any other text starts (or continues) the opinion.
	if msg.Code == tea.KeySpace {
		m.draftOpinion += " "
		m.editingOpinion = true
		return m, nil
	}

	if msg.Text != "" {
		m.draftOpinion += msg.Text
		m.editingOpinion = true
		return m, nil
	}

	return m, nil
}

func (m Model) selectedTrack() *db.Track {
	if len(m.tracks) == 0 || m.selectedIndex < 0 || m.selectedIndex >= len(m.tracks) {
		return nil
	}

	return &m.tracks[m.selectedIndex]
}

// selectedRating returns the saved rating for the selected track, if any.
func (m Model) selectedRating() *db.Rating {
	track := m.selectedTrack()
	if track == nil {
		return nil
	}
	rating, ok := m.ratings[track.ID]
	if !ok {
		return nil
	}
	return &rating
}

func (m Model) selectedTrackID() int64 {
	if track := m.selectedTrack(); track != nil {
		return track.ID
	}

	return 0
}

func (m Model) moveSelectionTo(index int) (tea.Model, tea.Cmd) {
	if len(m.tracks) == 0 {
		return m, nil
	}

	if index < 0 {
		index = 0
	}
	if index >= len(m.tracks) {
		index = len(m.tracks) - 1
	}
	if index == m.selectedIndex {
		return m, nil
	}

	m.selectedIndex = index
	m.clearStatus()
	return m, nil
}

func (m Model) loadTracksCmd() tea.Cmd {
	return func() tea.Msg {
		tracks, err := m.queries.ListAllTracks(context.Background())
		if err != nil {
			return tracksLoadedMsg{err: err}
		}

		ratings, err := m.queries.ListAllRatings(context.Background())
		if err != nil {
			return tracksLoadedMsg{err: err}
		}

		ratingsByTrackID := make(map[int64]db.Rating, len(ratings))
		for _, rating := range ratings {
			ratingsByTrackID[rating.TrackID] = rating
		}

		// Decoding artists JSON here keeps it off the Update loop.
		return tracksLoadedMsg{tracks: tracks, ratings: ratingsByTrackID, trackText: buildTrackText(tracks)}
	}
}

func (m Model) syncCmd() tea.Cmd {
	return func() tea.Msg {
		stats, err := m.runSync(context.Background())
		return syncFinishedMsg{stats: stats, err: err}
	}
}

func (m Model) saveRatingCmd(trackID int64, stars int, opinion string) tea.Cmd {
	return func() tea.Msg {
		rating, err := m.saveRating(context.Background(), db.UpsertRatingParams{
			TrackID:   trackID,
			Stars:     int64(stars),
			Opinion:   opinion,
			UpdatedAt: time.Now().Unix(),
		})
		if err != nil {
			return ratingSavedMsg{trackID: trackID, err: err}
		}
		return ratingSavedMsg{trackID: trackID, rating: &rating}
	}
}

func (m *Model) startRatingEditor() {
	m.editingRating = true
	m.editingOpinion = false
	m.clearStatus()
	if rating := m.selectedRating(); rating != nil {
		m.draftStars = int(rating.Stars)
		m.draftOpinion = rating.Opinion
		return
	}

	m.draftStars = 0
	m.draftOpinion = ""
}

func (m *Model) setStatus(message string, isError bool) {
	m.statusMessage = message
	m.statusIsError = isError
}

func (m *Model) clearStatus() {
	m.statusMessage = ""
	m.statusIsError = false
}

func (m Model) footerView() string {
	base := "j/k or arrows: move   g/G: top/bottom   o: sort   s: sync   enter/e: rate   r: reload   q: quit"
	if m.editingRating {
		base = "1-5: stars   tab: switch field   ctrl+u: clear opinion   enter: save   esc: cancel"
	}
	if m.searching {
		base = "type: search   backspace: delete   enter: apply   esc: clear"
	}

	var lines []string
	switch {
	case m.syncing:
		lines = append(lines, "Syncing with Spotify...")
	case m.savingRating:
		lines = append(lines, "Saving rating...")
	case m.statusMessage != "":
		if m.statusIsError {
			lines = append(lines, "Error: "+m.statusMessage)
		} else {
			lines = append(lines, m.statusMessage)
		}
	case m.searching:
		lines = append(lines, fmt.Sprintf("Search /%s_ (%d/%d)", m.searchQuery, len(m.tracks), m.totalTrackCount()))
	case strings.TrimSpace(m.searchQuery) != "":
		lines = append(lines, fmt.Sprintf("Filter /%s (%d/%d)", strings.TrimSpace(m.searchQuery), len(m.tracks), m.totalTrackCount()))
	}

	lines = append(lines, base)
	return statusBarStyle.Render(strings.Join(lines, "\n"))
}

func (m Model) ratingDraftStarsLabel() string {
	if m.draftStars < 1 || m.draftStars > 5 {
		return "not set"
	}
	return fmt.Sprintf("%d/5", m.draftStars)
}

// draftOpinionLine shows the text cursor only while the opinion has focus.
func (m Model) draftOpinionLine() string {
	if m.editingOpinion {
		return m.draftOpinion + "_"
	}
	return m.draftOpinion
}

func editorFieldLabel(label string, focused bool) string {
	if focused {
		return highlightStyle.Render("> " + label)
	}
	return "  " + label
}

func formatTrackArtists(raw string) string {
	// Fast path for the compact form json.Marshal writes during sync: with no
	// escapes, `["A","B"]` decodes to exactly the text between the quotes.
	if inner, ok := strings.CutPrefix(raw, `["`); ok && !strings.Contains(raw, `\`) {
		if inner, ok = strings.CutSuffix(inner, `"]`); ok && inner != "" {
			if joined := strings.ReplaceAll(inner, `","`, ", "); !strings.Contains(joined, `"`) {
				return joined
			}
		}
	}

	var artists []string
	if err := json.Unmarshal([]byte(raw), &artists); err != nil || len(artists) == 0 {
		return raw
	}

	return strings.Join(artists, ", ")
}

func (m *Model) cycleSortMode() {
	if len(sortModeCycle) == 0 {
		return
	}

	selectedTrackID := int64(0)
	if track := m.selectedTrack(); track != nil {
		selectedTrackID = track.ID
	}

	currentIndex := slices.Index(sortModeCycle, m.sortMode)
	if currentIndex < 0 {
		m.sortMode = sortModeCycle[0]
	} else {
		m.sortMode = sortModeCycle[(currentIndex+1)%len(sortModeCycle)]
	}

	m.refreshTrackList(selectedTrackID)
}

func (m *Model) sortTracks() {
	switch m.sortMode {
	case sortModeIDAsc:
		sortTracksByIDAsc(m.allTracks)
	case sortModeTopPlayed:
		sortTracksByTopPlayed(m.allTracks)
	case sortModeUnratedFirst:
		sortTracksByUnratedFirst(m.allTracks, m.ratings)
	default:
		m.sortMode = sortModeRecentDesc
		sortTracksByRecentDesc(m.allTracks)
	}
	m.sortedBy = m.sortMode
	m.sorted = true
}

func (m *Model) refreshTrackList(selectedTrackID int64) {
	if len(m.allTracks) == 0 && len(m.tracks) > 0 {
		m.allTracks = append([]db.Track(nil), m.tracks...)
		m.sorted = false
	}

	if !m.sorted || m.sortedBy != m.sortMode {
		m.sortTracks()
	}
	m.tracks = m.filterTracks(m.allTracks, m.searchQuery)
	if len(m.tracks) == 0 {
		m.selectedIndex = 0
		m.editingRating = false
		return
	}

	if idx := indexOfTrackID(m.tracks, selectedTrackID); idx >= 0 {
		m.selectedIndex = idx
		return
	}

	m.selectedIndex = 0
	m.editingRating = false
}

func (m Model) trackListSummary() string {
	if strings.TrimSpace(m.searchQuery) == "" {
		return fmt.Sprintf("%d loaded · sort: %s", len(m.tracks), m.sortModeLabel())
	}

	return fmt.Sprintf("%d/%d shown · sort: %s", len(m.tracks), m.totalTrackCount(), m.sortModeLabel())
}

func (m Model) totalTrackCount() int {
	if len(m.allTracks) > 0 {
		return len(m.allTracks)
	}

	return len(m.tracks)
}

func (m Model) sortModeLabel() string {
	switch m.sortMode {
	case sortModeRecentDesc:
		return "recent"
	case sortModeIDAsc:
		return "id"
	case sortModeTopPlayed:
		return "top played"
	case sortModeUnratedFirst:
		return "unrated first"
	default:
		return "recent"
	}
}

func sortTracksByRecentDesc(tracks []db.Track) {
	slices.SortFunc(tracks, func(left db.Track, right db.Track) int {
		if byPlayedAt := cmp.Compare(right.LastPlayedAt, left.LastPlayedAt); byPlayedAt != 0 {
			return byPlayedAt
		}
		return cmp.Compare(right.ID, left.ID)
	})
}

func sortTracksByIDAsc(tracks []db.Track) {
	slices.SortFunc(tracks, func(left db.Track, right db.Track) int {
		return cmp.Compare(left.ID, right.ID)
	})
}

func sortTracksByTopPlayed(tracks []db.Track) {
	slices.SortFunc(tracks, func(left db.Track, right db.Track) int {
		if byPlayCount := cmp.Compare(right.PlayCount, left.PlayCount); byPlayCount != 0 {
			return byPlayCount
		}
		if byPlayedAt := cmp.Compare(right.LastPlayedAt, left.LastPlayedAt); byPlayedAt != 0 {
			return byPlayedAt
		}
		return cmp.Compare(right.ID, left.ID)
	})
}

func sortTracksByUnratedFirst(tracks []db.Track, ratings map[int64]db.Rating) {
	slices.SortFunc(tracks, func(left db.Track, right db.Track) int {
		_, leftRated := ratings[left.ID]
		_, rightRated := ratings[right.ID]
		if leftRated != rightRated {
			if leftRated {
				return 1
			}
			return -1
		}
		if byPlayedAt := cmp.Compare(right.LastPlayedAt, left.LastPlayedAt); byPlayedAt != 0 {
			return byPlayedAt
		}
		return cmp.Compare(right.ID, left.ID)
	})
}

func (m Model) filterTracks(tracks []db.Track, query string) []db.Track {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		// Sharing the backing array is safe: allTracks is only re-sorted
		// inside refreshTrackList, which always reassigns tracks afterwards.
		return tracks
	}

	matches := make([]db.Track, 0, len(tracks))
	for _, track := range tracks {
		if strings.Contains(m.textFor(track).search, query) {
			matches = append(matches, track)
		}
	}

	return matches
}

func buildTrackText(tracks []db.Track) map[int64]trackText {
	texts := make(map[int64]trackText, len(tracks))
	for _, track := range tracks {
		texts[track.ID] = newTrackText(track)
	}
	return texts
}

func newTrackText(track db.Track) trackText {
	artists := formatTrackArtists(track.Artists)
	return trackText{
		artists: artists,
		// NUL separators keep a pasted query from matching across fields.
		search: strings.ToLower(track.TrackName + "\x00" + artists + "\x00" + track.AlbumName),
	}
}

// textFor falls back to decoding on a cache miss so hand-built models (tests)
// behave the same as loaded ones.
func (m Model) textFor(track db.Track) trackText {
	if text, ok := m.trackText[track.ID]; ok {
		return text
	}
	return newTrackText(track)
}

func indexOfTrackID(tracks []db.Track, trackID int64) int {
	for idx, track := range tracks {
		if track.ID == trackID {
			return idx
		}
	}

	return -1
}

func truncate(value string, width int) string {
	if width <= 0 {
		return ""
	}
	if lipgloss.Width(value) <= width {
		return value
	}
	// Cut by terminal cells, not bytes, so accented names stay valid UTF-8.
	if width <= 3 {
		return ansi.Truncate(value, width, "")
	}
	return ansi.Truncate(value, width, "...")
}

func wrapText(value string, width int) []string {
	if width <= 0 {
		return []string{""}
	}
	if value == "" {
		return []string{""}
	}

	var lines []string
	for _, paragraph := range strings.Split(value, "\n") {
		if paragraph == "" {
			lines = append(lines, "")
			continue
		}

		words := strings.Fields(paragraph)
		if len(words) == 0 {
			lines = append(lines, "")
			continue
		}

		line := words[0]
		for _, word := range words[1:] {
			candidate := line + " " + word
			if lipgloss.Width(candidate) <= width {
				line = candidate
				continue
			}
			lines = append(lines, line)
			line = word
		}
		lines = append(lines, line)
	}

	return lines
}

func (m Model) visibleTracks(height int) (tracks []db.Track, offset int, hiddenAbove bool, hiddenBelow bool) {
	availableLines := max(2, height-3)
	maxVisible := max(1, availableLines/2)

	if len(m.tracks) <= maxVisible {
		return m.tracks, 0, false, false
	}

	start := m.selectedIndex - maxVisible/2
	if start < 0 {
		start = 0
	}
	if start+maxVisible > len(m.tracks) {
		start = len(m.tracks) - maxVisible
	}

	end := start + maxVisible
	return m.tracks[start:end], start, start > 0, end < len(m.tracks)
}

func trimLines(lines []string, height int) []string {
	if height <= 0 || len(lines) <= height {
		return lines
	}
	if height <= 1 {
		return lines[:1]
	}

	trimmed := append([]string(nil), lines[:height-1]...)
	trimmed = append(trimmed, mutedStyle.Render("..."))
	return trimmed
}

func min(a int, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a int, b int) int {
	if a > b {
		return a
	}
	return b
}
