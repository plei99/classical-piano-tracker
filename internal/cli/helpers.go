package cli

import (
	"fmt"

	"github.com/plei99/classical-piano-tracker/internal/config"
)

// ensureLoadedConfig is the common first-run path used by commands that need a
// config file but can tolerate generating a default template for the user.
func ensureLoadedConfig(path string) (*config.Config, bool, error) {
	created, err := config.Ensure(path)
	if err != nil {
		return nil, false, err
	}

	cfg, err := config.Load(path)
	if err != nil {
		return nil, created, err
	}

	return cfg, created, nil
}

// createdConfigError standardizes the "we created a config, now go fill it in"
// messaging so first-run failures stay actionable.
func createdConfigError(path string, nextStep string) error {
	return fmt.Errorf("created default config at %q; %s", path, nextStep)
}
