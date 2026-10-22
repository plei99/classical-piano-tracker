//! `tracker config`: inspect, validate, and edit the artist filters.

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Subcommand;
use tracker_core::config::{self, Config};

use super::{Io, RootOptions, created_config_error};

#[derive(Debug, Subcommand)]
pub(crate) enum ConfigCommand {
    #[command(
        about = "Inspect and edit pianists_allowlist entries",
        subcommand_required = true,
        arg_required_else_help = true
    )]
    Allowlist {
        #[command(subcommand)]
        command: AllowlistCommand,
    },

    #[command(
        about = "Inspect and edit artists_blocklist entries",
        subcommand_required = true,
        arg_required_else_help = true
    )]
    Blocklist {
        #[command(subcommand)]
        command: BlocklistCommand,
    },

    #[command(about = "Print the config file path")]
    Path,

    #[command(about = "Validate the config file")]
    Validate,
}

// The allowlist and blocklist trees are identical apart from their help text.
#[derive(Debug, Subcommand)]
pub(crate) enum AllowlistCommand {
    #[command(about = "Add an artist to pianists_allowlist")]
    Add {
        #[arg(value_name = "artist")]
        artist: String,
    },
    #[command(about = "Print pianists_allowlist entries")]
    List,
    #[command(about = "Remove an artist from pianists_allowlist")]
    Remove {
        #[arg(value_name = "artist")]
        artist: String,
    },
}

#[derive(Debug, Subcommand)]
pub(crate) enum BlocklistCommand {
    #[command(about = "Add an artist to artists_blocklist")]
    Add {
        #[arg(value_name = "artist")]
        artist: String,
    },
    #[command(about = "Print artists_blocklist entries")]
    List,
    #[command(about = "Remove an artist from artists_blocklist")]
    Remove {
        #[arg(value_name = "artist")]
        artist: String,
    },
}

#[derive(Debug, Clone, Copy)]
enum ArtistList {
    Allowlist,
    Blocklist,
}

impl ArtistList {
    fn entries_mut(self, cfg: &mut Config) -> &mut Vec<String> {
        match self {
            ArtistList::Allowlist => &mut cfg.pianists_allowlist,
            ArtistList::Blocklist => &mut cfg.artists_blocklist,
        }
    }
}

enum ArtistAction {
    List,
    Add(String),
    Remove(String),
}

impl From<AllowlistCommand> for ArtistAction {
    fn from(command: AllowlistCommand) -> Self {
        match command {
            AllowlistCommand::Add { artist } => ArtistAction::Add(artist),
            AllowlistCommand::List => ArtistAction::List,
            AllowlistCommand::Remove { artist } => ArtistAction::Remove(artist),
        }
    }
}

impl From<BlocklistCommand> for ArtistAction {
    fn from(command: BlocklistCommand) -> Self {
        match command {
            BlocklistCommand::Add { artist } => ArtistAction::Add(artist),
            BlocklistCommand::List => ArtistAction::List,
            BlocklistCommand::Remove { artist } => ArtistAction::Remove(artist),
        }
    }
}

pub(crate) fn run(command: ConfigCommand, opts: &RootOptions, io: &mut Io<'_>) -> Result<()> {
    match command {
        ConfigCommand::Allowlist { command } => run_artist_action(ArtistList::Allowlist, command.into(), opts, io),
        ConfigCommand::Blocklist { command } => run_artist_action(ArtistList::Blocklist, command.into(), opts, io),
        ConfigCommand::Path => {
            writeln!(io.out, "{}", opts.resolve_config_path()?.display())?;
            Ok(())
        }
        ConfigCommand::Validate => validate(opts, io),
    }
}

/// Edits go through `ensure_loaded`, so curating filters works before the
/// rest of the config has been filled in.
fn load_editable_config(opts: &RootOptions) -> Result<(Config, PathBuf, bool)> {
    let path = opts.resolve_config_path()?;
    let (cfg, created) = config::ensure_loaded(&path)?;
    Ok((cfg, path, created))
}

fn run_artist_action(list: ArtistList, action: ArtistAction, opts: &RootOptions, io: &mut Io<'_>) -> Result<()> {
    let (mut cfg, path, created) = load_editable_config(opts)?;

    let (artist, changed, done, unchanged) = match action {
        ArtistAction::List => {
            let entries = list.entries_mut(&mut cfg);
            if entries.is_empty() {
                writeln!(io.out, "no entries")?;
            }
            for (idx, entry) in entries.iter().enumerate() {
                writeln!(io.out, "{}. {entry}", idx + 1)?;
            }
            return Ok(());
        }
        ArtistAction::Add(artist) => {
            let artist = artist.trim().to_string();
            let entries = list.entries_mut(&mut cfg);
            let (updated, added) = config::add_artist(entries, &artist)?;
            *entries = updated;
            (artist, added, "added", "is already present")
        }
        ArtistAction::Remove(artist) => {
            let artist = artist.trim().to_string();
            let entries = list.entries_mut(&mut cfg);
            let (updated, removed) = config::remove_artist(entries, &artist)?;
            *entries = updated;
            (artist, removed, "removed", "was not present")
        }
    };

    config::save(&path, &cfg).with_context(|| format!("save config {path:?}"))?;

    if created {
        writeln!(io.out, "created default config at {}", path.display())?;
    }
    if changed {
        writeln!(io.out, "{done} {artist:?}")?;
    } else {
        writeln!(io.out, "{artist:?} {unchanged}")?;
    }
    Ok(())
}

