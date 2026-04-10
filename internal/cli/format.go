package cli

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"
	"unicode/utf8"

	"github.com/charmbracelet/x/term"
	"github.com/plei99/classical-piano-tracker/internal/recommend"
	spotifyclient "github.com/plei99/classical-piano-tracker/internal/spotify"
)

const fallbackOutputWidth = 100

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

// printTasteProfile renders the profile snapshot sent to the LLM, excluding
// the internal discovery-guidance prompt text.
func printTasteProfile(out io.Writer, summary recommend.TasteSummary) {
	width := outputWidth(out)
	fmt.Fprintf(
		out,
		"Tracks: %d\nRatings: %d\nComments: %d\nKnown Pianists: %d\n\n",
		summary.TotalTracks,
		summary.TotalRatings,
		summary.CommentCount,
		len(summary.KnownPianists),
	)

	fmt.Fprintln(out, "Favorite Pianists")
	if len(summary.FavoritePianists) == 0 {
		fmt.Fprintln(out, "  none")
	} else {
		writer := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
		fmt.Fprintln(writer, "  #\tPianist\tAvg Stars\tRated Tracks\tTotal Plays")
		for idx, pianist := range summary.FavoritePianists {
			fmt.Fprintf(
				writer,
				"  %d\t%s\t%.2f\t%d\t%d\n",
				idx+1,
				pianist.Name,
				pianist.AverageStars,
				pianist.RatedTrackCount,
				pianist.TotalPlayCount,
			)
		}
		_ = writer.Flush()
	}

	fmt.Fprintln(out)
	printTasteTracks(out, "Loved Tracks", summary.LovedTracks, width)
	fmt.Fprintln(out)
	printTasteTracks(out, "Disliked Tracks", summary.DislikedTracks, width)
	fmt.Fprintln(out)
	printTasteTracks(out, "Commented Tracks", summary.CommentedTracks, width)
	fmt.Fprintln(out)
	printWrappedField(out, "Known Pianists: ", "                ", strings.Join(summary.KnownPianists, ", "), width)
}

func printTasteTracks(out io.Writer, heading string, tracks []recommend.TasteTrack, width int) {
	fmt.Fprintln(out, heading)
	if len(tracks) == 0 {
		fmt.Fprintln(out, "  none")
		return
	}

	for idx, track := range tracks {
		fmt.Fprintf(out, "  %d. [%d] %s\n", idx+1, track.TrackID, track.TrackName)
		printWrappedField(out, "     Artists: ", "              ", strings.Join(track.Artists, ", "), width)
		if strings.TrimSpace(track.MatchedArtist) != "" {
			fmt.Fprintf(out, "     Matched: %s\n", track.MatchedArtist)
		}
		if strings.TrimSpace(track.AlbumName) != "" {
			printWrappedField(out, "     Album:   ", "              ", track.AlbumName, width)
		}
		fmt.Fprintf(out, "     Stars:   %d/5\n", track.Stars)
		fmt.Fprintf(out, "     Plays:   %d\n", track.PlayCount)
		if strings.TrimSpace(track.Opinion) != "" {
			printWrappedField(out, "     Opinion: ", "              ", track.Opinion, width)
		}
		if idx < len(tracks)-1 {
			fmt.Fprintln(out)
		}
	}
}

// printValidatedPianists renders the validated subset of LLM suggestions after
// Spotify catalog lookup has attached IDs and genres.
func printValidatedPianists(out io.Writer, summary string, pianists []recommend.ValidatedPianist) {
	width := outputWidth(out)
	printWrappedField(out, "Summary: ", "", summary, width)
	fmt.Fprintln(out)
	for idx, pianist := range pianists {
		fmt.Fprintf(out, "%d. %s\n", idx+1, pianist.SpotifyName)
		fmt.Fprintf(out, "   Spotify ID: %s\n", pianist.SpotifyID)
		if len(pianist.Genres) > 0 {
			printWrappedField(out, "   Genres:     ", "               ", strings.Join(pianist.Genres, ", "), width)
		}
		if len(pianist.SimilarTo) > 0 {
			printWrappedField(out, "   Similar to: ", "               ", strings.Join(pianist.SimilarTo, ", "), width)
		}
		printWrappedField(out, "   Why:        ", "               ", pianist.WhyFit, width)
		if strings.TrimSpace(pianist.Confidence) != "" {
			fmt.Fprintf(out, "   Confidence: %s\n", pianist.Confidence)
		}
		if idx < len(pianists)-1 {
			fmt.Fprintln(out)
		}
	}
}

func outputWidth(out io.Writer) int {
	type fdWriter interface {
		Fd() uintptr
	}

	if file, ok := out.(fdWriter); ok {
		if width, _, err := term.GetSize(file.Fd()); err == nil && width >= 40 {
			return width
		}
	}

	if columns, err := strconv.Atoi(strings.TrimSpace(os.Getenv("COLUMNS"))); err == nil && columns >= 40 {
		return columns
	}

	return fallbackOutputWidth
}

func printWrappedField(out io.Writer, firstPrefix string, nextPrefix string, value string, width int) {
	text := strings.Join(strings.Fields(value), " ")
	if text == "" {
		fmt.Fprintln(out, strings.TrimRight(firstPrefix, " "))
		return
	}

	linePrefix := firstPrefix
	available := max(20, width-utf8.RuneCountInString(linePrefix))
	current := strings.Builder{}

	for _, word := range strings.Fields(text) {
		if current.Len() == 0 {
			current.WriteString(word)
			continue
		}

		if utf8.RuneCountInString(current.String())+1+utf8.RuneCountInString(word) <= available {
			current.WriteByte(' ')
			current.WriteString(word)
			continue
		}

		fmt.Fprintln(out, linePrefix+current.String())
		linePrefix = nextPrefix
		available = max(20, width-utf8.RuneCountInString(linePrefix))
		current.Reset()
		current.WriteString(word)
	}

	if current.Len() > 0 {
		fmt.Fprintln(out, linePrefix+current.String())
	}
}
