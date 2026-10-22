//! The JSON config file. The on-disk format is shared with the Go build, so
//! field names, aliases, and omission rules must stay byte-compatible.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result, anyhow, bail};
use jiff::Timestamp;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub const DEFAULT_LLM_PROFILE_NAME: &str = "openai";
pub const DEFAULT_LLM_PROVIDER: &str = "openai";
pub const DEFAULT_LLM_MODEL: &str = "gpt-5.4";

pub const DEFAULT_PIANISTS_ALLOWLIST: &[&str] = &[
    "Martha Argerich",
    "Vladimir Horowitz",
    "Arthur Rubinstein",
    "Sviatoslav Richter",
    "Emil Gilels",
    "Glenn Gould",
    "Alfred Brendel",
    "Maurizio Pollini",
    "Krystian Zimerman",
    "Evgeny Kissin",
    "Daniil Trifonov",
    "Murray Perahia",
    "Maria Joao Pires",
    "Piotr Anderszewski",
    "Radu Lupu",
    "Claudio Arrau",
    "Wilhelm Kempff",
    "Arturo Benedetti Michelangeli",
    "Alfred Cortot",
    "Dinu Lipatti",
    "Josef Hofmann",
    "Ignaz Friedman",
    "Benno Moiseiwitsch",
    "Walter Gieseking",
    "Myra Hess",
    "Annie Fischer",
    "Alicia de Larrocha",
    "Clara Haskil",
    "Leon Fleisher",
    "Van Cliburn",
    "Byron Janis",
    "Earl Wild",
    "Garrick Ohlsson",
    "Jorge Bolet",
    "Gyorgy Cziffra",
    "Grigory Sokolov",
    "Arcadi Volodos",
    "Nikolai Lugansky",
    "Leif Ove Andsnes",
    "Mitsuko Uchida",
    "Andras Schiff",
    "Stephen Hough",
    "Marc-Andre Hamelin",
    "Igor Levit",
    "Yuja Wang",
    "Seong-Jin Cho",
    "Yunchan Lim",
    "Beatrice Rana",
    "Alexandre Kantorow",
    "Jan Lisiecki",
    "Boris Berezovsky",
    "Denis Matsuev",
    "Paul Lewis",
    "Pierre-Laurent Aimard",
    "Lars Vogt",
    "Jean-Efflam Bavouzet",
    "Wilhelm Backhaus",
    "Samson Francois",
    "Arthur Schnabel",
    "Edwin Fischer",
    "Geza Anda",
    "Lazar Berman",
    "Shura Cherkassky",
    "Josef Lhevinne",
    "Nelson Freire",
    "Nelson Goerner",
    "Angela Hewitt",
    "Behzod Abduraimov",
    "Kirill Gerstein",
    "Emanuel Ax",
    "Barry Douglas",
    "Menahem Pressler",
    "Idil Biret",
    "Fou Ts'ong",
    "Abbey Simon",
    "Pascal Roge",
    "Vladimir Ashkenazy",
    "Yefim Bronfman",
    "Víkingur Ólafsson",
    "Stephen Kovacevich",
    "Lang Lang",
    "Khatia Buniatishvili",
    "Alice Sara Ott",
    "Ivo Pogorelich",
];

/// Local application state and curation filters.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Config {
    pub spotify: SpotifyConfig,
    pub llm: LlmConfig,
    /// Legacy single-key block; only written back when it still holds a key.
    pub openai: OpenAiConfig,
    pub pianists_allowlist: Vec<String>,
    pub artists_blocklist: Vec<String>,
}

/// Spotify credentials and OAuth token state.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct SpotifyConfig {
    pub client_id: String,
    pub client_secret: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<Token>,
}

/// Optional legacy OpenAI settings.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct OpenAiConfig {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub api_key: String,
}

/// Provider-agnostic recommendation settings.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct LlmConfig {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub active_profile: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub profiles: BTreeMap<String, LlmProfile>,
}

/// Settings for one named LLM provider profile.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LlmProfile {
    pub provider: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub model: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub api_key: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub base_url: String,
    /// Executable used by the codex and claude_cli providers. Empty means
    /// resolve the default command from PATH at runtime.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub command: String,
}

