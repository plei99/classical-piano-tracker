package cli

import (
	"bytes"
	"context"
	"errors"
	"io"
	"path/filepath"
	"strings"
	"testing"

	"github.com/plei99/classical-piano-tracker/internal/config"
)

func TestOnboardingCommandWritesSelectedConfig(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")

	defaultPianists := config.DefaultPianistsAllowlist()
	previous := runPianistSelection
	previousProvider := runProviderSelection
	previousModel := runModelSelection
	previousListModels := listOnboardingModels
	runPianistSelection = func(_ io.Reader, _ io.Writer, _ []string) ([]string, error) {
		return []string{defaultPianists[0], defaultPianists[2]}, nil
	}
	defer func() {
		runPianistSelection = previous
		runProviderSelection = previousProvider
		runModelSelection = previousModel
		listOnboardingModels = previousListModels
	}()
	runProviderSelection = func(_ io.Reader, _ io.Writer, choices []onboardingProvider, _ int) (onboardingProvider, error) {
		return choices[0], nil
	}
	runModelSelection = func(_ io.Reader, _ io.Writer, _ string, _ []string, _ int) (string, error) {
		return "gpt-5.4", nil
	}
	listOnboardingModels = func(_ context.Context, _ string, _ config.LLMProfile) ([]string, error) {
		return []string{"gpt-5.4", "gpt-4o-mini"}, nil
	}

	cmd := NewRootCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetIn(strings.NewReader("spotify-client\nspotify-secret\nopenai-key\n"))
	cmd.SetArgs([]string{"--config", configPath, "onboarding"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("cmd.Execute() error = %v", err)
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatalf("config.Load() error = %v", err)
	}

	if cfg.Spotify.ClientID != "spotify-client" || cfg.Spotify.ClientSecret != "spotify-secret" {
		t.Fatalf("unexpected Spotify config: %#v", cfg.Spotify)
	}
	if profile := cfg.EffectiveLLMConfig().Profiles["openai"]; profile.APIKey != "openai-key" {
		t.Fatalf("openai profile APIKey = %q, want openai-key", profile.APIKey)
	}
	if cfg.EffectiveLLMConfig().ActiveProfile != "openai" {
		t.Fatalf("ActiveProfile = %q, want openai", cfg.EffectiveLLMConfig().ActiveProfile)
	}
	if profile := cfg.EffectiveLLMConfig().Profiles["openai"]; profile.Model != "gpt-5.4" {
		t.Fatalf("openai profile Model = %q, want gpt-5.4", profile.Model)
	}
	wantAllowlist := []string{defaultPianists[0], defaultPianists[2]}
	if len(cfg.PianistsAllowlist) != len(wantAllowlist) {
		t.Fatalf("PianistsAllowlist len = %d, want %d", len(cfg.PianistsAllowlist), len(wantAllowlist))
	}
	for idx := range wantAllowlist {
		if cfg.PianistsAllowlist[idx] != wantAllowlist[idx] {
			t.Fatalf("PianistsAllowlist[%d] = %q, want %q", idx, cfg.PianistsAllowlist[idx], wantAllowlist[idx])
		}
	}

	if !strings.Contains(out.String(), "Saved onboarding config") {
		t.Fatalf("output = %q, want save confirmation", out.String())
	}
}

func TestOnboardingCommandKeepsFullDefaultAllowlistOnBlankSelection(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")

	previous := runPianistSelection
	previousProvider := runProviderSelection
	previousModel := runModelSelection
	previousListModels := listOnboardingModels
	runPianistSelection = func(_ io.Reader, _ io.Writer, pianists []string) ([]string, error) {
		return append([]string(nil), pianists...), nil
	}
	defer func() {
		runPianistSelection = previous
		runProviderSelection = previousProvider
		runModelSelection = previousModel
		listOnboardingModels = previousListModels
	}()
	runProviderSelection = func(_ io.Reader, _ io.Writer, choices []onboardingProvider, _ int) (onboardingProvider, error) {
		return choices[0], nil
	}
	runModelSelection = func(_ io.Reader, _ io.Writer, _ string, _ []string, _ int) (string, error) {
		return "gpt-5.4", nil
	}
	listOnboardingModels = func(_ context.Context, _ string, _ config.LLMProfile) ([]string, error) {
		return []string{"gpt-5.4"}, nil
	}

	cmd := NewRootCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetIn(strings.NewReader("spotify-client\nspotify-secret\n\n"))
	cmd.SetArgs([]string{"--config", configPath, "onboarding"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("cmd.Execute() error = %v", err)
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatalf("config.Load() error = %v", err)
	}

	if len(cfg.PianistsAllowlist) != len(config.DefaultPianistsAllowlist()) {
		t.Fatalf("PianistsAllowlist len = %d, want full default list", len(cfg.PianistsAllowlist))
	}
	if profile := cfg.EffectiveLLMConfig().Profiles["openai"]; profile.APIKey != "" {
		t.Fatalf("openai profile APIKey = %q, want blank optional key", profile.APIKey)
	}
}

func TestOnboardingCommandWritesFixedDeepSeekModel(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")

	defaultPianists := config.DefaultPianistsAllowlist()
	previous := runPianistSelection
	previousProvider := runProviderSelection
	previousModel := runModelSelection
	previousListModels := listOnboardingModels
	runPianistSelection = func(_ io.Reader, _ io.Writer, _ []string) ([]string, error) {
		return []string{defaultPianists[0]}, nil
	}
	defer func() {
		runPianistSelection = previous
		runProviderSelection = previousProvider
		runModelSelection = previousModel
		listOnboardingModels = previousListModels
	}()
	runProviderSelection = func(_ io.Reader, _ io.Writer, choices []onboardingProvider, _ int) (onboardingProvider, error) {
		for _, choice := range choices {
			if choice.ProfileName == "deepseek" {
				return choice, nil
			}
		}
		t.Fatal("deepseek choice not found")
		return onboardingProvider{}, nil
	}
	runModelSelection = func(_ io.Reader, _ io.Writer, _ string, models []string, _ int) (string, error) {
		return models[1], nil
	}
	listOnboardingModels = func(_ context.Context, _ string, _ config.LLMProfile) ([]string, error) {
		t.Fatal("listOnboardingModels should not be called for fixed-model provider")
		return nil, nil
	}

	cmd := NewRootCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetIn(strings.NewReader("spotify-client\nspotify-secret\ndeepseek-key\nhttps://api.deepseek.com/v1\n"))
	cmd.SetArgs([]string{"--config", configPath, "onboarding"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("cmd.Execute() error = %v", err)
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatalf("config.Load() error = %v", err)
	}

	if cfg.EffectiveLLMConfig().ActiveProfile != "deepseek" {
		t.Fatalf("ActiveProfile = %q, want deepseek", cfg.EffectiveLLMConfig().ActiveProfile)
	}
	profile := cfg.EffectiveLLMConfig().Profiles["deepseek"]
	if profile.Provider != "openai_compat" || profile.Model != "deepseek-reasoner" || profile.APIKey != "deepseek-key" {
		t.Fatalf("deepseek profile = %#v, want selected fixed-model profile", profile)
	}
}

func TestOnboardingCommandWritesClaudeCLIProfileWithResolvedCommand(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")

	defaultPianists := config.DefaultPianistsAllowlist()
	previous := runPianistSelection
	previousProvider := runProviderSelection
	previousModel := runModelSelection
	previousListModels := listOnboardingModels
	previousLookup := lookupClaudeCommand
	runPianistSelection = func(_ io.Reader, _ io.Writer, _ []string) ([]string, error) {
		return []string{defaultPianists[0]}, nil
	}
	defer func() {
		runPianistSelection = previous
		runProviderSelection = previousProvider
		runModelSelection = previousModel
		listOnboardingModels = previousListModels
		lookupClaudeCommand = previousLookup
	}()
	runProviderSelection = func(_ io.Reader, _ io.Writer, choices []onboardingProvider, _ int) (onboardingProvider, error) {
		for _, choice := range choices {
			if choice.ProfileName == "claude_cli" {
				if choice.PromptAPIKey {
					t.Fatal("claude_cli choice should not prompt for an API key")
				}
				return choice, nil
			}
		}
		t.Fatal("claude_cli choice not found")
		return onboardingProvider{}, nil
	}
	runModelSelection = func(_ io.Reader, _ io.Writer, _ string, models []string, initial int) (string, error) {
		if models[initial] != "sonnet" {
			t.Fatalf("initial model = %q, want default sonnet preselected", models[initial])
		}
		return models[initial], nil
	}
	listOnboardingModels = func(_ context.Context, _ string, _ config.LLMProfile) ([]string, error) {
		t.Fatal("listOnboardingModels should not be called for fixed-model provider")
		return nil, nil
	}
	lookupClaudeCommand = func() (string, error) {
		return "/stub/bin/claude", nil
	}

	cmd := NewRootCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetIn(strings.NewReader("spotify-client\nspotify-secret\n"))
	cmd.SetArgs([]string{"--config", configPath, "onboarding"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("cmd.Execute() error = %v", err)
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatalf("config.Load() error = %v", err)
	}

	if cfg.EffectiveLLMConfig().ActiveProfile != "claude_cli" {
		t.Fatalf("ActiveProfile = %q, want claude_cli", cfg.EffectiveLLMConfig().ActiveProfile)
	}
	profile := cfg.EffectiveLLMConfig().Profiles["claude_cli"]
	if profile.Provider != "claude_cli" || profile.Model != "sonnet" || profile.APIKey != "" || profile.Command != "/stub/bin/claude" {
		t.Fatalf("claude_cli profile = %#v, want provider claude_cli, model sonnet, no key, resolved command", profile)
	}
}

func TestOnboardingCommandWarnsWhenClaudeCLIIsMissing(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")

	defaultPianists := config.DefaultPianistsAllowlist()
	previous := runPianistSelection
	previousProvider := runProviderSelection
	previousModel := runModelSelection
	previousLookup := lookupClaudeCommand
	runPianistSelection = func(_ io.Reader, _ io.Writer, _ []string) ([]string, error) {
		return []string{defaultPianists[0]}, nil
	}
	defer func() {
		runPianistSelection = previous
		runProviderSelection = previousProvider
		runModelSelection = previousModel
		lookupClaudeCommand = previousLookup
	}()
	runProviderSelection = func(_ io.Reader, _ io.Writer, choices []onboardingProvider, _ int) (onboardingProvider, error) {
		for _, choice := range choices {
			if choice.ProfileName == "claude_cli" {
				return choice, nil
			}
		}
		t.Fatal("claude_cli choice not found")
		return onboardingProvider{}, nil
	}
	runModelSelection = func(_ io.Reader, _ io.Writer, _ string, models []string, _ int) (string, error) {
		return models[0], nil
	}
	lookupClaudeCommand = func() (string, error) {
		return "", errors.New("executable file not found in $PATH")
	}

	cmd := NewRootCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetIn(strings.NewReader("spotify-client\nspotify-secret\n"))
	cmd.SetArgs([]string{"--config", configPath, "onboarding"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("cmd.Execute() error = %v, want onboarding to succeed with a warning", err)
	}
	if !strings.Contains(out.String(), "Could not find the claude command") {
		t.Fatalf("output = %q, want missing-claude warning", out.String())
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatalf("config.Load() error = %v", err)
	}
	profile := cfg.EffectiveLLMConfig().Profiles["claude_cli"]
	if profile.Command != "" {
		t.Fatalf("profile.Command = %q, want empty so PATH lookup happens at runtime", profile.Command)
	}
}

func TestOnboardingCodexProfile(t *testing.T) {
	for _, tc := range []struct {
		name, model, existingCommand, foundCommand string
		missing                                    bool
	}{
		{name: "default model", foundCommand: "/opt/bin/codex"},
		{name: "manual model", model: "chosen-model", foundCommand: "/opt/bin/codex"},
		{name: "missing command", missing: true},
		{name: "preserve custom command", existingCommand: "/custom/codex"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.json")
			if tc.existingCommand != "" {
				cfg := &config.Config{Spotify: config.SpotifyConfig{ClientID: "old", ClientSecret: "old"}}
				cfg.SetLLMProfile("codex", config.LLMProfile{Provider: "codex", Command: tc.existingCommand})
				if err := config.Save(path, cfg); err != nil {
					t.Fatal(err)
				}
			}
			oldPicker, oldProvider, oldLookup, oldListing := runPianistSelection, runProviderSelection, lookupCodexCommand, listOnboardingModels
			t.Cleanup(func() {
				runPianistSelection, runProviderSelection, lookupCodexCommand, listOnboardingModels = oldPicker, oldProvider, oldLookup, oldListing
			})
			runPianistSelection = func(io.Reader, io.Writer, []string) ([]string, error) { return []string{"Martha Argerich"}, nil }
			runProviderSelection = func(_ io.Reader, _ io.Writer, choices []onboardingProvider, _ int) (onboardingProvider, error) {
				for _, choice := range choices {
					if choice.ProviderKind == "codex" {
						if choice.PromptAPIKey || choice.PromptBaseURL {
							t.Fatal("Codex must not prompt for API credentials")
						}
						return choice, nil
					}
				}
				t.Fatal("Codex choice missing")
				return onboardingProvider{}, nil
			}
			lookupCodexCommand = func() (string, error) {
				if tc.existingCommand != "" {
					t.Fatal("must preserve existing executable path")
				}
				if tc.missing {
					return "", errors.New("not installed")
				}
				return tc.foundCommand, nil
			}
			listOnboardingModels = func(context.Context, string, config.LLMProfile) ([]string, error) {
				t.Fatal("Codex onboarding must not use API model listing")
				return nil, nil
			}
			cmd := NewRootCmd()
			var out bytes.Buffer
			cmd.SetOut(&out)
			cmd.SetErr(&out)
			cmd.SetIn(strings.NewReader("spotify-client\nspotify-secret\n" + tc.model + "\n"))
			cmd.SetArgs([]string{"--config", path, "onboarding"})
			if err := cmd.Execute(); err != nil {
				t.Fatal(err)
			}
			cfg, err := config.Load(path)
			if err != nil {
				t.Fatal(err)
			}
			if err := cfg.Validate(); err != nil {
				t.Fatal(err)
			}
			profile := cfg.EffectiveLLMConfig().Profiles["codex"]
			command := tc.foundCommand
			if tc.existingCommand != "" {
				command = tc.existingCommand
			}
			if cfg.LLM.ActiveProfile != "codex" || profile.Provider != "codex" || profile.Model != tc.model || profile.Command != command || profile.APIKey != "" {
				t.Fatalf("unexpected Codex profile: %+v", profile)
			}
			if tc.missing && !strings.Contains(out.String(), "Could not find the codex command") {
				t.Fatalf("missing warning: %s", &out)
			}
		})
	}
}
