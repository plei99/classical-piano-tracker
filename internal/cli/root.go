package cli

import "github.com/spf13/cobra"

// NewRootCmd builds the top-level tracker CLI command.
func NewRootCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:           "tracker",
		Short:         "Track and rate classical piano listening history from Spotify",
		SilenceUsage:  true,
		SilenceErrors: true,
	}

	return cmd
}
