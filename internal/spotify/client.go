package spotify

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/plei99/classical-piano-tracker/internal/config"
	"github.com/plei99/classical-piano-tracker/internal/recommend"
	spotifyapi "github.com/zmb3/spotify/v2"
	"golang.org/x/oauth2"
)

type tokenSaver func(*oauth2.Token) error

// OAuthToken wraps an oauth2 token when the CLI layer needs to persist refreshed credentials.
type OAuthToken struct {
	Token *oauth2.Token
}

// Artist is the normalized artist shape used by the app.
type Artist struct {
	ID   string
	Name string
}

// RecentTrack is the normalized recent-play shape used by the app.
type RecentTrack struct {
	SpotifyID  string
	Name       string
	AlbumName  string
	Artists    []Artist
	DurationMS int
	PlayedAt   time.Time
}

// ArtistNames returns the recent track's artist names in order.
func (t RecentTrack) ArtistNames() []string {
	names := make([]string, 0, len(t.Artists))
	for _, artist := range t.Artists {
		names = append(names, artist.Name)
	}

	return names
}

// Client wraps the Spotify SDK and persists refreshed tokens after API calls.
type Client struct {
	api            *spotifyapi.Client
	saveToken      tokenSaver
	lastKnownToken *oauth2.Token
}

// NewClient constructs an authenticated Spotify client from stored config.
func NewClient(ctx context.Context, cfg config.SpotifyConfig, persist func(*OAuthToken) error) (*Client, error) {
	authenticator, err := newAuthenticator(cfg)
	if err != nil {
		return nil, err
	}

	if err := cfg.ValidateStoredToken(); err != nil {
		return nil, fmt.Errorf("missing stored Spotify token: %w", err)
	}

	currentToken := cfg.Token.OAuthToken()
	httpClient := authenticator.Client(ctx, currentToken)
	apiClient := spotifyapi.New(httpClient, spotifyapi.WithRetry(true))

	var save tokenSaver
	if persist != nil {
		save = func(token *oauth2.Token) error {
			return persist(&OAuthToken{Token: cloneToken(token)})
		}
	}

	return &Client{
		api:            apiClient,
		saveToken:      save,
		lastKnownToken: cloneToken(currentToken),
	}, nil
}

// RecentTracks fetches and normalizes the current user's recent Spotify plays.
func (c *Client) RecentTracks(ctx context.Context, limit int) ([]RecentTrack, error) {
	if c == nil || c.api == nil {
		return nil, errors.New("spotify client is not initialized")
	}

	normalizedLimit, err := normalizeRecentTrackLimit(limit)
	if err != nil {
		return nil, err
	}

	items, err := c.api.PlayerRecentlyPlayedOpt(ctx, &spotifyapi.RecentlyPlayedOptions{
		Limit: spotifyapi.Numeric(normalizedLimit),
	})
	if err != nil {
		return nil, fmt.Errorf("fetch recently played tracks from Spotify: %w", err)
	}

	if err := c.persistCurrentToken(); err != nil {
		return nil, err
	}

	return normalizeRecentlyPlayed(items), nil
}

// SearchArtists searches the Spotify catalog for matching artist records.
func (c *Client) SearchArtists(ctx context.Context, query string, limit int) ([]recommend.CatalogArtist, error) {
	if c == nil || c.api == nil {
		return nil, errors.New("spotify client is not initialized")
	}
	if limit < 1 {
		limit = 5
	}

	result, err := c.api.Search(ctx, query, spotifyapi.SearchTypeArtist, spotifyapi.Limit(limit))
	if err != nil {
		return nil, fmt.Errorf("search Spotify artists for %q: %w", query, err)
	}
	if result == nil || result.Artists == nil || len(result.Artists.Artists) == 0 {
		if err := c.persistCurrentToken(); err != nil {
			return nil, err
		}
		return nil, nil
	}

	artists := make([]recommend.CatalogArtist, 0, len(result.Artists.Artists))
	for _, artist := range result.Artists.Artists {
		artistID := ""
		if artist.ID != "" {
			artistID = (&artist.ID).String()
		}
		artists = append(artists, recommend.CatalogArtist{
			Name:       artist.Name,
			ID:         artistID,
			Popularity: int(artist.Popularity),
			Genres:     append([]string(nil), artist.Genres...),
		})
	}

	if err := c.persistCurrentToken(); err != nil {
		return nil, err
	}

	return artists, nil
}

func normalizeRecentTrackLimit(limit int) (int, error) {
	if limit == 0 {
		return 50, nil
	}
	if limit < 1 || limit > 50 {
		return 0, fmt.Errorf("recent track limit must be between 1 and 50, got %d", limit)
	}

	return limit, nil
}

// normalizeRecentlyPlayed converts Spotify SDK types into the app's smaller
// normalized shape so downstream packages do not depend on the SDK directly.
func normalizeRecentlyPlayed(items []spotifyapi.RecentlyPlayedItem) []RecentTrack {
	tracks := make([]RecentTrack, 0, len(items))
	for _, item := range items {
		artists := make([]Artist, 0, len(item.Track.Artists))
		for _, artist := range item.Track.Artists {
			artistID := ""
			if artist.ID != "" {
				artistID = (&artist.ID).String()
			}

			artists = append(artists, Artist{
				ID:   artistID,
				Name: artist.Name,
			})
		}

		spotifyID := ""
		if item.Track.ID != "" {
			spotifyID = (&item.Track.ID).String()
		}

		tracks = append(tracks, RecentTrack{
			SpotifyID:  spotifyID,
			Name:       item.Track.Name,
			AlbumName:  item.Track.Album.Name,
			Artists:    artists,
			DurationMS: int(item.Track.Duration),
			PlayedAt:   item.PlayedAt,
		})
	}

	return tracks
}

// persistCurrentToken snapshots the SDK's current token after API calls so
// refreshes are written back only when something actually changed.
func (c *Client) persistCurrentToken() error {
	if c.saveToken == nil {
		return nil
	}

	currentToken, err := c.api.Token()
	if err != nil {
		return fmt.Errorf("read current Spotify token: %w", err)
	}

	if tokensEqual(currentToken, c.lastKnownToken) {
		return nil
	}

	if err := c.saveToken(currentToken); err != nil {
		return fmt.Errorf("persist refreshed Spotify token: %w", err)
	}

	c.lastKnownToken = cloneToken(currentToken)
	return nil
}

func tokensEqual(left *oauth2.Token, right *oauth2.Token) bool {
	if left == nil || right == nil {
		return left == right
	}

	return left.AccessToken == right.AccessToken &&
		left.RefreshToken == right.RefreshToken &&
		left.TokenType == right.TokenType &&
		left.Expiry.Equal(right.Expiry)
}

// cloneToken prevents shared mutation between the SDK's token and persisted
// snapshots kept by the CLI layer.
func cloneToken(token *oauth2.Token) *oauth2.Token {
	if token == nil {
		return nil
	}

	cloned := *token
	return &cloned
}
