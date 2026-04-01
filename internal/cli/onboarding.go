package cli

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/plei99/classical-piano-tracker/internal/config"
	"github.com/spf13/cobra"
)

func newOnboardingCmd(opts *rootOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "onboarding",
		Short: "Interactive first-run setup for Spotify, OpenAI, and pianist filters",
		RunE: func(cmd *cobra.Command, args []string) error {
			configPath, err := opts.resolveConfigPath()
			if err != nil {
				return err
			}

			cfg, _, err := ensureLoadedConfig(configPath)
			if err != nil {
				return err
			}

			reader := bufio.NewReader(cmd.InOrStdin())
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
			selected, err := promptPianistSelection(reader, writer, defaultPianists)
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

func promptOptionalValue(reader *bufio.Reader, writer io.Writer, label string, current string) (string, error) {
	return promptValue(reader, writer, label, current)
}

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

func promptPianistSelection(reader *bufio.Reader, writer io.Writer, pianists []string) ([]string, error) {
	fmt.Fprintln(writer, "Select pianists for the initial allowlist.")
	fmt.Fprintln(writer, "Press Enter to keep the full default list, or enter comma-separated numbers and ranges like 1,2,5-8.")
	fmt.Fprintln(writer)

	for idx, pianist := range pianists {
		fmt.Fprintf(writer, "%2d. %s\n", idx+1, pianist)
	}
	fmt.Fprintln(writer)
	fmt.Fprint(writer, "Selection [all]: ")

	line, err := reader.ReadString('\n')
	if err != nil && err != io.EOF {
		return nil, fmt.Errorf("read pianist selection: %w", err)
	}

	selection := strings.TrimSpace(line)
	if selection == "" {
		return append([]string(nil), pianists...), nil
	}

	indexes, err := parseSelection(selection, len(pianists))
	if err != nil {
		return nil, err
	}

	selected := make([]string, 0, len(indexes))
	for _, idx := range indexes {
		selected = append(selected, pianists[idx])
	}

	return selected, nil
}

func parseSelection(selection string, max int) ([]int, error) {
	if max < 1 {
		return nil, fmt.Errorf("selection source must not be empty")
	}

	seen := map[int]struct{}{}
	indexes := make([]int, 0, max)

	for _, part := range strings.Split(selection, ",") {
		item := strings.TrimSpace(part)
		if item == "" {
			continue
		}

		if strings.Contains(item, "-") {
			bounds := strings.SplitN(item, "-", 2)
			if len(bounds) != 2 {
				return nil, fmt.Errorf("invalid range %q", item)
			}

			start, err := strconv.Atoi(strings.TrimSpace(bounds[0]))
			if err != nil {
				return nil, fmt.Errorf("invalid range start %q", item)
			}
			end, err := strconv.Atoi(strings.TrimSpace(bounds[1]))
			if err != nil {
				return nil, fmt.Errorf("invalid range end %q", item)
			}
			if start < 1 || end < 1 || start > max || end > max || start > end {
				return nil, fmt.Errorf("range %q is out of bounds", item)
			}

			for value := start; value <= end; value++ {
				idx := value - 1
				if _, exists := seen[idx]; exists {
					continue
				}
				seen[idx] = struct{}{}
				indexes = append(indexes, idx)
			}
			continue
		}

		value, err := strconv.Atoi(item)
		if err != nil {
			return nil, fmt.Errorf("invalid selection %q", item)
		}
		if value < 1 || value > max {
			return nil, fmt.Errorf("selection %q is out of bounds", item)
		}

		idx := value - 1
		if _, exists := seen[idx]; exists {
			continue
		}
		seen[idx] = struct{}{}
		indexes = append(indexes, idx)
	}

	if len(indexes) == 0 {
		return nil, fmt.Errorf("selection must include at least one pianist")
	}

	return indexes, nil
}