/// Persisted OAuth token state.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct Token {
    pub access_token: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub refresh_token: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub token_type: String,
    /// `None` is Go's zero time, which Go writes as `0001-01-01T00:00:00Z`.
    #[serde(with = "go_time")]
    pub expiry: Option<Timestamp>,
}

/// One or more config validation failures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError {
    pub problems: Vec<String>,
}

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.problems.join("; "))
    }
}

impl std::error::Error for ValidationError {}

fn validation_result(problems: Vec<String>) -> Result<(), ValidationError> {
    if problems.is_empty() { Ok(()) } else { Err(ValidationError { problems }) }
}

// Hand-edited configs sometimes use api-key/base-url; accept both spellings
// on read and always write the canonical underscore names.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, default)]
#[derive(Default)]
struct LlmProfileJson {
    provider: String,
    model: String,
    api_key: String,
    #[serde(rename = "api-key")]
    api_key_alt: String,
    base_url: String,
    #[serde(rename = "base-url")]
    base_url_alt: String,
    command: String,
}

impl<'de> Deserialize<'de> for LlmProfile {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = LlmProfileJson::deserialize(deserializer)?;
        Ok(LlmProfile {
            provider: raw.provider.trim().to_string(),
            model: raw.model.trim().to_string(),
            api_key: first_non_empty(&[&raw.api_key, &raw.api_key_alt]).trim().to_string(),
            base_url: first_non_empty(&[&raw.base_url, &raw.base_url_alt]).trim().to_string(),
            command: raw.command.trim().to_string(),
        })
    }
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields, default)]
struct OpenAiConfigJson {
    api_key: String,
    #[serde(rename = "api-key")]
    api_key_alt: String,
}

impl<'de> Deserialize<'de> for OpenAiConfig {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = OpenAiConfigJson::deserialize(deserializer)?;
        Ok(OpenAiConfig { api_key: first_non_empty(&[&raw.api_key, &raw.api_key_alt]).trim().to_string() })
    }
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields, default)]
struct ConfigJsonIn {
    spotify: SpotifyConfig,
    llm: Option<LlmConfig>,
    openai: Option<OpenAiConfig>,
    pianists_allowlist: Option<Vec<String>>,
    artists_blocklist: Option<Vec<String>>,
}

impl<'de> Deserialize<'de> for Config {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = ConfigJsonIn::deserialize(deserializer)?;
        Ok(Config {
            spotify: raw.spotify,
            llm: raw.llm.unwrap_or_default(),
            openai: raw.openai.unwrap_or_default(),
            pianists_allowlist: raw.pianists_allowlist.unwrap_or_default(),
            artists_blocklist: raw.artists_blocklist.unwrap_or_default(),
        })
    }
}

#[derive(Serialize)]
struct ConfigJsonOut<'a> {
    spotify: &'a SpotifyConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    llm: Option<&'a LlmConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    openai: Option<&'a OpenAiConfig>,
    pianists_allowlist: &'a [String],
    artists_blocklist: &'a [String],
}

impl Serialize for Config {
    /// Omits the llm block when empty and the legacy openai block unless it
    /// actually holds a key.
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let has_llm = !self.llm.active_profile.is_empty() || !self.llm.profiles.is_empty();
        ConfigJsonOut {
            spotify: &self.spotify,
            llm: has_llm.then_some(&self.llm),
            openai: (!self.openai.api_key.trim().is_empty()).then_some(&self.openai),
            pianists_allowlist: &self.pianists_allowlist,
            artists_blocklist: &self.artists_blocklist,
        }
        .serialize(serializer)
    }
}

mod go_time {
    use jiff::Timestamp;
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    const ZERO: &str = "0001-01-01T00:00:00Z";

