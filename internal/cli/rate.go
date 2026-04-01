package cli

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/plei99/classical-piano-tracker/internal/db"
	"github.com/spf13/cobra"
)

func newRateCmd(opts *rootOptions) *cobra.Command {
	var (
		trackID   int64
		spotifyID string
		stars     int
		opinion   string
	)

	cmd := &cobra.Command{
		Use:   "rate",
		Short: "Rate a locally synced track by ID",
		Example: "  tracker rate --track-id 12 --stars 5 --opinion \"Explosive and clear\"\n" +
			"  tracker rate --spotify-id 4uLU6hMCjMI75M1A2tKUQC --stars 4",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := validateStrictRateInput(trackID, spotifyID, stars); err != nil {
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

			track, err := resolveTrackByIdentifier(cmd.Context(), queries, trackID, spotifyID)
			if err != nil {
				return err
			}

			return saveAndPrintRating(cmd.Context(), queries, cmd.OutOrStdout(), track, stars, opinion)
		},
	}

	cmd.Flags().Int64Var(&trackID, "track-id", 0, "local track ID to rate")
	cmd.Flags().StringVar(&spotifyID, "spotify-id", "", "Spotify track ID to rate")
	cmd.Flags().IntVar(&stars, "stars", 0, "star rating to save (1-5)")
	cmd.Flags().StringVar(&opinion, "opinion", "", "free-form opinion to store with the rating")

	return cmd
}

func validateStrictRateInput(trackID int64, spotifyID string, stars int) error {
	if trackID != 0 && strings.TrimSpace(spotifyID) != "" {
		return errors.New("only one of --track-id or --spotify-id may be provided")
	}
	if trackID == 0 && strings.TrimSpace(spotifyID) == "" {
		return errors.New("one of --track-id or --spotify-id is required")
	}
	if stars < 1 || stars > 5 {
		return fmt.Errorf("stars must be between 1 and 5, got %d", stars)
	}

	return nil
}

func resolveTrackByIdentifier(ctx context.Context, queries *db.Queries, trackID int64, spotifyID string) (db.Track, error) {
	switch {
	case trackID != 0:
		track, err := queries.GetTrackByID(ctx, trackID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return db.Track{}, fmt.Errorf("track %d not found", trackID)
			}
			return db.Track{}, fmt.Errorf("lookup track %d: %w", trackID, err)
		}
		return track, nil
	case strings.TrimSpace(spotifyID) != "":
		track, err := queries.GetTrackBySpotifyID(ctx, spotifyID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return db.Track{}, fmt.Errorf("track with spotify_id %q not found", spotifyID)
			}
			return db.Track{}, fmt.Errorf("lookup track %q: %w", spotifyID, err)
		}
		return track, nil
	default:
		return db.Track{}, errors.New("track identifier is required")
	}
}

func saveAndPrintRating(ctx context.Context, queries *db.Queries, outWriter io.Writer, track db.Track, stars int, opinion string) error {
	rating, err := queries.UpsertRating(ctx, db.UpsertRatingParams{
		TrackID:   track.ID,
		Stars:     int64(stars),
		Opinion:   opinion,
		UpdatedAt: time.Now().Unix(),
	})
	if err != nil {
		return fmt.Errorf("save rating for track %d: %w", track.ID, err)
	}

	fmt.Fprintf(outWriter, "saved rating for track %d\n", track.ID)
	fmt.Fprintf(outWriter, "title: %s\n", track.TrackName)
	fmt.Fprintf(outWriter, "artists: %s\n", formatTrackArtists(track))
	fmt.Fprintf(outWriter, "stars: %d\n", rating.Stars)
	if rating.Opinion != "" {
		fmt.Fprintf(outWriter, "opinion: %s\n", rating.Opinion)
	}

	return nil
}

func formatTrackChoice(track db.Track) string {
	return fmt.Sprintf(
		"%s | %s | %s | play_count=%d | id=%d",
		time.Unix(track.LastPlayedAt, 0).Format("2006-01-02 15:04:05"),
		track.TrackName,
		formatTrackArtists(track),
		track.PlayCount,
		track.ID,
	)
}

func formatTrackArtists(track db.Track) string {
	var artists []string
	if err := json.Unmarshal([]byte(track.Artists), &artists); err != nil || len(artists) == 0 {
		return track.Artists
	}

	return strings.Join(artists, ", ")
}
