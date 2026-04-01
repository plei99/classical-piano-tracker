package tui

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/plei99/classical-piano-tracker/internal/db"
	"github.com/plei99/classical-piano-tracker/internal/syncer"
)

const defaultRecentTrackLimit = 25

const (
	minPaneContentHeight   = 8
	verticalLayoutWidthCut = 90
)

var (
	appStyle = lipgloss.NewStyle().
			Padding(1)

	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("230"))

	mutedStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("245"))

	highlightStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("229"))

	selectedRowStyle = lipgloss.NewStyle().
				Background(lipgloss.Color("24")).
				Foreground(lipgloss.Color("230")).
				Padding(0, 1)

	listPaneStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("240")).
			Padding(1)

	detailPaneStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("240")).
			Padding(1)

	statusBarStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("244"))

	errorStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("203")).
			Bold(true)
)

type SyncFunc func(context.Context) (syncer.Stats, error)

type SaveRatingFunc func(context.Context, db.UpsertRatingParams) (db.Rating, error)

// Model is the root Bubble Tea model for the tracker TUI.
type Model struct {
	queries        *db.Queries
	runSync        SyncFunc
	saveRating     SaveRatingFunc
	width          int
	height         int
	loadingTracks  bool
	loadingRating  bool
	syncing        bool
	savingRating   bool
	tracks         []db.Track
	selectedIndex  int
	selectedRating *db.Rating
	ratingKnown    bool
	editingRating  bool
	draftStars     int
	draftOpinion   string
	statusMessage  string
	statusIsError  bool
	err            error
}

type tracksLoadedMsg struct {
	tracks []db.Track
	err    error
}

type ratingLoadedMsg struct {
	trackID int64
	rating  *db.Rating
	err     error
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

		m.err = nil
		m.tracks = msg.tracks
		if len(m.tracks) == 0 {
			m.selectedIndex = 0
			m.selectedRating = nil
			m.ratingKnown = true
			m.editingRating = false
			return m, nil
		}

		if m.selectedIndex >= len(m.tracks) {
			m.selectedIndex = len(m.tracks) - 1
		}

		m.loadingRating = true
		m.selectedRating = nil
		m.ratingKnown = false
		m.editingRating = false
		return m, m.loadRatingCmd(m.selectedTrack().ID)
	case ratingLoadedMsg:
		if m.selectedTrack() == nil || msg.trackID != m.selectedTrack().ID {
			return m, nil
		}

		m.loadingRating = false
		if msg.err != nil {
			m.err = msg.err
			return m, nil
		}

		m.err = nil
		m.selectedRating = msg.rating
		m.ratingKnown = true
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
		m.loadingRating = false
		m.selectedRating = nil
		m.ratingKnown = false
		return m, m.loadTracksCmd()
	case ratingSavedMsg:
		m.savingRating = false
		if msg.err != nil {
			m.setStatus("Save failed: "+msg.err.Error(), true)
			return m, nil
		}
		if msg.rating != nil && m.selectedTrack() != nil && msg.trackID == m.selectedTrack().ID {
			m.selectedRating = msg.rating
			m.ratingKnown = true
			m.loadingRating = false
		}
		m.setStatus(fmt.Sprintf("Saved %d/5 rating for track %d", msg.rating.Stars, msg.trackID), false)
		return m, nil
	case tea.KeyMsg:
		if m.editingRating {
			return m.handleRatingEditorKey(msg)
		}
		return m.handleBrowsingKey(msg)
	}

	return m, nil
}

