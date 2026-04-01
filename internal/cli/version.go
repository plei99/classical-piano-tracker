package cli

import (
	"fmt"

	"github.com/plei99/classical-piano-tracker/internal/buildinfo"
	"github.com/spf13/cobra"
)

func newVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print build and version metadata",
		Example: "  tracker version\n" +
			"  tracker --version",
		Run: func(cmd *cobra.Command, args []string) {
			fmt.Fprintf(cmd.OutOrStdout(), "tracker %s\n", buildinfo.Version)
			fmt.Fprintf(cmd.OutOrStdout(), "commit: %s\n", buildinfo.Commit)
			fmt.Fprintf(cmd.OutOrStdout(), "built:  %s\n", buildinfo.Date)
		},
	}
}
