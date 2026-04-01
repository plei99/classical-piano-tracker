package buildinfo

import (
	"fmt"
	"runtime/debug"
)

var (
	// These values are injected by `make build`. The init fallback below keeps
	// local `go run` and ad hoc builds from reporting completely blank metadata.
	Version = "dev"
	Commit  = "unknown"
	Date    = "unknown"
)

// init opportunistically fills in VCS metadata from Go's embedded build info
// when ldflags were not supplied.
func init() {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return
	}

	settings := map[string]string{}
	for _, setting := range info.Settings {
		settings[setting.Key] = setting.Value
	}

	revision := settings["vcs.revision"]
	modified := settings["vcs.modified"] == "true"
	shortRevision := revision
	if len(shortRevision) > 7 {
		shortRevision = shortRevision[:7]
	}

	if Commit == "unknown" && shortRevision != "" {
		Commit = shortRevision
	}
	if Date == "unknown" && settings["vcs.time"] != "" {
		Date = settings["vcs.time"]
	}
	if Version == "dev" && shortRevision != "" {
		Version = "dev+" + shortRevision
		if modified {
			Version += "-dirty"
		}
	}
}

// Summary returns a short human-readable build description.
func Summary() string {
	return fmt.Sprintf("%s (commit %s, built %s)", Version, Commit, Date)
}
