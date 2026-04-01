package cli

import (
	"fmt"
	"io"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type singleChoiceModel struct {
	title    string
	help     string
	options  []string
	cursor   int
	canceled bool
	width    int
	height   int
}

func newSingleChoiceModel(title string, help string, options []string, initial int) singleChoiceModel {
	if initial < 0 || initial >= len(options) {
		initial = 0
	}
	return singleChoiceModel{
		title:   title,
		help:    help,
		options: append([]string(nil), options...),
		cursor:  initial,
	}
}

func (m singleChoiceModel) Init() tea.Cmd { return nil }

func (m singleChoiceModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "q":
			m.canceled = true
			return m, tea.Quit
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
		case "down", "j":
			if m.cursor < len(m.options)-1 {
				m.cursor++
			}
		case "enter":
			return m, tea.Quit
		}
	}
	return m, nil
}

func (m singleChoiceModel) View() string {
	width := m.width
	if width <= 0 {
		width = 80
	}

	var b strings.Builder
	b.WriteString(m.title + "\n")
	b.WriteString(m.help + "\n")
	if len(m.options) > 0 {
		fmt.Fprintf(&b, "Current: %d of %d\n\n", m.cursor+1, len(m.options))
	}

	visible, offset, hiddenAbove, hiddenBelow := m.visibleOptions()
	if hiddenAbove {
		fmt.Fprintf(&b, "  ... %d more above\n", offset)
	}

	for idx, option := range visible {
		absoluteIdx := offset + idx
		cursor := " "
		if absoluteIdx == m.cursor {
			cursor = ">"
		}
		line := fmt.Sprintf("%s %s", cursor, option)
		style := lipgloss.NewStyle().MaxWidth(width)
		if absoluteIdx == m.cursor {
			style = style.Bold(true)
		}
		fmt.Fprintln(&b, style.Render(line))
	}

	if hiddenBelow {
		fmt.Fprintf(&b, "  ... %d more below\n", len(m.options)-(offset+len(visible)))
	}

	return b.String()
}

func (m singleChoiceModel) visibleOptions() (options []string, offset int, hiddenAbove bool, hiddenBelow bool) {
	if len(m.options) == 0 {
		return nil, 0, false, false
	}
	height := m.height
	if height <= 0 {
		height = 24
	}
	available := height - 5
	if available < 3 {
		available = 3
	}
	if available > len(m.options) {
		available = len(m.options)
	}

	start := m.cursor - (available / 2)
	if start < 0 {
		start = 0
	}
	if start+available > len(m.options) {
		start = len(m.options) - available
	}
	if start < 0 {
		start = 0
	}
	end := start + available
	if end > len(m.options) {
		end = len(m.options)
	}
	return m.options[start:end], start, start > 0, end < len(m.options)
}

func runSingleChoiceSelection(reader io.Reader, writer io.Writer, title string, help string, options []string, initial int) (string, error) {
	if len(options) == 0 {
		return "", fmt.Errorf("single-choice selection requires at least one option")
	}
	model := newSingleChoiceModel(title, help, options, initial)
	finalModel, err := tea.NewProgram(model, tea.WithInput(reader), tea.WithOutput(writer), tea.WithAltScreen()).Run()
	if err != nil {
		return "", fmt.Errorf("run selection %q: %w", title, err)
	}
	result, ok := finalModel.(singleChoiceModel)
	if !ok {
		return "", fmt.Errorf("unexpected single-choice model type %T", finalModel)
	}
	if result.canceled {
		return "", fmt.Errorf("selection canceled")
	}
	if result.cursor < 0 || result.cursor >= len(result.options) {
		return "", fmt.Errorf("selection cursor %d out of range", result.cursor)
	}
	fmt.Fprintln(writer)
	return result.options[result.cursor], nil
}
