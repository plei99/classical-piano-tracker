//! OpenAI's Codex CLI in non-interactive `exec` mode. It uses the CLI's
//! existing authentication, never tracker API keys.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail};

use super::command::{CommandRunner, Invocation, command_error, default_runner, private_tempdir};
use crate::{Provider, Request, gojson};

const DEFAULT_CODEX_COMMAND: &str = "codex";
const DEFAULT_CODEX_TIMEOUT: Duration = Duration::from_secs(5 * 60);

pub struct CodexProvider {
    pub(crate) command: String,
    pub(crate) model: String,
    pub(crate) timeout: Duration,
    run: CommandRunner,
}

impl CodexProvider {
    /// An empty model leaves selection to the CLI's built-in default, and an
    /// empty command resolves `codex` from PATH.
    pub fn new(model: &str, command: &str) -> CodexProvider {
        CodexProvider::with_runner(model, command, default_runner())
    }

    pub(crate) fn with_runner(model: &str, command: &str, run: CommandRunner) -> CodexProvider {
        let command = if command.trim().is_empty() { DEFAULT_CODEX_COMMAND } else { command };
        CodexProvider {
            command: command.trim().to_string(),
            model: model.trim().to_string(),
            timeout: DEFAULT_CODEX_TIMEOUT,
            run,
        }
    }
}

impl Provider for CodexProvider {
    fn generate(&self, req: &Request) -> Result<String> {
        let dir = private_tempdir("piano-tracker-codex-").context("create Codex working directory")?;

        let output_path = dir.path().join("response.txt");
        // Precreate with private permissions; the CLI writes the final answer
        // here, while stdout/stderr may contain progress and must not be
        // parsed as JSON.
        write_private_file(&output_path, b"").context("create Codex output file")?;

        let mut args: Vec<String> = [
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--color",
            "never",
            "-c",
            r#"approval_policy="never""#,
            "-c",
            r#"web_search="disabled""#,
            "-c",
            "features.shell_tool=false",
            "-c",
            "features.unified_exec=false",
            "-c",
            "project_doc_max_bytes=0",
            "--output-last-message",
        ]
        .iter()
        .map(|arg| arg.to_string())
        .collect();
        args.push(output_path.to_string_lossy().into_owned());
        if !self.model.is_empty() {
            args.extend(["--model".to_string(), self.model.clone()]);
        }
        if let Some(schema) = req.schema.as_ref().filter(|schema| !schema.schema.is_null()) {
            let schema = gojson::to_string(&schema.schema).context("marshal Codex JSON schema")?;
            let schema_path = dir.path().join("schema.json");
            write_private_file(&schema_path, schema.as_bytes()).context("write Codex JSON schema")?;
            args.extend(["--output-schema".to_string(), schema_path.to_string_lossy().into_owned()]);
        }
        args.push("-".to_string());

        // Codex exec has one prompt input rather than separate API message
        // roles. Both task instructions and taste data travel via stdin, not
        // process argv.
        let prompt = format!(
            "Answer only the following music taste task using the supplied data and your existing knowledge. Do not use tools, browse, inspect files, or execute commands. Return only the requested output.\n\n{}\n\n{}",
            req.system_prompt, req.user_prompt
        );
        let output = (self.run)(&Invocation {
            dir: dir.path(),
            stdin: &prompt,
            program: &self.command,
            args: &args,
            timeout: (!self.timeout.is_zero()).then_some(self.timeout),
        });
        if let Some(failure) = output.failure {
            return Err(command_error(&self.command, failure, &output.stderr));
        }

        let response = fs::read(&output_path).context("read Codex final response")?;
        let raw = String::from_utf8_lossy(&response).trim().to_string();
        if raw.is_empty() {
            bail!("{} returned no final response", self.command);
        }
        Ok(raw)
    }
}

