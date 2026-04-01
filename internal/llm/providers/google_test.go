package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/plei99/classical-piano-tracker/internal/llm"
)

func TestGoogleProviderUsesJSONSchemaAndParsesResponseText(t *testing.T) {
	t.Parallel()

	var requestBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		if got := r.Header.Get("x-goog-api-key"); got != "test-key" {
			t.Fatalf("x-goog-api-key = %q, want test-key", got)
		}

		if err := json.NewDecoder(r.Body).Decode(&requestBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":"{\"summary\":\"You like vivid, high-energy pianists.\",\"recommendations\":[{\"pianist_name\":\"Radu Lupu\",\"why_fit\":\"lyrical contrast\",\"similar_to\":[\"Martha Argerich\"],\"confidence\":\"medium\"}]}"}]}}]}`))
	}))
	defer server.Close()

	provider, err := NewGoogle("test-key", "gemini-2.5-pro", server.URL, server.Client())
	if err != nil {
		t.Fatalf("NewGoogle() error = %v", err)
	}

	raw, err := provider.Generate(context.Background(), llm.Request{
		SystemPrompt: "system prompt",
		UserPrompt:   "user prompt",
		OutputMode:   llm.StructuredOutputModeStrict,
		Schema: &llm.JSONSchema{
			Name:   "pianist_discovery",
			Schema: map[string]any{"type": "object"},
			Strict: true,
		},
	})
	if err != nil {
		t.Fatalf("Generate() error = %v", err)
	}
	if raw == "" {
		t.Fatal("Generate() raw = empty, want JSON text")
	}

	generationConfig, ok := requestBody["generationConfig"].(map[string]any)
	if !ok {
		t.Fatalf("generationConfig = %#v, want object", requestBody["generationConfig"])
	}
	if generationConfig["responseMimeType"] != "application/json" {
		t.Fatalf("responseMimeType = %#v, want application/json", generationConfig["responseMimeType"])
	}
	if _, ok := generationConfig["responseJsonSchema"].(map[string]any); !ok {
		t.Fatalf("responseJsonSchema = %#v, want object", generationConfig["responseJsonSchema"])
	}
}

func TestNewGoogleUsesLongerDefaultTimeout(t *testing.T) {
	t.Parallel()

	provider, err := NewGoogle("test-key", "", "", nil)
	if err != nil {
		t.Fatalf("NewGoogle() error = %v", err)
	}

	google, ok := provider.(*googleProvider)
	if !ok {
		t.Fatalf("provider type = %T, want *googleProvider", provider)
	}
	if google.httpClient.Timeout != defaultGoogleTimeout {
		t.Fatalf("httpClient.Timeout = %v, want %v", google.httpClient.Timeout, defaultGoogleTimeout)
	}
}
