package cli

import (
	"context"
	"fmt"

	"github.com/plei99/classical-piano-tracker/internal/db"
	"github.com/spf13/cobra"
)

func newListCmd(opts *rootOptions) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List locally synced tracks and their IDs",
		Example: "  tracker list recent\n" +
			"  tracker list top --limit 20\n" +
			"  tracker list unrated",
	}

	cmd.AddCommand(
		newListRecentCmd(opts),
		newListUnratedCmd(opts),
		newListTopCmd(opts),
	)

	return cmd
}

func newListRecentCmd(opts *rootOptions) *cobra.Command {
	var limit int

	cmd := &cobra.Command{
		Use:   "recent",
		Short: "List recent local tracks",
		Example: "  tracker list recent\n" +
			"  tracker --db ~/tmp/tracker.db list recent --limit 25",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runTrackList(cmd.Context(), cmd, opts, limit, func(ctx context.Context, queries *db.Queries, listLimit int64) ([]db.Track, error) {
				return queries.ListRecentTracks(ctx, listLimit)
			})
		},
	}

	cmd.Flags().IntVar(&limit, "limit", 10, "maximum number of tracks to list")
	return cmd
}

func newListUnratedCmd(opts *rootOptions) *cobra.Command {
	var limit int

	cmd := &cobra.Command{
		Use:   "unrated",
		Short: "List unrated local tracks",
		Example: "  tracker list unrated\n" +
			"  tracker list unrated --limit 15",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runTrackList(cmd.Context(), cmd, opts, limit, func(ctx context.Context, queries *db.Queries, listLimit int64) ([]db.Track, error) {
				return queries.ListUnratedTracks(ctx, listLimit)
			})
		},
	}

	cmd.Flags().IntVar(&limit, "limit", 10, "maximum number of tracks to list")
	return cmd
}

func newListTopCmd(opts *rootOptions) *cobra.Command {
	var limit int

	cmd := &cobra.Command{
		Use:   "top",
		Short: "List top-played local tracks",
		Example: "  tracker list top\n" +
			"  tracker list top --limit 20",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runTrackList(cmd.Context(), cmd, opts, limit, func(ctx context.Context, queries *db.Queries, listLimit int64) ([]db.Track, error) {
				return queries.ListTopPlayedTracks(ctx, listLimit)
			})
		},
	}

	cmd.Flags().IntVar(&limit, "limit", 10, "maximum number of tracks to list")
	return cmd
}

func runTrackList(
	ctx context.Context,
	cmd *cobra.Command,
	opts *rootOptions,
	limit int,
	listFn func(context.Context, *db.Queries, int64) ([]db.Track, error),
) error {
	if limit < 1 {
		return fmt.Errorf("limit must be at least 1, got %d", limit)
	}

	databasePath, err := opts.resolveDBPath()
	if err != nil {
		return err
	}

	queries, closeDB, err := openQueries(ctx, databasePath)
	if err != nil {
		return err
	}
	defer closeDB()

	tracks, err := listFn(ctx, queries, int64(limit))
	if err != nil {
		return err
	}
	if len(tracks) == 0 {
		cmd.Println("no tracks found")
		return nil
	}

	for _, track := range tracks {
		cmd.Printf("%s\n", formatTrackChoice(track))
	}

	return nil
}
