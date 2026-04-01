package main

import (
	"fmt"
	"os"

	"github.com/plei99/classical-piano-tracker/internal/cli"
)

// main is intentionally thin: all command wiring lives in internal/cli so the
// binary entrypoint stays stable while the command tree evolves.
func main() {
	if err := cli.NewRootCmd().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
