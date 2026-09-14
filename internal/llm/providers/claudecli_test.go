package providers

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/plei99/classical-piano-tracker/internal/llm"
)

type recordedCommand struct {
	dir   string
	name  string
	args  []string
	stdin string
}

func stubRunner(record *recordedCommand, stdout string, stderr string, err error) commandRunner {
	return func(_ context.Context, dir, stdin string, name string, args ...string) ([]byte, []byte, error) {
		record.dir = dir
		record.name = name
		record.args = append([]string(nil), args...)
		record.stdin = stdin
		return []byte(stdout), []byte(stderr), err
	}
}

func flagValue(t *testing.T, args []string, flag string) string {
	t.Helper()
	idx := slices.Index(args, flag)
	if idx < 0 || idx+1 >= len(args) {
		t.Fatalf("args %q do not contain %s with a value", args, flag)
	}
	return args[idx+1]
}

func TestClaudeCLIProviderBuildsPrintArgsAndReturnsStructuredOutput(t *testing.T) {
	t.Parallel()

	var record recordedCommand
	envelope := `{"type":"result","subtype":"success","is_error":false,"result":"done","structured_output":{"summary":"You like lyrical playing.","recommendations":[{"pianist_name":"Radu Lupu","why_fit":"warm tone","similar_to":["Murray Perahia"],"confidence":"medium"}]}}`
	provider, err := NewClaudeCLI("sonnet", "/opt/bin/claude", stubRunner(&record, envelope, "", nil))
	if err != nil {
		t.Fatalf("NewClaudeCLI() error = %v", err)
	}

	schema := map[string]any{
		"type":       "object",
		"properties": map[string]any{"summary": map[string]any{"type": "string"}},
		"required":   []string{"summary"},
	}
	raw, err := provider.Generate(context.Background(), llm.Request{
		SystemPrompt: "system prompt",
		UserPrompt:   "user prompt with\nmultiple lines",
		OutputMode:   llm.StructuredOutputModeStrict,
		Schema:       &llm.JSONSchema{Name: "pianist_discovery", Schema: schema, Strict: true},
	})
	if err != nil {
		t.Fatalf("Generate() error = %v", err)
	}

	var parsed struct {
		Summary         string `json:"summary"`
		Recommendations []struct {
			PianistName string `json:"pianist_name"`
		} `json:"recommendations"`
	}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		t.Fatalf("raw output is not JSON: %v (%q)", err, raw)
	}
	if parsed.Summary != "You like lyrical playing." || len(parsed.Recommendations) != 1 || parsed.Recommendations[0].PianistName != "Radu Lupu" {
		t.Fatalf("parsed structured output = %#v, want tool payload", parsed)
	}

	if record.name != "/opt/bin/claude" {
		t.Fatalf("command = %q, want /opt/bin/claude", record.name)
	}
	if record.dir == "" {
		t.Fatal("missing isolated working directory")
	}
	if _, err := os.Stat(record.dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("temporary directory remains: %v", err)
	}
	if !slices.Contains(record.args, "--strict-mcp-config") || !slices.Contains(record.args, "--disable-slash-commands") {
		t.Fatalf("args %q do not disable external tools/skills", record.args)
	}
	if flagValue(t, record.args, "--mcp-config") != `{"mcpServers":{}}` || flagValue(t, record.args, "--permission-mode") != "dontAsk" {
		t.Fatalf("args %q allow unexpected tool access", record.args)
	}
	if record.stdin != "user prompt with\nmultiple lines" {
		t.Fatalf("stdin = %q, want user prompt", record.stdin)
	}
	if !slices.Contains(record.args, "-p") {
		t.Fatalf("args %q missing -p", record.args)
	}
	if !slices.Contains(record.args, "--safe-mode") || slices.Contains(record.args, "--bare") {
		t.Fatalf("args %q must use safe mode, not bare mode (which ignores login)", record.args)
	}
	if !slices.Contains(record.args, "--no-session-persistence") {
		t.Fatalf("args %q missing --no-session-persistence", record.args)
	}
	if got := flagValue(t, record.args, "--output-format"); got != "json" {
		t.Fatalf("--output-format = %q, want json", got)
	}
	if got := flagValue(t, record.args, "--tools"); got != "" {
		t.Fatalf("--tools = %q, want empty string to disable tools", got)
	}
	if got := flagValue(t, record.args, "--model"); got != "sonnet" {
		t.Fatalf("--model = %q, want sonnet", got)
	}
	if got := flagValue(t, record.args, "--system-prompt"); got != "system prompt" {
		t.Fatalf("--system-prompt = %q, want system prompt", got)
	}
	var sentSchema map[string]any
	if err := json.Unmarshal([]byte(flagValue(t, record.args, "--json-schema")), &sentSchema); err != nil {
		t.Fatalf("--json-schema is not JSON: %v", err)
	}
	if sentSchema["type"] != "object" {
		t.Fatalf("--json-schema = %#v, want request schema", sentSchema)
	}
	for _, arg := range record.args {
		if strings.Contains(arg, "user prompt") {
			t.Fatalf("user prompt leaked into argv: %q", record.args)
		}
	}
}