    pub fn serialize<S: Serializer>(value: &Option<Timestamp>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(ts) => serializer.collect_str(ts),
            None => serializer.serialize_str(ZERO),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Timestamp>, D::Error> {
        let raw = String::deserialize(deserializer)?;
        let ts: Timestamp = raw.parse().map_err(D::Error::custom)?;
        Ok((ts != ZERO.parse::<Timestamp>().expect("valid zero time")).then_some(ts))
    }
}

impl Config {
    /// The first-run config template written when no file exists yet.
    pub fn default_template() -> Config {
        Config {
            spotify: SpotifyConfig::default(),
            llm: LlmConfig::default_template(),
            openai: OpenAiConfig::default(),
            pianists_allowlist: default_pianists_allowlist(),
            artists_blocklist: Vec::new(),
        }
    }

    /// The active provider-agnostic config, synthesizing an OpenAI profile
    /// from the legacy openai block when no profiles exist.
    pub fn effective_llm_config(&self) -> LlmConfig {
        if !self.llm.profiles.is_empty() {
            return self.llm.clone();
        }
        let mut cfg = LlmConfig::default_template();
        let legacy_key = self.openai.api_key.trim();
        if !legacy_key.is_empty()
            && let Some(profile) = cfg.profiles.get_mut(DEFAULT_LLM_PROFILE_NAME)
        {
            profile.api_key = legacy_key.to_string();
        }
        cfg
    }

    /// Stores the key on the default OpenAI profile and clears the legacy block.
    pub fn set_default_llm_api_key(&mut self, api_key: &str) {
        let mut cfg = self.effective_llm_config();
        let profile = cfg.profiles.entry(DEFAULT_LLM_PROFILE_NAME.to_string()).or_default();
        profile.provider = DEFAULT_LLM_PROVIDER.to_string();
        if profile.model.trim().is_empty() {
            profile.model = DEFAULT_LLM_MODEL.to_string();
        }
        profile.api_key = api_key.trim().to_string();
        cfg.active_profile = DEFAULT_LLM_PROFILE_NAME.to_string();
        self.llm = cfg;
        self.openai = OpenAiConfig::default();
    }

    /// Stores one LLM profile and marks it active.
    pub fn set_llm_profile(&mut self, name: &str, profile: LlmProfile) {
        let name = name.trim();
        if name.is_empty() {
            return;
        }
        let mut cfg = self.effective_llm_config();
        cfg.active_profile = name.to_string();
        cfg.profiles.insert(name.to_string(), profile);
        self.llm = cfg;
        self.openai = OpenAiConfig::default();
    }

    /// Checks required config values.
    pub fn validate(&self) -> Result<(), ValidationError> {
        let mut problems = Vec::new();
        if self.spotify.client_id.trim().is_empty() {
            problems.push("spotify.client_id is required".to_string());
        }
        if self.spotify.client_secret.trim().is_empty() {
            problems.push("spotify.client_secret is required".to_string());
        }
        if self.pianists_allowlist.is_empty() {
            problems.push("pianists_allowlist must contain at least one artist".to_string());
        }
        problems.extend(validate_artists("pianists_allowlist", &self.pianists_allowlist));
        problems.extend(validate_artists("artists_blocklist", &self.artists_blocklist));
        problems.extend(self.effective_llm_config().validate());
        if let Some(token) = &self.spotify.token {
            if token.access_token.trim().is_empty() {
                problems.push("spotify.token.access_token is required when spotify.token is present".to_string());
            }
            if token.expiry.is_none() {
                problems.push("spotify.token.expiry is required when spotify.token is present".to_string());
            }
        }
        validation_result(problems)
    }
}

impl LlmConfig {
    /// The default provider-agnostic LLM config template.
    pub fn default_template() -> LlmConfig {
        LlmConfig {
            active_profile: DEFAULT_LLM_PROFILE_NAME.to_string(),
            profiles: BTreeMap::from([(
                DEFAULT_LLM_PROFILE_NAME.to_string(),
                LlmProfile {
                    provider: DEFAULT_LLM_PROVIDER.to_string(),
                    model: DEFAULT_LLM_MODEL.to_string(),
                    ..LlmProfile::default()
                },
            )]),
        }
    }

