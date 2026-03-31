package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	appDirName = "piano-tracker"
	configName = "config.json"
	fileMode   = 0o600
	dirMode    = 0o700
)

// Config stores local application state and curation filters.
type Config struct {
	Spotify           SpotifyConfig `json:"spotify"`
	PianistsAllowlist []string      `json:"pianists_allowlist"`
	ArtistsBlocklist  []string      `json:"artists_blocklist"`
}

// SpotifyConfig stores credentials and OAuth token state.
type SpotifyConfig struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	Token        *Token `json:"token,omitempty"`
}

// Token stores the persisted OAuth token state.
type Token struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token,omitempty"`
	TokenType    string    `json:"token_type,omitempty"`
	Expiry       time.Time `json:"expiry,omitempty"`
}

// ValidationError contains one or more config validation failures.
type ValidationError struct {
	Problems []string
}

func (e *ValidationError) Error() string {
	return strings.Join(e.Problems, "; ")
}

// PathFromConfigDir returns the default config path for a given config root.
func PathFromConfigDir(configDir string) string {
	return filepath.Join(configDir, appDirName, configName)
}

// DefaultPath returns the default config path under the user's config directory.
func DefaultPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve user config directory: %w", err)
	}

	return PathFromConfigDir(configDir), nil
}

// Load reads and decodes a config file from disk.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf(
				"config file not found at %q; create it manually for now, or use --config to point to an existing file: %w",
				path,
				err,
			)
		}

		return nil, fmt.Errorf("read config %q: %w", path, err)
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()

	var cfg Config
	if err := decoder.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("decode config %q: %w", path, err)
	}

	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("decode config %q: unexpected trailing JSON content", path)
		}
		return nil, fmt.Errorf("decode config %q: %w", path, err)
	}

	return &cfg, nil
}

// LoadAndValidate reads a config file and validates its required fields.
func LoadAndValidate(path string) (*Config, error) {
	cfg, err := Load(path)
	if err != nil {
		return nil, err
	}

	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("invalid config %q: %w", path, err)
	}

	return cfg, nil
}

// Save writes the config to disk using an atomic replace.
func Save(path string, cfg *Config) error {
	if cfg == nil {
		return errors.New("config must not be nil")
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, dirMode); err != nil {
		return fmt.Errorf("create config directory %q: %w", dir, err)
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config %q: %w", path, err)
	}

	data = append(data, '\n')

	tempFile, err := os.CreateTemp(dir, ".config-*.json")
	if err != nil {
		return fmt.Errorf("create temporary config file in %q: %w", dir, err)
	}

	tempPath := tempFile.Name()
	cleanup := true
	defer func() {
		_ = tempFile.Close()
		if cleanup {
			_ = os.Remove(tempPath)
		}
	}()

	if err := tempFile.Chmod(fileMode); err != nil {
		return fmt.Errorf("set permissions on temporary config file %q: %w", tempPath, err)
	}

	if _, err := tempFile.Write(data); err != nil {
		return fmt.Errorf("write temporary config file %q: %w", tempPath, err)
	}

	if err := tempFile.Close(); err != nil {
		return fmt.Errorf("close temporary config file %q: %w", tempPath, err)
	}

	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("replace config file %q: %w", path, err)
	}

	cleanup = false
	return nil
}

// Validate checks required config values for the current CLI phases.
func (c *Config) Validate() error {
	if c == nil {
		return errors.New("config must not be nil")
	}

	var problems []string

	if strings.TrimSpace(c.Spotify.ClientID) == "" {
		problems = append(problems, "spotify.client_id is required")
	}

	if strings.TrimSpace(c.Spotify.ClientSecret) == "" {
		problems = append(problems, "spotify.client_secret is required")
	}

	if len(c.PianistsAllowlist) == 0 {
		problems = append(problems, "pianists_allowlist must contain at least one artist")
	}

	problems = append(problems, validateArtists("pianists_allowlist", c.PianistsAllowlist)...)
	problems = append(problems, validateArtists("artists_blocklist", c.ArtistsBlocklist)...)

	if c.Spotify.Token != nil {
		if strings.TrimSpace(c.Spotify.Token.AccessToken) == "" {
			problems = append(problems, "spotify.token.access_token is required when spotify.token is present")
		}
		if c.Spotify.Token.Expiry.IsZero() {
			problems = append(problems, "spotify.token.expiry is required when spotify.token is present")
		}
	}

	if len(problems) > 0 {
		return &ValidationError{Problems: problems}
	}

	return nil
}

func validateArtists(field string, artists []string) []string {
	var problems []string

	for idx, artist := range artists {
		if strings.TrimSpace(artist) == "" {
			problems = append(problems, fmt.Sprintf("%s[%d] must not be blank", field, idx))
		}
	}

	return problems
}
