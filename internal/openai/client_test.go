package openai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/plei99/classical-piano-tracker/internal/config"
	"github.com/plei99/classical-piano-tracker/internal/recommend"
)

func TestSuggestNewPianistsUsesStructuredRequestAndParsesResponse(t *testing.T) {
	t.Parallel()

	var requestBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Fatalf("Authorization = %q, want bearer token", got)
		}

		if err := json.NewDecoder(r.Body).Decode(&requestBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"output_text":"{\"summary\":\"You like vivid, high-energy pianists.\",\"recommendations\":[{\"pianist_name\":\"Radu Lupu\",\"why_fit\":\"lyrical contrast\",\"similar_to\":[\"Martha Argerich\"],\"confidence\":\"medium\"}]}"}`))
	}))
	defer server.Close()

	client, err := NewClient("test-key", "gpt-4o-mini", server.URL, server.Client())
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

	textSection, ok := requestBody["text"].(map[string]any)
	if !ok {
		t.Fatalf("request body missing text section: %#v", requestBody)
	}
	format, ok := textSection["format"].(map[string]any)
	if !ok {
		t.Fatalf("request text missing format section: %#v", textSection)
	}
	if format["type"] != "json_schema" {
		t.Fatalf("format.type = %#v, want json_schema", format["type"])
	}
}

func TestSuggestNewPianistsRejectsDiscoveryInputWithoutEnoughRatings(t *testing.T) {
	t.Parallel()

	client, err := NewClient("test-key", "gpt-4o-mini", "https://example.com", &http.Client{})
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

func TestFromConfigFallsBackToConfigKeyAndEnvOverrides(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	client, err := FromConfig(config.OpenAIConfig{APIKey: "config-key"})
	if err != nil {
		t.Fatalf("FromConfig() error = %v", err)
	}
	if client.apiKey != "config-key" {
		t.Fatalf("client.apiKey = %q, want config-key", client.apiKey)
	}

	t.Setenv("OPENAI_API_KEY", "env-key")
	client, err = FromConfig(config.OpenAIConfig{APIKey: "config-key"})
	if err != nil {
		t.Fatalf("FromConfig() error = %v", err)
	}
	if client.apiKey != "env-key" {
		t.Fatalf("client.apiKey = %q, want env-key", client.apiKey)
	}
}
