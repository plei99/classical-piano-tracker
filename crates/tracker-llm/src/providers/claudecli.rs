//! The Claude Code CLI in print mode. It needs no API key: the CLI uses the
//! user's existing login.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::value::RawValue;

use super::command::{CommandRunner, Invocation, command_error, default_runner, private_tempdir};
use super::http::nullable;
use crate::{Provider, Request, gojson};

const DEFAULT_CLAUDE_CLI_COMMAND: &str = "claude";
/// Generous because each call pays for CLI startup on top of model latency,
/// and discovery may chain several calls.
const DEFAULT_CLAUDE_CLI_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// The model aliases the Claude Code CLI accepts. The CLI has no
/// model-listing endpoint, so onboarding offers these fixed choices.
pub(crate) const CLAUDE_CLI_MODELS: [&str; 4] = ["sonnet", "opus", "haiku", "fable"];

pub struct ClaudeCliProvider {
    pub(crate) command: String,
    pub(crate) model: String,
    pub(crate) timeout: Duration,
    run: CommandRunner,
}

/// The single-object envelope printed by `claude -p --output-format json`.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ClaudeCliResult {
    #[serde(rename = "type", deserialize_with = "nullable")]
    kind: String,
    #[serde(deserialize_with = "nullable")]
    subtype: String,
    #[serde(deserialize_with = "nullable")]
    is_error: bool,
    #[serde(deserialize_with = "nullable")]
    result: String,
    /// Kept as raw JSON so the caller sees exactly what the CLI produced.
    structured_output: Option<Box<RawValue>>,
    #[serde(deserialize_with = "nullable")]
    errors: Vec<Option<String>>,
}

impl ClaudeCliProvider {
    /// An empty model defers to the CLI default; an empty command resolves
    /// `claude` from PATH.
    pub fn new(model: &str, command: &str) -> ClaudeCliProvider {
        ClaudeCliProvider::with_runner(model, command, default_runner())
    }

    pub(crate) fn with_runner(model: &str, command: &str, run: CommandRunner) -> ClaudeCliProvider {
        let command = if command.trim().is_empty() { DEFAULT_CLAUDE_CLI_COMMAND } else { command };
        ClaudeCliProvider {
            command: command.trim().to_string(),
            model: model.trim().to_string(),
            timeout: DEFAULT_CLAUDE_CLI_TIMEOUT,
            run,
        }
    }

    fn build_args(&self, req: &Request) -> Result<Vec<String>> {
        let mut args: Vec<String> = [
            "-p",
            "--output-format",
            "json",
            "--tools",
            "",
            // Unlike --bare, safe mode preserves OAuth/keychain authentication
            // while disabling custom instructions, hooks, skills, plugins, and
            // MCP servers.
            "--safe-mode",
            "--strict-mcp-config",
            "--mcp-config",
            r#"{"mcpServers":{}}"#,
            "--disable-slash-commands",
            "--permission-mode",
            "dontAsk",
            "--no-session-persistence",
        ]
        .iter()
        .map(|arg| arg.to_string())
        .collect();
        if !self.model.is_empty() {
            args.extend(["--model".to_string(), self.model.clone()]);
        }
        if !req.system_prompt.trim().is_empty() {
            args.extend(["--system-prompt".to_string(), req.system_prompt.clone()]);
        }
        if let Some(schema) = req.schema.as_ref().filter(|schema| !schema.schema.is_null()) {
            let schema = gojson::to_string(&schema.schema).context("marshal Claude CLI JSON schema")?;
            args.extend(["--json-schema".to_string(), schema]);
        }
        Ok(args)
    }
}

