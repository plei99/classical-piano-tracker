package cli

import (
	"fmt"
	"strings"

	"github.com/plei99/classical-piano-tracker/internal/config"
	"github.com/plei99/classical-piano-tracker/internal/paths"
	"github.com/spf13/cobra"
)

// rootOptions carries global path overrides down into subcommands without
// forcing every package to know how config/db defaults are resolved.
type rootOptions struct {
	configPath string
	dbPath     string
}

func (o *rootOptions) resolveConfigPath() (string, error) {
	if o.configPath != "" {
		return o.configPath, nil
	}

	return config.DefaultPath()
}

func (o *rootOptions) resolveDBPath() (string, error) {
	if o.dbPath != "" {
		return o.dbPath, nil
	}

	return paths.DefaultDBPath()
}

func newConfigCmd(opts *rootOptions) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "config",
		Short: "Inspect and validate local configuration",
	}

	cmd.AddCommand(
		newConfigAllowlistCmd(opts),
		newConfigBlocklistCmd(opts),
		newConfigPathCmd(opts),
		newConfigValidateCmd(opts),
	)

	return cmd
}

func newConfigAllowlistCmd(opts *rootOptions) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "allowlist",
		Short: "Inspect and edit pianists_allowlist entries",
	}

	cmd.AddCommand(
		newConfigArtistListPrintCmd(opts, "list", "Print pianists_allowlist entries", func(cfg *config.Config) []string {
			return cfg.PianistsAllowlist
		}),
		newConfigArtistAddCmd(opts, "add", "Add an artist to pianists_allowlist", func(cfg *config.Config, artist string) (bool, error) {
			updated, added, err := config.AddArtist(cfg.PianistsAllowlist, artist)
			if err != nil {
				return false, err
			}
			cfg.PianistsAllowlist = updated
			return added, nil
		}),
		newConfigArtistRemoveCmd(opts, "remove", "Remove an artist from pianists_allowlist", func(cfg *config.Config, artist string) (bool, error) {
			updated, removed, err := config.RemoveArtist(cfg.PianistsAllowlist, artist)
			if err != nil {
				return false, err
			}
			cfg.PianistsAllowlist = updated
			return removed, nil
		}),
	)

	return cmd
}

func newConfigBlocklistCmd(opts *rootOptions) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "blocklist",
		Short: "Inspect and edit artists_blocklist entries",
	}

	cmd.AddCommand(
		newConfigArtistListPrintCmd(opts, "list", "Print artists_blocklist entries", func(cfg *config.Config) []string {
			return cfg.ArtistsBlocklist
		}),
		newConfigArtistAddCmd(opts, "add", "Add an artist to artists_blocklist", func(cfg *config.Config, artist string) (bool, error) {
			updated, added, err := config.AddArtist(cfg.ArtistsBlocklist, artist)
			if err != nil {
				return false, err
			}
			cfg.ArtistsBlocklist = updated
			return added, nil
		}),
		newConfigArtistRemoveCmd(opts, "remove", "Remove an artist from artists_blocklist", func(cfg *config.Config, artist string) (bool, error) {
			updated, removed, err := config.RemoveArtist(cfg.ArtistsBlocklist, artist)
			if err != nil {
				return false, err
			}
			cfg.ArtistsBlocklist = updated
			return removed, nil
		}),
	)

	return cmd
}

func newConfigArtistListPrintCmd(
	opts *rootOptions,
	use string,
	short string,
	items func(*config.Config) []string,
) *cobra.Command {
	return &cobra.Command{
		Use:   use,
		Short: short,
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, _, _, err := loadEditableConfig(opts)
			if err != nil {
				return err
			}

			entries := items(cfg)
			if len(entries) == 0 {
				cmd.Println("no entries")
				return nil
			}

			for idx, entry := range entries {
				cmd.Printf("%d. %s\n", idx+1, entry)
			}

			return nil
		},
	}
}

func newConfigArtistAddCmd(
	opts *rootOptions,
	use string,
	short string,
	mutate func(*config.Config, string) (bool, error),
) *cobra.Command {
	return &cobra.Command{
		Use:   use + " <artist>",
		Short: short,
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, configPath, created, err := loadEditableConfig(opts)
			if err != nil {
				return err
			}

			artist := strings.TrimSpace(args[0])
			added, err := mutate(cfg, artist)
			if err != nil {
				return err
			}

			if err := config.Save(configPath, cfg); err != nil {
				return fmt.Errorf("save config %q: %w", configPath, err)
			}

			if created {
				cmd.Printf("created default config at %s\n", configPath)
			}
			if added {
				cmd.Printf("added %q\n", artist)
			} else {
				cmd.Printf("%q is already present\n", artist)
			}

			return nil
		},
	}
}

func newConfigArtistRemoveCmd(
	opts *rootOptions,
	use string,
	short string,
	mutate func(*config.Config, string) (bool, error),
) *cobra.Command {
	return &cobra.Command{
		Use:   use + " <artist>",
		Short: short,
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, configPath, created, err := loadEditableConfig(opts)
			if err != nil {
				return err
			}

			artist := strings.TrimSpace(args[0])
			removed, err := mutate(cfg, artist)
			if err != nil {
				return err
			}

			if err := config.Save(configPath, cfg); err != nil {
				return fmt.Errorf("save config %q: %w", configPath, err)
			}

			if created {
				cmd.Printf("created default config at %s\n", configPath)
			}
			if removed {
				cmd.Printf("removed %q\n", artist)
			} else {
				cmd.Printf("%q was not present\n", artist)
			}

			return nil
		},
	}
}

func loadEditableConfig(opts *rootOptions) (*config.Config, string, bool, error) {
	configPath, err := opts.resolveConfigPath()
	if err != nil {
		return nil, "", false, err
	}

	cfg, created, err := ensureLoadedConfig(configPath)
	if err != nil {
		return nil, "", false, err
	}

	return cfg, configPath, created, nil
}

func newConfigPathCmd(opts *rootOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "path",
		Short: "Print the config file path",
		RunE: func(cmd *cobra.Command, args []string) error {
			path, err := opts.resolveConfigPath()
			if err != nil {
				return err
			}

			cmd.Println(path)
			return nil
		},
	}
}

func newConfigValidateCmd(opts *rootOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "validate",
		Short: "Validate the config file",
		RunE: func(cmd *cobra.Command, args []string) error {
			path, err := opts.resolveConfigPath()
			if err != nil {
				return err
			}

			cfg, created, err := ensureLoadedConfig(path)
			if err != nil {
				return err
			}

			if err := cfg.Validate(); err != nil {
				if created {
					return createdConfigError(path, fmt.Sprintf("fill the required values, then rerun `tracker --config %q config validate`: %v", path, err))
				}
				return fmt.Errorf("invalid config %q: %w", path, err)
			}

			cmd.Printf("config is valid: %s\n", path)
			return nil
		},
	}
}
