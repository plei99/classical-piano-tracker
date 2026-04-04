package cli

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/plei99/classical-piano-tracker/internal/config"
	"github.com/plei99/classical-piano-tracker/internal/db"
)

func TestRecommendFavoritesPrintsEmptyState(t *testing.T) {
	t.Parallel()

	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := config.Save(configPath, &config.Config{
		Spotify: config.SpotifyConfig{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
		},
		PianistsAllowlist: []string{"Martha Argerich"},
	}); err != nil {
		t.Fatalf("config.Save() error = %v", err)
	}

	dbPath := filepath.Join(t.TempDir(), "tracker.db")

	cmd := NewRootCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs([]string{"--config", configPath, "--db", dbPath, "recommend", "favorites"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("cmd.Execute() error = %v", err)
	}
	if !strings.Contains(out.String(), "no favorite pianists could be derived") {
		t.Fatalf("output = %q, want empty-state message", out.String())
	}
}

func TestRecommendPianistsRejectsSparseRatingsWithActionableMessage(t *testing.T) {
	t.Parallel()

	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := config.Save(configPath, testRecommendationConfig("")); err != nil {
		t.Fatalf("config.Save() error = %v", err)
	}

	dbPath := filepath.Join(t.TempDir(), "tracker.db")
	queries := newRecommendationTestQueries(t, dbPath)
	if _, err := queries.UpsertTrack(context.Background(), db.UpsertTrackParams{
		SpotifyID:    "track-1",
		TrackName:    "Track One",
		AlbumName:    "Album One",
		Artists:      `["Martha Argerich"]`,
		LastPlayedAt: time.Now().Unix(),
	}); err != nil {
		t.Fatalf("UpsertTrack() error = %v", err)
	}
	if _, err := queries.UpsertRating(context.Background(), db.UpsertRatingParams{
		TrackID:   1,
		Stars:     5,
		Opinion:   "Excellent",
		UpdatedAt: time.Now().Unix(),
	}); err != nil {
		t.Fatalf("UpsertRating() error = %v", err)
	}

	cmd := NewRootCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs([]string{"--config", configPath, "--db", dbPath, "recommend", "pianists"})

	err := cmd.Execute()
	if err == nil {
		t.Fatal("cmd.Execute() error = nil, want sparse-data failure")
	}
	if !strings.Contains(err.Error(), "not enough local rating data for pianist recommendations yet") {
		t.Fatalf("error = %q, want actionable sparse-data prefix", err)
	}
}

func TestRecommendPianistsRequiresOpenAIKeyAfterDataCheck(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := config.Save(configPath, testRecommendationConfig("")); err != nil {
		t.Fatalf("config.Save() error = %v", err)
	}

	dbPath := filepath.Join(t.TempDir(), "tracker.db")
	queries := newRecommendationTestQueries(t, dbPath)
	for idx, spotifyID := range []string{"track-1", "track-2", "track-3"} {
		track, err := queries.UpsertTrack(context.Background(), db.UpsertTrackParams{
			SpotifyID:    spotifyID,
			TrackName:    "Track",
			AlbumName:    "Album",
			Artists:      `["Martha Argerich"]`,
			LastPlayedAt: time.Now().Unix(),
		})
		if err != nil {
			t.Fatalf("UpsertTrack(%d) error = %v", idx, err)
		}
		if _, err := queries.UpsertRating(context.Background(), db.UpsertRatingParams{
			TrackID:   track.ID,
			Stars:     5,
			Opinion:   "Excellent",
			UpdatedAt: time.Now().Unix(),
		}); err != nil {
			t.Fatalf("UpsertRating(%d) error = %v", idx, err)
		}
	}

	t.Setenv("OPENAI_API_KEY", "")

	cmd := NewRootCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs([]string{"--config", configPath, "--db", dbPath, "recommend", "pianists"})

	err := cmd.Execute()
	if err == nil {
		t.Fatal("cmd.Execute() error = nil, want missing OpenAI key failure")
	}
	if !strings.Contains(err.Error(), "API key is required") {
		t.Fatalf("error = %q, want missing key message", err)
	}
}

func TestRecommendProfilePrintsLocalTasteSummary(t *testing.T) {
	t.Parallel()

	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := config.Save(configPath, &config.Config{
		Spotify: config.SpotifyConfig{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
		},
		PianistsAllowlist: []string{"Martha Argerich"},
	}); err != nil {
		t.Fatalf("config.Save() error = %v", err)
	}

	dbPath := filepath.Join(t.TempDir(), "tracker.db")
	track := saveRecommendationTrackWithRating(t, newRecommendationTestQueries(t, dbPath), "track-1", "Scarbo", "Ravel", `["Martha Argerich"]`, 5, "Electrifying.")

	cmd := NewRootCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs([]string{"--config", configPath, "--db", dbPath, "recommend", "profile"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("cmd.Execute() error = %v", err)
	}

	for _, want := range []string{
		"Tracks: 1",
		"Ratings: 1",
		"Comments: 1",
		"Favorite Pianists",
		"Martha Argerich",
		"Loved Tracks",
		"[1] Scarbo",
		"Matched: Martha Argerich",
		"Opinion: Electrifying.",
		"Known Pianists: Martha Argerich",
	} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("output = %q, want %q", out.String(), want)
		}
	}
	if strings.Contains(out.String(), "Discovery Guidance:") {
		t.Fatalf("output = %q, did not expect discovery guidance", out.String())
	}
	if track.ID != 1 {
		t.Fatalf("track.ID = %d, want 1", track.ID)
	}
}