    fn validate(&self) -> Vec<String> {
        let mut problems = Vec::new();
        if self.active_profile.is_empty() && self.profiles.is_empty() {
            return problems;
        }
        if self.active_profile.trim().is_empty() {
            problems.push("llm.active_profile is required when llm.profiles is configured".to_string());
            return problems;
        }
        let Some(profile) = self.profiles.get(&self.active_profile) else {
            problems.push(format!("llm.active_profile {:?} was not found in llm.profiles", self.active_profile));
            return problems;
        };
        if profile.provider.trim().is_empty() {
            problems.push(format!("llm.profiles.{}.provider is required", self.active_profile));
        }
        // CLI-backed profiles can defer model selection to the installed CLI.
        let provider = profile.provider.trim().to_lowercase();
        if profile.model.trim().is_empty() && provider != "codex" && provider != "claude_cli" {
            problems.push(format!("llm.profiles.{}.model is required", self.active_profile));
        }
        for (name, profile) in &self.profiles {
            if name.trim().is_empty() {
                problems.push("llm.profiles must not contain blank profile names".to_string());
                continue;
            }
            if profile.provider.trim().is_empty() {
                problems.push(format!("llm.profiles.{name}.provider is required"));
            }
        }
        problems
    }
}

impl SpotifyConfig {
    /// Checks only the credentials required to start OAuth.
    pub fn validate_client_credentials(&self) -> Result<(), ValidationError> {
        let mut problems = Vec::new();
        if self.client_id.trim().is_empty() {
            problems.push("spotify.client_id is required".to_string());
        }
        if self.client_secret.trim().is_empty() {
            problems.push("spotify.client_secret is required".to_string());
        }
        validation_result(problems)
    }

    /// Checks the persisted token fields needed to create an authenticated client.
    pub fn validate_stored_token(&self) -> Result<(), ValidationError> {
        let Some(token) = &self.token else {
            return validation_result(vec!["spotify.token is required".to_string()]);
        };
        let mut problems = Vec::new();
        if token.access_token.trim().is_empty() {
            problems.push("spotify.token.access_token is required".to_string());
        }
        if token.expiry.is_none() {
            problems.push("spotify.token.expiry is required".to_string());
        }
        validation_result(problems)
    }
}

impl Token {
    /// Merges a freshly issued token into the persisted one. When the new
    /// token omits refresh data, the previous values are retained.
    pub fn merged(new: Token, previous: Option<&Token>) -> Token {
        let Some(previous) = previous else { return new };
        Token {
            refresh_token: if new.refresh_token.is_empty() {
                previous.refresh_token.clone()
            } else {
                new.refresh_token
            },
            token_type: if new.token_type.is_empty() { previous.token_type.clone() } else { new.token_type },
            expiry: new.expiry.or(previous.expiry),
            access_token: new.access_token,
        }
    }
}

/// A copy of the built-in pianist seed list.
pub fn default_pianists_allowlist() -> Vec<String> {
    DEFAULT_PIANISTS_ALLOWLIST.iter().map(|name| name.to_string()).collect()
}

/// Creates a default config file when one does not already exist. Reports
/// whether a new file was created.
pub fn ensure(path: &Path) -> Result<bool> {
    match fs::metadata(path) {
        Ok(_) => Ok(false),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            save(path, &Config::default_template()).with_context(|| format!("create default config {path:?}"))?;
            Ok(true)
        }
        Err(err) => Err(anyhow!(err).context(format!("stat config {path:?}"))),
    }
}

/// Reads and decodes a config file from disk.
pub fn load(path: &Path) -> Result<Config> {
    let data = match fs::read(path) {
        Ok(data) => data,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => bail!(
            "config file not found at {path:?}; create it manually for now, or use --config to point to an existing file: {err}"
        ),
        Err(err) => return Err(anyhow!(err).context(format!("read config {path:?}"))),
    };
    serde_json::from_slice(&data).with_context(|| format!("decode config {path:?}"))
}

/// Reads a config file and validates its required fields.
pub fn load_and_validate(path: &Path) -> Result<Config> {
    let cfg = load(path)?;
    cfg.validate().with_context(|| format!("invalid config {path:?}"))?;
    Ok(cfg)
}

