package providers

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestExecCommand(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	t.Setenv("TRACKER_COMMAND_HELPER", "1")
	stdout, stderr, err := execCommand(context.Background(), dir, "piped input", executable, "-test.run=TestCommandHelperProcess", "--", "echo")
	if err != nil {
		t.Fatal(err)
	}
	realDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	reportedDir, input, _ := strings.Cut(string(stdout), "\n")
	reportedDir, err = filepath.EvalSymlinks(reportedDir)
	if err != nil {
		t.Fatal(err)
	}
	if reportedDir != realDir || input != "piped input" || string(stderr) != "diagnostic" {
		t.Fatalf("stdout = %q, stderr = %q", stdout, stderr)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, _, err = execCommand(ctx, dir, "", executable, "-test.run=TestCommandHelperProcess", "--", "wait")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timeout error = %v", err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	cancel()
	_, _, err = execCommand(ctx, dir, "", executable, "-test.run=TestCommandHelperProcess", "--", "wait")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation error = %v", err)
	}
}

// Re-execute the Go test binary rather than depending on shell utilities or a
// real LLM. The parent test can exercise actual stdin, cwd, and cancellation.
func TestCommandHelperProcess(t *testing.T) {
	if os.Getenv("TRACKER_COMMAND_HELPER") != "1" {
		return
	}
	if os.Args[len(os.Args)-1] == "wait" {
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	dir, err := os.Getwd()
	if err != nil {
		os.Exit(1)
	}
	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		os.Exit(1)
	}
	fmt.Fprintf(os.Stdout, "%s\n%s", dir, input)
	fmt.Fprint(os.Stderr, "diagnostic")
	os.Exit(0)
}