func TestClaudeCLIProviderOmitsSchemaAndModelWhenUnsetAndReturnsText(t *testing.T) {
	t.Parallel()

	var record recordedCommand
	envelope := `{"type":"result","subtype":"success","is_error":false,"result":"Radu Lupu || warm tone || Murray Perahia || medium"}`
	provider, err := NewClaudeCLI("", "", stubRunner(&record, envelope, "", nil))
	if err != nil {
		t.Fatalf("NewClaudeCLI() error = %v", err)
	}

	raw, err := provider.Generate(context.Background(), llm.Request{
		SystemPrompt: "system prompt",
		UserPrompt:   "user prompt",
		OutputMode:   llm.StructuredOutputModePromptOnly,
	})
	if err != nil {
		t.Fatalf("Generate() error = %v", err)
	}
	if raw != "Radu Lupu || warm tone || Murray Perahia || medium" {
		t.Fatalf("raw = %q, want result text", raw)
	}
	if record.name != "claude" {
		t.Fatalf("command = %q, want default claude", record.name)
	}
	if slices.Contains(record.args, "--json-schema") {
		t.Fatalf("args %q should not contain --json-schema without a schema", record.args)
	}
	if slices.Contains(record.args, "--model") {
		t.Fatalf("args %q should not contain --model when unset", record.args)
	}
}

func TestClaudeCLIProviderFallsBackToResultTextWhenStructuredOutputIsNull(t *testing.T) {
	t.Parallel()

	var record recordedCommand
	envelope := `{"type":"result","subtype":"success","is_error":false,"result":"{\"summary\":\"text fallback\"}","structured_output":null}`
	provider, err := NewClaudeCLI("sonnet", "claude", stubRunner(&record, envelope, "", nil))
	if err != nil {
		t.Fatalf("NewClaudeCLI() error = %v", err)
	}

	raw, err := provider.Generate(context.Background(), llm.Request{
		UserPrompt: "user prompt",
		Schema:     &llm.JSONSchema{Schema: map[string]any{"type": "object"}},
	})
	if err != nil {
		t.Fatalf("Generate() error = %v", err)
	}
	if raw != `{"summary":"text fallback"}` {
		t.Fatalf("raw = %q, want result text", raw)
	}
}

func TestClaudeCLIProviderReportsErrorEnvelope(t *testing.T) {
	t.Parallel()

	var record recordedCommand
	envelope := `{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate: OAuth session expired"}`
	provider, err := NewClaudeCLI("sonnet", "claude", stubRunner(&record, envelope, "", nil))
	if err != nil {
		t.Fatalf("NewClaudeCLI() error = %v", err)
	}

	_, err = provider.Generate(context.Background(), llm.Request{UserPrompt: "user prompt"})
	if err == nil {
		t.Fatal("Generate() error = nil, want error from is_error envelope")
	}
	if !strings.Contains(err.Error(), "OAuth session expired") {
		t.Fatalf("error = %q, want result text included", err)
	}
}

func TestClaudeCLIProviderIncludesStderrWhenCommandFails(t *testing.T) {
	t.Parallel()

	var record recordedCommand
	provider, err := NewClaudeCLI("sonnet", "claude", stubRunner(&record, "", "unknown option '--bogus'", errors.New("exit status 1")))
	if err != nil {
		t.Fatalf("NewClaudeCLI() error = %v", err)
	}

	_, err = provider.Generate(context.Background(), llm.Request{UserPrompt: "user prompt"})
	if err == nil {
		t.Fatal("Generate() error = nil, want command failure")
	}
	if !strings.Contains(err.Error(), "exit status 1") || !strings.Contains(err.Error(), "unknown option") {
		t.Fatalf("error = %q, want exit error and stderr", err)
	}
}

func TestClaudeCLIProviderRejectsEmptyOutput(t *testing.T) {
	t.Parallel()

	var record recordedCommand
	envelope := `{"type":"result","subtype":"success","is_error":false,"result":"   "}`
	provider, err := NewClaudeCLI("sonnet", "claude", stubRunner(&record, envelope, "", nil))
	if err != nil {
		t.Fatalf("NewClaudeCLI() error = %v", err)
	}

	_, err = provider.Generate(context.Background(), llm.Request{UserPrompt: "user prompt"})
	if err == nil {
		t.Fatal("Generate() error = nil, want error for empty output")
	}
}

func TestClaudeCLIProviderAppliesDefaultTimeout(t *testing.T) {
	t.Parallel()

	runner := func(ctx context.Context, _, _, _ string, _ ...string) ([]byte, []byte, error) {
		<-ctx.Done()
		return nil, nil, ctx.Err()
	}
	provider, err := NewClaudeCLI("sonnet", "claude", runner)
	if err != nil {
		t.Fatalf("NewClaudeCLI() error = %v", err)
	}
	provider.(*claudeCLIProvider).timeout = 20 * time.Millisecond

	_, err = provider.Generate(context.Background(), llm.Request{UserPrompt: "user prompt"})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Generate() error = %v, want context deadline exceeded", err)
	}
}

func TestClaudeCLIPreservesRuntimeErrorsOnNonzeroExit(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ name, stdout, want string }{
		{"auth", `{"type":"result","subtype":"success","is_error":true,"result":"Not logged in. Please run /login"}`, "Please run /login"},
		{"errors array", `{"type":"result","subtype":"error_during_execution","errors":["OAuth session expired"]}`, "OAuth session expired"},
		{"plain error", "Not logged in. Please run /login", "Please run /login"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var record recordedCommand
			cause := errors.New("exit status 1")
			p, _ := NewClaudeCLI("", "", stubRunner(&record, tc.stdout, "", cause))
			_, err := p.Generate(context.Background(), llm.Request{})
			if !errors.Is(err, cause) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v", err)
			}
			if _, err := os.Stat(record.dir); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("temporary directory remains: %v", err)
			}
		})
	}
}

func TestClaudeCLIRejectsInvalidEnvelopes(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{`not json`, `null`, `{}`, `{"type":"system","subtype":"init","result":"not an answer"}`} {
		var record recordedCommand
		p, _ := NewClaudeCLI("", "", stubRunner(&record, raw, "", nil))
		if _, err := p.Generate(context.Background(), llm.Request{}); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
