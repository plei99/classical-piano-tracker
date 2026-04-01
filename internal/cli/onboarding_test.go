package cli

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"

	"github.com/plei99/classical-piano-tracker/internal/config"
)

func TestParseSelectionSupportsSinglesRangesAndDeduplication(t *testing.T) {
	t.Parallel()

	got, err := parseSelection("1, 3-4, 2, 4", 5)
	if err != nil {
		t.Fatalf("parseSelection() error = %v", err)
	}

	want := []int{0, 2, 3, 1}
	if len(got) != len(want) {
		t.Fatalf("parseSelection() len = %d, want %d", len(got), len(want))
	}
	for idx := range want {
		if got[idx] != want[idx] {
			t.Fatalf("parseSelection()[%d] = %d, want %d", idx, got[idx], want[idx])
		}
	}
}

func TestParseSelectionRejectsInvalidRanges(t *testing.T) {
	t.Parallel()

	if _, err := parseSelection("4-2", 5); err == nil {
		t.Fatal("parseSelection() error = nil, want error for descending range")
	}
	if _, err := parseSelection("7", 5); err == nil {
		t.Fatal("parseSelection() error = nil, want out-of-bounds error")
	}
}

func TestOnboardingCommandWritesSelectedConfig(t *testing.T) {
	t.Parallel()

	configPath := filepath.Join(t.TempDir(), "config.json")

	cmd := NewRootCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetIn(strings.NewReader("spotify-client\nspotify-secret\nopenai-key\n1,3\n"))
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
	if cfg.OpenAI.APIKey != "openai-key" {
		t.Fatalf("OpenAI.APIKey = %q, want openai-key", cfg.OpenAI.APIKey)
	}
	defaultPianists := config.DefaultPianistsAllowlist()
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
	t.Parallel()

	configPath := filepath.Join(t.TempDir(), "config.json")

	cmd := NewRootCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetIn(strings.NewReader("spotify-client\nspotify-secret\n\n\n"))
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
	if cfg.OpenAI.APIKey != "" {
		t.Fatalf("OpenAI.APIKey = %q, want blank optional key", cfg.OpenAI.APIKey)
	}
}
