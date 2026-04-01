package llm

import (
	"context"
	"testing"

	"github.com/plei99/classical-piano-tracker/internal/recommend"
)

type stubProvider struct {
	raw string
	err error
	req Request
}

func (s *stubProvider) Generate(_ context.Context, req Request) (string, error) {
	s.req = req
	return s.raw, s.err
}

func TestClientSuggestNewPianistsBuildsDiscoveryRequestAndParsesResult(t *testing.T) {
	t.Parallel()

	provider := &stubProvider{
		raw: `{"summary":"You like vivid, high-energy pianists.","recommendations":[{"pianist_name":"Radu Lupu","why_fit":"lyrical contrast","similar_to":["Martha Argerich"],"confidence":"medium"}]}`,
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
	if provider.req.Schema == nil || provider.req.Schema.Name != "pianist_discovery" {
		t.Fatalf("provider.req.Schema = %#v, want structured discovery schema", provider.req.Schema)
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