// View renders a track browser with recent tracks, details, sync, and rating actions.
func (m Model) View() string {
	if m.loadingTracks {
		return appStyle.Render(titleStyle.Render("Classical Piano Tracker") + "\n\nLoading recent local tracks...")
	}

	if m.err != nil {
		return appStyle.Render(
			titleStyle.Render("Classical Piano Tracker") + "\n\n" +
				errorStyle.Render("Error: "+m.err.Error()) + "\n\n" +
				statusBarStyle.Render("Press r to retry or q to quit."),
		)
	}

	if len(m.tracks) == 0 {
		return appStyle.Render(
			titleStyle.Render("Classical Piano Tracker") + "\n\n" +
				mutedStyle.Render("No local tracks found. Run `tracker sync` first.") + "\n\n" +
				statusBarStyle.Render(m.statusLine()),
		)
	}

	layout := m.layout()
	listPane := listPaneStyle.Width(layout.listWidth).Height(layout.listHeight).Render(m.renderList(layout.listWidth, layout.listHeight))
	detailPane := detailPaneStyle.Width(layout.detailWidth).Height(layout.detailHeight).Render(m.renderDetails(layout.detailWidth, layout.detailHeight))

	var body string
	if layout.vertical {
		body = lipgloss.JoinVertical(lipgloss.Left, listPane, detailPane)
	} else {
		body = lipgloss.JoinHorizontal(lipgloss.Top, listPane, detailPane)
	}

	return appStyle.Render(
		titleStyle.Render("Classical Piano Tracker") + "\n" +
			mutedStyle.Render("Recent local listening history") + "\n\n" +
			body + "\n\n" +
			statusBarStyle.Render(m.statusLine()),
	)
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

	availableWidth := max(40, width-appStyle.GetHorizontalFrameSize())
	availableHeight := max(18, height-appStyle.GetVerticalFrameSize()-4)

	if availableWidth < verticalLayoutWidthCut {
		paneWidth := max(30, availableWidth-detailPaneStyle.GetHorizontalFrameSize())
		listHeight := max(minPaneContentHeight, availableHeight/2-1)
		detailHeight := max(minPaneContentHeight, availableHeight-listHeight-1)

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
	listHeight := max(minPaneContentHeight, availableHeight)
	detailHeight := max(minPaneContentHeight, availableHeight)

	return layout{
		listWidth:    listWidth,
		detailWidth:  detailWidth,
		listHeight:   listHeight,
		detailHeight: detailHeight,
	}
}

func (m Model) renderList(width int, height int) string {
	lines := []string{
		titleStyle.Render("Recent Tracks"),
		mutedStyle.Render(fmt.Sprintf("%d loaded", len(m.tracks))),
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
		subtitle := mutedStyle.Render(fmt.Sprintf("    %s", truncate(formatTrackArtists(track.Artists), artistWidth)))

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
			mutedStyle.Render(truncate(formatTrackArtists(track.Artists), max(16, width-2))),
			"",
			fmt.Sprintf("Stars: %s", m.ratingDraftStarsLabel()),
			"Opinion:",
		}
		lines = append(lines, trimLines(wrapText(m.draftOpinionCursorLine(), max(16, width-2)), max(1, height-len(lines)-2))...)
		lines = append(lines, "")
		lines = append(lines, mutedStyle.Render("1-5 set stars. Type to edit opinion."))
		lines = append(lines, mutedStyle.Render("Enter saves. Esc cancels. Ctrl+U clears opinion."))
		return strings.Join(trimLines(lines, height), "\n")
	}

	lines := []string{
		titleStyle.Render("Track Details"),
		"",
		highlightStyle.Render(truncate(track.TrackName, max(16, width-2))),
		mutedStyle.Render(truncate(formatTrackArtists(track.Artists), max(16, width-2))),
		"",
		fmt.Sprintf("ID: %d", track.ID),
		truncate(fmt.Sprintf("Spotify ID: %s", track.SpotifyID), max(16, width-2)),
		truncate(fmt.Sprintf("Album: %s", track.AlbumName), max(16, width-2)),
		fmt.Sprintf("Play Count: %d", track.PlayCount),
		truncate(fmt.Sprintf("Last Played: %s", time.Unix(track.LastPlayedAt, 0).Format(time.RFC3339)), max(16, width-2)),
	}

	switch {
	case m.savingRating:
		lines = append(lines, "", mutedStyle.Render("Rating: saving..."))
	case m.loadingRating:
		lines = append(lines, "", mutedStyle.Render("Rating: loading..."))
	case !m.ratingKnown:
		lines = append(lines, "", mutedStyle.Render("Rating: unknown"))
	case m.selectedRating == nil:
		lines = append(lines, "", mutedStyle.Render("Rating: none"))
	default:
		lines = append(lines, "", fmt.Sprintf("Rating: %d/5", m.selectedRating.Stars))
		if m.selectedRating.Opinion != "" {
			lines = append(lines, trimLines(wrapText(fmt.Sprintf("Opinion: %s", m.selectedRating.Opinion), max(16, width-2)), 3)...)
		}
		lines = append(lines, mutedStyle.Render(fmt.Sprintf(
			"Updated: %s",
			time.Unix(m.selectedRating.UpdatedAt, 0).Format(time.RFC3339),
		)))
	}

	lines = trimLines(lines, height)
	return strings.Join(lines, "\n")
}

