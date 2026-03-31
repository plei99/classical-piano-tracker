package tui

import (
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

var appStyle = lipgloss.NewStyle().Padding(1)

// Model is the root Bubble Tea model for the tracker TUI.
type Model struct{}

// NewModel constructs the root TUI model.
func NewModel() Model {
	return Model{}
}

// Init starts the Bubble Tea program without background work yet.
func (m Model) Init() tea.Cmd {
	return nil
}

// Update handles messages for the root TUI model.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	return m, nil
}

// View renders a placeholder shell until real screens are implemented.
func (m Model) View() string {
	return appStyle.Render("Classical Piano Tracker")
}
