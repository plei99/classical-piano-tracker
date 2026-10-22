//! Running the codex and claude CLIs. Process execution is injectable so the
//! providers can be tested without real CLIs; providers own private working
//! directories so caller repositories cannot contribute instructions.

use std::fmt;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

/// How long to keep reading output after the process exits (or is killed) in
/// case a grandchild still holds the pipes open, like Go's `cmd.WaitDelay`.
const WAIT_DELAY: Duration = Duration::from_secs(1);

/// One command execution request.
pub(crate) struct Invocation<'a> {
    pub dir: &'a Path,
    pub stdin: &'a str,
    pub program: &'a str,
    pub args: &'a [String],
    pub timeout: Option<Duration>,
}

/// Captured output plus the reason the command failed, if it did.
#[derive(Debug, Default)]
pub(crate) struct CommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub failure: Option<CommandFailure>,
}

pub(crate) type CommandRunner = Arc<dyn Fn(&Invocation<'_>) -> CommandOutput + Send + Sync>;

/// Why a command did not complete successfully. Display text follows Go's
/// os/exec wording, since it ends up in user-facing errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CommandFailure {
    /// The timeout elapsed and the process was killed.
    DeadlineExceeded,
    /// The program could not be located or started.
    Start { kind: ErrorKind, message: String },
    /// The process exited unsuccessfully.
    Exit(String),
    /// The process exited, but its output pipes stayed open past the wait delay.
    WaitDelay,
}

impl fmt::Display for CommandFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CommandFailure::DeadlineExceeded => f.write_str("context deadline exceeded"),
            CommandFailure::Start { message, .. } => f.write_str(message),
            CommandFailure::Exit(status) => f.write_str(status),
            CommandFailure::WaitDelay => f.write_str("exec: WaitDelay expired before I/O complete"),
        }
    }
}

/// A failed CLI run, rendered like Go's `commandError`. It is a leaf error
/// (no source) so `{:#}` prints the message once.
#[derive(Debug)]
pub(crate) struct CommandError {
    pub command: String,
    pub failure: CommandFailure,
    detail: String,
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.detail.is_empty() {
            write!(
                f,
                "run {}: {} (check that the CLI is installed and signed in; configure command or LLM_COMMAND if it is not on PATH)",
                self.command, self.failure
            )
        } else {
            write!(f, "run {}: {}: {}", self.command, self.failure, self.detail)
        }
    }
}

impl std::error::Error for CommandError {}

pub(crate) fn command_error(command: &str, failure: CommandFailure, detail: &[u8]) -> anyhow::Error {
    let detail = String::from_utf8_lossy(detail).trim().to_string();
    anyhow::Error::new(CommandError { command: command.to_string(), failure, detail })
}

/// Creates an owner-only (0700) scratch directory like Go's `os.MkdirTemp`,
/// removed when the guard drops.
pub(crate) fn private_tempdir(prefix: &str) -> std::io::Result<tempfile::TempDir> {
    let mut builder = tempfile::Builder::new();
    builder.prefix(prefix);
    #[cfg(unix)]
    builder.permissions(std::os::unix::fs::PermissionsExt::from_mode(0o700));
    builder.tempdir()
}

pub(crate) fn default_runner() -> CommandRunner {
    Arc::new(exec_command)
}

/// Runs a command with stdin piped in and stdout/stderr captured, killing it
/// when the timeout elapses.
pub(crate) fn exec_command(inv: &Invocation<'_>) -> CommandOutput {
    let program = match resolve_program(inv.program, inv.dir) {
        Ok(program) => program,
        Err(failure) => return CommandOutput { failure: Some(failure), ..CommandOutput::default() },
    };
    let deadline = inv.timeout.map(|timeout| Instant::now() + timeout);

    let spawned = Command::new(&program)
        .args(inv.args)
        .current_dir(inv.dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(err) => {
            let failure = CommandFailure::Start {
                kind: err.kind(),
                message: format!("fork/exec {}: {}", inv.program, go_errno_text(&err)),
            };
            return CommandOutput { failure: Some(failure), ..CommandOutput::default() };
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        let input = inv.stdin.to_string();
        // A CLI that exits without reading stdin closes the pipe; Go ignores
        // that EPIPE too.
        thread::spawn(move || {
            let _ = stdin.write_all(input.as_bytes());
        });
    }
    let stdout = child.stdout.take().map(spawn_reader);
    let stderr = child.stderr.take().map(spawn_reader);

    let (status, timed_out) = wait_with_deadline(&mut child, deadline);

    let pipes_deadline = Instant::now() + WAIT_DELAY;
    let (stdout, stdout_done) = collect(stdout, pipes_deadline);
    let (stderr, stderr_done) = collect(stderr, pipes_deadline);

    let failure = if timed_out {
        Some(CommandFailure::DeadlineExceeded)
    } else {
        match status {
            Ok(status) if !status.success() => Some(CommandFailure::Exit(go_exit_text(status))),
            Ok(_) if !(stdout_done && stderr_done) => Some(CommandFailure::WaitDelay),
            Ok(_) => None,
            Err(err) => Some(CommandFailure::Exit(err.to_string())),
        }
    };
    CommandOutput { stdout, stderr, failure }
}

/// Polls for exit so the deadline can be enforced without a second handle to
/// the child. Returns whether the deadline killed the process.
fn wait_with_deadline(child: &mut Child, deadline: Option<Instant>) -> (std::io::Result<ExitStatus>, bool) {
    let mut pause = Duration::from_millis(1);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return (Ok(status), false),
            Ok(None) => {}
            Err(err) => return (Err(err), false),
        }
        let now = Instant::now();
        if let Some(deadline) = deadline {
            if now >= deadline {
                let _ = child.kill();
                return (child.wait(), true);
            }
            pause = pause.min(deadline - now);
        }
        thread::sleep(pause);
        pause = (pause * 2).min(Duration::from_millis(50));
    }
}

