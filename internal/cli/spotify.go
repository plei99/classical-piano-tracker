package cli

import (
	"fmt"

	"github.com/plei99/classical-piano-tracker/internal/config"
	spotifyclient "github.com/plei99/classical-piano-tracker/internal/spotify"
	"github.com/spf13/cobra"
)

func newSpotifyCmd(opts *rootOptions) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "spotify",
		Short: "Authenticate with Spotify and inspect playback data",
		Example: "  tracker spotify login\n" +
			"  tracker spotify recent --limit 10",
	}

	cmd.AddCommand(
		newSpotifyLoginCmd(opts),
		newSpotifyRecentCmd(opts),
	)

	return cmd
}

func newSpotifyLoginCmd(opts *rootOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "login",
		Short: "Run the Spotify OAuth login flow and save the token",
		Example: "  tracker spotify login\n" +
			"  tracker --config ~/custom-config.json spotify login",
		RunE: func(cmd *cobra.Command, args []string) error {
			configPath, err := opts.resolveConfigPath()
			if err != nil {
				return err
			}

			cfg, created, err := ensureLoadedConfig(configPath)
			if err != nil {
				return err
			}
			if created {
				return createdConfigError(configPath, fmt.Sprintf("set spotify.client_id and spotify.client_secret, then rerun `tracker --config %q spotify login`", configPath))
			}

			token, err := spotifyclient.Login(cmd.Context(), cfg.Spotify, func(url string) error {
				cmd.Printf("Open this URL in your browser:\n%s\n\nWaiting for the Spotify callback at %s\n", url, spotifyclient.DefaultRedirectURL)
				return nil
			})
			if err != nil {
				return err
			}

			cfg.Spotify.Token = config.TokenFromOAuth(token, cfg.Spotify.Token)
			if err := config.Save(configPath, cfg); err != nil {
				return fmt.Errorf("save Spotify token to %q: %w", configPath, err)
			}

			cmd.Printf("spotify login succeeded: token saved to %s\n", configPath)
			return nil
		},
	}
}

func newSpotifyRecentCmd(opts *rootOptions) *cobra.Command {
	var limit int

	cmd := &cobra.Command{
		Use:   "recent",
		Short: "Fetch the current user's recent Spotify plays",
		Example: "  tracker spotify recent\n" +
			"  tracker spotify recent --limit 10",
		RunE: func(cmd *cobra.Command, args []string) error {
			configPath, err := opts.resolveConfigPath()
			if err != nil {
				return err
			}

			cfg, created, err := ensureLoadedConfig(configPath)
			if err != nil {
				return err
			}
			if created {
				return createdConfigError(configPath, fmt.Sprintf("set spotify.client_id and spotify.client_secret, run `tracker --config %q spotify login`, then rerun this command", configPath))
			}

			client, err := spotifyclient.NewClient(cmd.Context(), cfg.Spotify, func(token *spotifyclient.OAuthToken) error {
				cfg.Spotify.Token = config.TokenFromOAuth(token.Token, cfg.Spotify.Token)
				return config.Save(configPath, cfg)
			})
			if err != nil {
				return err
			}

			tracks, err := client.RecentTracks(cmd.Context(), limit)
			if err != nil {
				return err
			}

			if len(tracks) == 0 {
				cmd.Println("no recent Spotify plays returned")
				return nil
			}

			printRecentSpotifyTracks(cmd.OutOrStdout(), tracks)

			return nil
		},
	}

	cmd.Flags().IntVar(&limit, "limit", 50, "maximum number of recent plays to fetch (1-50)")

	return cmd
}
