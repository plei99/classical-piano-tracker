package cli

import (
	"fmt"

	"github.com/plei99/classical-piano-tracker/internal/config"
	"github.com/spf13/cobra"
)

type rootOptions struct {
	configPath string
}

func (o *rootOptions) resolveConfigPath() (string, error) {
	if o.configPath != "" {
		return o.configPath, nil
	}

	return config.DefaultPath()
}

func newConfigCmd(opts *rootOptions) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "config",
		Short: "Inspect and validate local configuration",
	}

	cmd.AddCommand(
		newConfigPathCmd(opts),
		newConfigValidateCmd(opts),
	)

	return cmd
}

func newConfigPathCmd(opts *rootOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "path",
		Short: "Print the config file path",
		RunE: func(cmd *cobra.Command, args []string) error {
			path, err := opts.resolveConfigPath()
			if err != nil {
				return err
			}

			cmd.Println(path)
			return nil
		},
	}
}

func newConfigValidateCmd(opts *rootOptions) *cobra.Command {
	return &cobra.Command{
		Use:   "validate",
		Short: "Validate the config file",
		RunE: func(cmd *cobra.Command, args []string) error {
			path, err := opts.resolveConfigPath()
			if err != nil {
				return err
			}

			cfg, created, err := ensureLoadedConfig(path)
			if err != nil {
				return err
			}

			if err := cfg.Validate(); err != nil {
				if created {
					return createdConfigError(path, fmt.Sprintf("fill the required values, then rerun `tracker --config %q config validate`: %v", path, err))
				}
				return fmt.Errorf("invalid config %q: %w", path, err)
			}

			cmd.Printf("config is valid: %s\n", path)
			return nil
		},
	}
}
