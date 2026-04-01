package cli

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/plei99/classical-piano-tracker/internal/config"
	"github.com/plei99/classical-piano-tracker/internal/llm/providers"
	"github.com/spf13/cobra"
)

// runPianistSelection is a test seam for swapping out the interactive picker
// when onboarding command tests need deterministic selection results.
var runPianistSelection = promptPianistSelection
var runProviderSelection = promptProviderSelection
var runModelSelection = promptModelSelection
var listOnboardingModels = providers.ListModels

type onboardingProvider struct {
	ProfileName    string
	DisplayName    string
	ProviderKind   string
	DefaultModel   string
	DefaultBaseURL string
	PromptAPIKey   bool
	PromptBaseURL  bool
	FixedModels    []string
}

func onboardingProviders() []onboardingProvider {
	return []onboardingProvider{
		{
			ProfileName:  "openai",
			DisplayName:  "OpenAI",
			ProviderKind: "openai",
			DefaultModel: "gpt-5.4",
			PromptAPIKey: true,
		},
		{
			ProfileName:  "anthropic",
			DisplayName:  "Anthropic",
			ProviderKind: "anthropic",
			DefaultModel: "claude-sonnet-4-5",
			PromptAPIKey: true,
		},
		{
			ProfileName:  "google",
			DisplayName:  "Google Gemini",
			ProviderKind: "google",
			DefaultModel: "gemini-2.5-pro",
			PromptAPIKey: true,
		},
		{
			ProfileName:    "ollama",
			DisplayName:    "Ollama",
			ProviderKind:   "openai_compat",
			DefaultBaseURL: "http://localhost:11434/v1",
			PromptBaseURL:  true,
		},
		{
			ProfileName:    "deepseek",
			DisplayName:    "DeepSeek",
			ProviderKind:   "openai_compat",
			DefaultModel:   "deepseek-chat",
			DefaultBaseURL: "https://api.deepseek.com/v1",
			PromptAPIKey:   true,
			PromptBaseURL:  true,
			FixedModels:    []string{"deepseek-chat", "deepseek-reasoner"},
		},
		{
			ProfileName:    "kimi",
			DisplayName:    "Kimi",
			ProviderKind:   "openai_compat",
			DefaultModel:   "kimi-k2.5",
			DefaultBaseURL: "https://api.moonshot.ai/v1",
			PromptAPIKey:   true,
			PromptBaseURL:  true,
			FixedModels:    []string{"kimi-k2.5"},
		},
	}
}

func newOnboardingCmd(opts *rootOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "onboarding",
		Short: "Interactive first-run setup for Spotify, LLM, and pianist filters",
		Example: "  tracker onboarding\n" +
			"  tracker --config ~/custom-config.json onboarding",
		RunE: func(cmd *cobra.Command, args []string) error {
			configPath, err := opts.resolveConfigPath()
			if err != nil {
				return err
			}

			cfg, _, err := ensureLoadedConfig(configPath)
			if err != nil {
				return err
			}

			input := cmd.InOrStdin()
			reader := bufio.NewReader(input)
			writer := cmd.OutOrStdout()

			cmd.Printf("Config path: %s\n\n", configPath)

			clientID, err := promptRequiredValue(reader, writer, "Spotify client ID", cfg.Spotify.ClientID)
			if err != nil {
				return err
			}
			clientSecret, err := promptRequiredValue(reader, writer, "Spotify client secret", cfg.Spotify.ClientSecret)
			if err != nil {
				return err
			}
			llmConfig := cfg.EffectiveLLMConfig()
			providerChoices := onboardingProviders()
			providerIndex := initialProviderIndex(providerChoices, llmConfig)
			selectedProvider, err := runProviderSelection(input, writer, providerChoices, providerIndex)
			if err != nil {
				return err
			}
			currentProfile := llmConfig.Profiles[selectedProvider.ProfileName]

			apiKey := currentProfile.APIKey
			if selectedProvider.PromptAPIKey {
				apiKey, err = promptOptionalValue(reader, writer, selectedProvider.DisplayName+" API key (optional)", currentProfile.APIKey)
				if err != nil {
					return err
				}
			} else {
				apiKey = ""
			}

			baseURL := currentProfile.BaseURL
			if strings.TrimSpace(baseURL) == "" {
				baseURL = selectedProvider.DefaultBaseURL
			}
			if selectedProvider.PromptBaseURL {
				baseURL, err = promptRequiredValue(reader, writer, selectedProvider.DisplayName+" base URL", baseURL)
				if err != nil {
					return err
				}
			}

			profileForListing := config.LLMProfile{
				Provider: selectedProvider.ProviderKind,
				Model:    currentProfile.Model,
				APIKey:   apiKey,
				BaseURL:  baseURL,
			}
			selectedModel, err := promptProviderModel(cmd.Context(), reader, input, writer, selectedProvider, profileForListing)
			if err != nil {
				return err
			}

			defaultPianists := config.DefaultPianistsAllowlist()
			selected, err := runPianistSelection(input, writer, defaultPianists)
			if err != nil {
				return err
			}

			cfg.Spotify.ClientID = clientID
			cfg.Spotify.ClientSecret = clientSecret
			cfg.SetLLMProfile(selectedProvider.ProfileName, config.LLMProfile{
				Provider: selectedProvider.ProviderKind,
				Model:    selectedModel,
				APIKey:   strings.TrimSpace(apiKey),
				BaseURL:  strings.TrimSpace(baseURL),
			})
			cfg.PianistsAllowlist = selected

			if err := config.Save(configPath, cfg); err != nil {
				return fmt.Errorf("save config %q: %w", configPath, err)
			}

			cmd.Printf("\nSaved onboarding config to %s\n", configPath)
			cmd.Printf("Selected LLM provider: %s (%s)\n", selectedProvider.DisplayName, selectedModel)
			cmd.Printf("Selected %d pianists for pianists_allowlist\n", len(selected))
			cmd.Printf("Next steps:\n")
			cmd.Printf("  1. Add %s to your Spotify app redirect URIs\n", "http://127.0.0.1:8000/api/auth/spotify/callback")
			cmd.Printf("  2. Run `tracker spotify login`\n")
			cmd.Printf("  3. Run `tracker sync`\n")

			return nil
		},
	}
}