impl Provider for ClaudeCliProvider {
    /// Runs `claude -p` with all built-in tools disabled. A schema is passed
    /// via --json-schema so the CLI validates the output and returns it in
    /// the structured_output field.
    fn generate(&self, req: &Request) -> Result<String> {
        let args = self.build_args(req)?;
        let dir = private_tempdir("piano-tracker-claude-").context("create Claude CLI working directory")?;

        let output = (self.run)(&Invocation {
            dir: dir.path(),
            stdin: &req.user_prompt,
            program: &self.command,
            args: &args,
            timeout: (!self.timeout.is_zero()).then_some(self.timeout),
        });

        // Claude reports runtime failures on stdout, often with a nonzero
        // exit. Decode that envelope before falling back to stderr/exit status.
        let decoded = serde_json::from_slice::<Option<ClaudeCliResult>>(output.stdout.trim_ascii())
            .map(Option::unwrap_or_default);
        if let Ok(result) = &decoded
            && (result.is_error || result.subtype.starts_with("error"))
        {
            let mut lines = vec![result.result.as_str()];
            lines.extend(result.errors.iter().map(|error| error.as_deref().unwrap_or("")));
            let detail = lines.join("\n").trim().to_string();
            if let Some(failure) = output.failure {
                return Err(command_error(&self.command, failure, format!("{}: {detail}", result.subtype).as_bytes()));
            }
            bail!("{} reported an error ({}): {detail}", self.command, result.subtype);
        }
        if let Some(failure) = output.failure {
            let detail = if output.stderr.trim_ascii().is_empty() { &output.stdout } else { &output.stderr };
            return Err(command_error(&self.command, failure, detail));
        }

        let result = decoded.with_context(|| format!("decode {} result", self.command))?;
        if result.kind != "result" || result.subtype != "success" {
            bail!("{} returned an unexpected result envelope ({}/{})", self.command, result.kind, result.subtype);
        }

        if let Some(structured) = &result.structured_output {
            let structured = structured.get().trim();
            if !structured.is_empty() && structured != "null" {
                return Ok(structured.to_string());
            }
        }
        let raw = result.result.trim();
        if raw.is_empty() {
            bail!("{} returned neither structured output nor text", self.command);
        }
        Ok(raw.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::command::tests::{RecordedCommand, flag_value, stub_runner};
    use crate::providers::command::{CommandError, CommandFailure};
    use crate::{JsonSchema, StructuredOutputMode};
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn request(system: &str, user: &str, schema: Option<serde_json::Value>) -> Request {
        Request {
            system_prompt: system.into(),
            user_prompt: user.into(),
            output_mode: StructuredOutputMode::Strict,
            schema: schema.map(|schema| JsonSchema { name: "pianist_discovery".into(), schema, strict: true }),
            temperature: 0.0,
            max_output_tokens: 0,
        }
    }

    fn stub_provider(
        model: &str,
        command: &str,
        stdout: &str,
        stderr: &str,
        failure: Option<CommandFailure>,
    ) -> (ClaudeCliProvider, Arc<Mutex<RecordedCommand>>) {
        let record = Arc::new(Mutex::new(RecordedCommand::default()));
        let runner = stub_runner(Arc::clone(&record), stdout, stderr, failure);
        (ClaudeCliProvider::with_runner(model, command, runner), record)
    }

    fn has(args: &[String], flag: &str) -> bool {
        args.iter().any(|arg| arg == flag)
    }

    #[test]
    fn builds_print_args_and_returns_structured_output() {
        let envelope = r#"{"type":"result","subtype":"success","is_error":false,"result":"done","structured_output":{"summary":"You like lyrical playing.","recommendations":[{"pianist_name":"Radu Lupu","why_fit":"warm tone","similar_to":["Murray Perahia"],"confidence":"medium"}]}}"#;
        let (provider, record) = stub_provider("sonnet", "/opt/bin/claude", envelope, "", None);
        let schema = json!({
            "type": "object",
            "properties": {"summary": {"type": "string"}},
            "required": ["summary"],
        });
        let raw =
            provider.generate(&request("system prompt", "user prompt with\nmultiple lines", Some(schema))).unwrap();

        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["summary"], "You like lyrical playing.");
        assert_eq!(parsed["recommendations"][0]["pianist_name"], "Radu Lupu");
        assert!(raw.starts_with(r#"{"summary":"You like"#), "raw JSON is passed through verbatim: {raw}");

        let record = record.lock().unwrap();
        assert_eq!(record.name, "/opt/bin/claude");
        assert!(!record.dir.as_os_str().is_empty(), "missing isolated working directory");
        assert!(!record.dir.exists(), "temporary directory remains");
        let args = &record.args;
        assert!(has(args, "--strict-mcp-config") && has(args, "--disable-slash-commands"));
        assert_eq!(flag_value(args, "--mcp-config"), r#"{"mcpServers":{}}"#);
        assert_eq!(flag_value(args, "--permission-mode"), "dontAsk");
        assert_eq!(record.stdin, "user prompt with\nmultiple lines");
        assert!(has(args, "-p"));
        assert!(has(args, "--safe-mode") && !has(args, "--bare"), "safe mode, not bare mode (which ignores login)");
        assert!(has(args, "--no-session-persistence"));
        assert_eq!(flag_value(args, "--output-format"), "json");
        assert_eq!(flag_value(args, "--tools"), "", "empty string disables tools");
        assert_eq!(flag_value(args, "--model"), "sonnet");
        assert_eq!(flag_value(args, "--system-prompt"), "system prompt");
        // Compact, sorted keys, as Go's json.Marshal writes it.
        assert_eq!(
            flag_value(args, "--json-schema"),
            r#"{"properties":{"summary":{"type":"string"}},"required":["summary"],"type":"object"}"#
        );
        assert!(!args.iter().any(|arg| arg.contains("user prompt")), "user prompt leaked into argv: {args:?}");
        assert_eq!(record.timeout, Some(DEFAULT_CLAUDE_CLI_TIMEOUT));
    }

    #[test]
    fn omits_schema_model_and_blank_system_prompt_and_returns_text() {
        let envelope = r#"{"type":"result","subtype":"success","is_error":false,"result":"Radu Lupu || warm tone || Murray Perahia || medium"}"#;
        let (provider, record) = stub_provider("", "", envelope, "", None);
        let req = Request { output_mode: StructuredOutputMode::PromptOnly, ..request(" ", "user prompt", None) };
        assert_eq!(provider.generate(&req).unwrap(), "Radu Lupu || warm tone || Murray Perahia || medium");
        let record = record.lock().unwrap();
        assert_eq!(record.name, "claude");
        assert!(!has(&record.args, "--json-schema"));
        assert!(!has(&record.args, "--model"));
        assert!(!has(&record.args, "--system-prompt"));
    }

    #[test]
    fn falls_back_to_result_text_when_structured_output_is_null() {
        let envelope = r#"{"type":"result","subtype":"success","is_error":false,"result":"{\"summary\":\"text fallback\"}","structured_output":null}"#;
        let (provider, _) = stub_provider("sonnet", "claude", envelope, "", None);
        let raw = provider.generate(&request("", "user prompt", Some(json!({"type": "object"})))).unwrap();
        assert_eq!(raw, r#"{"summary":"text fallback"}"#);
    }

    #[test]
    fn reports_error_envelope() {
        let envelope = r#"{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate: OAuth session expired"}"#;
        let (provider, _) = stub_provider("sonnet", "claude", envelope, "", None);
        let err = provider.generate(&request("", "user prompt", None)).unwrap_err();
        assert_eq!(
            format!("{err:#}"),
            "claude reported an error (success): Failed to authenticate: OAuth session expired"
        );
    }

    #[test]
    fn includes_stderr_when_command_fails() {
        let failure = CommandFailure::Exit("exit status 1".into());
        let (provider, _) = stub_provider("sonnet", "claude", "", "unknown option '--bogus'", Some(failure));
        let err = provider.generate(&request("", "user prompt", None)).unwrap_err();
        assert_eq!(format!("{err:#}"), "run claude: exit status 1: unknown option '--bogus'");
    }

    #[test]
    fn rejects_empty_output() {
        let envelope = r#"{"type":"result","subtype":"success","is_error":false,"result":"   "}"#;
        let (provider, _) = stub_provider("sonnet", "claude", envelope, "", None);
        let err = provider.generate(&request("", "user prompt", None)).unwrap_err();
        assert_eq!(err.to_string(), "claude returned neither structured output nor text");
    }

    #[test]
    fn applies_default_timeout() {
        let (mut provider, record) = stub_provider("sonnet", "claude", "", "", Some(CommandFailure::DeadlineExceeded));
        assert_eq!(provider.timeout, Duration::from_secs(5 * 60));
        provider.timeout = Duration::from_millis(20);
        let err = provider.generate(&request("", "user prompt", None)).unwrap_err();
        assert_eq!(record.lock().unwrap().timeout, Some(Duration::from_millis(20)));
        assert_eq!(err.downcast_ref::<CommandError>().map(|err| &err.failure), Some(&CommandFailure::DeadlineExceeded));
    }

    #[test]
    fn preserves_runtime_errors_on_nonzero_exit() {
        let cases = [
            (
                "auth",
                r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in. Please run /login"}"#,
                "run claude: exit status 1: success: Not logged in. Please run /login",
            ),
            (
                "errors array",
                r#"{"type":"result","subtype":"error_during_execution","errors":["OAuth session expired"]}"#,
                "run claude: exit status 1: error_during_execution: OAuth session expired",
            ),
            (
                "plain error",
                "Not logged in. Please run /login",
                "run claude: exit status 1: Not logged in. Please run /login",
            ),
        ];
        for (name, stdout, want) in cases {
            let cause = CommandFailure::Exit("exit status 1".into());
            let (provider, record) = stub_provider("", "", stdout, "", Some(cause.clone()));
            let err = provider.generate(&request("", "", None)).unwrap_err();
            assert_eq!(format!("{err:#}"), want, "{name}");
            assert_eq!(err.downcast_ref::<CommandError>().map(|err| &err.failure), Some(&cause), "{name}");
            assert!(!record.lock().unwrap().dir.exists(), "{name}: temporary directory remains");
        }
    }

    #[test]
    fn rejects_invalid_envelopes() {
        for raw in ["not json", "null", "{}", r#"{"type":"system","subtype":"init","result":"not an answer"}"#] {
            let (provider, _) = stub_provider("", "", raw, "", None);
            assert!(provider.generate(&request("", "", None)).is_err(), "accepted {raw}");
        }
        let (provider, _) = stub_provider("", "", "null", "", None);
        assert_eq!(
            provider.generate(&request("", "", None)).unwrap_err().to_string(),
            "claude returned an unexpected result envelope (/)"
        );
        let (provider, _) = stub_provider("", "", "not json", "", None);
        assert!(
            format!("{:#}", provider.generate(&request("", "", None)).unwrap_err())
                .starts_with("decode claude result: ")
        );
    }

    #[cfg(unix)]
    #[test]
    fn runs_a_real_fake_executable() {
        let bin = tempfile::tempdir().unwrap();
        let script = crate::providers::command::tests::write_script(
            bin.path(),
            "claude",
            r#"input=$(cat)
printf '{"type":"result","subtype":"success","is_error":false,"result":"%s"}' "$input""#,
        );
        let provider = ClaudeCliProvider::new("", script.to_str().unwrap());
        assert_eq!(provider.generate(&request("sys", "hello", None)).unwrap(), "hello");

        let script = crate::providers::command::tests::write_script(
            bin.path(),
            "claude-fail",
            r#"printf '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in"}'
exit 1"#,
        );
        let provider = ClaudeCliProvider::new("", script.to_str().unwrap());
        let err = provider.generate(&request("", "", None)).unwrap_err();
        assert_eq!(format!("{err:#}"), format!("run {}: exit status 1: success: Not logged in", script.display()));
    }
}