fn validate(opts: &RootOptions, io: &mut Io<'_>) -> Result<()> {
    let path = opts.resolve_config_path()?;
    let (cfg, created) = config::ensure_loaded(&path)?;

    if let Err(err) = cfg.validate() {
        if created {
            return Err(created_config_error(
                &path,
                &format!("fill the required values, then rerun `tracker --config {path:?} config validate`: {err}"),
            ));
        }
        return Err(anyhow::Error::new(err).context(format!("invalid config {path:?}")));
    }

    writeln!(io.out, "config is valid: {}", path.display())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use tracker_core::config;

    use super::super::testutil::{path_str, run, save_config, temp_path};

    #[test]
    fn config_allowlist_add_updates_config_file() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = temp_path(&dir, "config.json");
        save_config(&config_path, &["Martha Argerich"], &[]);

        let (result, out) = run(&["--config", path_str(&config_path), "config", "allowlist", "add", "Daniil Trifonov"]);
        result.unwrap();
        assert!(out.contains(r#"added "Daniil Trifonov""#), "output = {out:?}, want add confirmation");

        let updated = config::load(&config_path).unwrap();
        assert!(updated.pianists_allowlist.iter().any(|a| a == "Daniil Trifonov"), "{:?}", updated.pianists_allowlist);
    }

    #[test]
    fn config_blocklist_remove_persists_change() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = temp_path(&dir, "config.json");
        save_config(&config_path, &["Martha Argerich"], &["Yiruma"]);

        let (result, out) = run(&["--config", path_str(&config_path), "config", "blocklist", "remove", "yiruma"]);
        result.unwrap();
        assert!(out.contains(r#"removed "yiruma""#), "output = {out:?}, want remove confirmation");

        let updated = config::load(&config_path).unwrap();
        assert!(!updated.artists_blocklist.iter().any(|a| a == "Yiruma"), "{:?}", updated.artists_blocklist);
    }

    #[test]
    fn config_allowlist_list_prints_entries() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = temp_path(&dir, "config.json");
        save_config(&config_path, &["Martha Argerich", "Daniil Trifonov"], &[]);

        let (result, out) = run(&["--config", path_str(&config_path), "config", "allowlist", "list"]);
        result.unwrap();
        for want in ["1. Martha Argerich", "2. Daniil Trifonov"] {
            assert!(out.contains(want), "output = {out:?}, want {want:?}");
        }
    }

    #[test]
    fn config_edits_report_unchanged_and_created() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = temp_path(&dir, "nested/config.json");
        let (result, out) = run(&["--config", path_str(&config_path), "config", "blocklist", "add", " Yiruma "]);
        result.unwrap();
        assert_eq!(out, format!("created default config at {}\nadded \"Yiruma\"\n", config_path.display()));

        let (result, out) = run(&["--config", path_str(&config_path), "config", "blocklist", "add", "yiruma"]);
        result.unwrap();
        assert_eq!(out, "\"yiruma\" is already present\n");

        let (result, out) = run(&["--config", path_str(&config_path), "config", "allowlist", "remove", "Nobody"]);
        result.unwrap();
        assert_eq!(out, "\"Nobody\" was not present\n");

        let (result, _) = run(&["--config", path_str(&config_path), "config", "allowlist", "add", "  "]);
        assert_eq!(result.unwrap_err().to_string(), "artist name must not be blank");
    }

    #[test]
    fn config_path_and_validate() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = temp_path(&dir, "config.json");

        let (result, out) = run(&["--config", path_str(&config_path), "config", "path"]);
        result.unwrap();
        assert_eq!(out, format!("{}\n", config_path.display()));

        let (result, _) = run(&["--config", path_str(&config_path), "config", "validate"]);
        let message = format!("{:#}", result.unwrap_err());
        assert!(message.starts_with(&format!("created default config at {config_path:?}; fill the required values")));
        assert!(message.contains("spotify.client_id is required"), "{message}");

        let (result, _) = run(&["--config", path_str(&config_path), "config", "validate"]);
        let message = format!("{:#}", result.unwrap_err());
        assert!(message.starts_with(&format!("invalid config {config_path:?}: spotify.client_id")), "{message}");

        save_config(&config_path, &["Martha Argerich"], &[]);
        let (result, out) = run(&["--config", path_str(&config_path), "config", "validate"]);
        result.unwrap();
        assert_eq!(out, format!("config is valid: {}\n", config_path.display()));
    }
}
