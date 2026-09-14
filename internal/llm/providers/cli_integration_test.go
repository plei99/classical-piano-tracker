package providers

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/plei99/classical-piano-tracker/internal/llm"
	"github.com/plei99/classical-piano-tracker/internal/recommend"
)

// Explicit opt-in only: these tests use CLI account quota, but never read the
// user's tracker database/config or contact Spotify. Normal go test is offline.
func TestLiveCLI(t *testing.T) {
	var provider llm.Provider
	switch os.Getenv("TRACKER_TEST_LIVE_CLI") {
	case "codex":
		provider, _ = NewCodex(os.Getenv("TRACKER_TEST_CLI_MODEL"), "", nil)
	case "claude_cli":
		provider, _ = NewClaudeCLI(os.Getenv("TRACKER_TEST_CLI_MODEL"), "", nil)
	case "":
		t.Skip("set TRACKER_TEST_LIVE_CLI=codex or claude_cli to exercise an authenticated CLI")
	default:
		t.Fatal("unknown TRACKER_TEST_LIVE_CLI")
	}
	client, err := llm.NewClient(provider)
	if err != nil {
		t.Fatal(err)
	}
	summary := recommend.TasteSummary{
		TotalTracks: 3, TotalRatings: 3, CommentCount: 1,
		FavoritePianists: []recommend.FavoritePianist{{Name: "Murray Perahia", TrackCount: 3, RatedTrackCount: 3, AverageStars: 5, TotalPlayCount: 3}},
		KnownPianists:    []string{"Murray Perahia"},
		CommentedTracks:  []recommend.TasteTrack{{TrackName: "Goldberg Variations", Artists: []string{"Murray Perahia"}, Stars: 5, Opinion: "Clear counterpoint and warm tone."}},
	}
	t.Run("summary", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		text, err := client.SummarizeTaste(ctx, summary)
		if err != nil {
			t.Fatal(err)
		}
		if strings.TrimSpace(text) == "" {
			t.Fatal("empty summary")
		}
	})
	t.Run("discovery", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		result, err := client.SuggestNewPianists(ctx, summary, 5)
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Recommendations) != 5 {
			t.Fatalf("got %d recommendations, want 5", len(result.Recommendations))
		}
	})
}
