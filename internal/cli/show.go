package cli

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/spf13/cobra"
)

func newShowCmd(opts *rootOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "show <track-id>",
		Short: "Show details for a local track",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			trackID, err := parsePositiveInt64(args[0], "track ID")
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

			track, err := queries.GetTrackByID(cmd.Context(), trackID)
			if err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					return fmt.Errorf("track %d not found", trackID)
				}
				return fmt.Errorf("lookup track %d: %w", trackID, err)
			}

			cmd.Printf("id: %d\n", track.ID)
			cmd.Printf("spotify_id: %s\n", track.SpotifyID)
			cmd.Printf("title: %s\n", track.TrackName)
			cmd.Printf("album: %s\n", track.AlbumName)
			cmd.Printf("artists: %s\n", formatTrackArtists(track))
			cmd.Printf("play_count: %d\n", track.PlayCount)
			cmd.Printf("last_played_at: %s\n", time.Unix(track.LastPlayedAt, 0).Format(time.RFC3339))

			rating, err := queries.GetRatingByTrackID(cmd.Context(), track.ID)
			switch {
			case err == nil:
				cmd.Printf("rating_stars: %d\n", rating.Stars)
				if rating.Opinion != "" {
					cmd.Printf("rating_opinion: %s\n", rating.Opinion)
				}
				cmd.Printf("rating_updated_at: %s\n", time.Unix(rating.UpdatedAt, 0).Format(time.RFC3339))
			case errors.Is(err, sql.ErrNoRows):
				cmd.Println("rating: none")
			default:
				return fmt.Errorf("lookup rating for track %d: %w", track.ID, err)
			}

			return nil
		},
	}
}
