package spotify

import (
	"testing"
	"time"

	spotifyapi "github.com/zmb3/spotify/v2"
	"golang.org/x/oauth2"
)

func TestNormalizeRecentTrackLimit(t *testing.T) {
	t.Parallel()

	got, err := normalizeRecentTrackLimit(0)
	if err != nil {
		t.Fatalf("normalizeRecentTrackLimit(0) error = %v", err)
	}
	if got != 50 {
		t.Fatalf("normalizeRecentTrackLimit(0) = %d, want 50", got)
	}

	if _, err := normalizeRecentTrackLimit(51); err == nil {
		t.Fatal("normalizeRecentTrackLimit(51) error = nil, want error")
	}
}

func TestNormalizeRecentlyPlayed(t *testing.T) {
	t.Parallel()

	trackID := spotifyapi.ID("track-id")
	artistID := spotifyapi.ID("artist-id")
	items := []spotifyapi.RecentlyPlayedItem{
		{
			Track: spotifyapi.SimpleTrack{
				ID:   trackID,
				Name: "Piano Sonata No. 14",
				Album: spotifyapi.SimpleAlbum{
					Name: "Beethoven Favorites",
				},
				Artists: []spotifyapi.SimpleArtist{
					{
						ID:   artistID,
						Name: "Martha Argerich",
					},
				},
				Duration: 1234,
			},
			PlayedAt: time.Date(2026, time.March, 31, 12, 0, 0, 0, time.UTC),
		},
	}

	tracks := normalizeRecentlyPlayed(items)
	if len(tracks) != 1 {
		t.Fatalf("normalizeRecentlyPlayed() len = %d, want 1", len(tracks))
	}
	if tracks[0].SpotifyID != "track-id" {
		t.Fatalf("normalizeRecentlyPlayed() spotify_id = %q, want track-id", tracks[0].SpotifyID)
	}
	if tracks[0].AlbumName != "Beethoven Favorites" {
		t.Fatalf("normalizeRecentlyPlayed() album_name = %q, want Beethoven Favorites", tracks[0].AlbumName)
	}
	if len(tracks[0].Artists) != 1 || tracks[0].Artists[0].Name != "Martha Argerich" {
		t.Fatalf("normalizeRecentlyPlayed() artists = %#v, want Martha Argerich", tracks[0].Artists)
	}
}

func TestTokensEqual(t *testing.T) {
	t.Parallel()

	expiry := time.Date(2026, time.March, 31, 12, 0, 0, 0, time.UTC)
	left := &oauth2.Token{
		AccessToken:  "access",
		RefreshToken: "refresh",
		TokenType:    "Bearer",
		Expiry:       expiry,
	}
	right := cloneToken(left)

	if !tokensEqual(left, right) {
		t.Fatal("tokensEqual() = false, want true")
	}

	right.AccessToken = "different"
	if tokensEqual(left, right) {
		t.Fatal("tokensEqual() = true, want false after access-token change")
	}
}
