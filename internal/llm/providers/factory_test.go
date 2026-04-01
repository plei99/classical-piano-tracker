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

func TestFromConfigSupportsAnthropicProfile(t *testing.T) {
	provider, err := FromConfig(&config.Config{
		LLM: config.LLMConfig{
			ActiveProfile: "anthropic",
			Profiles: map[string]config.LLMProfile{
				"anthropic": {
					Provider: "anthropic",
					Model:    "claude-sonnet-4-5",
					APIKey:   "key",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("FromConfig() error = %v", err)
	}

	anthropic, ok := provider.(*anthropicProvider)
	if !ok {
		t.Fatalf("provider type = %T, want *anthropicProvider", provider)
	}
	if anthropic.model != "claude-sonnet-4-5" {
		t.Fatalf("model = %q, want claude-sonnet-4-5", anthropic.model)
	}
}

func TestFromConfigSupportsGoogleProfile(t *testing.T) {
	provider, err := FromConfig(&config.Config{
		LLM: config.LLMConfig{
			ActiveProfile: "google",
			Profiles: map[string]config.LLMProfile{
				"google": {
					Provider: "google",
					Model:    "gemini-2.5-pro",
					APIKey:   "key",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("FromConfig() error = %v", err)
	}

	google, ok := provider.(*googleProvider)
	if !ok {
		t.Fatalf("provider type = %T, want *googleProvider", provider)
	}
	if google.model != "gemini-2.5-pro" {
		t.Fatalf("model = %q, want gemini-2.5-pro", google.model)
	}
}

func TestFromConfigSupportsOpenAICompatProfile(t *testing.T) {
	provider, err := FromConfig(&config.Config{
		LLM: config.LLMConfig{
			ActiveProfile: "ollama",
			Profiles: map[string]config.LLMProfile{
				"ollama": {
					Provider: "openai_compat",
					Model:    "qwen2.5:latest",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("FromConfig() error = %v", err)
	}

	openAICompat, ok := provider.(*openAICompatProvider)
	if !ok {
		t.Fatalf("provider type = %T, want *openAICompatProvider", provider)
	}
	if openAICompat.baseURL != "http://localhost:11434/v1" {
		t.Fatalf("baseURL = %q, want Ollama default", openAICompat.baseURL)
	}
	if openAICompat.apiKey != "" {
		t.Fatalf("apiKey = %q, want empty for Ollama-compatible profile", openAICompat.apiKey)
	}
}

func TestFromConfigUsesDeepSeekAPIKeyFallback(t *testing.T) {
	t.Setenv("DEEPSEEK_API_KEY", "deepseek-key")

	provider, err := FromConfig(&config.Config{
		LLM: config.LLMConfig{
			ActiveProfile: "deepseek",
			Profiles: map[string]config.LLMProfile{
				"deepseek": {
					Provider: "openai_compat",
					Model:    "deepseek-chat",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("FromConfig() error = %v", err)
	}

	openAICompat, ok := provider.(*openAICompatProvider)
	if !ok {
		t.Fatalf("provider type = %T, want *openAICompatProvider", provider)
	}
	if openAICompat.apiKey != "deepseek-key" {
		t.Fatalf("apiKey = %q, want deepseek-key", openAICompat.apiKey)
	}
	if openAICompat.baseURL != "https://api.deepseek.com/v1" {
		t.Fatalf("baseURL = %q, want DeepSeek default", openAICompat.baseURL)
	}
}
