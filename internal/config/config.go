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

	"golang.org/x/oauth2"
)

const (
	appDirName = "piano-tracker"
	configName = "config.json"
	fileMode   = 0o600
	dirMode    = 0o700
)

var defaultPianistsAllowlist = []string{
	"Martha Argerich",
	"Vladimir Horowitz",
	"Arthur Rubinstein",
	"Sviatoslav Richter",
	"Emil Gilels",
	"Glenn Gould",
	"Alfred Brendel",
	"Maurizio Pollini",
	"Krystian Zimerman",
	"Evgeny Kissin",
	"Daniil Trifonov",
	"Murray Perahia",
	"Maria Joao Pires",
	"Piotr Anderszewski",
	"Radu Lupu",
	"Claudio Arrau",
	"Wilhelm Kempff",
	"Arturo Benedetti Michelangeli",
	"Alfred Cortot",
	"Dinu Lipatti",
	"Josef Hofmann",
	"Ignaz Friedman",
	"Benno Moiseiwitsch",
	"Walter Gieseking",
	"Myra Hess",
	"Annie Fischer",
	"Alicia de Larrocha",
	"Clara Haskil",
	"Leon Fleisher",
	"Van Cliburn",
	"Byron Janis",
	"Earl Wild",
	"Garrick Ohlsson",
	"Jorge Bolet",
	"Gyorgy Cziffra",
	"Grigory Sokolov",
	"Arcadi Volodos",
	"Nikolai Lugansky",
	"Leif Ove Andsnes",
	"Mitsuko Uchida",
	"Andras Schiff",
	"Stephen Hough",
	"Marc-Andre Hamelin",
	"Igor Levit",
	"Yuja Wang",
	"Seong-Jin Cho",
	"Yunchan Lim",
	"Beatrice Rana",
	"Alexandre Kantorow",
	"Jan Lisiecki",
	"Boris Berezovsky",
	"Denis Matsuev",
	"Paul Lewis",
	"Pierre-Laurent Aimard",
	"Lars Vogt",
	"Jean-Efflam Bavouzet",
	"Wilhelm Backhaus",
	"Samson Francois",
	"Arthur Schnabel",
	"Edwin Fischer",
	"Geza Anda",
	"Lazar Berman",
	"Shura Cherkassky",
	"Josef Lhevinne",
	"Nelson Freire",
	"Nelson Goerner",
	"Angela Hewitt",
	"Behzod Abduraimov",
	"Kirill Gerstein",
	"Emanuel Ax",
	"Barry Douglas",
	"Menahem Pressler",
	"Idil Biret",
	"Fou Ts'ong",
	"Abbey Simon",
	"Pascal Roge",
	"Vladimir Ashkenazy",
	"Yefim Bronfman",
	"Víkingur Ólafsson",
	"Stephen Kovacevich",
	"Lang Lang",
	"Khatia Buniatishvili",
	"Alice Sara Ott",
	"Ivo Pogorelich",
}

// Config stores local application state and curation filters.
type Config struct {
	Spotify           SpotifyConfig `json:"spotify"`
	OpenAI            OpenAIConfig  `json:"openai,omitempty"`
	PianistsAllowlist []string      `json:"pianists_allowlist"`
	ArtistsBlocklist  []string      `json:"artists_blocklist"`
}

// SpotifyConfig stores credentials and OAuth token state.
type SpotifyConfig struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	Token        *Token `json:"token,omitempty"`
}

