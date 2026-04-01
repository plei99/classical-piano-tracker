package cli

import (
	"context"
	"fmt"

	"github.com/plei99/classical-piano-tracker/internal/config"
	"github.com/plei99/classical-piano-tracker/internal/db"
	"github.com/plei99/classical-piano-tracker/internal/llm"
	"github.com/plei99/classical-piano-tracker/internal/llm/providers"
	"github.com/plei99/classical-piano-tracker/internal/recommend"
	spotifyclient "github.com/plei99/classical-piano-tracker/internal/spotify"
	"github.com/spf13/cobra"
)

// newRecommendCmd groups the deterministic and LLM-backed recommendation flows
// under one namespace without mixing their implementation details.
func newRecommendCmd(opts *rootOptions) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "recommend",
		Short: "Analyze favorites and generate pianist recommendations",
		Example: "  tracker recommend favorites\n" +
			"  tracker recommend pianists --limit 5",
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
		Example: "  tracker recommend favorites\n" +
			"  tracker recommend favorites --limit 15",
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

			printFavoritePianists(cmd.OutOrStdout(), profiles)

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
		Example: "  tracker recommend pianists\n" +
			"  OPENAI_MODEL=gpt-5.4 tracker recommend pianists --limit 5",
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

			provider, err := providers.NewOpenAIFromConfig(cfg.OpenAI)
			if err != nil {
				return err
			}

			llmClient, err := llm.NewClient(provider)
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

			if len(validated) == 0 {
				cmd.Printf("Summary: %s\n", discovery.Summary)
				cmd.Println("No validated pianist recommendations were found.")
				return nil
			}

			printValidatedPianists(cmd.OutOrStdout(), discovery.Summary, validated)

			return nil
		},
	}

	cmd.Flags().IntVar(&limit, "limit", 5, "maximum number of new pianist recommendations to request")
	return cmd
}

// loadRecommendationConfig keeps recommendation commands aligned on the same
// config-loading and first-run semantics used elsewhere in the CLI.
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

// loadRecommendationData reads the complete local corpus because recommendation
// scoring needs the full set of tracks and ratings, not a paginated subset.
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
