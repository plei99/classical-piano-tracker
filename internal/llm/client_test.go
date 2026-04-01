package llm

import (
	"context"
	"testing"

	"github.com/plei99/classical-piano-tracker/internal/recommend"
)

type stubProvider struct {
	raws []string
	err  error
	reqs []Request
}

func (s *stubProvider) Generate(_ context.Context, req Request) (string, error) {
	s.reqs = append(s.reqs, req)
	if len(s.raws) == 0 {
		return "", s.err
	}
	raw := s.raws[0]
	s.raws = s.raws[1:]
	return raw, s.err
}

func TestClientSuggestNewPianistsBuildsDiscoveryRequestAndParsesResult(t *testing.T) {
	t.Parallel()

	provider := &stubProvider{
		raws: []string{`{"summary":"You like vivid, high-energy pianists.","recommendations":[{"pianist_name":"Radu Lupu","why_fit":"lyrical contrast","similar_to":["Martha Argerich"],"confidence":"medium"}]}`},
	}
	client, err := NewClient(provider)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	result, err := client.SuggestNewPianists(context.Background(), recommend.TasteSummary{
		TotalRatings:     3,
		FavoritePianists: []recommend.FavoritePianist{{Name: "Martha Argerich"}},
		KnownPianists:    []string{"Martha Argerich"},
	}, 1)
	if err != nil {
		t.Fatalf("SuggestNewPianists() error = %v", err)
	}
	if result.Summary == "" || len(result.Recommendations) != 1 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if len(provider.reqs) != 1 {
		t.Fatalf("len(provider.reqs) = %d, want 1", len(provider.reqs))
	}
	if provider.reqs[0].Schema == nil || provider.reqs[0].Schema.Name != "pianist_discovery" {
		t.Fatalf("provider.reqs[0].Schema = %#v, want structured discovery schema", provider.reqs[0].Schema)
	}
	recommendations, ok := provider.reqs[0].Schema.Schema["properties"].(map[string]any)["recommendations"].(map[string]any)
	if !ok {
		t.Fatalf("recommendations schema missing: %#v", provider.reqs[0].Schema.Schema)
	}
	if recommendations["minItems"] != 1 {
		t.Fatalf("recommendations.minItems = %#v, want 1 for limit=1", recommendations["minItems"])
	}
}

func TestClientSuggestNewPianistsRepairsIncompleteStructuredOutput(t *testing.T) {
	t.Parallel()

	provider := &stubProvider{
		raws: []string{
			`{"summary":"You like vivid, high-energy pianists."}`,
			`{"summary":"You like vivid, high-energy pianists.","recommendations":[{"pianist_name":"Radu Lupu","why_fit":"lyrical contrast","similar_to":["Martha Argerich"],"confidence":"medium"}]}`,
		},
	}
	client, err := NewClient(provider)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	result, err := client.SuggestNewPianists(context.Background(), recommend.TasteSummary{
		TotalRatings:     3,
		FavoritePianists: []recommend.FavoritePianist{{Name: "Martha Argerich"}},
		KnownPianists:    []string{"Martha Argerich"},
	}, 1)
	if err != nil {
		t.Fatalf("SuggestNewPianists() error = %v", err)
	}
	if len(result.Recommendations) != 1 {
		t.Fatalf("unexpected recommendations: %+v", result.Recommendations)
	}
	if len(provider.reqs) != 2 {
		t.Fatalf("len(provider.reqs) = %d, want 2 after repair", len(provider.reqs))
	}
	if provider.reqs[1].Schema == nil || provider.reqs[1].Schema.Name != "pianist_discovery" {
		t.Fatalf("provider.reqs[1].Schema = %#v, want discovery schema on repair request", provider.reqs[1].Schema)
	}
}

