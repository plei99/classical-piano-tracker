package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/plei99/classical-piano-tracker/internal/llm"
)

const (
	defaultClaudeCLICommand = "claude"
	// defaultClaudeCLITimeout is generous because each call pays for CLI
	// startup on top of model latency, and discovery may chain several calls.
	defaultClaudeCLITimeout = 5 * time.Minute
)

// claudeCLIModels lists the model aliases the Claude Code CLI accepts. The CLI
// has no model-listing endpoint, so onboarding offers these fixed choices.
var claudeCLIModels = []string{"sonnet", "opus", "haiku", "fable"}

// ClaudeCLIModels returns a copy of the fixed model choices for the claude_cli
// provider.
func ClaudeCLIModels() []string {
	return append([]string(nil), claudeCLIModels...)
}

type claudeCLIProvider struct {
	command string
	model   string
	timeout time.Duration
	run     commandRunner
}

// claudeCLIResult is the single-object envelope printed by
// `claude -p --output-format json`.
type claudeCLIResult struct {
	Type             string          `json:"type"`
	Subtype          string          `json:"subtype"`
	IsError          bool            `json:"is_error"`
	Result           string          `json:"result"`
	StructuredOutput json.RawMessage `json:"structured_output"`
	Errors           []string        `json:"errors"`
}

// NewClaudeCLI constructs a provider that shells out to the Claude Code CLI in
// print mode. It needs no API key: the CLI uses the user's existing login.
func NewClaudeCLI(model string, command string, run commandRunner) (llm.Provider, error) {
	if strings.TrimSpace(command) == "" {
		command = defaultClaudeCLICommand
	}
	if run == nil {
		run = execCommand
	}

	return &claudeCLIProvider{
		command: strings.TrimSpace(command),
		model:   strings.TrimSpace(model),
		timeout: defaultClaudeCLITimeout,
		run:     run,
	}, nil
}

// Generate runs `claude -p` with all built-in tools disabled. When a schema is
// supplied it is passed via --json-schema so the CLI validates the output and
// returns it in the structured_output field.
func (p *claudeCLIProvider) Generate(ctx context.Context, req llm.Request) (string, error) {
	args, err := p.buildArgs(req)
	if err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp("", "piano-tracker-claude-*")
	if err != nil {
		return "", fmt.Errorf("create Claude CLI working directory: %w", err)
	}
	defer os.RemoveAll(dir)

	if p.timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, p.timeout)
		defer cancel()
	}

	stdout, stderr, runErr := p.run(ctx, dir, req.UserPrompt, p.command, args...)
	// Claude reports runtime failures on stdout, often with a nonzero exit.
	// Decode that envelope before falling back to stderr/exit status.
	var result claudeCLIResult
	decodeErr := json.Unmarshal(bytes.TrimSpace(stdout), &result)
	if decodeErr == nil && (result.IsError || strings.HasPrefix(result.Subtype, "error")) {
		detail := strings.TrimSpace(strings.Join(append([]string{result.Result}, result.Errors...), "\n"))
		if runErr != nil {
			return "", commandError(p.command, runErr, []byte(result.Subtype+": "+detail))
		}
		return "", fmt.Errorf("%s reported an error (%s): %s", p.command, result.Subtype, detail)
	}
	if runErr != nil {
		if len(bytes.TrimSpace(stderr)) == 0 {
			stderr = stdout
		}
		return "", commandError(p.command, runErr, stderr)
	}
	if decodeErr != nil {
		return "", fmt.Errorf("decode %s result: %w", p.command, decodeErr)
	}
	if result.Type != "result" || result.Subtype != "success" {
		return "", fmt.Errorf("%s returned an unexpected result envelope (%s/%s)", p.command, result.Type, result.Subtype)
	}

	if structured := bytes.TrimSpace(result.StructuredOutput); len(structured) > 0 && !bytes.Equal(structured, []byte("null")) {
		return string(structured), nil
	}

	raw := strings.TrimSpace(result.Result)
	if raw == "" {
		return "", fmt.Errorf("%s returned neither structured output nor text", p.command)
	}
	return raw, nil
}

func (p *claudeCLIProvider) buildArgs(req llm.Request) ([]string, error) {
	args := []string{
		"-p",
		"--output-format", "json",
		"--tools", "",
		// Unlike --bare, safe mode preserves OAuth/keychain authentication while
		// disabling custom instructions, hooks, skills, plugins, and MCP servers.
		"--safe-mode",
		"--strict-mcp-config",
		"--mcp-config", `{"mcpServers":{}}`,
		"--disable-slash-commands",
		"--permission-mode", "dontAsk",
		"--no-session-persistence",
	}
	if p.model != "" {
		args = append(args, "--model", p.model)
	}
	if strings.TrimSpace(req.SystemPrompt) != "" {
		args = append(args, "--system-prompt", req.SystemPrompt)
	}
	if req.Schema != nil && req.Schema.Schema != nil {
		schema, err := json.Marshal(req.Schema.Schema)
		if err != nil {
			return nil, fmt.Errorf("marshal Claude CLI JSON schema: %w", err)
		}
		args = append(args, "--json-schema", string(schema))
	}
	return args, nil
}
