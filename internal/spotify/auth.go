package spotify

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/plei99/classical-piano-tracker/internal/config"
	spotifyauth "github.com/zmb3/spotify/v2/auth"
	"golang.org/x/oauth2"
)

const (
	// DefaultRedirectURL is the local callback used during the CLI OAuth flow.
	DefaultRedirectURL = "http://127.0.0.1:8000/api/auth/spotify/callback"

	callbackShutdownTimeout = 5 * time.Second
)

func newAuthenticator(cfg config.SpotifyConfig) (*spotifyauth.Authenticator, error) {
	if err := cfg.ValidateClientCredentials(); err != nil {
		return nil, fmt.Errorf("invalid Spotify credentials: %w", err)
	}

	return spotifyauth.New(
		spotifyauth.WithClientID(cfg.ClientID),
		spotifyauth.WithClientSecret(cfg.ClientSecret),
		spotifyauth.WithRedirectURL(DefaultRedirectURL),
		spotifyauth.WithScopes(spotifyauth.ScopeUserReadRecentlyPlayed),
	), nil
}

// Login runs the Spotify OAuth flow and returns the issued token.
func Login(ctx context.Context, cfg config.SpotifyConfig, presentURL func(string) error) (*oauth2.Token, error) {
	authenticator, err := newAuthenticator(cfg)
	if err != nil {
		return nil, err
	}

	listenAddr, callbackPath, err := callbackServerConfig(DefaultRedirectURL)
	if err != nil {
		return nil, err
	}

	state, err := randomState()
	if err != nil {
		return nil, fmt.Errorf("generate OAuth state: %w", err)
	}

	listener, err := net.Listen("tcp", listenAddr)
	if err != nil {
		return nil, fmt.Errorf("listen for Spotify callback on %s: %w", listenAddr, err)
	}

	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)

	mux := http.NewServeMux()
	mux.HandleFunc(callbackPath, func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		if query.Get("state") != state {
			http.Error(w, "spotify login failed: state mismatch", http.StatusBadRequest)
			sendCallbackError(errCh, errors.New("spotify login failed: callback state mismatch"))
			return
		}

		if authErr := query.Get("error"); authErr != "" {
			http.Error(w, "spotify login failed", http.StatusBadRequest)
			sendCallbackError(errCh, fmt.Errorf("spotify login failed: %s", authErr))
			return
		}

		code := query.Get("code")
		if code == "" {
			http.Error(w, "spotify login failed: missing code", http.StatusBadRequest)
			sendCallbackError(errCh, errors.New("spotify login failed: missing authorization code"))
			return
		}

		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("Spotify authentication complete. You can close this window.\n"))

		select {
		case codeCh <- code:
		default:
		}
	})

	server := &http.Server{Handler: mux}
	go func() {
		if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			sendCallbackError(errCh, fmt.Errorf("serve Spotify callback listener: %w", serveErr))
		}
	}()

	authURL := authenticator.AuthURL(state)
	if presentURL != nil {
		if err := presentURL(authURL); err != nil {
			_ = shutdownCallbackServer(server)
			return nil, err
		}
	}

	select {
	case <-ctx.Done():
		_ = shutdownCallbackServer(server)
		return nil, fmt.Errorf("spotify login canceled: %w", ctx.Err())
	case err := <-errCh:
		_ = shutdownCallbackServer(server)
		return nil, err
	case code := <-codeCh:
		token, err := authenticator.Exchange(ctx, code)
		_ = shutdownCallbackServer(server)
		if err != nil {
			return nil, fmt.Errorf("exchange Spotify authorization code: %w", err)
		}
		return token, nil
	}
}

func callbackServerConfig(rawURL string) (listenAddr string, callbackPath string, err error) {
	redirectURL, err := url.Parse(rawURL)
	if err != nil {
		return "", "", fmt.Errorf("parse redirect URL %q: %w", rawURL, err)
	}

	if redirectURL.Scheme != "http" {
		return "", "", fmt.Errorf("redirect URL %q must use http for local callback handling", rawURL)
	}
	if redirectURL.Host == "" {
		return "", "", fmt.Errorf("redirect URL %q must include a host", rawURL)
	}
	if redirectURL.Path == "" {
		return "", "", fmt.Errorf("redirect URL %q must include a callback path", rawURL)
	}
	if redirectURL.RawQuery != "" || redirectURL.Fragment != "" {
		return "", "", fmt.Errorf("redirect URL %q must not include query or fragment components", rawURL)
	}

	host := redirectURL.Host
	if !strings.Contains(host, ":") {
		host += ":80"
	}

	return host, redirectURL.Path, nil
}

func randomState() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}

	return hex.EncodeToString(buf), nil
}

func shutdownCallbackServer(server *http.Server) error {
	ctx, cancel := context.WithTimeout(context.Background(), callbackShutdownTimeout)
	defer cancel()
	return server.Shutdown(ctx)
}

func sendCallbackError(errCh chan<- error, err error) {
	select {
	case errCh <- err:
	default:
	}
}
