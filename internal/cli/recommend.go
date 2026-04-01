package cli

import (
	"context"
	"fmt"
	"strings"

	"github.com/plei99/classical-piano-tracker/internal/config"
	"github.com/plei99/classical-piano-tracker/internal/db"
	"github.com/plei99/classical-piano-tracker/internal/openai"
	"github.com/plei99/classical-piano-tracker/internal/recommend"
	spotifyclient "github.com/plei99/classical-piano-tracker/internal/spotify"
	"github.com/spf13/cobra"
)

func newRecommendCmd(opts *rootOptions) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "recommend",
		Short: "Analyze favorites and generate pianist recommendations",
	}

	cmd.AddCommand(
		newRecommendFavoritesCmd(opts),
		newRecommendPianistsCmd(opts),
	)

	return cmd
}

func newRecommendFavoritesCmd(opts *rootOptions) *cobra.Command {
	var limit int

	cmd := &cobra.Command{
		Use:   "favorites",
		Short: "Rank favorite pianists from local ratings and replay counts",
		RunE: func(cmd *cobra.Command, args []string) error {
			if limit < 1 {
				return fmt.Errorf("limit must be at least 1, got %d", limit)
			}

			cfg, _, err := loadRecommendationConfig(opts)
			if err != nil {
				return err
			}
			if len(cfg.PianistsAllowlist) == 0 {
				return fmt.Errorf("config has an empty pianists_allowlist")
			}

			tracks, ratings, err := loadRecommendationData(cmd.Context(), opts)
			if err != nil {
				return err
			}

			profiles, err := recommend.BuildPianistProfiles(tracks, ratings, cfg.PianistsAllowlist)
			if err != nil {
				return err
			}
			if len(profiles) == 0 {
				cmd.Println("no favorite pianists could be derived from the local database")
				return nil
			}

			if len(profiles) > limit {
				profiles = profiles[:limit]
			}

			for idx, profile := range profiles {
				cmd.Printf(
					"%d. %s | score=%.2f | avg_stars=%.2f | rated_tracks=%d | total_plays=%d\n",
					idx+1,
					profile.Name,
					profile.FavoriteScore,
					profile.AverageStars,
					profile.RatedTrackCount,
					profile.TotalPlayCount,
				)
			}

			return nil
		},
	}

	cmd.Flags().IntVar(&limit, "limit", 10, "maximum number of favorite pianists to print")
	return cmd
}

func newRecommendPianistsCmd(opts *rootOptions) *cobra.Command {
	var limit int

	cmd := &cobra.Command{
		Use:   "pianists",
		Short: "Use an LLM plus Spotify validation to recommend new pianists",
		RunE: func(cmd *cobra.Command, args []string) error {
			if limit < 1 {
				return fmt.Errorf("limit must be at least 1, got %d", limit)
			}

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
			if len(cfg.PianistsAllowlist) == 0 {
				return fmt.Errorf("config %q has an empty pianists_allowlist", configPath)
			}
			if err := validateSyncConfig(cfg, configPath); err != nil {
				return err
			}

			tracks, ratings, err := loadRecommendationData(cmd.Context(), opts)
			if err != nil {
				return err
			}

			summary, err := recommend.BuildTasteSummary(tracks, ratings, cfg.PianistsAllowlist)
			if err != nil {
				return err
			}
			if err := recommend.ValidateDiscoveryInput(summary); err != nil {
				return fmt.Errorf("not enough local rating data for pianist recommendations yet: %w", err)
			}

			llmClient, err := openai.FromConfig(cfg.OpenAI)
			if err != nil {
				return err
			}

			discovery, err := llmClient.SuggestNewPianists(cmd.Context(), summary, limit)
			if err != nil {
				return err
			}

			spotifyAPI, err := spotifyclient.NewClient(cmd.Context(), cfg.Spotify, func(token *spotifyclient.OAuthToken) error {
				cfg.Spotify.Token = config.TokenFromOAuth(token.Token, cfg.Spotify.Token)
				return config.Save(configPath, cfg)
			})
			if err != nil {
				return err
			}

			validated, err := recommend.ValidateSuggestedPianists(cmd.Context(), spotifyAPI, summary.KnownPianists, discovery.Recommendations, 5)
			if err != nil {
				return err
			}

			cmd.Printf("summary: %s\n", discovery.Summary)
			if len(validated) == 0 {
				cmd.Println("no validated pianist recommendations were found")
				return nil
			}

			for idx, pianist := range validated {
				cmd.Printf("%d. %s | spotify=%s | popularity=%d\n", idx+1, pianist.SpotifyName, pianist.SpotifyID, pianist.Popularity)
				if len(pianist.SimilarTo) > 0 {
					cmd.Printf("   bridge: %s\n", strings.Join(pianist.SimilarTo, ", "))
				}
				cmd.Printf("   why: %s\n", pianist.WhyFit)
				if pianist.Confidence != "" {
					cmd.Printf("   confidence: %s\n", pianist.Confidence)
				}
			}

			return nil
		},
	}

	cmd.Flags().IntVar(&limit, "limit", 5, "maximum number of new pianist recommendations to request")
	return cmd
}

func loadRecommendationConfig(opts *rootOptions) (*config.Config, string, error) {
	configPath, err := opts.resolveConfigPath()
	if err != nil {
		return nil, "", err
	}

	cfg, _, err := ensureLoadedConfig(configPath)
	if err != nil {
		return nil, "", err
	}
	return cfg, configPath, nil
}

func loadRecommendationData(ctx context.Context, opts *rootOptions) ([]db.Track, []db.Rating, error) {
	databasePath, err := opts.resolveDBPath()
	if err != nil {
		return nil, nil, err
	}

	queries, closeDB, err := openQueries(ctx, databasePath)
	if err != nil {
		return nil, nil, err
	}
	defer closeDB()

	tracks, err := queries.ListAllTracks(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("list all tracks: %w", err)
	}

	ratings, err := queries.ListAllRatings(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("list all ratings: %w", err)
	}

	return tracks, ratings, nil
}
