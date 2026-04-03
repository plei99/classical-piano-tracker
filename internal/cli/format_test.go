package cli

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/plei99/classical-piano-tracker/internal/recommend"
	spotifyclient "github.com/plei99/classical-piano-tracker/internal/spotify"
)

func TestPrintRecentSpotifyTracks(t *testing.T) {
	t.Parallel()

	var out bytes.Buffer
	printRecentSpotifyTracks(&out, []spotifyclient.RecentTrack{
		{
			Name:      "Piano Concerto No. 1",
			AlbumName: "Album One",
			Artists:   []spotifyclient.Artist{{Name: "Martha Argerich"}},
			PlayedAt:  time.Date(2026, time.April, 1, 12, 30, 0, 0, time.UTC),
		},
	})

	output := out.String()
	for _, want := range []string{
		"1. Piano Concerto No. 1",
		"Artists: Martha Argerich",
		"Album:   Album One",
		"Played:  2026-04-01 12:30:00",
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("output = %q, want %q", output, want)
		}
	}
}

func TestPrintFavoritePianists(t *testing.T) {
	t.Parallel()

	var out bytes.Buffer
	printFavoritePianists(&out, []recommend.PianistProfile{
		{
			Name:            "Martha Argerich",
			FavoriteScore:   98.42,
			AverageStars:    4.75,
			RatedTrackCount: 4,
			TotalPlayCount:  12,
		},
	})

	output := out.String()
	for _, want := range []string{
		"#",
		"Pianist",
		"Martha Argerich",
		"98.42",
		"4.75",
		"12",
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("output = %q, want %q", output, want)
		}
	}
}

func TestPrintValidatedPianists(t *testing.T) {
	t.Parallel()

	var out bytes.Buffer
	printValidatedPianists(&out, "You like fire and lyricism.", []recommend.ValidatedPianist{
		{
			SuggestedPianist: recommend.SuggestedPianist{
				PianistName: "Radu Lupu",
				WhyFit:      "Poetic contrast to your current favorites.",
				SimilarTo:   []string{"Martha Argerich"},
				Confidence:  "medium",
			},
			SpotifyName: "Radu Lupu",
			SpotifyID:   "artist-1",
			Genres:      []string{"classical piano"},
		},
	})

	output := out.String()
	for _, want := range []string{
		"Summary: You like fire and lyricism.",
		"1. Radu Lupu",
		"Spotify ID: artist-1",
		"Genres:     classical piano",
		"Similar to: Martha Argerich",
		"Why:        Poetic contrast to your current favorites.",
		"Confidence: medium",
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("output = %q, want %q", output, want)
		}
	}
	if strings.Contains(output, "Popularity:") {
		t.Fatalf("output = %q, did not expect popularity field", output)
	}
}

func TestPrintValidatedPianistsWrapsLongText(t *testing.T) {
	t.Parallel()

	var out bytes.Buffer
	printValidatedPianists(
		&out,
		"Your taste centers on modern virtuoso pianism with exceptional clarity, control, and intelligence across large-scale Romantic and modern repertoire.",
		[]recommend.ValidatedPianist{
			{
				SuggestedPianist: recommend.SuggestedPianist{
					PianistName: "Arcadi Volodos",
					WhyFit:      "Your profile strongly favors dazzling technique that stays musically controlled, with enough tonal imagination and rhythmic command to keep complex repertoire coherent.",
					SimilarTo:   []string{"Yuja Wang", "Martha Argerich", "Yunchan Lim"},
					Confidence:  "high",
				},
				SpotifyName: "Arcadi Volodos",
				SpotifyID:   "artist-1",
			},
		},
	)

	for _, line := range strings.Split(strings.TrimRight(out.String(), "\n"), "\n") {
		if len(line) > fallbackOutputWidth {
			t.Fatalf("line length = %d, want <= %d: %q", len(line), fallbackOutputWidth, line)
		}
	}
}