// OpenAIConfig stores optional OpenAI settings used for recommendations.
type OpenAIConfig struct {
	APIKey string `json:"api_key,omitempty"`
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

// Default returns the first-run config template written when no file exists yet.
func Default() *Config {
	return &Config{
		Spotify:           SpotifyConfig{},
		OpenAI:            OpenAIConfig{},
		PianistsAllowlist: append([]string(nil), defaultPianistsAllowlist...),
		ArtistsBlocklist:  []string{},
	}
}

// DefaultPianistsAllowlist returns a copy of the built-in pianist seed list.
func DefaultPianistsAllowlist() []string {
	return append([]string(nil), defaultPianistsAllowlist...)
}

// OAuthToken returns the config token as an oauth2 token.
func (t *Token) OAuthToken() *oauth2.Token {
	if t == nil {
		return nil
	}

	return &oauth2.Token{
		AccessToken:  t.AccessToken,
		RefreshToken: t.RefreshToken,
		TokenType:    t.TokenType,
		Expiry:       t.Expiry,
	}
}

// TokenFromOAuth converts an oauth2 token into the persisted config format.
// If the new token omits refresh data, the previous value is retained.
func TokenFromOAuth(token *oauth2.Token, previous *Token) *Token {
	if token == nil {
		return nil
	}

	refreshToken := token.RefreshToken
	if refreshToken == "" && previous != nil {
		refreshToken = previous.RefreshToken
	}

	tokenType := token.TokenType
	if tokenType == "" && previous != nil {
		tokenType = previous.TokenType
	}

	expiry := token.Expiry
	if expiry.IsZero() && previous != nil {
		expiry = previous.Expiry
	}

	return &Token{
		AccessToken:  token.AccessToken,
		RefreshToken: refreshToken,
		TokenType:    tokenType,
		Expiry:       expiry,
	}
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

// Ensure creates a default config file when one does not already exist.
// It reports whether a new file was created.
func Ensure(path string) (bool, error) {
	_, err := os.Stat(path)
	if err == nil {
		return false, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("stat config %q: %w", path, err)
	}

	if err := Save(path, Default()); err != nil {
		return false, fmt.Errorf("create default config %q: %w", path, err)
	}

	return true, nil
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

// ValidateClientCredentials checks only the Spotify credentials required to start OAuth.
func (c SpotifyConfig) ValidateClientCredentials() error {
	var problems []string

	if strings.TrimSpace(c.ClientID) == "" {
		problems = append(problems, "spotify.client_id is required")
	}

	if strings.TrimSpace(c.ClientSecret) == "" {
		problems = append(problems, "spotify.client_secret is required")
	}

	if len(problems) > 0 {
		return &ValidationError{Problems: problems}
	}

	return nil
}

// ValidateStoredToken checks the persisted Spotify token fields needed to create an authenticated client.
func (c SpotifyConfig) ValidateStoredToken() error {
	if c.Token == nil {
		return &ValidationError{Problems: []string{"spotify.token is required"}}
	}

	var problems []string

	if strings.TrimSpace(c.Token.AccessToken) == "" {
		problems = append(problems, "spotify.token.access_token is required")
	}

	if c.Token.Expiry.IsZero() {
		problems = append(problems, "spotify.token.expiry is required")
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

// AddArtist appends an artist name if it is not already present in the list.
// Matching is case-insensitive and ignores surrounding whitespace.
func AddArtist(artists []string, artist string) ([]string, bool, error) {
	trimmed := strings.TrimSpace(artist)
	if trimmed == "" {
		return nil, false, errors.New("artist name must not be blank")
	}

	normalized := normalizeArtistName(trimmed)
	for _, existing := range artists {
		if normalizeArtistName(existing) == normalized {
			return append([]string(nil), artists...), false, nil
		}
	}

	updated := append(append([]string(nil), artists...), trimmed)
	return updated, true, nil
}

// RemoveArtist removes all matching artist names from the list.
// Matching is case-insensitive and ignores surrounding whitespace.
func RemoveArtist(artists []string, artist string) ([]string, bool, error) {
	trimmed := strings.TrimSpace(artist)
	if trimmed == "" {
		return nil, false, errors.New("artist name must not be blank")
	}

	normalized := normalizeArtistName(trimmed)
	updated := make([]string, 0, len(artists))
	removed := false
	for _, existing := range artists {
		if normalizeArtistName(existing) == normalized {
			removed = true
			continue
		}
		updated = append(updated, existing)
	}

	return updated, removed, nil
}

func normalizeArtistName(name string) string {
	return strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(name)), " "))
}
