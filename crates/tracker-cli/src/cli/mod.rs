//! The clap command tree. It keeps user-facing orchestration (prompts,
//! output formats, first-run messaging) out of the library crates, which
//! only deal in data and errors.

mod config_cmd;
mod format;
mod list;
mod onboarding;
mod picker;
mod rate;
mod recommend;
mod show;
mod spotify_cmd;
mod sync;
mod tabwriter;
mod timefmt;
mod tui_cmd;
mod web_cmd;

use std::ffi::OsString;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use clap::error::ErrorKind;
use clap::{ArgAction, CommandFactory, Parser, Subcommand};
use tracker_core::config::Config;
use tracker_core::paths;

use crate::buildinfo;

pub use onboarding::OnboardingDeps;
pub use web_cmd::WebDeps;

/// The streams a command reads and writes. Commands never touch the process
/// stdin/stdout directly, so tests can drive them with in-memory buffers.
pub struct Io<'a> {
    pub input: &'a mut dyn BufRead,
    pub out: &'a mut dyn Write,
    /// Whether `out` is the controlling terminal; only then is the terminal
    /// size consulted when wrapping long fields.
    pub out_is_terminal: bool,
}

/// Interactive seams that tests swap out (the Go build used package-level
/// function variables for the same purpose).
#[derive(Default)]
pub struct Deps {
    pub onboarding: OnboardingDeps,
    pub web: WebDeps,
}

// Cobra's root command: Short/Long/Example map to about/long_about/after_help.
#[derive(Debug, Parser)]
#[command(
    name = "tracker",
    version = buildinfo::VERSION,
    disable_version_flag = true,
    about = "Track and rate classical piano listening history from Spotify",
    long_about = "Track, rate, and explore classical piano listening history from Spotify.",
    after_help = "Examples:
  tracker onboarding
  tracker spotify login
  tracker sync
  tracker tui
  tracker recommend favorites"
)]
pub struct Cli {
    // Cobra registers `-v/--version` on the root command only.
    #[arg(short = 'v', long = "version", action = ArgAction::Version, help = "version for tracker")]
    _version: Option<bool>,

    #[command(flatten)]
    opts: RootOptions,

    #[command(subcommand)]
    command: Option<Command>,
}

/// Global path overrides carried down into subcommands, so no library needs
/// to know how config and database defaults are resolved.
#[derive(Debug, Clone, clap::Args)]
pub(crate) struct RootOptions {
    // An empty default (when the platform path cannot be resolved) defers
    // the error to the commands that actually need the path.
    #[arg(
        long = "config",
        global = true,
        value_name = "CONFIG",
        default_value_os_t = default_path_arg(paths::default_config_path()),
        help = "path to the config file"
    )]
    config_path: OsString,

    #[arg(
        long = "db",
        global = true,
        value_name = "DB",
        default_value_os_t = default_path_arg(paths::default_db_path()),
        help = "path to the SQLite database file"
    )]
    db_path: OsString,
}

fn default_path_arg(path: Result<PathBuf>) -> OsString {
    path.map(PathBuf::into_os_string).unwrap_or_default()
}

impl RootOptions {
    pub(crate) fn resolve_config_path(&self) -> Result<PathBuf> {
        if self.config_path.is_empty() { paths::default_config_path() } else { Ok(PathBuf::from(&self.config_path)) }
    }

    pub(crate) fn resolve_db_path(&self) -> Result<PathBuf> {
        if self.db_path.is_empty() { paths::default_db_path() } else { Ok(PathBuf::from(&self.db_path)) }
    }
}

