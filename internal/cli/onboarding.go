package cli

import (
	"bufio"
	"fmt"
	"io"
	"strings"

	"github.com/plei99/classical-piano-tracker/internal/config"
	"github.com/spf13/cobra"
)

// runPianistSelection is a test seam for swapping out the interactive picker
// when onboarding command tests need deterministic selection results.
var runPianistSelection = promptPianistSelection

func newOnboardingCmd(opts *rootOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "onboarding",
		Short: "Interactive first-run setup for Spotify, OpenAI, and pianist filters",
		Example: "  tracker onboarding\n" +
			"  tracker --config ~/custom-config.json onboarding",
		RunE: func(cmd *cobra.Command, args []string) error {
			configPath, err := opts.resolveConfigPath()
			if err != nil {
				return err
			}

			cfg, _, err := ensureLoadedConfig(configPath)
			if err != nil {
				return err
			}

			input := cmd.InOrStdin()
			reader := bufio.NewReader(input)
			writer := cmd.OutOrStdout()

			cmd.Printf("Config path: %s\n\n", configPath)

			clientID, err := promptRequiredValue(reader, writer, "Spotify client ID", cfg.Spotify.ClientID)
			if err != nil {
				return err
			}
			clientSecret, err := promptRequiredValue(reader, writer, "Spotify client secret", cfg.Spotify.ClientSecret)
			if err != nil {
				return err
			}
			openAIKey, err := promptOptionalValue(reader, writer, "OpenAI API key (optional)", cfg.OpenAI.APIKey)
			if err != nil {
				return err
			}

			defaultPianists := config.DefaultPianistsAllowlist()
			selected, err := runPianistSelection(input, writer, defaultPianists)
			if err != nil {
				return err
			}

			cfg.Spotify.ClientID = clientID
			cfg.Spotify.ClientSecret = clientSecret
			cfg.OpenAI.APIKey = openAIKey
			cfg.PianistsAllowlist = selected

			if err := config.Save(configPath, cfg); err != nil {
				return fmt.Errorf("save config %q: %w", configPath, err)
			}

			cmd.Printf("\nSaved onboarding config to %s\n", configPath)
			cmd.Printf("Selected %d pianists for pianists_allowlist\n", len(selected))
			cmd.Printf("Next steps:\n")
			cmd.Printf("  1. Add %s to your Spotify app redirect URIs\n", "http://127.0.0.1:8000/api/auth/spotify/callback")
			cmd.Printf("  2. Run `tracker spotify login`\n")
			cmd.Printf("  3. Run `tracker sync`\n")

			return nil
		},
	}
}

// promptRequiredValue keeps the line-oriented onboarding prompts small and
// dependency-free for simple string fields.
func promptRequiredValue(reader *bufio.Reader, writer io.Writer, label string, current string) (string, error) {
	for {
		value, err := promptValue(reader, writer, label, current)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(value) == "" {
			fmt.Fprintf(writer, "%s is required.\n", label)
			continue
		}
		return value, nil
	}
}

// promptOptionalValue mirrors promptRequiredValue but preserves blank input.
func promptOptionalValue(reader *bufio.Reader, writer io.Writer, label string, current string) (string, error) {
	return promptValue(reader, writer, label, current)
}

// promptValue implements the shared "show current value, allow Enter to keep"
// behavior used by all non-picker onboarding prompts.
func promptValue(reader *bufio.Reader, writer io.Writer, label string, current string) (string, error) {
	if strings.TrimSpace(current) != "" {
		fmt.Fprintf(writer, "%s [%s]: ", label, current)
	} else {
		fmt.Fprintf(writer, "%s: ", label)
	}

	line, err := reader.ReadString('\n')
	if err != nil && err != io.EOF {
		return "", fmt.Errorf("read %s: %w", label, err)
	}

	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return current, nil
	}
	return trimmed, nil
}
