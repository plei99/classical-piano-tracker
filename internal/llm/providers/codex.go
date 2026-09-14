package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/plei99/classical-piano-tracker/internal/llm"
)

const defaultCodexTimeout = 5 * time.Minute

type codexProvider struct {
	command string
	model   string
	timeout time.Duration
	run     commandRunner
}

// NewCodex uses the CLI's existing authentication, never tracker API keys.
// An empty model leaves selection to the CLI's built-in default, not user config.
func NewCodex(model, command string, run commandRunner) (llm.Provider, error) {
	if strings.TrimSpace(command) == "" {
		command = "codex"
	}
	if run == nil {
		run = execCommand
	}
	return &codexProvider{command: strings.TrimSpace(command), model: strings.TrimSpace(model), timeout: defaultCodexTimeout, run: run}, nil
}

func (p *codexProvider) Generate(ctx context.Context, req llm.Request) (string, error) {
	dir, err := os.MkdirTemp("", "piano-tracker-codex-*")
	if err != nil {
		return "", fmt.Errorf("create Codex working directory: %w", err)
	}
	defer os.RemoveAll(dir)

	outputPath := filepath.Join(dir, "response.txt")
	// Precreate with private permissions; the CLI writes the final answer here,
	// while stdout/stderr may contain progress and must not be parsed as JSON.
	if err := os.WriteFile(outputPath, nil, 0o600); err != nil {
		return "", fmt.Errorf("create Codex output file: %w", err)
	}
	args := []string{
		"exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
		"--sandbox", "read-only", "--color", "never",
		"-c", `approval_policy="never"`,
		"-c", `web_search="disabled"`,
		"-c", "features.shell_tool=false",
		"-c", "features.unified_exec=false",
		"-c", "project_doc_max_bytes=0",
		"--output-last-message", outputPath,
	}
	if p.model != "" {
		args = append(args, "--model", p.model)
	}
	if req.Schema != nil && req.Schema.Schema != nil {
		schema, err := json.Marshal(req.Schema.Schema)
		if err != nil {
			return "", fmt.Errorf("marshal Codex JSON schema: %w", err)
		}
		schemaPath := filepath.Join(dir, "schema.json")
		if err := os.WriteFile(schemaPath, schema, 0o600); err != nil {
			return "", fmt.Errorf("write Codex JSON schema: %w", err)
		}
		args = append(args, "--output-schema", schemaPath)
	}
	args = append(args, "-")
	// Codex exec has one prompt input rather than separate API message roles.
	// Both task instructions and taste data travel via stdin, not process argv.
	prompt := "Answer only the following music taste task using the supplied data and your existing knowledge. Do not use tools, browse, inspect files, or execute commands. Return only the requested output.\n\n" + req.SystemPrompt + "\n\n" + req.UserPrompt
	if p.timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, p.timeout)
		defer cancel()
	}
	_, stderr, err := p.run(ctx, dir, prompt, p.command, args...)
	if err != nil {
		return "", commandError(p.command, err, stderr)
	}
	output, err := os.ReadFile(outputPath)
	if err != nil {
		return "", fmt.Errorf("read Codex final response: %w", err)
	}
	raw := strings.TrimSpace(string(output))
	if raw == "" {
		return "", fmt.Errorf("%s returned no final response", p.command)
	}
	return raw, nil
}
