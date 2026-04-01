package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/plei99/classical-piano-tracker/internal/llm"
)

func TestAnthropicProviderUsesToolSchemaAndParsesToolInput(t *testing.T) {
	t.Parallel()

	var requestBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		if got := r.Header.Get("x-api-key"); got != "test-key" {
			t.Fatalf("x-api-key = %q, want test-key", got)
		}
		if got := r.Header.Get("anthropic-version"); got != anthropicVersion {
			t.Fatalf("anthropic-version = %q, want %q", got, anthropicVersion)
		}

		if err := json.NewDecoder(r.Body).Decode(&requestBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"content":[{"type":"tool_use","name":"emit_recommendations","input":{"summary":"You like vivid, high-energy pianists.","recommendations":[{"pianist_name":"Radu Lupu","why_fit":"lyrical contrast","similar_to":["Martha Argerich"],"confidence":"medium"}]}}]}`))
	}))
	defer server.Close()

	provider, err := NewAnthropic("test-key", "claude-sonnet-4-5", server.URL, server.Client())
	if err != nil {
		t.Fatalf("NewAnthropic() error = %v", err)
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

	tools, ok := requestBody["tools"].([]any)
	if !ok || len(tools) != 1 {
		t.Fatalf("request body tools = %#v, want one tool", requestBody["tools"])
	}
	tool, ok := tools[0].(map[string]any)
	if !ok {
		t.Fatalf("tool = %#v, want object", tools[0])
	}
	if tool["name"] != anthropicToolName {
		t.Fatalf("tool.name = %#v, want %q", tool["name"], anthropicToolName)
	}
	messages, ok := requestBody["messages"].([]any)
	if !ok || len(messages) != 1 {
		t.Fatalf("messages = %#v, want one user message", requestBody["messages"])
	}
	message, ok := messages[0].(map[string]any)
	if !ok {
		t.Fatalf("message = %#v, want object", messages[0])
	}
	content, ok := message["content"].([]any)
	if !ok || len(content) != 1 {
		t.Fatalf("content = %#v, want one text block", message["content"])
	}
}
