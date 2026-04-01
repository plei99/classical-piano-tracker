package cli

import (
	"fmt"
	"io"
	"strings"
	"text/tabwriter"

	"github.com/plei99/classical-piano-tracker/internal/recommend"
	spotifyclient "github.com/plei99/classical-piano-tracker/internal/spotify"
)

// printRecentSpotifyTracks renders recent-play output in a human-scannable
// block format instead of the older single-line dump.
func printRecentSpotifyTracks(out io.Writer, tracks []spotifyclient.RecentTrack) {
	for idx, track := range tracks {
		fmt.Fprintf(out, "%d. %s\n", idx+1, track.Name)
		fmt.Fprintf(out, "   Artists: %s\n", strings.Join(track.ArtistNames(), ", "))
		if strings.TrimSpace(track.AlbumName) != "" {
			fmt.Fprintf(out, "   Album:   %s\n", track.AlbumName)
		}
		fmt.Fprintf(out, "   Played:  %s\n", track.PlayedAt.Format("2006-01-02 15:04:05"))
		if idx < len(tracks)-1 {
			fmt.Fprintln(out)
		}
	}
}

// printFavoritePianists renders deterministic pianist scores as a compact
// aligned table for CLI use.
func printFavoritePianists(out io.Writer, profiles []recommend.PianistProfile) {
	writer := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	fmt.Fprintln(writer, "#\tPianist\tScore\tAvg Stars\tRated Tracks\tTotal Plays")
	for idx, profile := range profiles {
		fmt.Fprintf(
			writer,
			"%d\t%s\t%.2f\t%.2f\t%d\t%d\n",
			idx+1,
			profile.Name,
			profile.FavoriteScore,
			profile.AverageStars,
			profile.RatedTrackCount,
			profile.TotalPlayCount,
		)
	}
	_ = writer.Flush()
}

// printValidatedPianists renders the validated subset of LLM suggestions after
// Spotify catalog lookup has attached IDs, genres, and popularity.
func printValidatedPianists(out io.Writer, summary string, pianists []recommend.ValidatedPianist) {
	fmt.Fprintf(out, "Summary: %s\n\n", summary)
	for idx, pianist := range pianists {
		fmt.Fprintf(out, "%d. %s\n", idx+1, pianist.SpotifyName)
		fmt.Fprintf(out, "   Spotify ID: %s\n", pianist.SpotifyID)
		fmt.Fprintf(out, "   Popularity: %d\n", pianist.Popularity)
		if len(pianist.Genres) > 0 {
			fmt.Fprintf(out, "   Genres:     %s\n", strings.Join(pianist.Genres, ", "))
		}
		if len(pianist.SimilarTo) > 0 {
			fmt.Fprintf(out, "   Similar to: %s\n", strings.Join(pianist.SimilarTo, ", "))
		}
		fmt.Fprintf(out, "   Why:        %s\n", pianist.WhyFit)
		if strings.TrimSpace(pianist.Confidence) != "" {
			fmt.Fprintf(out, "   Confidence: %s\n", pianist.Confidence)
		}
		if idx < len(pianists)-1 {
			fmt.Fprintln(out)
		}
	}
}