/// Loads the config, first writing the default template if the file is
/// missing. Reports whether the template was just created.
pub fn ensure_loaded(path: &Path) -> Result<(Config, bool)> {
    let created = ensure(path)?;
    Ok((load(path)?, created))
}

/// Writes the config with an atomic replace and owner-only permissions.
pub fn save(path: &Path, cfg: &Config) -> Result<()> {
    let dir = path.parent().filter(|dir| !dir.as_os_str().is_empty()).unwrap_or(Path::new("."));
    create_private_dir(dir).with_context(|| format!("create config directory {dir:?}"))?;

    let mut data = serde_json::to_vec_pretty(cfg).with_context(|| format!("encode config {path:?}"))?;
    data.push(b'\n');

    let temp_path = dir.join(format!(".config-{}-{}.json", std::process::id(), Timestamp::now().as_nanosecond()));
    let result = (|| -> Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&temp_path).with_context(|| format!("create temporary config file in {dir:?}"))?;
        file.write_all(&data).with_context(|| format!("write temporary config file {temp_path:?}"))?;
        file.sync_all().with_context(|| format!("flush temporary config file {temp_path:?}"))?;
        fs::rename(&temp_path, path).with_context(|| format!("replace config file {path:?}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)
}

fn validate_artists(field: &str, artists: &[String]) -> Vec<String> {
    artists
        .iter()
        .enumerate()
        .filter(|(_, artist)| artist.trim().is_empty())
        .map(|(idx, _)| format!("{field}[{idx}] must not be blank"))
        .collect()
}

fn first_non_empty<'a>(values: &[&'a str]) -> &'a str {
    values.iter().copied().find(|value| !value.trim().is_empty()).unwrap_or("")
}

/// Appends an artist unless already present (case-insensitive, whitespace
/// tolerant). Reports whether it was added.
pub fn add_artist(artists: &[String], artist: &str) -> Result<(Vec<String>, bool)> {
    let trimmed = artist.trim();
    if trimmed.is_empty() {
        bail!("artist name must not be blank");
    }
    let normalized = normalize_artist_name(trimmed);
    let mut updated = artists.to_vec();
    if artists.iter().any(|existing| normalize_artist_name(existing) == normalized) {
        return Ok((updated, false));
    }
    updated.push(trimmed.to_string());
    Ok((updated, true))
}

/// Removes all matching artists (case-insensitive, whitespace tolerant).
/// Reports whether anything was removed.
pub fn remove_artist(artists: &[String], artist: &str) -> Result<(Vec<String>, bool)> {
    let trimmed = artist.trim();
    if trimmed.is_empty() {
        bail!("artist name must not be blank");
    }
    let normalized = normalize_artist_name(trimmed);
    let updated: Vec<String> =
        artists.iter().filter(|existing| normalize_artist_name(existing) != normalized).cloned().collect();
    let removed = updated.len() != artists.len();
    Ok((updated, removed))
}

