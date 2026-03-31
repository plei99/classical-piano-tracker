package main

import (
	"fmt"
	"os"

	"github.com/plei99/classical-piano-tracker/internal/cli"
)

func main() {
	if err := cli.NewRootCmd().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
