package cli

import (
	"bytes"
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
	runPianistSelection = func(_ io.Reader, _ io.Writer, _ []string) ([]string, error) {
		return []string{defaultPianists[0], defaultPianists[2]}, nil
	}
	defer func() {
		runPianistSelection = previous
	}()

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
	runPianistSelection = func(_ io.Reader, _ io.Writer, pianists []string) ([]string, error) {
		return append([]string(nil), pianists...), nil
	}
	defer func() {
		runPianistSelection = previous
	}()

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
