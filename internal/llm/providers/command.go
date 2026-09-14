package providers

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// commandRunner keeps process execution injectable; providers own their private
// working directories so caller repositories cannot contribute instructions.
type commandRunner func(ctx context.Context, dir, stdin, name string, args ...string) (stdout, stderr []byte, err error)

func execCommand(ctx context.Context, dir, stdin, name string, args ...string) ([]byte, []byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Stdin = strings.NewReader(stdin)
	// Bound waits on inherited output pipes if a CLI leaves children running.
	cmd.WaitDelay = time.Second
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil && ctx.Err() != nil {
		err = ctx.Err()
	}
	return stdout.Bytes(), stderr.Bytes(), err
}

func commandError(command string, err error, detail []byte) error {
	if text := strings.TrimSpace(string(detail)); text != "" {
		return fmt.Errorf("run %s: %w: %s", command, err, text)
	}
	return fmt.Errorf("run %s: %w (check that the CLI is installed and signed in; configure command or LLM_COMMAND if it is not on PATH)", command, err)
}
