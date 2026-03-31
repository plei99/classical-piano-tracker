package paths

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

const (
	appDirName   = "piano-tracker"
	databaseName = "tracker.db"
)

// DefaultDataDir returns the platform-appropriate application data directory.
func DefaultDataDir() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve user home directory: %w", err)
	}

	return dataDirForOS(runtime.GOOS, homeDir, getenvLookup), nil
}

// DefaultDBPath returns the default SQLite database path.
func DefaultDBPath() (string, error) {
	dataDir, err := DefaultDataDir()
	if err != nil {
		return "", err
	}

	return filepath.Join(dataDir, databaseName), nil
}

type lookupEnvFunc func(string) string

func getenvLookup(key string) string {
	return os.Getenv(key)
}

func dataDirForOS(goos string, homeDir string, lookup lookupEnvFunc) string {
	switch goos {
	case "darwin":
		return filepath.Join(homeDir, "Library", "Application Support", appDirName)
	case "windows":
		if localAppData := lookup("LOCALAPPDATA"); localAppData != "" {
			return filepath.Join(localAppData, appDirName)
		}
		if appData := lookup("APPDATA"); appData != "" {
			return filepath.Join(appData, appDirName)
		}
		return filepath.Join(homeDir, "AppData", "Local", appDirName)
	default:
		if xdgDataHome := lookup("XDG_DATA_HOME"); xdgDataHome != "" {
			return filepath.Join(xdgDataHome, appDirName)
		}
		return filepath.Join(homeDir, ".local", "share", appDirName)
	}
}