/// Like Go's `os.WriteFile(path, data, 0o600)`.
fn write_private_file(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)?.write_all(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::JsonSchema;
    use crate::StructuredOutputMode;
    use crate::providers::command::tests::{RecordedCommand, flag_value, stub_runner};
    use crate::providers::command::{CommandError, CommandFailure, CommandOutput};
    use serde_json::json;
    use std::io::ErrorKind;
    use std::sync::{Arc, Mutex};

    fn request(system: &str, user: &str, schema: Option<serde_json::Value>) -> Request {
        Request {
            system_prompt: system.into(),
            user_prompt: user.into(),
            output_mode: StructuredOutputMode::Strict,
            schema: schema.map(|schema| JsonSchema { name: String::new(), schema, strict: false }),
            temperature: 0.0,
            max_output_tokens: 0,
        }
    }

    #[cfg(unix)]
    fn mode(path: &str) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn request_and_private_artifacts() {
        let seen_dir = Arc::new(Mutex::new(std::path::PathBuf::new()));
        let seen = Arc::clone(&seen_dir);
        let runner: CommandRunner = Arc::new(move |inv: &Invocation<'_>| {
            *seen.lock().unwrap() = inv.dir.to_path_buf();
            assert_eq!(inv.program, "/opt/bin/codex");
            assert!(inv.stdin.contains("task instructions") && inv.stdin.contains("private taste data"));
            let args = inv.args;
            assert_eq!(args[0], "exec");
            assert_eq!(args.last().map(String::as_str), Some("-"));
            for flag in ["--ephemeral", "--ignore-user-config", "--skip-git-repo-check"] {
                assert!(args.iter().any(|arg| arg == flag), "missing {flag}: {args:?}");
            }
            for (flag, want) in [("--sandbox", "read-only"), ("--color", "never"), ("--model", "chosen-model")] {
                assert_eq!(flag_value(args, flag), want, "{flag}");
            }
            for setting in [
                r#"approval_policy="never""#,
                r#"web_search="disabled""#,
                "features.shell_tool=false",
                "features.unified_exec=false",
                "project_doc_max_bytes=0",
            ] {
                assert!(args.iter().any(|arg| arg == setting), "missing setting {setting}");
            }
            assert!(!args.join(" ").contains("private taste data"), "taste data leaked into argv");

            let schema_path = flag_value(args, "--output-schema");
            let output_path = flag_value(args, "--output-last-message");
            #[cfg(unix)]
            {
                assert_eq!(mode(inv.dir.to_str().unwrap()), 0o700);
                assert_eq!(mode(schema_path), 0o600);
                assert_eq!(mode(output_path), 0o600);
            }
            assert_eq!(Path::new(schema_path).parent(), Some(inv.dir));
            assert_eq!(Path::new(output_path).parent(), Some(inv.dir));
            let schema: serde_json::Value = serde_json::from_slice(&fs::read(schema_path).unwrap()).unwrap();
            assert_eq!(schema["type"], "object");
            fs::write(output_path, " {\"summary\":\"lyrical playing\"}\n").unwrap();
            CommandOutput { stdout: b"progress, not JSON".to_vec(), ..CommandOutput::default() }
        });

        let provider = CodexProvider::with_runner(" chosen-model ", "/opt/bin/codex", runner);
        let raw = provider
            .generate(&request("task instructions", "private taste data", Some(json!({"type": "object"}))))
            .unwrap();
        assert_eq!(raw, r#"{"summary":"lyrical playing"}"#);
        assert!(!seen_dir.lock().unwrap().exists(), "temporary directory remains");
    }

    #[test]
    fn prompt_layout() {
        let record = Arc::new(Mutex::new(RecordedCommand::default()));
        let provider = CodexProvider::with_runner("", "", stub_runner(Arc::clone(&record), "", "", None));
        let _ = provider.generate(&request("SYS", "USER", None));
        assert_eq!(
            record.lock().unwrap().stdin,
            "Answer only the following music taste task using the supplied data and your existing knowledge. Do not use tools, browse, inspect files, or execute commands. Return only the requested output.\n\nSYS\n\nUSER"
        );
        assert_eq!(record.lock().unwrap().timeout, Some(DEFAULT_CODEX_TIMEOUT));
    }

    #[test]
    fn text_without_model_or_schema() {
        let runner: CommandRunner = Arc::new(|inv: &Invocation<'_>| {
            assert_eq!(inv.program, "codex");
            assert!(!inv.args.iter().any(|arg| arg == "--model" || arg == "--output-schema"), "{:?}", inv.args);
            fs::write(flag_value(inv.args, "--output-last-message"), "plain text fallback").unwrap();
            CommandOutput::default()
        });
        let provider = CodexProvider::with_runner("", "", runner);
        assert_eq!(provider.generate(&request("", "task", None)).unwrap(), "plain text fallback");

        // A null schema is treated like no schema.
        let runner: CommandRunner = Arc::new(|inv: &Invocation<'_>| {
            assert!(!inv.args.iter().any(|arg| arg == "--output-schema"));
            fs::write(flag_value(inv.args, "--output-last-message"), "x").unwrap();
            CommandOutput::default()
        });
        let provider = CodexProvider::with_runner("", "", runner);
        assert_eq!(provider.generate(&request("", "task", Some(serde_json::Value::Null))).unwrap(), "x");
    }

    #[test]
    fn failures_and_cleanup() {
        let not_found = CommandFailure::Start { kind: ErrorKind::NotFound, message: "file does not exist".into() };
        let cases = [
            ("empty", "", None, "no final response"),
            (
                "exit",
                "Please run codex login",
                Some(CommandFailure::Exit("exit status 1".into())),
                "Please run codex login",
            ),
            ("missing", "", Some(not_found), "installed and signed in"),
        ];
        for (name, stderr, failure, want) in cases {
            let record = Arc::new(Mutex::new(RecordedCommand::default()));
            let provider = CodexProvider::with_runner(
                "",
                "",
                stub_runner(Arc::clone(&record), "ignored stdout", stderr, failure.clone()),
            );
            let err = provider.generate(&request("", "", None)).unwrap_err();
            assert!(format!("{err:#}").contains(want), "{name}: {err:#}");
            if let Some(failure) = failure {
                let cause = err.downcast_ref::<CommandError>().map(|err| &err.failure);
                assert_eq!(cause, Some(&failure), "{name}: lost cause");
            }
            assert!(!record.lock().unwrap().dir.exists(), "{name}: directory remains");
        }
    }

    #[test]
    fn deadline() {
        let provider = CodexProvider::new("", "");
        assert_eq!(provider.timeout, Duration::from_secs(5 * 60));

        let runner: CommandRunner = Arc::new(|inv: &Invocation<'_>| {
            assert_eq!(inv.timeout, Some(Duration::from_millis(10)));
            CommandOutput { failure: Some(CommandFailure::DeadlineExceeded), ..CommandOutput::default() }
        });
        let mut provider = CodexProvider::with_runner("", "", runner);
        provider.timeout = Duration::from_millis(10);
        let err = provider.generate(&request("", "", None)).unwrap_err();
        assert_eq!(err.downcast_ref::<CommandError>().map(|err| &err.failure), Some(&CommandFailure::DeadlineExceeded));
    }

    #[cfg(unix)]
    #[test]
    fn runs_a_real_fake_executable() {
        let bin = tempfile::tempdir().unwrap();
        // Writes its stdin to the --output-last-message path.
        let script = crate::providers::command::tests::write_script(
            bin.path(),
            "codex",
            r#"while [ "$1" != "--output-last-message" ]; do shift; done
cat > "$2"
echo progress"#,
        );
        let provider = CodexProvider::new("", script.to_str().unwrap());
        let raw = provider.generate(&request("SYS", "USER", Some(json!({"type": "object"})))).unwrap();
        assert!(raw.ends_with("SYS\n\nUSER"), "{raw}");
    }
}
