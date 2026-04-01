package cli

import (
	"fmt"
	"io"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// pianistSelectionModel is a deliberately small one-screen Bubble Tea model
// used only during onboarding. It exists so pianist curation can use real key
// bindings without pulling the main TUI into the setup flow.
type pianistSelectionModel struct {
	pianists []string
	selected map[int]bool
	cursor   int
	canceled bool
	width    int
	height   int
}

// newPianistSelectionModel starts with every pianist selected so onboarding
// keeps the old "accept the full default list" behavior unless the user opts out.
func newPianistSelectionModel(pianists []string) pianistSelectionModel {
	selected := make(map[int]bool, len(pianists))
	for idx := range pianists {
		selected[idx] = true
	}

	return pianistSelectionModel{
		pianists: append([]string(nil), pianists...),
		selected: selected,
	}
}

func (m pianistSelectionModel) Init() tea.Cmd {
	return nil
}

func (m pianistSelectionModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
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
			if m.cursor < len(m.pianists)-1 {
				m.cursor++
			}
		case " ":
			if m.selected[m.cursor] {
				delete(m.selected, m.cursor)
			} else {
				m.selected[m.cursor] = true
			}
		case "enter":
			return m, tea.Quit
		}
	}

	return m, nil
}

func (m pianistSelectionModel) View() string {
	width := m.width
	if width <= 0 {
		width = 80
	}

	var b strings.Builder
	b.WriteString("Select pianists for the initial allowlist.\n")
	b.WriteString("Up/down or j/k: move   space: toggle   enter: confirm   q: cancel\n")
	b.WriteString(fmt.Sprintf("Selected: %d of %d   Current: %d of %d\n\n", len(m.selected), len(m.pianists), m.cursor+1, len(m.pianists)))

	visible, offset, hiddenAbove, hiddenBelow := m.visiblePianists()
	if hiddenAbove {
		fmt.Fprintf(&b, "  ... %d more above\n", offset)
	}

	for idx, pianist := range visible {
		absoluteIdx := offset + idx
		cursor := " "
		if absoluteIdx == m.cursor {
			cursor = ">"
		}

		check := " "
		if m.selected[absoluteIdx] {
			check = "x"
		}

		line := fmt.Sprintf("%s [%s] %s", cursor, check, pianist)
		style := lipgloss.NewStyle().MaxWidth(width)
		if absoluteIdx == m.cursor {
			style = style.Bold(true)
		}
		fmt.Fprintln(&b, style.Render(line))
	}

	if hiddenBelow {
		fmt.Fprintf(&b, "  ... %d more below\n", len(m.pianists)-(offset+len(visible)))
	}

	if len(m.selected) == 0 {
		b.WriteString("\nSelect at least one pianist before confirming.\n")
	}

	return b.String()
}

// visiblePianists keeps the cursor centered in the visible window when possible
// so large seed lists remain usable in smaller terminals.
func (m pianistSelectionModel) visiblePianists() (pianists []string, offset int, hiddenAbove bool, hiddenBelow bool) {
	if len(m.pianists) == 0 {
		return nil, 0, false, false
	}

	height := m.height
	if height <= 0 {
		height = 24
	}

	available := height - 6
	if available < 3 {
		available = 3
	}
	if available > len(m.pianists) {
		available = len(m.pianists)
	}

	start := m.cursor - (available / 2)
	if start < 0 {
		start = 0
	}
	if start+available > len(m.pianists) {
		start = len(m.pianists) - available
	}
	if start < 0 {
		start = 0
	}

	end := start + available
	if end > len(m.pianists) {
		end = len(m.pianists)
	}

	return m.pianists[start:end], start, start > 0, end < len(m.pianists)
}

// selectedPianists converts the internal toggle map back into a stable,
// allowlist-ready slice in original display order.
func (m pianistSelectionModel) selectedPianists() ([]string, error) {
	if len(m.pianists) == 0 {
		return nil, fmt.Errorf("selection source must not be empty")
	}
	if len(m.selected) == 0 {
		return nil, fmt.Errorf("selection must include at least one pianist")
	}

	selected := make([]string, 0, len(m.selected))
	for idx, pianist := range m.pianists {
		if m.selected[idx] {
			selected = append(selected, pianist)
		}
	}

	return selected, nil
}

// promptPianistSelection runs the alternate-screen picker with raw terminal
// input so arrow keys and space toggles work correctly.
func promptPianistSelection(reader io.Reader, writer io.Writer, pianists []string) ([]string, error) {
	model := newPianistSelectionModel(pianists)

	finalModel, err := tea.NewProgram(model, tea.WithInput(reader), tea.WithOutput(writer), tea.WithAltScreen()).Run()
	if err != nil {
		return nil, fmt.Errorf("run pianist selection: %w", err)
	}

	result, ok := finalModel.(pianistSelectionModel)
	if !ok {
		return nil, fmt.Errorf("unexpected pianist selection model type %T", finalModel)
	}
	if result.canceled {
		return nil, fmt.Errorf("pianist selection canceled")
	}

	selected, err := result.selectedPianists()
	if err != nil {
		return nil, err
	}

	fmt.Fprintln(writer)
	return selected, nil
}
