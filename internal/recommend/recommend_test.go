package recommend

import (
	"context"
	"testing"

	"github.com/plei99/classical-piano-tracker/internal/db"
)

func TestBuildPianistProfilesUsesAllowlistAndSortsByScore(t *testing.T) {
	t.Parallel()

	tracks := []db.Track{
		{ID: 1, TrackName: "Track One", Artists: `["Martha Argerich","London Symphony Orchestra"]`, PlayCount: 6},
		{ID: 2, TrackName: "Track Two", Artists: `["Martha Argerich"]`, PlayCount: 3},
		{ID: 3, TrackName: "Track Three", Artists: `["Daniil Trifonov"]`, PlayCount: 2},
		{ID: 4, TrackName: "Track Four", Artists: `["Unknown Artist"]`, PlayCount: 20},
	}
	ratings := []db.Rating{
		{TrackID: 1, Stars: 5},
		{TrackID: 2, Stars: 4},
		{TrackID: 3, Stars: 5},
	}
	allowlist := []string{"Martha Argerich", "Daniil Trifonov"}

	profiles, err := BuildPianistProfiles(tracks, ratings, allowlist)
	if err != nil {
		t.Fatalf("BuildPianistProfiles() error = %v", err)
	}
	if len(profiles) != 2 {
		t.Fatalf("BuildPianistProfiles() len = %d, want 2", len(profiles))
	}
	if profiles[0].Name != "Martha Argerich" {
		t.Fatalf("profiles[0].Name = %q, want Martha Argerich", profiles[0].Name)
	}
	if profiles[0].RatedTrackCount != 2 || profiles[0].TotalPlayCount != 9 {
		t.Fatalf("unexpected Martha profile: %+v", profiles[0])
	}
	if profiles[1].Name != "Daniil Trifonov" {
		t.Fatalf("profiles[1].Name = %q, want Daniil Trifonov", profiles[1].Name)
	}
}

func TestBuildTasteSummaryCollectsCommentsAndFavorites(t *testing.T) {
	t.Parallel()

	tracks := []db.Track{
		{ID: 1, TrackName: "Concerto", AlbumName: "Album A", Artists: `["Martha Argerich"]`, PlayCount: 4, LastPlayedAt: 30},
		{ID: 2, TrackName: "Sonata", AlbumName: "Album B", Artists: `["Daniil Trifonov"]`, PlayCount: 2, LastPlayedAt: 20},
		{ID: 3, TrackName: "Ballade", AlbumName: "Album C", Artists: `["Martha Argerich"]`, PlayCount: 1, LastPlayedAt: 10},
	}
	ratings := []db.Rating{
		{TrackID: 1, Stars: 5, Opinion: "Explosive and clear"},
		{TrackID: 2, Stars: 2, Opinion: "Too heavy"},
		{TrackID: 3, Stars: 4},
	}

	summary, err := BuildTasteSummary(tracks, ratings, []string{"Martha Argerich", "Daniil Trifonov"})
	if err != nil {
		t.Fatalf("BuildTasteSummary() error = %v", err)
	}
	if summary.TotalRatings != 3 || summary.CommentCount != 2 {
		t.Fatalf("unexpected summary counts: %+v", summary)
	}
	if len(summary.FavoritePianists) == 0 || summary.FavoritePianists[0].Name != "Martha Argerich" {
		t.Fatalf("FavoritePianists = %+v, want Martha Argerich first", summary.FavoritePianists)
	}
	if len(summary.LovedTracks) != 2 {
		t.Fatalf("LovedTracks len = %d, want 2", len(summary.LovedTracks))
	}
	if len(summary.DislikedTracks) != 1 || summary.DislikedTracks[0].TrackName != "Sonata" {
		t.Fatalf("DislikedTracks = %+v, want Sonata", summary.DislikedTracks)
	}
	if len(summary.CommentedTracks) != 2 {
		t.Fatalf("CommentedTracks len = %d, want 2", len(summary.CommentedTracks))
	}
	if len(summary.KnownPianists) != 2 || summary.KnownPianists[1] != "Daniil Trifonov" {
		t.Fatalf("KnownPianists = %+v, want allowlist-backed names", summary.KnownPianists)
	}
}

func TestValidateDiscoveryInputRequiresEnoughRatings(t *testing.T) {
	t.Parallel()

	err := ValidateDiscoveryInput(TasteSummary{
		TotalRatings:     2,
		FavoritePianists: []FavoritePianist{{Name: "Martha Argerich"}},
	})
	if err == nil {
		t.Fatal("ValidateDiscoveryInput() error = nil, want error")
	}
}

