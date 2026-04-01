package cli

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestPianistSelectionModelToggleAndSelectionOrder(t *testing.T) {
	t.Parallel()

	model := newPianistSelectionModel([]string{"A", "B", "C"})

	updated, _ := model.Update(tea.KeyMsg{Type: tea.KeySpace})
	model = updated.(pianistSelectionModel)

	updated, _ = model.Update(tea.KeyMsg{Type: tea.KeyDown})
	model = updated.(pianistSelectionModel)

	updated, _ = model.Update(tea.KeyMsg{Type: tea.KeySpace})
	model = updated.(pianistSelectionModel)

	selected, err := model.selectedPianists()
	if err != nil {
		t.Fatalf("selectedPianists() error = %v", err)
	}

	want := []string{"C"}
	if len(selected) != len(want) {
		t.Fatalf("selected len = %d, want %d", len(selected), len(want))
	}
	for idx := range want {
		if selected[idx] != want[idx] {
			t.Fatalf("selected[%d] = %q, want %q", idx, selected[idx], want[idx])
		}
	}
}

func TestPianistSelectionModelRejectsEmptySelection(t *testing.T) {
	t.Parallel()

	model := newPianistSelectionModel([]string{"A"})

	updated, _ := model.Update(tea.KeyMsg{Type: tea.KeySpace})
	model = updated.(pianistSelectionModel)

	if _, err := model.selectedPianists(); err == nil {
		t.Fatal("selectedPianists() error = nil, want error")
	}
}

func TestPianistSelectionModelViewIncludesControls(t *testing.T) {
	t.Parallel()

	view := newPianistSelectionModel([]string{"A", "B"}).View()
	for _, want := range []string{
		"space: toggle",
		"enter: confirm",
		"[x] A",
	} {
		if !strings.Contains(view, want) {
			t.Fatalf("view = %q, want %q", view, want)
		}
	}
}

func TestPianistSelectionModelVisiblePianistsTracksCursorWindow(t *testing.T) {
	t.Parallel()

	model := newPianistSelectionModel([]string{"A", "B", "C", "D", "E", "F", "G", "H"})
	model.height = 10
	model.cursor = 6

	visible, offset, hiddenAbove, hiddenBelow := model.visiblePianists()
	if offset != 4 {
		t.Fatalf("offset = %d, want 4", offset)
	}
	if !hiddenAbove {
		t.Fatal("hiddenAbove = false, want true")
	}
	if hiddenBelow {
		t.Fatal("hiddenBelow = true, want false")
	}
	want := []string{"E", "F", "G", "H"}
	if len(visible) != len(want) {
		t.Fatalf("visible len = %d, want %d", len(visible), len(want))
	}
	for idx := range want {
		if visible[idx] != want[idx] {
			t.Fatalf("visible[%d] = %q, want %q", idx, visible[idx], want[idx])
		}
	}
}

func TestPianistSelectionModelViewShowsOverflowHints(t *testing.T) {
	t.Parallel()

	model := newPianistSelectionModel([]string{"A", "B", "C", "D", "E", "F", "G", "H"})
	model.height = 10
	model.cursor = 3

	view := model.View()
	for _, want := range []string{
		"... 1 more above",
		"... 3 more below",
	} {
		if !strings.Contains(view, want) {
			t.Fatalf("view = %q, want %q", view, want)
		}
	}
}