// Declared alphabetically because cobra lists subcommands sorted by name.
#[derive(Debug, Subcommand)]
enum Command {
    #[command(
        about = "Inspect and validate local configuration",
        subcommand_required = true,
        arg_required_else_help = true
    )]
    Config {
        #[command(subcommand)]
        command: config_cmd::ConfigCommand,
    },

    #[command(
        about = "List locally synced tracks and their IDs",
        subcommand_required = true,
        arg_required_else_help = true,
        after_help = "Examples:
  tracker list recent
  tracker list top --limit 20
  tracker list unrated"
    )]
    List {
        #[command(subcommand)]
        command: list::ListCommand,
    },

    #[command(
        about = "Interactive first-run setup for Spotify, LLM, and pianist filters",
        after_help = "Examples:
  tracker onboarding
  tracker --config ~/custom-config.json onboarding"
    )]
    Onboarding,

    #[command(
        about = "Rate a locally synced track by ID",
        after_help = "Examples:
  tracker rate --track-id 12 --stars 5 --opinion \"Explosive and clear\"
  tracker rate --spotify-id 4uLU6hMCjMI75M1A2tKUQC --stars 4"
    )]
    Rate(rate::RateArgs),

    #[command(
        about = "Choose a local track interactively and rate it",
        after_help = "Examples:
  tracker rate-prompt
  tracker rate-prompt --unrated"
    )]
    RatePrompt(rate::RatePromptArgs),

    #[command(
        about = "Analyze favorites and generate pianist recommendations",
        subcommand_required = true,
        arg_required_else_help = true,
        after_help = "Examples:
  tracker recommend favorites
  tracker recommend profile
  tracker recommend summary
  tracker recommend pianists --limit 5"
    )]
    Recommend {
        #[command(subcommand)]
        command: recommend::RecommendCommand,
    },

    #[command(
        about = "Show details for a local track",
        after_help = "Examples:
  tracker show 12
  tracker --db ~/tmp/tracker.db show 7"
    )]
    Show(show::ShowArgs),

    #[command(
        about = "Authenticate with Spotify and inspect playback data",
        subcommand_required = true,
        arg_required_else_help = true,
        after_help = "Examples:
  tracker spotify login
  tracker spotify recent --limit 10"
    )]
    Spotify {
        #[command(subcommand)]
        command: spotify_cmd::SpotifyCommand,
    },

    #[command(
        about = "Sync recent Spotify plays into the local SQLite database",
        after_help = "Examples:
  tracker sync
  tracker sync --limit 25
  tracker sync status
  tracker --config ~/custom-config.json --db ~/custom-tracker.db sync"
    )]
    Sync(sync::SyncArgs),

    #[command(
        about = "Browse, sync, and rate tracks in a terminal UI",
        after_help = "Examples:
  tracker tui
  tracker --db ~/tmp/tracker.db tui"
    )]
    Tui,

    #[command(
        about = "Print build and version metadata",
        after_help = "Examples:
  tracker version
  tracker --version"
    )]
    Version,

    #[command(
        about = "Browse, sync, and rate tracks in a local web UI",
        after_help = "Examples:
  tracker web
  tracker web --port 9000 --no-open
  tracker --db ~/tmp/tracker.db web"
    )]
    Web(web_cmd::WebArgs),
}

/// Parses `args` (including the program name) and runs the selected command.
/// Help and version requests are written to `io.out` and succeed; every other
/// parse failure becomes a single-line error, like cobra's flag errors.
pub fn execute<I, T>(args: I, io: &mut Io<'_>, deps: &Deps) -> Result<()>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(err) => return handle_parse_error(&err, io),
    };
    let opts = &cli.opts;

    match cli.command {
        // The bare root command prints its full help, as cobra's RunE did.
        None => {
            write!(io.out, "{}", Cli::command().render_long_help())?;
            Ok(())
        }
        Some(Command::Config { command }) => config_cmd::run(command, opts, io),
        Some(Command::List { command }) => list::run(command, opts, io),
        Some(Command::Onboarding) => onboarding::run(opts, io, &deps.onboarding),
        Some(Command::Rate(args)) => rate::run_rate(&args, opts, io),
        Some(Command::RatePrompt(args)) => rate::run_rate_prompt(&args, opts, io),
        Some(Command::Recommend { command }) => recommend::run(command, opts, io),
        Some(Command::Show(args)) => show::run(&args, opts, io),
        Some(Command::Spotify { command }) => spotify_cmd::run(command, opts, io),
        Some(Command::Sync(args)) => sync::run(args, opts, io),
        Some(Command::Tui) => tui_cmd::run(opts),
        Some(Command::Version) => print_version(io),
        Some(Command::Web(args)) => web_cmd::run(&args, opts, io, &deps.web),
    }
}