func TestParseDiscoveryResultHandlesFencedJSON(t *testing.T) {
	t.Parallel()

	raw := "```json\n{\"summary\":\"lyrical\",\"recommendations\":[{\"pianist_name\":\"Radu Lupu\",\"why_fit\":\"poetic touch\",\"similar_to\":[\"Martha Argerich\"],\"confidence\":\"medium\"}]}\n```"
	result, err := ParseDiscoveryResult(raw)
	if err != nil {
		t.Fatalf("ParseDiscoveryResult() error = %v", err)
	}
	if result.Summary != "lyrical" || len(result.Recommendations) != 1 {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestParseDiscoveryResultAcceptsPianistsAlias(t *testing.T) {
	t.Parallel()

	raw := `{"summary":"lyrical","pianists":[{"name":"Radu Lupu","reason":"poetic touch","similar":["Martha Argerich"],"confidence":"medium"}]}`
	result, err := ParseDiscoveryResult(raw)
	if err != nil {
		t.Fatalf("ParseDiscoveryResult() error = %v", err)
	}
	if len(result.Recommendations) != 1 {
		t.Fatalf("Recommendations len = %d, want 1", len(result.Recommendations))
	}
	if result.Recommendations[0].PianistName != "Radu Lupu" {
		t.Fatalf("PianistName = %q, want Radu Lupu", result.Recommendations[0].PianistName)
	}
	if result.Recommendations[0].WhyFit != "poetic touch" {
		t.Fatalf("WhyFit = %q, want poetic touch", result.Recommendations[0].WhyFit)
	}
}

func TestParseDiscoveryResultAcceptsNestedResultAlias(t *testing.T) {
	t.Parallel()

	raw := `{"result":{"overview":"lyrical","suggestions":[{"pianist":"Radu Lupu","why":"poetic touch","similar_to":["Martha Argerich"],"confidence":"medium"}]}}`
	result, err := ParseDiscoveryResult(raw)
	if err != nil {
		t.Fatalf("ParseDiscoveryResult() error = %v", err)
	}
	if result.Summary != "lyrical" {
		t.Fatalf("Summary = %q, want lyrical", result.Summary)
	}
	if len(result.Recommendations) != 1 || result.Recommendations[0].PianistName != "Radu Lupu" {
		t.Fatalf("unexpected recommendations: %+v", result.Recommendations)
	}
}

func TestParseTasteSummaryHandlesJSONPlaintextAndFences(t *testing.T) {
	t.Parallel()

	for _, raw := range []string{
		`{"summary":"You prefer high-voltage precision with clear voicing."}`,
		"```json\n{\"summary\":\"You prefer high-voltage precision with clear voicing.\"}\n```",
		"You prefer high-voltage precision with clear voicing.",
	} {
		got, err := ParseTasteSummary(raw)
		if err != nil {
			t.Fatalf("ParseTasteSummary(%q) error = %v", raw, err)
		}
		if got != "You prefer high-voltage precision with clear voicing." {
			t.Fatalf("ParseTasteSummary(%q) = %q", raw, got)
		}
	}
}

func TestParseDiscoveryRecommendationsAcceptsRecommendationsOnlyPayload(t *testing.T) {
	t.Parallel()

	raw := `{"recommendations":[{"pianist_name":"Radu Lupu","why_fit":"poetic touch","similar_to":["Martha Argerich"],"confidence":"medium"}]}`
	recommendations, err := ParseDiscoveryRecommendations(raw)
	if err != nil {
		t.Fatalf("ParseDiscoveryRecommendations() error = %v", err)
	}
	if len(recommendations) != 1 || recommendations[0].PianistName != "Radu Lupu" {
		t.Fatalf("unexpected recommendations: %+v", recommendations)
	}
}

func TestParsePlaintextRecommendationsParsesRigidFallbackFormat(t *testing.T) {
	t.Parallel()

	raw := "Radu Lupu || poetic touch || Martha Argerich, Daniil Trifonov || medium\nMarc-André Hamelin || virtuosity with brains || Yuja Wang || high"
	recommendations, err := ParsePlaintextRecommendations(raw)
	if err != nil {
		t.Fatalf("ParsePlaintextRecommendations() error = %v", err)
	}
	if len(recommendations) != 2 {
		t.Fatalf("len(recommendations) = %d, want 2", len(recommendations))
	}
	if recommendations[0].PianistName != "Radu Lupu" || recommendations[1].PianistName != "Marc-André Hamelin" {
		t.Fatalf("unexpected recommendations: %+v", recommendations)
	}
}

func TestValidateSuggestedPianistsFiltersKnownNamesAndRequiresCatalogMatch(t *testing.T) {
	t.Parallel()

	searcher := fakeArtistSearcher{
		results: map[string][]CatalogArtist{
			"Radu Lupu": {
				{Name: "Radu Lupu", ID: "artist-1", Popularity: 55},
			},
			"Martha Argerich": {
				{Name: "Martha Argerich", ID: "artist-2", Popularity: 80},
			},
			"Invented Pianist": {
				{Name: "Completely Different", ID: "artist-3", Popularity: 10},
			},
		},
	}

	validated, err := ValidateSuggestedPianists(context.Background(), searcher, []string{"Martha Argerich"}, []SuggestedPianist{
		{PianistName: "Radu Lupu", WhyFit: "poetic"},
		{PianistName: "Martha Argerich", WhyFit: "known already"},
		{PianistName: "Invented Pianist", WhyFit: "hallucinated"},
	}, 5)
	if err != nil {
		t.Fatalf("ValidateSuggestedPianists() error = %v", err)
	}
	if len(validated) != 1 || validated[0].SpotifyName != "Radu Lupu" {
		t.Fatalf("validated = %+v, want only Radu Lupu", validated)
	}
}

type fakeArtistSearcher struct {
	results map[string][]CatalogArtist
}

func (f fakeArtistSearcher) SearchArtists(_ context.Context, query string, _ int) ([]CatalogArtist, error) {
	return f.results[query], nil
}
