package tui

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/plei99/classical-piano-tracker/internal/db"
)

const defaultRecentTrackLimit = 25

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

// Model is the root Bubble Tea model for the tracker TUI.
type Model struct {
	queries        *db.Queries
	width          int
	height         int
	loadingTracks  bool
	loadingRating  bool
	tracks         []db.Track
	selectedIndex  int
	selectedRating *db.Rating
	ratingKnown    bool
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

// NewModel constructs the root TUI model.
func NewModel(queries *db.Queries) Model {
	return Model{
		queries:       queries,
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
			return m, nil
		}

		if m.selectedIndex >= len(m.tracks) {
			m.selectedIndex = len(m.tracks) - 1
		}

		m.loadingRating = true
		m.selectedRating = nil
		m.ratingKnown = false
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
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "r":
			m.loadingTracks = true
			m.loadingRating = false
			m.selectedRating = nil
			m.ratingKnown = false
			m.err = nil
			return m, m.loadTracksCmd()
		case "up", "k":
			if len(m.tracks) == 0 || m.selectedIndex == 0 {
				return m, nil
			}
			m.selectedIndex--
			m.loadingRating = true
			m.selectedRating = nil
			m.ratingKnown = false
			return m, m.loadRatingCmd(m.selectedTrack().ID)
		case "down", "j":
			if len(m.tracks) == 0 || m.selectedIndex >= len(m.tracks)-1 {
				return m, nil
			}
			m.selectedIndex++
			m.loadingRating = true
			m.selectedRating = nil
			m.ratingKnown = false
			return m, m.loadRatingCmd(m.selectedTrack().ID)
		}
	}

	return m, nil
}

// View renders a read-only track browser with a recent list and detail pane.
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
				statusBarStyle.Render("Press r to reload or q to quit."),
		)
	}

	listWidth, detailWidth := m.paneWidths()
	listPane := listPaneStyle.Width(listWidth).Render(m.renderList())
	detailPane := detailPaneStyle.Width(detailWidth).Render(m.renderDetails())

	body := lipgloss.JoinHorizontal(lipgloss.Top, listPane, detailPane)
	status := statusBarStyle.Render("j/k or arrows: move   r: reload   q: quit")

	return appStyle.Render(
		titleStyle.Render("Classical Piano Tracker") + "\n" +
			mutedStyle.Render("Recent local listening history") + "\n\n" +
			body + "\n\n" + status,
	)
}

func (m Model) paneWidths() (int, int) {
	if m.width <= 0 {
		return 40, 56
	}

	available := m.width - 6
	if available < 60 {
		return 24, 32
	}

	listWidth := available / 2
	if listWidth > 48 {
		listWidth = 48
	}
	detailWidth := available - listWidth - 1
	return listWidth, detailWidth
}

func (m Model) renderList() string {
	lines := []string{
		titleStyle.Render("Recent Tracks"),
		mutedStyle.Render(fmt.Sprintf("%d loaded", len(m.tracks))),
		"",
	}

	for idx, track := range m.tracks {
		line := fmt.Sprintf("%2d  %s", track.ID, truncate(track.TrackName, 28))
		subtitle := mutedStyle.Render(fmt.Sprintf("    %s", truncate(formatTrackArtists(track.Artists), 32)))

		if idx == m.selectedIndex {
			lines = append(lines, selectedRowStyle.Render(line))
			lines = append(lines, selectedRowStyle.Render(subtitle))
			continue
		}

		lines = append(lines, line)
		lines = append(lines, subtitle)
	}

	return strings.Join(lines, "\n")
}

func (m Model) renderDetails() string {
	track := m.selectedTrack()
	if track == nil {
		return titleStyle.Render("Track Details") + "\n\n" + mutedStyle.Render("No track selected.")
	}

	lines := []string{
		titleStyle.Render("Track Details"),
		"",
		highlightStyle.Render(track.TrackName),
		mutedStyle.Render(formatTrackArtists(track.Artists)),
		"",
		fmt.Sprintf("ID: %d", track.ID),
		fmt.Sprintf("Spotify ID: %s", track.SpotifyID),
		fmt.Sprintf("Album: %s", track.AlbumName),
		fmt.Sprintf("Play Count: %d", track.PlayCount),
		fmt.Sprintf("Last Played: %s", time.Unix(track.LastPlayedAt, 0).Format(time.RFC3339)),
	}

	switch {
	case m.loadingRating:
		lines = append(lines, "", mutedStyle.Render("Rating: loading..."))
	case !m.ratingKnown:
		lines = append(lines, "", mutedStyle.Render("Rating: unknown"))
	case m.selectedRating == nil:
		lines = append(lines, "", mutedStyle.Render("Rating: none"))
	default:
		lines = append(lines, "", fmt.Sprintf("Rating: %d/5", m.selectedRating.Stars))
		if m.selectedRating.Opinion != "" {
			lines = append(lines, fmt.Sprintf("Opinion: %s", m.selectedRating.Opinion))
		}
		lines = append(lines, mutedStyle.Render(fmt.Sprintf(
			"Updated: %s",
			time.Unix(m.selectedRating.UpdatedAt, 0).Format(time.RFC3339),
		)))
	}

	return strings.Join(lines, "\n")
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