fn handle_parse_error(err: &clap::Error, io: &mut Io<'_>) -> Result<()> {
    match err.kind() {
        ErrorKind::DisplayHelp | ErrorKind::DisplayVersion | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand => {
            write!(io.out, "{}", err.render())?;
            Ok(())
        }
        _ => Err(anyhow!(single_line_parse_error(err))),
    }
}

/// Reduces clap's multi-paragraph error (message, tips, usage, "For more
/// information...") to its first paragraph on one line.
fn single_line_parse_error(err: &clap::Error) -> String {
    let rendered = err.render().to_string();
    let head = rendered.split("\n\n").next().unwrap_or_default();
    let head = head.strip_prefix("error: ").unwrap_or(head);
    head.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>().join(" ")
}

fn print_version(io: &mut Io<'_>) -> Result<()> {
    writeln!(io.out, "tracker {}", buildinfo::VERSION)?;
    writeln!(io.out, "commit: {}", buildinfo::COMMIT)?;
    writeln!(io.out, "built:  {}", buildinfo::DATE)?;
    Ok(())
}

/// Standardizes the "we created a config, now go fill it in" messaging so
/// first-run failures stay actionable.
pub(crate) fn created_config_error(path: &Path, next_step: &str) -> anyhow::Error {
    anyhow!("created default config at {path:?}; {next_step}")
}

/// Checks everything sync-like commands need: a valid config plus a stored
/// Spotify token from `tracker spotify login`.
pub(crate) fn validate_sync_config(cfg: &Config, config_path: &Path) -> Result<()> {
    cfg.validate().with_context(|| format!("invalid config {config_path:?}"))?;
    cfg.spotify.validate_stored_token().with_context(|| format!("spotify login required for {config_path:?}"))?;
    Ok(())
}

/// Shared by commands that accept local numeric IDs, for a consistent
/// validation error shape.
pub(crate) fn parse_positive_i64(raw: &str, field: &str) -> Result<i64> {
    match raw.parse::<i64>() {
        Ok(value) if value >= 1 => Ok(value),
        _ => Err(anyhow!("{field} must be a positive integer, got {raw:?}")),
    }
}

/// Builds an authenticated Spotify client whose token refreshes are merged
/// into the config and saved back to `config_path`, so the next run reuses
/// them. The persister works on its own copy of the config because callers
/// keep reading theirs while the client is alive.
pub(crate) fn spotify_client(cfg: &Config, config_path: &Path) -> Result<tracker_spotify::Client> {
    tracker_spotify::Client::saving_to_config(cfg, config_path)
}

/// Writes `prompt` and flushes, since prompts have no trailing newline and
/// stdout is line-buffered.
pub(crate) fn write_prompt(out: &mut dyn Write, prompt: &str) -> Result<()> {
    out.write_all(prompt.as_bytes())?;
    out.flush()?;
    Ok(())
}

/// Reads one line, reporting whether input ended before a newline (Go's
/// `ReadString('\n')` returning `io.EOF`).
pub(crate) fn read_line(input: &mut dyn BufRead) -> std::io::Result<(String, bool)> {
    let mut line = String::new();
    input.read_line(&mut line)?;
    let eof = !line.ends_with('\n');
    Ok((line, eof))
}

#[cfg(test)]
pub(crate) mod testutil {
    use std::io::Cursor;
    use std::path::{Path, PathBuf};

    use anyhow::Result;
    use tracker_core::config::{self, Config, SpotifyConfig};

    use super::{Deps, Io, execute};

    /// Runs the CLI in-process with the given stdin, returning the result and
    /// everything written to stdout.
    pub fn run_with(args: &[&str], stdin: &str, deps: &Deps) -> (Result<()>, String) {
        let mut input = Cursor::new(stdin.as_bytes().to_vec());
        let mut out = Vec::new();
        let mut io = Io { input: &mut input, out: &mut out, out_is_terminal: false };
        let argv = std::iter::once("tracker").chain(args.iter().copied());
        let result = execute(argv, &mut io, deps);
        (result, String::from_utf8(out).expect("utf-8 output"))
    }

