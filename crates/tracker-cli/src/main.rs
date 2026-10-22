//! `tracker`: track and rate classical piano listening history from Spotify.
//!
//! The entrypoint is intentionally thin: all command wiring lives in
//! [`cli`] so it can be driven in tests with in-memory streams.

mod buildinfo;
mod cli;

use std::io::IsTerminal;
use std::process::ExitCode;

fn main() -> ExitCode {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut stdout = std::io::stdout();
    let out_is_terminal = stdout.is_terminal();
    let mut io = cli::Io { input: &mut input, out: &mut stdout, out_is_terminal };

    match cli::execute(std::env::args_os(), &mut io, &cli::Deps::default()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            // Like the Go build (cobra with SilenceUsage/SilenceErrors), print
            // only the error chain on one line, with no usage noise.
            eprintln!("{err:#}");
            ExitCode::FAILURE
        }
    }
}
