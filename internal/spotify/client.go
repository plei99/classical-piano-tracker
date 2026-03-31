package spotify

import spotifyapi "github.com/zmb3/spotify/v2"

// Client wraps the Spotify SDK and gives this package a stable home for app logic.
type Client struct {
	api *spotifyapi.Client
}

// NewClient constructs a package-level Spotify client wrapper.
func NewClient(api *spotifyapi.Client) *Client {
	return &Client{api: api}
}
