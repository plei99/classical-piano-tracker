package paths

import (
	"path/filepath"
	"testing"
)

func TestDataDirForOS(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		goos    string
		homeDir string
		env     map[string]string
		want    string
	}{
		{
			name:    "darwin",
			goos:    "darwin",
			homeDir: "/Users/patrick",
			env:     map[string]string{},
			want:    "/Users/patrick/Library/Application Support/piano-tracker",
		},
		{
			name:    "linux xdg",
			goos:    "linux",
			homeDir: "/home/patrick",
			env:     map[string]string{"XDG_DATA_HOME": "/tmp/xdg-data"},
			want:    "/tmp/xdg-data/piano-tracker",
		},
		{
			name:    "linux fallback",
			goos:    "linux",
			homeDir: "/home/patrick",
			env:     map[string]string{},
			want:    "/home/patrick/.local/share/piano-tracker",
		},
		{
			name:    "windows local app data",
			goos:    "windows",
			homeDir: `C:\Users\patrick`,
			env:     map[string]string{"LOCALAPPDATA": `C:\Users\patrick\AppData\Local`},
			want:    filepath.Join(`C:\Users\patrick\AppData\Local`, "piano-tracker"),
		},
		{
			name:    "windows app data fallback",
			goos:    "windows",
			homeDir: `C:\Users\patrick`,
			env:     map[string]string{"APPDATA": `C:\Users\patrick\AppData\Roaming`},
			want:    filepath.Join(`C:\Users\patrick\AppData\Roaming`, "piano-tracker"),
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			lookup := func(key string) string {
				return tt.env[key]
			}

			if got := dataDirForOS(tt.goos, tt.homeDir, lookup); got != tt.want {
				t.Fatalf("dataDirForOS() = %q, want %q", got, tt.want)
			}
		})
	}
}
