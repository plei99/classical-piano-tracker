package cli

import (
	"context"
	"fmt"

	"github.com/plei99/classical-piano-tracker/internal/config"
	"github.com/plei99/classical-piano-tracker/internal/db"
	"github.com/plei99/classical-piano-tracker/internal/spotify"
	"github.com/plei99/classical-piano-tracker/internal/syncer"
	"github.com/spf13/cobra"
)

func newSyncCmd(opts *rootOptions) *cobra.Command {
	var limit int

	cmd := &cobra.Command{
		Use:   "sync",
		Short: "Sync recent Spotify plays into the local SQLite database",
		Example: "  tracker sync\n" +
			"  tracker sync --limit 25\n" +
			"  tracker --config ~/custom-config.json --db ~/custom-tracker.db sync",
		RunE: func(cmd *cobra.Command, args []string) error {
			configPath, err := opts.resolveConfigPath()
			if err != nil {
				return err
			}

			cfg, created, err := ensureLoadedConfig(configPath)
			if err != nil {
				return err
			}
			if created {
				return createdConfigError(configPath, fmt.Sprintf("set spotify.client_id and spotify.client_secret, run `tracker --config %q spotify login`, then rerun `tracker sync`", configPath))
			}

			if err := validateSyncConfig(cfg, configPath); err != nil {
				return err
			}

			databasePath, err := opts.resolveDBPath()
			if err != nil {
				return err
			}

			client, err := spotify.NewClient(cmd.Context(), cfg.Spotify, func(token *spotify.OAuthToken) error {
				cfg.Spotify.Token = config.TokenFromOAuth(token.Token, cfg.Spotify.Token)
				return config.Save(configPath, cfg)
			})
			if err != nil {
				return err
			}

			queries, closeDB, err := openQueries(cmd.Context(), databasePath)
			if err != nil {
				return err
			}
			defer closeDB()

			stats, err := syncer.Run(cmd.Context(), cfg, client, queries, limit)
			if err != nil {
				return err
			}

			cmd.Printf("database: %s\n", databasePath)
			cmd.Printf("fetched: %d\n", stats.Fetched)
			cmd.Printf("blocked: %d\n", stats.Blocked)
			cmd.Printf("skipped: %d\n", stats.Skipped)
			cmd.Printf("accepted: %d\n", stats.Accepted)
			cmd.Printf("inserted: %d\n", stats.Inserted)
			cmd.Printf("updated: %d\n", stats.Updated)

			return nil
		},
	}

	cmd.Flags().IntVar(&limit, "limit", 50, "maximum number of recent plays to fetch from Spotify (1-50)")

	return cmd
}

func openQueries(ctx context.Context, databasePath string) (*db.Queries, func(), error) {
	conn, err := db.Open(databasePath)
	if err != nil {
		return nil, nil, err
	}

	if err := db.Init(ctx, conn); err != nil {
		_ = conn.Close()
		return nil, nil, err
	}

	return db.New(conn), func() {
		_ = conn.Close()
	}, nil
}

func validateSyncConfig(cfg *config.Config, configPath string) error {
	if err := cfg.Validate(); err != nil {
		return fmt.Errorf("invalid config %q: %w", configPath, err)
	}
	if err := cfg.Spotify.ValidateStoredToken(); err != nil {
		return fmt.Errorf("spotify login required for %q: %w", configPath, err)
	}
	return nil
}

var _ syncer.TrackStore = (*db.Queries)(nil)
