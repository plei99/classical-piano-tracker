package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/plei99/classical-piano-tracker/internal/llm"
)

func TestOpenAIProviderUsesStructuredRequestAndParsesResponseText(t *testing.T) {
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

	provider, err := NewOpenAI("test-key", "gpt-4o-mini", server.URL, server.Client())
	if err != nil {
		t.Fatalf("NewOpenAI() error = %v", err)
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
		t.Fatal("Generate() raw = empty, want text")
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
