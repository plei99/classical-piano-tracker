package cli

import (
	"github.com/plei99/classical-piano-tracker/internal/config"
	"github.com/plei99/classical-piano-tracker/internal/paths"
	"github.com/spf13/cobra"
)

// NewRootCmd builds the top-level tracker CLI command.
func NewRootCmd() *cobra.Command {
	opts := &rootOptions{}
	defaultConfigPath, _ := config.DefaultPath()
	defaultDBPath, _ := paths.DefaultDBPath()

	cmd := &cobra.Command{
		Use:           "tracker",
		Short:         "Track and rate classical piano listening history from Spotify",
		Long:          "Track and rate classical piano listening history from Spotify.",
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}

	cmd.PersistentFlags().StringVar(
		&opts.configPath,
		"config",
		defaultConfigPath,
		"path to the config file",
	)
	cmd.PersistentFlags().StringVar(
		&opts.dbPath,
		"db",
		defaultDBPath,
		"path to the SQLite database file",
	)

	cmd.AddCommand(newConfigCmd(opts))
	cmd.AddCommand(newListCmd(opts))
	cmd.AddCommand(newRateCmd(opts))
	cmd.AddCommand(newRatePromptCmd(opts))
	cmd.AddCommand(newShowCmd(opts))
	cmd.AddCommand(newSpotifyCmd(opts))
	cmd.AddCommand(newSyncCmd(opts))

	return cmd
}