func TestClientSuggestNewPianistsRetriesMultipleRepairPasses(t *testing.T) {
	t.Parallel()

	provider := &stubProvider{
		raws: []string{
			`{"summary":"first partial"}`,
			`{"summary":"second partial"}`,
			`{"summary":"third partial"}`,
			`{"summary":"final summary","recommendations":[{"pianist_name":"Radu Lupu","why_fit":"lyrical contrast","similar_to":["Martha Argerich"],"confidence":"medium"}]}`,
		},
	}
	client, err := NewClient(provider)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	result, err := client.SuggestNewPianists(context.Background(), recommend.TasteSummary{
		TotalRatings:     3,
		FavoritePianists: []recommend.FavoritePianist{{Name: "Martha Argerich"}},
		KnownPianists:    []string{"Martha Argerich"},
	}, 1)
	if err != nil {
		t.Fatalf("SuggestNewPianists() error = %v", err)
	}
	if result.Summary != "final summary" || len(result.Recommendations) != 1 {
		t.Fatalf("unexpected result after repair retries: %+v", result)
	}
	if len(provider.reqs) != 4 {
		t.Fatalf("len(provider.reqs) = %d, want 4 total attempts", len(provider.reqs))
	}
}

func TestClientSuggestNewPianistsFallsBackToRecommendationsOnlyRepair(t *testing.T) {
	t.Parallel()

	provider := &stubProvider{
		raws: []string{
			`{"summary":"partial summary"}`,
			`{"summary":"repair one"}`,
			`{"summary":"repair two"}`,
			`{"summary":"repair three"}`,
			`{"recommendations":[{"pianist_name":"Radu Lupu","why_fit":"lyrical contrast","similar_to":["Martha Argerich"],"confidence":"medium"}]}`,
		},
	}
	client, err := NewClient(provider)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	result, err := client.SuggestNewPianists(context.Background(), recommend.TasteSummary{
		TotalRatings:     3,
		FavoritePianists: []recommend.FavoritePianist{{Name: "Martha Argerich"}},
		KnownPianists:    []string{"Martha Argerich"},
	}, 1)
	if err != nil {
		t.Fatalf("SuggestNewPianists() error = %v", err)
	}
	if result.Summary != "repair three" {
		t.Fatalf("Summary = %q, want final repaired summary", result.Summary)
	}
	if len(result.Recommendations) != 1 {
		t.Fatalf("unexpected recommendations: %+v", result.Recommendations)
	}
	if len(provider.reqs) != 5 {
		t.Fatalf("len(provider.reqs) = %d, want 5 including recommendations-only fallback", len(provider.reqs))
	}
	if provider.reqs[4].Schema == nil || provider.reqs[4].Schema.Name != "pianist_recommendations_only" {
		t.Fatalf("provider.reqs[4].Schema = %#v, want recommendations-only schema", provider.reqs[4].Schema)
	}
}

func TestClientSuggestNewPianistsFallsBackToPlaintextRecommendations(t *testing.T) {
	t.Parallel()

	provider := &stubProvider{
		raws: []string{
			`{"summary":"partial summary"}`,
			`{"summary":"repair one"}`,
			`{"summary":"repair two"}`,
			`{"summary":"repair three"}`,
			`{"summary":"still no recommendations"}`,
			"Radu Lupu || lyrical contrast || Martha Argerich || medium",
		},
	}
	client, err := NewClient(provider)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	result, err := client.SuggestNewPianists(context.Background(), recommend.TasteSummary{
		TotalRatings:     3,
		FavoritePianists: []recommend.FavoritePianist{{Name: "Martha Argerich"}},
		KnownPianists:    []string{"Martha Argerich"},
	}, 1)
	if err != nil {
		t.Fatalf("SuggestNewPianists() error = %v", err)
	}
	if result.Summary != "repair three" {
		t.Fatalf("Summary = %q, want final repaired summary", result.Summary)
	}
	if len(result.Recommendations) != 1 || result.Recommendations[0].PianistName != "Radu Lupu" {
		t.Fatalf("unexpected recommendations: %+v", result.Recommendations)
	}
	if len(provider.reqs) != 6 {
		t.Fatalf("len(provider.reqs) = %d, want 6 including plaintext fallback", len(provider.reqs))
	}
	if provider.reqs[5].Schema != nil {
		t.Fatalf("provider.reqs[5].Schema = %#v, want nil for plaintext fallback", provider.reqs[5].Schema)
	}
}