func (m Model) handleBrowsingKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "r":
		m.loadingTracks = true
		m.loadingRating = false
		m.selectedRating = nil
		m.ratingKnown = false
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
	case "e", "enter":
		if m.selectedTrack() == nil || m.loadingRating || m.savingRating {
			return m, nil
		}
		m.startRatingEditor()
		return m, nil
	case "up", "k":
		if len(m.tracks) == 0 || m.selectedIndex == 0 || m.syncing || m.savingRating {
			return m, nil
		}
		m.selectedIndex--
		m.loadingRating = true
		m.selectedRating = nil
		m.ratingKnown = false
		m.clearStatus()
		return m, m.loadRatingCmd(m.selectedTrack().ID)
	case "down", "j":
		if len(m.tracks) == 0 || m.selectedIndex >= len(m.tracks)-1 || m.syncing || m.savingRating {
			return m, nil
		}
		m.selectedIndex++
		m.loadingRating = true
		m.selectedRating = nil
		m.ratingKnown = false
		m.clearStatus()
		return m, m.loadRatingCmd(m.selectedTrack().ID)
	}

	return m, nil
}

func (m Model) handleRatingEditorKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
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
	case "backspace":
		if m.draftOpinion != "" {
			_, size := utf8.DecodeLastRuneInString(m.draftOpinion)
			m.draftOpinion = m.draftOpinion[:len(m.draftOpinion)-size]
		}
		return m, nil
	case "ctrl+u":
		m.draftOpinion = ""
		return m, nil
	case "1", "2", "3", "4", "5":
		m.draftStars = int(msg.Runes[0] - '0')
		return m, nil
	}

	if msg.Type == tea.KeySpace {
		m.draftOpinion += " "
		return m, nil
	}

	if msg.Type == tea.KeyRunes {
		m.draftOpinion += string(msg.Runes)
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

func (m Model) loadTracksCmd() tea.Cmd {
	return func() tea.Msg {
		tracks, err := m.queries.ListRecentTracks(context.Background(), defaultRecentTrackLimit)
		return tracksLoadedMsg{tracks: tracks, err: err}
	}
}

func (m Model) loadRatingCmd(trackID int64) tea.Cmd {
	return func() tea.Msg {
		rating, err := m.queries.GetRatingByTrackID(context.Background(), trackID)
		switch {
		case err == nil:
			return ratingLoadedMsg{trackID: trackID, rating: &rating}
		case errors.Is(err, sql.ErrNoRows):
			return ratingLoadedMsg{trackID: trackID, rating: nil}
		default:
			return ratingLoadedMsg{trackID: trackID, err: err}
		}
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
	m.clearStatus()
	if m.selectedRating != nil {
		m.draftStars = int(m.selectedRating.Stars)
		m.draftOpinion = m.selectedRating.Opinion
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

func (m Model) statusLine() string {
	base := "j/k or arrows: move   s: sync   enter/e: rate   r: reload   q: quit"
	if m.editingRating {
		base = "1-5: stars   type: opinion   backspace: delete   enter: save   esc: cancel"
	}

	prefix := ""
	switch {
	case m.syncing:
		prefix = "Syncing with Spotify..."
	case m.savingRating:
		prefix = "Saving rating..."
	case m.statusMessage != "":
		if m.statusIsError {
			prefix = "Error: " + m.statusMessage
		} else {
			prefix = m.statusMessage
		}
	}

	if prefix == "" {
		return base
	}
	return prefix + "   " + base
}

func (m Model) ratingDraftStarsLabel() string {
	if m.draftStars < 1 || m.draftStars > 5 {
		return "not set"
	}
	return fmt.Sprintf("%d/5", m.draftStars)
}

func (m Model) draftOpinionCursorLine() string {
	if m.draftOpinion == "" {
		return "_"
	}
	return m.draftOpinion + "_"
}

func formatTrackArtists(raw string) string {
	var artists []string
	if err := json.Unmarshal([]byte(raw), &artists); err != nil || len(artists) == 0 {
		return raw
	}

	return strings.Join(artists, ", ")
}

func truncate(value string, width int) string {
	if width <= 0 {
		return ""
	}
	if lipgloss.Width(value) <= width {
		return value
	}
	if width <= 3 {
		return value[:width]
	}
	return value[:width-3] + "..."
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