func initialProviderIndex(choices []onboardingProvider, cfg config.LLMConfig) int {
	if len(choices) == 0 {
		return 0
	}
	active := strings.TrimSpace(cfg.ActiveProfile)
	for idx, choice := range choices {
		if choice.ProfileName == active {
			return idx
		}
	}
	return 0
}

func promptProviderModel(ctx context.Context, lineReader *bufio.Reader, pickerInput io.Reader, writer io.Writer, provider onboardingProvider, profile config.LLMProfile) (string, error) {
	currentModel := strings.TrimSpace(profile.Model)
	if currentModel == "" {
		currentModel = provider.DefaultModel
	}

	models := append([]string(nil), provider.FixedModels...)
	if len(models) == 0 {
		listed, err := listOnboardingModels(ctx, provider.ProfileName, profile)
		if err != nil {
			fmt.Fprintf(writer, "\nCould not list models for %s: %v\nFalling back to manual model entry.\n\n", provider.DisplayName, err)
			return promptRequiredValue(lineReader, writer, provider.DisplayName+" model", currentModel)
		}
		models = listed
	}

	models = compactNonEmpty(models)
	if len(models) == 0 {
		fmt.Fprintf(writer, "\nNo models were returned for %s.\nFalling back to manual model entry.\n\n", provider.DisplayName)
		return promptRequiredValue(lineReader, writer, provider.DisplayName+" model", currentModel)
	}
	if len(models) == 1 {
		fmt.Fprintf(writer, "%s model: %s\n\n", provider.DisplayName, models[0])
		return models[0], nil
	}

	initial := 0
	if idx := slices.Index(models, currentModel); idx >= 0 {
		initial = idx
	}
	return runModelSelection(pickerInput, writer, "Select model for "+provider.DisplayName, models, initial)
}

func compactNonEmpty(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		result = append(result, trimmed)
	}
	slices.Sort(result)
	return result
}

func promptProviderSelection(reader io.Reader, writer io.Writer, choices []onboardingProvider, initial int) (onboardingProvider, error) {
	labels := make([]string, 0, len(choices))
	for _, choice := range choices {
		labels = append(labels, choice.DisplayName)
	}
	selected, err := runSingleChoiceSelection(reader, writer, "Select LLM provider", "Up/down or j/k: move   enter: confirm   q: cancel", labels, initial)
	if err != nil {
		return onboardingProvider{}, err
	}
	for _, choice := range choices {
		if choice.DisplayName == selected {
			return choice, nil
		}
	}
	return onboardingProvider{}, fmt.Errorf("selected provider %q was not found", selected)
}

func promptModelSelection(reader io.Reader, writer io.Writer, title string, models []string, initial int) (string, error) {
	return runSingleChoiceSelection(reader, writer, title, "Up/down or j/k: move   enter: confirm   q: cancel", models, initial)
}

// promptRequiredValue keeps the line-oriented onboarding prompts small and
// dependency-free for simple string fields.
func promptRequiredValue(reader *bufio.Reader, writer io.Writer, label string, current string) (string, error) {
	for {
		value, err := promptValue(reader, writer, label, current)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(value) == "" {
			fmt.Fprintf(writer, "%s is required.\n", label)
			continue
		}
		return value, nil
	}
}

// promptOptionalValue mirrors promptRequiredValue but preserves blank input.
func promptOptionalValue(reader *bufio.Reader, writer io.Writer, label string, current string) (string, error) {
	return promptValue(reader, writer, label, current)
}

// promptValue implements the shared "show current value, allow Enter to keep"
// behavior used by all non-picker onboarding prompts.
func promptValue(reader *bufio.Reader, writer io.Writer, label string, current string) (string, error) {
	if strings.TrimSpace(current) != "" {
		fmt.Fprintf(writer, "%s [%s]: ", label, current)
	} else {
		fmt.Fprintf(writer, "%s: ", label)
	}

	line, err := reader.ReadString('\n')
	if err != nil && err != io.EOF {
		return "", fmt.Errorf("read %s: %w", label, err)
	}

	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return current, nil
	}
	return trimmed, nil
}
