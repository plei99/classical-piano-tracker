package cli

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"

	"github.com/plei99/classical-piano-tracker/internal/config"
)

func TestConfigAllowlistAddUpdatesConfigFile(t *testing.T) {
	t.Parallel()

	configPath := filepath.Join(t.TempDir(), "config.json")
	cfg := &config.Config{
		Spotify: config.SpotifyConfig{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
		},
		PianistsAllowlist: []string{"Martha Argerich"},
	}
	if err := config.Save(configPath, cfg); err != nil {
		t.Fatalf("config.Save() error = %v", err)
	}

	cmd := NewRootCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs([]string{"--config", configPath, "config", "allowlist", "add", "Daniil Trifonov"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("cmd.Execute() error = %v", err)
	}
	if !strings.Contains(out.String(), `added "Daniil Trifonov"`) {
		t.Fatalf("output = %q, want add confirmation", out.String())
	}

	updated, err := config.Load(configPath)
	if err != nil {
		t.Fatalf("config.Load() error = %v", err)
	}
	if !containsString(updated.PianistsAllowlist, "Daniil Trifonov") {
		t.Fatalf("PianistsAllowlist = %#v, want Daniil Trifonov added", updated.PianistsAllowlist)
	}
}

func TestConfigBlocklistRemovePersistsChange(t *testing.T) {
	t.Parallel()

	configPath := filepath.Join(t.TempDir(), "config.json")
	cfg := &config.Config{
		Spotify: config.SpotifyConfig{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
		},
		PianistsAllowlist: []string{"Martha Argerich"},
		ArtistsBlocklist:  []string{"Yiruma"},
	}
	if err := config.Save(configPath, cfg); err != nil {
		t.Fatalf("config.Save() error = %v", err)
	}

	cmd := NewRootCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs([]string{"--config", configPath, "config", "blocklist", "remove", "yiruma"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("cmd.Execute() error = %v", err)
	}
	if !strings.Contains(out.String(), `removed "yiruma"`) {
		t.Fatalf("output = %q, want remove confirmation", out.String())
	}

	updated, err := config.Load(configPath)
	if err != nil {
		t.Fatalf("config.Load() error = %v", err)
	}
	if containsString(updated.ArtistsBlocklist, "Yiruma") {
		t.Fatalf("ArtistsBlocklist = %#v, want Yiruma removed", updated.ArtistsBlocklist)
	}
}

func TestConfigAllowlistListPrintsEntries(t *testing.T) {
	t.Parallel()

	configPath := filepath.Join(t.TempDir(), "config.json")
	cfg := &config.Config{
		Spotify: config.SpotifyConfig{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
		},
		PianistsAllowlist: []string{"Martha Argerich", "Daniil Trifonov"},
	}
	if err := config.Save(configPath, cfg); err != nil {
		t.Fatalf("config.Save() error = %v", err)
	}

	cmd := NewRootCmd()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs([]string{"--config", configPath, "config", "allowlist", "list"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("cmd.Execute() error = %v", err)
	}

	output := out.String()
	for _, want := range []string{"1. Martha Argerich", "2. Daniil Trifonov"} {
		if !strings.Contains(output, want) {
			t.Fatalf("output = %q, want %q", output, want)
		}
	}
}

func containsString(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}
