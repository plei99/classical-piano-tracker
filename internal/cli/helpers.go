package cli

import (
	"fmt"

	"github.com/plei99/classical-piano-tracker/internal/config"
)

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

func createdConfigError(path string, nextStep string) error {
	return fmt.Errorf("created default config at %q; %s", path, nextStep)
}