func TestClientSuggestNewPianistsRecoversFromMissingPianistName(t *testing.T) {
	t.Parallel()

	provider := &stubProvider{
		raws: []string{
			`{"summary":"partial summary","recommendations":[{"why_fit":"missing name","similar_to":["Martha Argerich"],"confidence":"medium"}]}`,
			`{"summary":"repair one","recommendations":[{"why_fit":"still missing name","similar_to":["Martha Argerich"],"confidence":"medium"}]}`,
			`{"summary":"repair two","recommendations":[{"why_fit":"still missing name","similar_to":["Martha Argerich"],"confidence":"medium"}]}`,
			`{"summary":"repair three","recommendations":[{"why_fit":"still missing name","similar_to":["Martha Argerich"],"confidence":"medium"}]}`,
			`{"recommendations":[{"name":"Radu Lupu","reason":"lyrical contrast","similar":["Martha Argerich"],"confidence":"medium"}]}`,
		},
	}
	client, err := NewClient(provider)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	result, err := client.SuggestNewPianists(context.Background(), recommend.TasteSummary{
		TotalRatings:     3,
		FavoritePianists: []recommend.FavoritePianist{{Name: "Martha Argerich"}},
		KnownPianists:    []string{"Martha Argerich"},
	}, 1)
	if err != nil {
		t.Fatalf("SuggestNewPianists() error = %v", err)
	}
	if result.Summary != "repair three" {
		t.Fatalf("Summary = %q, want final repaired summary", result.Summary)
	}
	if len(result.Recommendations) != 1 || result.Recommendations[0].PianistName != "Radu Lupu" {
		t.Fatalf("unexpected recommendations: %+v", result.Recommendations)
	}
	if len(provider.reqs) != 5 {
		t.Fatalf("len(provider.reqs) = %d, want 5 including recommendations-only fallback", len(provider.reqs))
	}
	if provider.reqs[4].Schema == nil || provider.reqs[4].Schema.Name != "pianist_recommendations_only" {
		t.Fatalf("provider.reqs[4].Schema = %#v, want recommendations-only schema", provider.reqs[4].Schema)
	}
}

func TestClientSuggestNewPianistsRequiresAtLeastFiveRecommendationsWhenLimitIsHigher(t *testing.T) {
	t.Parallel()

	provider := &stubProvider{
		raws: []string{`{"summary":"summary","recommendations":[{"pianist_name":"Radu Lupu","why_fit":"lyrical contrast","similar_to":["Martha Argerich"],"confidence":"medium"},{"pianist_name":"Leif Ove Andsnes","why_fit":"clarity","similar_to":["Víkingur Ólafsson"],"confidence":"medium"},{"pianist_name":"Marc-Andre Hamelin","why_fit":"virtuosity","similar_to":["Yuja Wang"],"confidence":"medium"},{"pianist_name":"Jean-Yves Thibaudet","why_fit":"color","similar_to":["Alice Sara Ott"],"confidence":"medium"},{"pianist_name":"Khatia Buniatishvili","why_fit":"fire","similar_to":["Yuja Wang"],"confidence":"medium"}]}`},
	}
	client, err := NewClient(provider)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	_, err = client.SuggestNewPianists(context.Background(), recommend.TasteSummary{
		TotalRatings:     3,
		FavoritePianists: []recommend.FavoritePianist{{Name: "Martha Argerich"}},
		KnownPianists:    []string{"Martha Argerich"},
	}, 5)
	if err != nil {
		t.Fatalf("SuggestNewPianists() error = %v", err)
	}

	recommendations, ok := provider.reqs[0].Schema.Schema["properties"].(map[string]any)["recommendations"].(map[string]any)
	if !ok {
		t.Fatalf("recommendations schema missing: %#v", provider.reqs[0].Schema.Schema)
	}
	if recommendations["minItems"] != 5 {
		t.Fatalf("recommendations.minItems = %#v, want 5 for limit=5", recommendations["minItems"])
	}
}

func TestClientSuggestNewPianistsRejectsDiscoveryInputWithoutEnoughRatings(t *testing.T) {
	t.Parallel()

	client, err := NewClient(&stubProvider{})
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}

	_, err = client.SuggestNewPianists(context.Background(), recommend.TasteSummary{
		TotalRatings:     1,
		FavoritePianists: []recommend.FavoritePianist{{Name: "Martha Argerich"}},
	}, 5)
	if err == nil {
		t.Fatal("SuggestNewPianists() error = nil, want validation error")
	}
}
