package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/plei99/classical-piano-tracker/internal/llm"
)

func TestOpenAICompatProviderUsesChatCompletionsAndOptionalAuth(t *testing.T) {
	t.Parallel()

	var requestBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path = %q, want /v1/chat/completions", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "" {
			t.Fatalf("Authorization = %q, want omitted for no-key profile", got)
		}

		if err := json.NewDecoder(r.Body).Decode(&requestBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"summary\":\"You like vivid, high-energy pianists.\",\"recommendations\":[{\"pianist_name\":\"Radu Lupu\",\"why_fit\":\"lyrical contrast\",\"similar_to\":[\"Martha Argerich\"],\"confidence\":\"medium\"}]}"}}]}`))
	}))
	defer server.Close()

	provider, err := NewOpenAICompat("", "qwen2.5:latest", server.URL+"/v1", server.Client())
	if err != nil {
		t.Fatalf("NewOpenAICompat() error = %v", err)
	}

	raw, err := provider.Generate(context.Background(), llm.Request{
		SystemPrompt: "system prompt",
		UserPrompt:   "user prompt",
		OutputMode:   llm.StructuredOutputModePromptOnly,
	})
	if err != nil {
		t.Fatalf("Generate() error = %v", err)
	}
	if raw == "" {
		t.Fatal("Generate() raw = empty, want content")
	}

	if requestBody["model"] != "qwen2.5:latest" {
		t.Fatalf("model = %#v, want qwen2.5:latest", requestBody["model"])
	}
	messages, ok := requestBody["messages"].([]any)
	if !ok || len(messages) != 2 {
		t.Fatalf("messages = %#v, want system+user messages", requestBody["messages"])
	}
}

func TestOpenAICompatProviderUsesAuthWhenAPIKeyPresent(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Fatalf("Authorization = %q, want bearer token", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}))
	defer server.Close()

	provider, err := NewOpenAICompat("test-key", "deepseek-chat", server.URL, server.Client())
	if err != nil {
		t.Fatalf("NewOpenAICompat() error = %v", err)
	}

	if _, err := provider.Generate(context.Background(), llm.Request{
		SystemPrompt: "system prompt",
		UserPrompt:   "user prompt",
	}); err != nil {
		t.Fatalf("Generate() error = %v", err)
	}
}
