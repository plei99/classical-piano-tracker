package cli

import (
	"fmt"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/plei99/classical-piano-tracker/internal/tui"
	"github.com/spf13/cobra"
)

func newTUICmd(opts *rootOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "tui",
		Short: "Browse local tracks in a read-only terminal UI",
		RunE: func(cmd *cobra.Command, args []string) error {
			databasePath, err := opts.resolveDBPath()
			if err != nil {
				return err
			}

			queries, closeDB, err := openQueries(cmd.Context(), databasePath)
			if err != nil {
				return err
			}
			defer closeDB()

			model := tui.NewModel(queries)
			program := tea.NewProgram(model, tea.WithAltScreen())
			if _, err := program.Run(); err != nil {
				return fmt.Errorf("run tracker TUI: %w", err)
			}

			return nil
		},
	}
}