/// Streams a pipe in chunks so output read before the wait delay expires is
/// kept even if a grandchild holds the pipe open. `None` marks EOF.
fn spawn_reader(mut pipe: impl Read + Send + 'static) -> Receiver<Option<Vec<u8>>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(None);
                    return;
                }
                Ok(n) => {
                    if tx.send(Some(buf[..n].to_vec())).is_err() {
                        return;
                    }
                }
            }
        }
    });
    rx
}

/// Gathers output until EOF or the deadline; reports whether EOF was reached.
fn collect(rx: Option<Receiver<Option<Vec<u8>>>>, deadline: Instant) -> (Vec<u8>, bool) {
    let Some(rx) = rx else { return (Vec::new(), true) };
    let mut out = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(Some(chunk)) => out.extend_from_slice(&chunk),
            Ok(None) | Err(RecvTimeoutError::Disconnected) => return (out, true),
            Err(RecvTimeoutError::Timeout) => return (out, false),
        }
    }
}

/// Mirrors Go's `exec.Command` resolution: names containing a separator are
/// used as paths (relative ones resolve against the working directory), bare
/// names are looked up in `$PATH`, and a match relative to the current
/// directory is refused.
fn resolve_program(name: &str, dir: &Path) -> Result<PathBuf, CommandFailure> {
    if name.contains(std::path::MAIN_SEPARATOR) || name.contains('/') {
        let path = Path::new(name);
        return Ok(if path.is_relative() { dir.join(path) } else { path.to_path_buf() });
    }
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    if !path_var.is_empty() {
        for entry in std::env::split_paths(&path_var) {
            let entry = if entry.as_os_str().is_empty() { PathBuf::from(".") } else { entry };
            let candidate = entry.join(name);
            if !is_executable(&candidate) {
                continue;
            }
            if candidate.is_relative() {
                return Err(CommandFailure::Start {
                    kind: ErrorKind::NotFound,
                    message: format!("exec: {name:?}: cannot run executable found relative to current directory"),
                });
            }
            return Ok(candidate);
        }
    }
    Err(CommandFailure::Start {
        kind: ErrorKind::NotFound,
        message: format!("exec: {name:?}: executable file not found in $PATH"),
    })
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else { return false };
    if metadata.is_dir() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Go prints bare errno text ("no such file or directory"); Rust appends
/// " (os error N)" and capitalizes.
fn go_errno_text(err: &std::io::Error) -> String {
    match err.kind() {
        ErrorKind::NotFound => "no such file or directory".to_string(),
        ErrorKind::PermissionDenied => "permission denied".to_string(),
        _ => err.to_string(),
    }
}

/// Renders an exit status like Go's `ProcessState.String`.
fn go_exit_text(status: ExitStatus) -> String {
    if let Some(code) = status.code() {
        return format!("exit status {code}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            let name = match signal {
                1 => "hangup".to_string(),
                2 => "interrupt".to_string(),
                3 => "quit".to_string(),
                4 => "illegal instruction".to_string(),
                6 => "aborted".to_string(),
                9 => "killed".to_string(),
                11 => "segmentation fault".to_string(),
                13 => "broken pipe".to_string(),
                15 => "terminated".to_string(),
                other => other.to_string(),
            };
            let core = if status.core_dumped() { " (core dumped)" } else { "" };
            return format!("signal: {name}{core}");
        }
    }
    status.to_string()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Writes an executable shell script into `dir`.
    pub(crate) fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    /// What a stub runner saw.
    #[derive(Debug, Default, Clone)]
    pub(crate) struct RecordedCommand {
        pub dir: PathBuf,
        pub name: String,
        pub args: Vec<String>,
        pub stdin: String,
        pub timeout: Option<Duration>,
    }

    pub(crate) fn stub_runner(
        record: Arc<Mutex<RecordedCommand>>,
        stdout: &str,
        stderr: &str,
        failure: Option<CommandFailure>,
    ) -> CommandRunner {
        let (stdout, stderr) = (stdout.to_string(), stderr.to_string());
        Arc::new(move |inv: &Invocation<'_>| {
            *record.lock().unwrap() = RecordedCommand {
                dir: inv.dir.to_path_buf(),
                name: inv.program.to_string(),
                args: inv.args.to_vec(),
                stdin: inv.stdin.to_string(),
                timeout: inv.timeout,
            };
            CommandOutput {
                stdout: stdout.clone().into_bytes(),
                stderr: stderr.clone().into_bytes(),
                failure: failure.clone(),
            }
        })
    }

    pub(crate) fn flag_value<'a>(args: &'a [String], flag: &str) -> &'a str {
        let idx = args.iter().position(|arg| arg == flag);
        match idx.and_then(|idx| args.get(idx + 1)) {
            Some(value) => value,
            None => panic!("args {args:?} do not contain {flag} with a value"),
        }
    }

    fn run(dir: &Path, program: &str, stdin: &str, timeout: Option<Duration>) -> CommandOutput {
        exec_command(&Invocation { dir, stdin, program, args: &[], timeout })
    }

    #[test]
    fn exec_command_pipes_stdin_sets_dir_and_captures_output() {
        let bin = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let script = write_script(bin.path(), "echo", "pwd\ncat\nprintf diagnostic >&2");
        let output = run(work.path(), script.to_str().unwrap(), "piped input", None);
        assert_eq!(output.failure, None);
        let stdout = String::from_utf8(output.stdout).unwrap();
        let (reported_dir, input) = stdout.split_once('\n').unwrap();
        assert_eq!(std::fs::canonicalize(reported_dir).unwrap(), std::fs::canonicalize(work.path()).unwrap());
        assert_eq!(input, "piped input");
        assert_eq!(output.stderr, b"diagnostic");
    }

    #[test]
    fn exec_command_kills_on_deadline() {
        let bin = tempfile::tempdir().unwrap();
        let script = write_script(bin.path(), "wait", "exec sleep 60");
        let started = Instant::now();
        let output = run(bin.path(), script.to_str().unwrap(), "", Some(Duration::from_millis(50)));
        assert_eq!(output.failure, Some(CommandFailure::DeadlineExceeded));
        assert!(started.elapsed() < Duration::from_secs(5));

        // A grandchild holding the pipes open is bounded by the wait delay.
        let script = write_script(bin.path(), "fork", "sleep 5 &\nexit 0");
        let started = Instant::now();
        let output = run(bin.path(), script.to_str().unwrap(), "", None);
        assert_eq!(output.failure, Some(CommandFailure::WaitDelay));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn exec_command_reports_exit_status_and_missing_programs() {
        let bin = tempfile::tempdir().unwrap();
        let script = write_script(bin.path(), "fail", "echo oops >&2\nexit 3");
        let output = run(bin.path(), script.to_str().unwrap(), "", None);
        assert_eq!(output.failure, Some(CommandFailure::Exit("exit status 3".into())));
        assert_eq!(output.stderr, b"oops\n");

        let output = run(bin.path(), "/nonexistent/claude", "", None);
        assert_eq!(output.failure.unwrap().to_string(), "fork/exec /nonexistent/claude: no such file or directory");

        let output = run(bin.path(), "definitely-not-a-real-tracker-cli", "", None);
        let failure = output.failure.unwrap();
        assert!(matches!(failure, CommandFailure::Start { kind: ErrorKind::NotFound, .. }));
        assert_eq!(
            failure.to_string(),
            "exec: \"definitely-not-a-real-tracker-cli\": executable file not found in $PATH"
        );

        // Relative paths resolve against the private working directory.
        write_script(bin.path(), "local", "printf local");
        let output = run(bin.path(), "./local", "", None);
        assert_eq!(output.stdout, b"local");
    }

    #[test]
    fn command_error_wording() {
        let err = command_error("codex", CommandFailure::Exit("exit status 1".into()), b" Please run codex login\n");
        assert_eq!(format!("{err:#}"), "run codex: exit status 1: Please run codex login");
        let err = command_error("claude", CommandFailure::DeadlineExceeded, b"  ");
        assert_eq!(
            format!("{err:#}"),
            "run claude: context deadline exceeded (check that the CLI is installed and signed in; configure command or LLM_COMMAND if it is not on PATH)"
        );
    }
}