fn normalize_artist_name(name: &str) -> String {
    name.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_config_path() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("piano-tracker").join("config.json");
        (dir, path)
    }

    fn sample_config() -> Config {
        Config {
            spotify: SpotifyConfig {
                client_id: "client-id".into(),
                client_secret: "client-secret".into(),
                token: Some(Token {
                    access_token: "access-token".into(),
                    refresh_token: "refresh-token".into(),
                    token_type: "Bearer".into(),
                    expiry: Some("2026-03-31T12:00:00Z".parse().unwrap()),
                }),
            },
            llm: LlmConfig {
                active_profile: "openai".into(),
                profiles: BTreeMap::from([(
                    "openai".into(),
                    LlmProfile {
                        provider: "openai".into(),
                        model: "gpt-5.4".into(),
                        api_key: "openai-key".into(),
                        ..LlmProfile::default()
                    },
                )]),
            },
            openai: OpenAiConfig::default(),
            pianists_allowlist: vec!["Martha Argerich".into(), "Daniil Trifonov".into()],
            artists_blocklist: vec!["Yiruma".into()],
        }
    }

    #[test]
    fn save_and_load_round_trip() {
        let (_dir, path) = temp_config_path();
        let want = sample_config();
        save(&path, &want).unwrap();
        assert_eq!(load(&path).unwrap(), want);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        }
    }

    #[test]
    fn ensure_creates_default_config_when_missing() {
        let (_dir, path) = temp_config_path();
        assert!(ensure(&path).unwrap());
        let cfg = load(&path).unwrap();
        assert_eq!(cfg.pianists_allowlist, default_pianists_allowlist());
        assert!(cfg.artists_blocklist.is_empty());
        assert_eq!(cfg.llm, LlmConfig::default_template());
        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("\"openai\": {\n    \"api_key\""), "legacy block must be omitted:\n{raw}");
        assert!(!ensure(&path).unwrap(), "second ensure must not recreate");
    }

    #[test]
    fn load_missing_config_returns_actionable_error() {
        let (_dir, path) = temp_config_path();
        let err = load(&path).unwrap_err().to_string();
        assert!(err.contains("config file not found"), "{err}");
        assert!(err.contains("--config"), "{err}");
    }

    #[test]
    fn load_rejects_unknown_fields() {
        let (_dir, path) = temp_config_path();
        for body in [
            r#"{"spotify":{"client_id":"x","client_secret":"y"},"extra":true}"#,
            r#"{"spotify":{"client_id":"x","mystery":"y"}}"#,
            r#"{"llm":{"profiles":{"openai":{"provider":"openai","bogus":1}}}}"#,
            r#"{"spotify":{}} {"spotify":{}}"#,
        ] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, body).unwrap();
            assert!(load(&path).is_err(), "expected error for {body}");
        }
    }

    #[test]
    fn hyphenated_aliases_load_and_save_canonically() {
        let (_dir, path) = temp_config_path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"llm":{"active_profile":"ollama","profiles":{"ollama":{"provider":" openai_compat ","model":"qwen","api-key":" k ","base-url":"http://localhost:11434/v1"}}},"openai":{"api-key":"legacy"},"pianists_allowlist":["A"],"artists_blocklist":[]}"#,
        )
        .unwrap();
        let cfg = load(&path).unwrap();
        let profile = &cfg.llm.profiles["ollama"];
        assert_eq!(profile.provider, "openai_compat");
        assert_eq!(profile.api_key, "k");
        assert_eq!(profile.base_url, "http://localhost:11434/v1");
        assert_eq!(cfg.openai.api_key, "legacy");

        save(&path, &cfg).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"api_key\": \"k\""), "{raw}");
        assert!(raw.contains("\"base_url\""), "{raw}");
        assert!(!raw.contains("api-key") && !raw.contains("base-url"), "{raw}");
    }

    #[test]
    fn reads_go_written_config() {
        // Shape and time format exactly as the Go build writes them.
        let raw = r#"{
  "spotify": {
    "client_id": "id",
    "client_secret": "secret",
    "token": {
      "access_token": "a",
      "refresh_token": "r",
      "token_type": "Bearer",
      "expiry": "2026-09-30T15:04:05.123456-07:00"
    }
  },
  "llm": {
    "active_profile": "claude_cli",
    "profiles": {
      "claude_cli": {
        "provider": "claude_cli",
        "model": "sonnet",
        "command": "/usr/local/bin/claude"
      }
    }
  },
  "pianists_allowlist": ["Martha Argerich"],
  "artists_blocklist": null
}"#;
        let cfg: Config = serde_json::from_str(raw).unwrap();
        let token = cfg.spotify.token.as_ref().unwrap();
        assert_eq!(token.expiry, Some("2026-09-30T22:04:05.123456Z".parse().unwrap()));
        assert_eq!(cfg.llm.profiles["claude_cli"].command, "/usr/local/bin/claude");
        assert!(cfg.artists_blocklist.is_empty());
        cfg.validate().unwrap();

        let zero: Token = serde_json::from_str(r#"{"access_token":"a","expiry":"0001-01-01T00:00:00Z"}"#).unwrap();
        assert_eq!(zero.expiry, None);
        assert!(serde_json::to_string(&zero).unwrap().contains("0001-01-01T00:00:00Z"));
    }

    #[test]
    fn validate_rejects_missing_required_fields() {
        let cfg = Config::default();
        let err = cfg.validate().unwrap_err();
        assert_eq!(
            err.problems,
            vec![
                "spotify.client_id is required",
                "spotify.client_secret is required",
                "pianists_allowlist must contain at least one artist",
            ]
        );
    }

    #[test]
    fn validate_rejects_invalid_token_and_artists() {
        let mut cfg = sample_config();
        cfg.spotify.token = Some(Token::default());
        cfg.pianists_allowlist.push("  ".into());
        cfg.artists_blocklist.push(String::new());
        let problems = cfg.validate().unwrap_err().problems;
        assert_eq!(
            problems,
            vec![
                "pianists_allowlist[2] must not be blank",
                "artists_blocklist[1] must not be blank",
                "spotify.token.access_token is required when spotify.token is present",
                "spotify.token.expiry is required when spotify.token is present",
            ]
        );
    }

    #[test]
    fn effective_llm_config_synthesizes_legacy_openai() {
        let cfg = Config { openai: OpenAiConfig { api_key: " legacy ".into() }, ..Config::default() };
        let effective = cfg.effective_llm_config();
        assert_eq!(effective.active_profile, "openai");
        assert_eq!(effective.profiles["openai"].api_key, "legacy");
        assert_eq!(effective.profiles["openai"].model, DEFAULT_LLM_MODEL);
    }

    #[test]
    fn set_default_llm_api_key_writes_llm_and_clears_legacy() {
        let mut cfg = Config { openai: OpenAiConfig { api_key: "old".into() }, ..Config::default() };
        cfg.set_default_llm_api_key(" new ");
        assert_eq!(cfg.llm.profiles["openai"].api_key, "new");
        assert!(cfg.openai.api_key.is_empty());
        let raw = serde_json::to_string(&cfg).unwrap();
        assert!(!raw.contains("\"openai\":{\"api_key\""), "{raw}");
    }

    #[test]
    fn token_merge_preserves_refresh_data() {
        let previous = Token {
            access_token: "old".into(),
            refresh_token: "refresh".into(),
            token_type: "Bearer".into(),
            expiry: Some("2026-01-01T00:00:00Z".parse().unwrap()),
        };
        let merged = Token::merged(Token { access_token: "new".into(), ..Token::default() }, Some(&previous));
        assert_eq!(merged.access_token, "new");
        assert_eq!(merged.refresh_token, "refresh");
        assert_eq!(merged.token_type, "Bearer");
        assert_eq!(merged.expiry, previous.expiry);
    }

    #[test]
    fn add_artist_trims_and_deduplicates_case_insensitively() {
        let artists = vec!["Martha Argerich".to_string()];
        let (updated, added) = add_artist(&artists, "  martha   ARGERICH ").unwrap();
        assert!(!added);
        assert_eq!(updated, artists);
        let (updated, added) = add_artist(&artists, "  Igor Levit ").unwrap();
        assert!(added);
        assert_eq!(updated, vec!["Martha Argerich", "Igor Levit"]);
        assert!(add_artist(&artists, "   ").is_err());
    }

    #[test]
    fn remove_artist_matches_case_insensitively() {
        let artists = vec!["Martha Argerich".to_string(), "Igor Levit".to_string(), "martha argerich".to_string()];
        let (updated, removed) = remove_artist(&artists, "MARTHA  argerich").unwrap();
        assert!(removed);
        assert_eq!(updated, vec!["Igor Levit"]);
        let (_, removed) = remove_artist(&artists, "Nobody").unwrap();
        assert!(!removed);
    }

    #[test]
    fn cli_profiles_permit_default_model() {
        for provider in ["codex", "claude_cli"] {
            let mut cfg = sample_config();
            cfg.set_llm_profile(provider, LlmProfile { provider: provider.into(), ..LlmProfile::default() });
            cfg.validate().unwrap();
        }
        let mut cfg = sample_config();
        cfg.set_llm_profile("anthropic", LlmProfile { provider: "anthropic".into(), ..LlmProfile::default() });
        assert_eq!(cfg.validate().unwrap_err().problems, vec!["llm.profiles.anthropic.model is required"]);
    }
}