func TestRecommendSummaryUsesLLMProviderWithoutSpotifyValidation(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path = %q, want /v1/chat/completions", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"summary\":\"You like high-voltage clarity and sharply voiced modern repertoire.\"}"}}]}`))
	}))
	defer server.Close()

	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := config.Save(configPath, &config.Config{
		Spotify: config.SpotifyConfig{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
		},
		LLM: config.LLMConfig{
			ActiveProfile: "test",
			Profiles: map[string]config.LLMProfile{
				"test": {
					Provider: "openai_compat",
					Model:    "test-model",
					BaseURL:  server.URL + "/v1",
				},
			},
		},
		PianistsAllowlist: []string{"Martha Argerich"},
	}); err != nil {
		t.Fatalf("config.Save() error = %v", err)
	}

	dbPath := filepath.Join(t.TempDir(), "tracker.db")
	queries := newRecommendationTestQueries(t, dbPath)
	saveRecommendationTrackWithRating(t, queries, "track-1", "Track One", "Album One", `["Martha Argerich"]`, 5, "Brilliant.")
	saveRecommendationTrackWithRating(t, queries, "track-2", "Track Two", "Album Two", `["Martha Argerich"]`, 4, "Clear.")
	saveRecommendationTrackWithRating(t, queries, "track-3", "Track Three", "Album Three", `["Martha Argerich"]`, 5, "Incisive.")

	cmd := NewRootCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs([]string{"--config", configPath, "--db", dbPath, "recommend", "summary"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("cmd.Execute() error = %v", err)
	}
	if !strings.Contains(out.String(), "Summary: You like high-voltage clarity and sharply voiced modern repertoire.") {
		t.Fatalf("output = %q, want LLM summary", out.String())
	}
}

func TestDiscoveryRequestLimitOverRequestsForValidationHeadroom(t *testing.T) {
	t.Parallel()

	cases := []struct {
		limit int
		want  int
	}{
		{limit: 1, want: 10},
		{limit: 5, want: 10},
		{limit: 7, want: 14},
		{limit: 10, want: 20},
	}

	for _, tc := range cases {
		if got := discoveryRequestLimit(tc.limit); got != tc.want {
			t.Fatalf("discoveryRequestLimit(%d) = %d, want %d", tc.limit, got, tc.want)
		}
	}
}

func testRecommendationConfig(openAIKey string) *config.Config {
	return &config.Config{
		Spotify: config.SpotifyConfig{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
			Token: &config.Token{
				AccessToken: "access-token",
				TokenType:   "Bearer",
				Expiry:      time.Now().Add(time.Hour),
			},
		},
		LLM: config.LLMConfig{
			ActiveProfile: "openai",
			Profiles: map[string]config.LLMProfile{
				"openai": {
					Provider: "openai",
					Model:    "gpt-5.4",
					APIKey:   openAIKey,
				},
			},
		},
		PianistsAllowlist: []string{"Martha Argerich"},
	}
}

func newRecommendationTestQueries(t *testing.T, dbPath string) *db.Queries {
	t.Helper()

	conn, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open() error = %v", err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
	})

	if err := db.Init(context.Background(), conn); err != nil {
		t.Fatalf("db.Init() error = %v", err)
	}

	return db.New(conn)
}

func saveRecommendationTrackWithRating(t *testing.T, queries *db.Queries, spotifyID string, trackName string, albumName string, artists string, stars int64, opinion string) db.Track {
	t.Helper()

	track, err := queries.UpsertTrack(context.Background(), db.UpsertTrackParams{
		SpotifyID:    spotifyID,
		TrackName:    trackName,
		AlbumName:    albumName,
		Artists:      artists,
		LastPlayedAt: time.Now().Unix(),
	})
	if err != nil {
		t.Fatalf("UpsertTrack(%q) error = %v", spotifyID, err)
	}

	if _, err := queries.UpsertRating(context.Background(), db.UpsertRatingParams{
		TrackID:   track.ID,
		Stars:     stars,
		Opinion:   opinion,
		UpdatedAt: time.Now().Unix(),
	}); err != nil {
		t.Fatalf("UpsertRating(%q) error = %v", spotifyID, err)
	}

	return track
}
