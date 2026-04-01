package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/plei99/classical-piano-tracker/internal/config"
)

func TestListModelsReturnsFixedDeepSeekAndKimiChoices(t *testing.T) {
	t.Parallel()

	deepseek, err := ListModels(context.Background(), "deepseek", config.LLMProfile{Provider: "openai_compat"})
	if err != nil {
		t.Fatalf("ListModels(deepseek) error = %v", err)
	}
	if len(deepseek) != 2 || deepseek[0] != "deepseek-chat" || deepseek[1] != "deepseek-reasoner" {
		t.Fatalf("deepseek models = %#v, want fixed choices", deepseek)
	}

	kimi, err := ListModels(context.Background(), "kimi", config.LLMProfile{Provider: "openai_compat"})
	if err != nil {
		t.Fatalf("ListModels(kimi) error = %v", err)
	}
	if len(kimi) != 1 || kimi[0] != "kimi-k2.5" {
		t.Fatalf("kimi models = %#v, want fixed choice", kimi)
	}
}

func TestListModelsOpenAIRemovesResponsesSuffixAndUsesAuth(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("path = %q, want /v1/models", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Fatalf("Authorization = %q, want bearer token", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"gpt-5.4"},{"id":"text-embedding-3-large"}]}`))
	}))
	defer server.Close()

	models, err := ListModels(context.Background(), "openai", config.LLMProfile{
		Provider: "openai",
		APIKey:   "test-key",
		BaseURL:  server.URL + "/v1/responses",
	})
	if err != nil {
		t.Fatalf("ListModels(openai) error = %v", err)
	}
	if len(models) != 1 || models[0] != "gpt-5.4" {
		t.Fatalf("models = %#v, want only text-generation model", models)
	}
}

func TestListModelsAnthropicUsesModelsEndpoint(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Fatalf("path = %q, want /v1/models", r.URL.Path)
		}
		if got := r.Header.Get("x-api-key"); got != "test-key" {
			t.Fatalf("x-api-key = %q, want test-key", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"claude-sonnet-4-5"}]}`))
	}))
	defer server.Close()

	models, err := ListModels(context.Background(), "anthropic", config.LLMProfile{
		Provider: "anthropic",
		APIKey:   "test-key",
		BaseURL:  server.URL + "/v1/messages",
	})
	if err != nil {
		t.Fatalf("ListModels(anthropic) error = %v", err)
	}
	if len(models) != 1 || models[0] != "claude-sonnet-4-5" {
		t.Fatalf("models = %#v, want claude-sonnet-4-5", models)
	}
}

func TestListModelsGoogleFiltersGenerateContentModels(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1beta/models" {
			t.Fatalf("path = %q, want /v1beta/models", r.URL.Path)
		}
		if got := r.URL.Query().Get("key"); got != "test-key" {
			t.Fatalf("key = %q, want test-key", got)
		}
		response := googleModelsEnvelope{
			Models: []struct {
				Name                       string   `json:"name"`
				BaseModelID                string   `json:"baseModelId"`
				SupportedGenerationMethods []string `json:"supportedGenerationMethods"`
			}{
				{Name: "models/gemini-2.5-pro", BaseModelID: "gemini-2.5-pro", SupportedGenerationMethods: []string{"generateContent"}},
				{Name: "models/text-embedding-004", BaseModelID: "text-embedding-004", SupportedGenerationMethods: []string{"embedContent"}},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer server.Close()

	models, err := ListModels(context.Background(), "google", config.LLMProfile{
		Provider: "google",
		APIKey:   "test-key",
		BaseURL:  server.URL + "/v1beta/models",
	})
	if err != nil {
		t.Fatalf("ListModels(google) error = %v", err)
	}
	if len(models) != 1 || models[0] != "gemini-2.5-pro" {
		t.Fatalf("models = %#v, want only generateContent model", models)
	}
}

func TestListModelsOllamaUsesTagsEndpoint(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tags" {
			t.Fatalf("path = %q, want /api/tags", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"models":[{"name":"qwen2.5:latest"},{"name":"llama3.1:8b"}]}`))
	}))
	defer server.Close()

	models, err := ListModels(context.Background(), "ollama", config.LLMProfile{
		Provider: "openai_compat",
		BaseURL:  server.URL + "/v1",
	})
	if err != nil {
		t.Fatalf("ListModels(ollama) error = %v", err)
	}
	if len(models) != 2 || models[0] != "llama3.1:8b" || models[1] != "qwen2.5:latest" {
		t.Fatalf("models = %#v, want sorted Ollama tags", models)
	}
}
