package cli

import (
	"context"
	"fmt"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/plei99/classical-piano-tracker/internal/config"
	"github.com/plei99/classical-piano-tracker/internal/db"
	"github.com/plei99/classical-piano-tracker/internal/spotify"
	"github.com/plei99/classical-piano-tracker/internal/syncer"
	"github.com/plei99/classical-piano-tracker/internal/tui"
	"github.com/spf13/cobra"
)

func newTUICmd(opts *rootOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "tui",
		Short: "Browse, sync, and rate tracks in a terminal UI",
		Example: "  tracker tui\n" +
			"  tracker --db ~/tmp/tracker.db tui",
		RunE: func(cmd *cobra.Command, args []string) error {
			configPath, err := opts.resolveConfigPath()
			if err != nil {
				return err
			}

			databasePath, err := opts.resolveDBPath()
			if err != nil {
				return err
			}

			queries, closeDB, err := openQueries(cmd.Context(), databasePath)
			if err != nil {
				return err
			}
			defer closeDB()

			model := tui.NewModel(
				queries,
				newTUISyncFunc(configPath, queries),
				newTUISaveRatingFunc(queries),
			)
			program := tea.NewProgram(model, tea.WithAltScreen())
			if _, err := program.Run(); err != nil {
				return fmt.Errorf("run tracker TUI: %w", err)
			}

			return nil
		},
	}
}

func newTUISyncFunc(configPath string, queries *db.Queries) tui.SyncFunc {
	return func(ctx context.Context) (syncer.Stats, error) {
		cfg, created, err := ensureLoadedConfig(configPath)
		if err != nil {
			return syncer.Stats{}, err
		}
		if created {
			return syncer.Stats{}, createdConfigError(configPath, fmt.Sprintf("set spotify.client_id and spotify.client_secret, run `tracker --config %q spotify login`, then retry sync from the TUI", configPath))
		}
		if err := validateSyncConfig(cfg, configPath); err != nil {
			return syncer.Stats{}, err
		}

		client, err := spotify.NewClient(ctx, cfg.Spotify, func(token *spotify.OAuthToken) error {
			cfg.Spotify.Token = config.TokenFromOAuth(token.Token, cfg.Spotify.Token)
			return config.Save(configPath, cfg)
		})
		if err != nil {
			return syncer.Stats{}, err
		}

		return syncer.Run(ctx, cfg, client, queries, 50)
	}
}

func newTUISaveRatingFunc(queries *db.Queries) tui.SaveRatingFunc {
	return func(ctx context.Context, arg db.UpsertRatingParams) (db.Rating, error) {
		return queries.UpsertRating(ctx, arg)
	}
}
