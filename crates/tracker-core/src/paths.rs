//! Platform-specific locations for the database and config file. These must
//! match the Go build so both binaries share one set of state.

use std::env;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

pub const APP_DIR_NAME: &str = "piano-tracker";
const DATABASE_NAME: &str = "tracker.db";
const CONFIG_NAME: &str = "config.json";

fn home_dir() -> Result<PathBuf> {
    env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .context("resolve user home directory: $HOME is not defined")
}

fn lookup(key: &str) -> Option<String> {
    env::var(key).ok().filter(|value| !value.is_empty())
}

/// The platform-appropriate application data directory.
pub fn default_data_dir() -> Result<PathBuf> {
    Ok(data_dir_for_os(env::consts::OS, &home_dir()?, lookup))
}

/// The default SQLite database path.
pub fn default_db_path() -> Result<PathBuf> {
    Ok(default_data_dir()?.join(DATABASE_NAME))
}

/// Mirrors Go's `os.UserConfigDir`, which the Go build used for the config path.
pub fn user_config_dir() -> Result<PathBuf> {
    Ok(config_dir_for_os(env::consts::OS, &home_dir()?, lookup))
}

/// The config path under a given config root.
pub fn config_path_from_config_dir(config_dir: &Path) -> PathBuf {
    config_dir.join(APP_DIR_NAME).join(CONFIG_NAME)
}

/// The default config path under the user's config directory.
pub fn default_config_path() -> Result<PathBuf> {
    Ok(config_path_from_config_dir(&user_config_dir()?))
}

/// Split out for testability and to keep platform path policy in one place.
pub fn data_dir_for_os(os: &str, home: &Path, lookup: impl Fn(&str) -> Option<String>) -> PathBuf {
    match os {
        "macos" => home.join("Library").join("Application Support").join(APP_DIR_NAME),
        "windows" => lookup("LOCALAPPDATA")
            .or_else(|| lookup("APPDATA"))
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"))
            .join(APP_DIR_NAME),
        _ => lookup("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local").join("share"))
            .join(APP_DIR_NAME),
    }
}

fn config_dir_for_os(os: &str, home: &Path, lookup: impl Fn(&str) -> Option<String>) -> PathBuf {
    match os {
        "macos" => home.join("Library").join("Application Support"),
        "windows" => lookup("APPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData").join("Roaming")),
        _ => lookup("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |key| pairs.iter().find(|(k, _)| *k == key).map(|(_, v)| v.to_string())
    }

    #[test]
    fn data_dir_for_each_os() {
        let home = Path::new("/home/test");
        type Case = (&'static str, &'static [(&'static str, &'static str)], PathBuf);
        let cases: &[Case] = &[
            ("macos", &[], home.join("Library/Application Support/piano-tracker")),
            ("linux", &[("XDG_DATA_HOME", "/xdg/data")], PathBuf::from("/xdg/data/piano-tracker")),
            ("linux", &[], home.join(".local/share/piano-tracker")),
            ("windows", &[("LOCALAPPDATA", "C:/Local")], PathBuf::from("C:/Local/piano-tracker")),
            ("windows", &[("APPDATA", "C:/Roaming")], PathBuf::from("C:/Roaming/piano-tracker")),
            ("windows", &[], home.join("AppData/Local/piano-tracker")),
        ];
        for (os, env, want) in cases {
            assert_eq!(&data_dir_for_os(os, home, env_of(env)), want, "os={os} env={env:?}");
        }
    }

    #[test]
    fn config_path_layout() {
        assert_eq!(
            config_path_from_config_dir(Path::new("/tmp/config-home")),
            PathBuf::from("/tmp/config-home/piano-tracker/config.json")
        );
    }
}
