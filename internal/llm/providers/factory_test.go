package providers

import (
	"testing"

	"github.com/plei99/classical-piano-tracker/internal/config"
)

func TestFromConfigUsesLLMProfileAndGenericEnvOverrides(t *testing.T) {
	t.Setenv("LLM_MODEL", "override-model")
	t.Setenv("LLM_BASE_URL", "https://override.example/v1")
	t.Setenv("LLM_API_KEY", "override-key")

	provider, err := FromConfig(&config.Config{
		LLM: config.LLMConfig{
			ActiveProfile: "openai",
			Profiles: map[string]config.LLMProfile{
				"openai": {
					Provider: "openai",
					Model:    "config-model",
					APIKey:   "config-key",
					BaseURL:  "https://config.example/v1",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("FromConfig() error = %v", err)
	}

	openAI, ok := provider.(*openAIProvider)
	if !ok {
		t.Fatalf("provider type = %T, want *openAIProvider", provider)
	}
	if openAI.model != "override-model" {
		t.Fatalf("model = %q, want override-model", openAI.model)
	}
	if openAI.baseURL != "https://override.example/v1" {
		t.Fatalf("baseURL = %q, want override.example", openAI.baseURL)
	}
	if openAI.apiKey != "override-key" {
		t.Fatalf("apiKey = %q, want override-key", openAI.apiKey)
	}
}

func TestFromConfigFallsBackToLegacyOpenAIBlock(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")

	provider, err := FromConfig(&config.Config{
		OpenAI: config.OpenAIConfig{APIKey: "legacy-key"},
	})
	if err != nil {
		t.Fatalf("FromConfig() error = %v", err)
	}

	openAI, ok := provider.(*openAIProvider)
	if !ok {
		t.Fatalf("provider type = %T, want *openAIProvider", provider)
	}
	if openAI.apiKey != "legacy-key" {
		t.Fatalf("apiKey = %q, want legacy-key", openAI.apiKey)
	}
	if openAI.model != "gpt-5.4" {
		t.Fatalf("model = %q, want gpt-5.4", openAI.model)
	}
}

func TestFromConfigRejectsUnsupportedProvider(t *testing.T) {
	provider, err := FromConfig(&config.Config{
		LLM: config.LLMConfig{
			ActiveProfile: "anthropic",
			Profiles: map[string]config.LLMProfile{
				"anthropic": {
					Provider: "anthropic",
					Model:    "claude",
					APIKey:   "key",
				},
			},
		},
	})
	if err == nil {
		t.Fatalf("FromConfig() error = nil, provider = %#v", provider)
	}
}
