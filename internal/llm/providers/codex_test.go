package providers

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/plei99/classical-piano-tracker/internal/llm"
)

func TestCodexRequestAndPrivateArtifacts(t *testing.T) {
	t.Parallel()
	var dir string
	runner := func(_ context.Context, cwd, stdin, name string, args ...string) ([]byte, []byte, error) {
		dir = cwd
		if name != "/opt/bin/codex" || !strings.Contains(stdin, "task instructions") || !strings.Contains(stdin, "private taste data") {
			t.Fatalf("unexpected command %q or prompt %q", name, stdin)
		}
		if args[0] != "exec" || args[len(args)-1] != "-" {
			t.Fatalf("args = %q, want exec with stdin prompt", args)
		}
		for _, flag := range []string{"--ephemeral", "--ignore-user-config", "--skip-git-repo-check"} {
			if !slices.Contains(args, flag) {
				t.Fatalf("missing %s: %q", flag, args)
			}
		}
		for flag, want := range map[string]string{"--sandbox": "read-only", "--color": "never", "--model": "chosen-model"} {
			if got := flagValue(t, args, flag); got != want {
				t.Fatalf("%s = %q, want %q", flag, got, want)
			}
		}
		for _, setting := range []string{`approval_policy="never"`, `web_search="disabled"`, "features.shell_tool=false", "features.unified_exec=false", "project_doc_max_bytes=0"} {
			if !slices.Contains(args, setting) {
				t.Fatalf("missing setting %q", setting)
			}
		}
		if strings.Contains(strings.Join(args, " "), "private taste data") {
			t.Fatal("taste data leaked into argv")
		}
		schemaPath := flagValue(t, args, "--output-schema")
		outputPath := flagValue(t, args, "--output-last-message")
		for path, mode := range map[string]os.FileMode{cwd: 0o700, schemaPath: 0o600, outputPath: 0o600} {
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm() != mode {
				t.Fatalf("private artifact %s: %v, %v", path, info, err)
			}
		}
		if filepath.Dir(schemaPath) != cwd || filepath.Dir(outputPath) != cwd {
			t.Fatal("artifacts outside private directory")
		}
		data, err := os.ReadFile(schemaPath)
		if err != nil {
			t.Fatal(err)
		}
		var schema map[string]any
		if err := json.Unmarshal(data, &schema); err != nil || schema["type"] != "object" {
			t.Fatalf("schema: %s, %v", data, err)
		}
		if err := os.WriteFile(outputPath, []byte(" {\"summary\":\"lyrical playing\"}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		return []byte("progress, not JSON"), nil, nil
	}
	provider, _ := NewCodex(" chosen-model ", "/opt/bin/codex", runner)
	raw, err := provider.Generate(context.Background(), llm.Request{
		SystemPrompt: "task instructions", UserPrompt: "private taste data",
		Schema: &llm.JSONSchema{Schema: map[string]any{"type": "object"}},
	})
	if err != nil || raw != `{"summary":"lyrical playing"}` {
		t.Fatalf("Generate = %q, %v", raw, err)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("temporary directory remains: %v", err)
	}
}

func TestCodexTextWithoutModelOrSchema(t *testing.T) {
	t.Parallel()
	runner := func(_ context.Context, _, _, name string, args ...string) ([]byte, []byte, error) {
		if name != "codex" || slices.Contains(args, "--model") || slices.Contains(args, "--output-schema") {
			t.Fatalf("command = %s %q", name, args)
		}
		return nil, nil, os.WriteFile(flagValue(t, args, "--output-last-message"), []byte("plain text fallback"), 0o600)
	}
	p, _ := NewCodex("", "", runner)
	raw, err := p.Generate(context.Background(), llm.Request{UserPrompt: "task"})
	if err != nil || raw != "plain text fallback" {
		t.Fatalf("Generate = %q, %v", raw, err)
	}
}

func TestCodexFailuresAndCleanup(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, stderr string
		err          error
		want         string
	}{
		{"empty", "", nil, "no final response"},
		{"exit", "Please run codex login", errors.New("exit status 1"), "Please run codex login"},
		{"missing", "", os.ErrNotExist, "installed and signed in"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var record recordedCommand
			p, _ := NewCodex("", "", stubRunner(&record, "ignored stdout", tc.stderr, tc.err))
			_, err := p.Generate(context.Background(), llm.Request{})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
			if tc.err != nil && !errors.Is(err, tc.err) {
				t.Fatalf("lost cause: %v", err)
			}
			if _, err := os.Stat(record.dir); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("directory remains: %v", err)
			}
		})
	}
}

func TestCodexDeadlineAndCancellation(t *testing.T) {
	t.Parallel()
	runner := func(ctx context.Context, _, _, _ string, _ ...string) ([]byte, []byte, error) {
		<-ctx.Done()
		return nil, nil, ctx.Err()
	}
	p, _ := NewCodex("", "", runner)
	if p.(*codexProvider).timeout != 5*time.Minute {
		t.Fatal("unexpected default timeout")
	}
	p.(*codexProvider).timeout = 10 * time.Millisecond
	_, err := p.Generate(context.Background(), llm.Request{})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = p.Generate(ctx, llm.Request{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v", err)
	}
}

func TestCodexRejectsUnmarshalableSchema(t *testing.T) {
	t.Parallel()
	p, _ := NewCodex("", "", func(context.Context, string, string, string, ...string) ([]byte, []byte, error) {
		t.Fatal("must not execute CLI for invalid schema")
		return nil, nil, nil
	})
	_, err := p.Generate(context.Background(), llm.Request{Schema: &llm.JSONSchema{Schema: map[string]any{"bad": make(chan int)}}})
	if err == nil || !strings.Contains(err.Error(), "marshal Codex JSON schema") {
		t.Fatalf("error = %v", err)
	}
}