    pub fn run(args: &[&str]) -> (Result<()>, String) {
        run_with(args, "", &Deps::default())
    }

    pub fn temp_path(dir: &tempfile::TempDir, name: &str) -> PathBuf {
        dir.path().join(name)
    }

    pub fn path_str(path: &Path) -> &str {
        path.to_str().expect("utf-8 temp path")
    }

    pub fn save_config(path: &Path, allowlist: &[&str], blocklist: &[&str]) -> Config {
        let cfg = Config {
            spotify: SpotifyConfig {
                client_id: "client-id".into(),
                client_secret: "client-secret".into(),
                token: None,
            },
            pianists_allowlist: allowlist.iter().map(|s| s.to_string()).collect(),
            artists_blocklist: blocklist.iter().map(|s| s.to_string()).collect(),
            ..Config::default()
        };
        config::save(path, &cfg).expect("save config");
        cfg
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::run;
    use super::*;

    #[test]
    fn command_tree_is_well_formed() {
        Cli::command().debug_assert();
    }

    #[test]
    fn root_without_subcommand_prints_help() {
        let (result, out) = run(&[]);
        result.unwrap();
        assert!(out.contains("Track, rate, and explore classical piano listening history from Spotify."), "{out}");
        assert!(out.contains("Examples:\n  tracker onboarding"), "{out}");
    }

    #[test]
    fn version_flag_prints_cobra_template() {
        for flag in ["--version", "-v"] {
            let (result, out) = run(&[flag]);
            result.unwrap();
            assert_eq!(out, format!("tracker {}\n", buildinfo::VERSION));
        }
    }

    #[test]
    fn version_command_prints_build_metadata() {
        let (result, out) = run(&["version"]);
        result.unwrap();
        assert_eq!(
            out,
            format!("tracker {}\ncommit: {}\nbuilt:  {}\n", buildinfo::VERSION, buildinfo::COMMIT, buildinfo::DATE)
        );
    }

    #[test]
    fn parent_commands_without_subcommand_print_help() {
        for args in [&["config"][..], &["config", "allowlist"], &["list"], &["recommend"], &["spotify"]] {
            let (result, out) = run(args);
            result.unwrap();
            assert!(out.contains("Usage:"), "{args:?}: {out}");
        }
    }

    #[test]
    fn parse_errors_are_single_line() {
        let (result, _) = run(&["list", "recent", "--limit", "abc"]);
        let message = format!("{:#}", result.unwrap_err());
        assert!(!message.contains('\n'), "{message}");
        assert!(message.contains("--limit"), "{message}");
        assert!(!message.contains("Usage"), "{message}");

        let (result, _) = run(&["show"]);
        let message = format!("{:#}", result.unwrap_err());
        assert!(message.contains("track-id"), "{message}");
        assert!(!message.contains('\n'), "{message}");
    }

    #[test]
    fn negative_limits_reach_command_validation() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("tracker.db");
        let (result, _) = run(&["--db", db.to_str().unwrap(), "list", "recent", "--limit", "-1"]);
        assert_eq!(result.unwrap_err().to_string(), "limit must be at least 1, got -1");
    }

    #[test]
    fn parse_positive_i64_rejects_non_positive_values() {
        assert_eq!(parse_positive_i64("12", "track ID").unwrap(), 12);
        for raw in ["0", "-3", "abc", ""] {
            let err = parse_positive_i64(raw, "track ID").unwrap_err();
            assert_eq!(err.to_string(), format!("track ID must be a positive integer, got {raw:?}"));
        }
    }

    #[test]
    fn created_config_error_quotes_path() {
        let err = created_config_error(Path::new("/tmp/c.json"), "do the thing");
        assert_eq!(err.to_string(), "created default config at \"/tmp/c.json\"; do the thing");
    }
}
