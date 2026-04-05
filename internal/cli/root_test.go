package cli

import (
	"os"
	"testing"
)

func TestNewRootCmdDefaultsOutputStreams(t *testing.T) {
	t.Parallel()

	cmd := NewRootCmd()
	if got := cmd.OutOrStdout(); got != os.Stdout {
		t.Fatalf("OutOrStdout() = %T, want stdout", got)
	}
	if got := cmd.ErrOrStderr(); got != os.Stderr {
		t.Fatalf("ErrOrStderr() = %T, want stderr", got)
	}
}
