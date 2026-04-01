package providers

import (
	"fmt"
	"os"
	"strings"

	"github.com/plei99/classical-piano-tracker/internal/config"
	"github.com/plei99/classical-piano-tracker/internal/llm"
)

// FromConfig resolves the effective LLM profile from config and environment.
func FromConfig(cfg *config.Config) (llm.Provider, error) {
	profileName, profile, err := resolveProfile(cfg)
	if err != nil {
		return nil, err
	}

	switch strings.ToLower(strings.TrimSpace(profile.Provider)) {
	case "openai":
		return NewOpenAI(profile.APIKey, profile.Model, profile.BaseURL, nil)
	default:
		return nil, fmt.Errorf("LLM provider %q for profile %q is not implemented yet", profile.Provider, profileName)
	}
}

func resolveProfile(cfg *config.Config) (string, config.LLMProfile, error) {
	effective := config.DefaultLLMConfig()
	if cfg != nil {
		effective = cfg.EffectiveLLMConfig()
	}

	profileName := strings.TrimSpace(os.Getenv("LLM_PROFILE"))
	if profileName == "" {
		profileName = strings.TrimSpace(effective.ActiveProfile)
	}
	if profileName == "" {
		profileName = "openai"
	}

	profile, ok := effective.Profiles[profileName]
	if !ok {
		return "", config.LLMProfile{}, fmt.Errorf("LLM profile %q was not found in llm.profiles", profileName)
	}

	if provider := strings.TrimSpace(os.Getenv("LLM_PROVIDER")); provider != "" {
		profile.Provider = provider
	}
	if model := strings.TrimSpace(os.Getenv("LLM_MODEL")); model != "" {
		profile.Model = model
	}
	if baseURL := strings.TrimSpace(os.Getenv("LLM_BASE_URL")); baseURL != "" {
		profile.BaseURL = baseURL
	}
	if apiKey := strings.TrimSpace(os.Getenv("LLM_API_KEY")); apiKey != "" {
		profile.APIKey = apiKey
	}

	if strings.TrimSpace(profile.Provider) == "" {
		profile.Provider = "openai"
	}
	if strings.EqualFold(profile.Provider, "openai") {
		if strings.TrimSpace(profile.Model) == "" {
			profile.Model = strings.TrimSpace(os.Getenv("OPENAI_MODEL"))
		}
		if strings.TrimSpace(profile.BaseURL) == "" {
			profile.BaseURL = strings.TrimSpace(os.Getenv("OPENAI_BASE_URL"))
		}
	}

	if strings.TrimSpace(profile.APIKey) == "" {
		for _, envVar := range providerAPIKeyEnvVars(profileName, profile.Provider) {
			if value := strings.TrimSpace(os.Getenv(envVar)); value != "" {
				profile.APIKey = value
				break
			}
		}
	}

	return profileName, profile, nil
}

func providerAPIKeyEnvVars(profileName string, provider string) []string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "openai":
		return []string{"OPENAI_API_KEY"}
	case "anthropic":
		return []string{"ANTHROPIC_API_KEY"}
	case "google":
		return []string{"GOOGLE_API_KEY", "GEMINI_API_KEY"}
	case "openai_compat":
		switch strings.ToLower(strings.TrimSpace(profileName)) {
		case "deepseek":
			return []string{"DEEPSEEK_API_KEY"}
		case "kimi":
			return []string{"KIMI_API_KEY"}
		default:
			return nil
		}
	default:
		return nil
	}
}
