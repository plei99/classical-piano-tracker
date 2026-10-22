//! `tracker spotify`: OAuth login and a raw view of recent plays.

use anyhow::{Context, Result};
use clap::{Args, Subcommand};
use tracker_core::config::{self, Token};
use tracker_spotify::DEFAULT_REDIRECT_URL;

use super::format::print_recent_spotify_tracks;
use super::{Io, RootOptions, created_config_error, spotify_client};

#[derive(Debug, Subcommand)]
pub(crate) enum SpotifyCommand {
    #[command(
        about = "Run the Spotify OAuth login flow and save the token",
        after_help = "Examples:
  tracker spotify login
  tracker --config ~/custom-config.json spotify login"
    )]
    Login,

    #[command(
        about = "Fetch the current user's recent Spotify plays",
        after_help = "Examples:
  tracker spotify recent
  tracker spotify recent --limit 10"
    )]
    Recent(RecentArgs),
}

#[derive(Debug, Args)]
pub(crate) struct RecentArgs {
    #[arg(
        long,
        default_value_t = 50,
        allow_negative_numbers = true,
        help = "maximum number of recent plays to fetch (1-50)"
    )]
    limit: i64,
}

pub(crate) fn run(command: SpotifyCommand, opts: &RootOptions, io: &mut Io<'_>) -> Result<()> {
    match command {
        SpotifyCommand::Login => login(opts, io),
        SpotifyCommand::Recent(args) => recent(args.limit, opts, io),
    }
}

fn login(opts: &RootOptions, io: &mut Io<'_>) -> Result<()> {
    let config_path = opts.resolve_config_path()?;
    let (mut cfg, created) = config::ensure_loaded(&config_path)?;
    if created {
        return Err(created_config_error(
            &config_path,
            &format!(
                "set spotify.client_id and spotify.client_secret, then rerun `tracker --config {config_path:?} spotify login`"
            ),
        ));
    }

    let out = &mut *io.out;
    let token = tracker_spotify::login(&cfg.spotify, &mut |url: &str| {
        write!(
            out,
            "Open this URL in your browser:\n{url}\n\nWaiting for the Spotify callback at {DEFAULT_REDIRECT_URL}\n"
        )?;
        out.flush()?;
        Ok(())
    })?;

    cfg.spotify.token = Some(Token::merged(token, cfg.spotify.token.as_ref()));
    config::save(&config_path, &cfg).with_context(|| format!("save Spotify token to {config_path:?}"))?;

    writeln!(io.out, "spotify login succeeded: token saved to {}", config_path.display())?;
    Ok(())
}

fn recent(limit: i64, opts: &RootOptions, io: &mut Io<'_>) -> Result<()> {
    let config_path = opts.resolve_config_path()?;
    let (cfg, created) = config::ensure_loaded(&config_path)?;
    if created {
        return Err(created_config_error(
            &config_path,
            &format!(
                "set spotify.client_id and spotify.client_secret, run `tracker --config {config_path:?} spotify login`, then rerun this command"
            ),
        ));
    }

    let client = spotify_client(&cfg, &config_path)?;
    let tracks = client.recent_tracks(recent_track_limit(limit)?)?;
    if tracks.is_empty() {
        writeln!(io.out, "no recent Spotify plays returned")?;
        return Ok(());
    }
    print_recent_spotify_tracks(io.out, &tracks)?;
    Ok(())
}

/// The client takes an unsigned limit; negative values get the same message
/// the Go client used for out-of-range limits.
pub(crate) fn recent_track_limit(limit: i64) -> Result<usize> {
    usize::try_from(limit).map_err(|_| anyhow::anyhow!("recent track limit must be between 1 and 50, got {limit}"))
}

#[cfg(test)]
mod tests {
    use super::super::testutil::{path_str, run, temp_path};
    use super::*;

    #[test]
    fn spotify_commands_create_config_and_explain_next_steps() {
        for (command, next) in [
            ("login", "set spotify.client_id and spotify.client_secret, then rerun `tracker --config"),
            ("recent", "set spotify.client_id and spotify.client_secret, run `tracker --config"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let config_path = temp_path(&dir, "config.json");
            let (result, _) = run(&["--config", path_str(&config_path), "spotify", command]);
            let message = result.unwrap_err().to_string();
            assert!(message.starts_with(&format!("created default config at {config_path:?}; {next}")), "{message}");
            assert!(config_path.exists());
        }
    }

    #[test]
    fn negative_recent_limits_are_rejected() {
        assert_eq!(recent_track_limit(25).unwrap(), 25);
        assert_eq!(
            recent_track_limit(-1).unwrap_err().to_string(),
            "recent track limit must be between 1 and 50, got -1"
        );
    }
}
