package cli

import (
	"bytes"
	"context"
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
