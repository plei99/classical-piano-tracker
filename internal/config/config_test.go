package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPathFromConfigDir(t *testing.T) {
	t.Parallel()

	base := filepath.Join(string(os.PathSeparator), "tmp", "config-home")
	got := PathFromConfigDir(base)
	want := filepath.Join(base, "piano-tracker", "config.json")

	if got != want {
		t.Fatalf("PathFromConfigDir() = %q, want %q", got, want)
	}
}

func TestSaveAndLoadRoundTrip(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "piano-tracker", "config.json")
	want := &Config{
		Spotify: SpotifyConfig{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
			Token: &Token{
				AccessToken:  "access-token",
				RefreshToken: "refresh-token",
				TokenType:    "Bearer",
				Expiry:       time.Date(2026, time.March, 31, 12, 0, 0, 0, time.UTC),
			},
		},
		PianistsAllowlist: []string{"Martha Argerich", "Daniil Trifonov"},
		ArtistsBlocklist:  []string{"Yiruma"},
	}

	if err := Save(path, want); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	got, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("Marshal(want) error = %v", err)
	}

	gotJSON, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("Marshal(got) error = %v", err)
	}

	if string(gotJSON) != string(wantJSON) {
		t.Fatalf("Load() mismatch = %s, want %s", gotJSON, wantJSON)
	}
}

func TestLoadMissingConfigReturnsActionableError(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "missing.json")
	_, err := Load(path)
	if err == nil {
		t.Fatal("Load() error = nil, want error")
	}

	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Load() error does not wrap os.ErrNotExist: %v", err)
	}

	if !strings.Contains(err.Error(), "config file not found") {
		t.Fatalf("Load() error = %q, want actionable missing-config message", err)
	}
}

func TestLoadRejectsUnknownFields(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "config.json")
	body := `{
  "spotify": {
    "client_id": "client-id",
    "client_secret": "client-secret"
  },
  "pianists_allowlist": ["Martha Argerich"],
  "artists_blocklist": [],
  "unexpected": true
}`

	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	_, err := Load(path)
	if err == nil {
		t.Fatal("Load() error = nil, want error")
	}

	if !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("Load() error = %q, want unknown field failure", err)
	}
}

func TestValidateRejectsMissingRequiredFields(t *testing.T) {
	t.Parallel()

	cfg := &Config{}
	err := cfg.Validate()
	if err == nil {
		t.Fatal("Validate() error = nil, want error")
	}

	for _, problem := range []string{
		"spotify.client_id is required",
		"spotify.client_secret is required",
		"pianists_allowlist must contain at least one artist",
	} {
		if !strings.Contains(err.Error(), problem) {
			t.Fatalf("Validate() error = %q, want %q", err, problem)
		}
	}
}

func TestValidateRejectsInvalidTokenAndArtists(t *testing.T) {
	t.Parallel()

	cfg := &Config{
		Spotify: SpotifyConfig{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
			Token:        &Token{},
		},
		PianistsAllowlist: []string{"", "Martha Argerich"},
		ArtistsBlocklist:  []string{" "},
	}

	err := cfg.Validate()
	if err == nil {
		t.Fatal("Validate() error = nil, want error")
	}

	for _, problem := range []string{
		"pianists_allowlist[0] must not be blank",
		"artists_blocklist[0] must not be blank",
		"spotify.token.access_token is required when spotify.token is present",
		"spotify.token.expiry is required when spotify.token is present",
	} {
		if !strings.Contains(err.Error(), problem) {
			t.Fatalf("Validate() error = %q, want %q", err, problem)
		}
	}
}
