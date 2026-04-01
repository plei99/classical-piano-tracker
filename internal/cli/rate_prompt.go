package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/plei99/classical-piano-tracker/internal/db"
	"github.com/spf13/cobra"
)

const defaultRateSelectionLimit = 10

func newRatePromptCmd(opts *rootOptions) *cobra.Command {
	var (
		unrated bool
		limit   int
	)

	cmd := &cobra.Command{
		Use:   "rate-prompt",
		Short: "Choose a local track interactively and rate it",
		Example: "  tracker rate-prompt\n" +
			"  tracker rate-prompt --unrated",
		RunE: func(cmd *cobra.Command, args []string) error {
			if limit < 1 {
				return fmt.Errorf("limit must be at least 1, got %d", limit)
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

			track, err := chooseTrackForRating(cmd.Context(), queries, os.Stdin, cmd.OutOrStdout(), unrated, limit)
			if err != nil {
				return err
			}

			stars, opinion, err := promptRating(os.Stdin, cmd.OutOrStdout())
			if err != nil {
				return err
			}

			return saveAndPrintRating(cmd.Context(), queries, cmd.OutOrStdout(), track, stars, opinion)
		},
	}

	cmd.Flags().BoolVar(&unrated, "unrated", false, "select from unrated tracks instead of recent tracks")
	cmd.Flags().IntVar(&limit, "limit", defaultRateSelectionLimit, "number of candidate tracks to list for interactive selection")

	return cmd
}

func chooseTrackForRating(
	ctx context.Context,
	queries *db.Queries,
	in io.Reader,
	out io.Writer,
	unrated bool,
	limit int,
) (db.Track, error) {
	var (
		candidates []db.Track
		err        error
		label      string
	)

	if unrated {
		candidates, err = queries.ListUnratedTracks(ctx, int64(limit))
		label = "unrated"
	} else {
		candidates, err = queries.ListRecentTracks(ctx, int64(limit))
		label = "recent"
	}
	if err != nil {
		return db.Track{}, fmt.Errorf("list %s tracks: %w", label, err)
	}
	if len(candidates) == 0 {
		return db.Track{}, fmt.Errorf("no %s tracks available to rate", label)
	}
	if len(candidates) == 1 {
		fmt.Fprintf(out, "selected only available %s track: %s\n", label, formatTrackChoice(candidates[0]))
		return candidates[0], nil
	}

	fmt.Fprintf(out, "select a %s track to rate:\n", label)
	for idx, track := range candidates {
		fmt.Fprintf(out, "%d. %s\n", idx+1, formatTrackChoice(track))
	}

	return promptTrackSelection(in, out, candidates)
}

func promptTrackSelection(in io.Reader, out io.Writer, candidates []db.Track) (db.Track, error) {
	reader := bufio.NewReader(in)

	for {
		fmt.Fprintf(out, "enter choice [1-%d]: ", len(candidates))
		line, err := reader.ReadString('\n')
		if err != nil {
			if errors.Is(err, io.EOF) {
				return db.Track{}, errors.New("rating selection aborted")
			}
			return db.Track{}, fmt.Errorf("read track selection: %w", err)
		}

		choice, err := strconv.Atoi(strings.TrimSpace(line))
		if err != nil || choice < 1 || choice > len(candidates) {
			fmt.Fprintf(out, "invalid choice, enter a number between 1 and %d\n", len(candidates))
			continue
		}

		return candidates[choice-1], nil
	}
}

func promptRating(in io.Reader, out io.Writer) (int, string, error) {
	reader := bufio.NewReader(in)

	var stars int
	for {
		fmt.Fprint(out, "enter stars [1-5]: ")
		line, err := reader.ReadString('\n')
		if err != nil {
			if errors.Is(err, io.EOF) {
				return 0, "", errors.New("rating prompt aborted")
			}
			return 0, "", fmt.Errorf("read stars: %w", err)
		}

		value, err := strconv.Atoi(strings.TrimSpace(line))
		if err != nil || value < 1 || value > 5 {
			fmt.Fprintln(out, "invalid rating, enter a number between 1 and 5")
			continue
		}

		stars = value
		break
	}

	fmt.Fprint(out, "enter opinion (optional): ")
	opinion, err := reader.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return 0, "", fmt.Errorf("read opinion: %w", err)
	}

	return stars, strings.TrimSpace(opinion), nil
}
