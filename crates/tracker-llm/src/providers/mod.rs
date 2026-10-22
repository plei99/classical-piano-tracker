//! Concrete LLM providers and the factory that picks one from config.

mod anthropic;
mod catalog;
mod claudecli;
mod codex;
mod command;
mod google;
mod http;
mod openai;
mod openaicompat;
#[cfg(test)]
mod test_support;

use anyhow::{Result, bail};
use tracker_core::config::{Config, LlmProfile};

use crate::Provider;

pub use anthropic::AnthropicProvider;
pub use claudecli::ClaudeCliProvider;
pub use codex::CodexProvider;
pub use google::GoogleProvider;
pub use openai::OpenAiProvider;
pub use openaicompat::OpenAiCompatProvider;

use claudecli::CLAUDE_CLI_MODELS;
use openaicompat::DEFAULT_OPENAI_COMPAT_BASE_URL;

/// Resolves the effective LLM profile from config and the LLM_PROFILE /
/// LLM_PROVIDER / LLM_MODEL / API-key environment overrides.
pub fn from_config(cfg: &Config) -> Result<Box<dyn Provider>> {
    let (profile_name, profile) = resolve_profile(cfg, &|key| std::env::var(key).ok())?;
    Ok(build_provider(&profile_name, profile)?.boxed())
}

/// Onboarding-friendly model identifiers for a profile.
pub fn list_models(profile_name: &str, profile: &LlmProfile) -> Result<Vec<String>> {
    catalog::list_models(profile_name, profile)
}

/// Fixed model choices for the claude_cli provider.
pub fn claude_cli_models() -> Vec<String> {
    CLAUDE_CLI_MODELS.iter().map(|model| model.to_string()).collect()
}

/// The concrete provider chosen by the factory. Kept as an enum (rather than
/// boxing right away) so tests can inspect the resolved settings.
enum AnyProvider {
    OpenAi(OpenAiProvider),
    Anthropic(AnthropicProvider),
    Google(GoogleProvider),
    ClaudeCli(ClaudeCliProvider),
    Codex(CodexProvider),
    OpenAiCompat(OpenAiCompatProvider),
}

impl AnyProvider {
    fn boxed(self) -> Box<dyn Provider> {
        match self {
            AnyProvider::OpenAi(provider) => Box::new(provider),
            AnyProvider::Anthropic(provider) => Box::new(provider),
            AnyProvider::Google(provider) => Box::new(provider),
            AnyProvider::ClaudeCli(provider) => Box::new(provider),
            AnyProvider::Codex(provider) => Box::new(provider),
            AnyProvider::OpenAiCompat(provider) => Box::new(provider),
        }
    }
}

fn build_provider(profile_name: &str, mut profile: LlmProfile) -> Result<AnyProvider> {
    Ok(match profile.provider.trim().to_lowercase().as_str() {
        "openai" => AnyProvider::OpenAi(OpenAiProvider::new(&profile.api_key, &profile.model, &profile.base_url)?),
        "anthropic" => {
            AnyProvider::Anthropic(AnthropicProvider::new(&profile.api_key, &profile.model, &profile.base_url)?)
        }
        "google" => AnyProvider::Google(GoogleProvider::new(&profile.api_key, &profile.model, &profile.base_url)?),
        "claude_cli" => AnyProvider::ClaudeCli(ClaudeCliProvider::new(&profile.model, &profile.command)),
        "codex" => AnyProvider::Codex(CodexProvider::new(&profile.model, &profile.command)),
        "openai_compat" => {
            if profile.base_url.trim().is_empty() {
                profile.base_url = default_openai_compat_base_url_for_profile(profile_name).to_string();
            }
            AnyProvider::OpenAiCompat(OpenAiCompatProvider::new(&profile.api_key, &profile.model, &profile.base_url)?)
        }
        _ => bail!("LLM provider {:?} for profile {profile_name:?} is not implemented yet", profile.provider),
    })
}

/// Picks the profile (LLM_PROFILE, else the active one, else "openai") and
/// layers the environment overrides on top. `env` is injectable so tests do
/// not touch the process environment.
fn resolve_profile(cfg: &Config, env: &dyn Fn(&str) -> Option<String>) -> Result<(String, LlmProfile)> {
    let getenv = |key: &str| env(key).map(|value| value.trim().to_string()).unwrap_or_default();
    let effective = cfg.effective_llm_config();

    let mut profile_name = getenv("LLM_PROFILE");
    if profile_name.is_empty() {
        profile_name = effective.active_profile.trim().to_string();
    }
    if profile_name.is_empty() {
        profile_name = "openai".to_string();
    }

    let Some(profile) = effective.profiles.get(&profile_name) else {
        bail!("LLM profile {profile_name:?} was not found in llm.profiles");
    };
    let mut profile = profile.clone();

    let overrides: [(&str, &mut String); 5] = [
        ("LLM_PROVIDER", &mut profile.provider),
        ("LLM_MODEL", &mut profile.model),
        ("LLM_BASE_URL", &mut profile.base_url),
        ("LLM_API_KEY", &mut profile.api_key),
        ("LLM_COMMAND", &mut profile.command),
    ];
    for (key, field) in overrides {
        let value = getenv(key);
        if !value.is_empty() {
            *field = value;
        }
    }

    if profile.provider.trim().is_empty() {
        profile.provider = "openai".to_string();
    }
    // Legacy OpenAI-specific overrides only fill gaps.
    if profile.provider.eq_ignore_ascii_case("openai") {
        if profile.model.trim().is_empty() {
            profile.model = getenv("OPENAI_MODEL");
        }
        if profile.base_url.trim().is_empty() {
            profile.base_url = getenv("OPENAI_BASE_URL");
        }
    }

    if profile.api_key.trim().is_empty()
        && let Some(value) = provider_api_key_env_vars(&profile_name, &profile.provider)
            .iter()
            .map(|key| getenv(key))
            .find(|value| !value.is_empty())
    {
        profile.api_key = value;
    }

    Ok((profile_name, profile))
}

fn provider_api_key_env_vars(profile_name: &str, provider: &str) -> &'static [&'static str] {
    match provider.trim().to_lowercase().as_str() {
        "openai" => &["OPENAI_API_KEY"],
        "anthropic" => &["ANTHROPIC_API_KEY"],
        "google" => &["GOOGLE_API_KEY", "GEMINI_API_KEY"],
        "openai_compat" => match profile_name.trim().to_lowercase().as_str() {
            "deepseek" => &["DEEPSEEK_API_KEY"],
            "kimi" => &["KIMI_API_KEY"],
            _ => &[],
        },
        _ => &[],
    }
}

fn default_openai_compat_base_url_for_profile(profile_name: &str) -> &'static str {
    match profile_name.trim().to_lowercase().as_str() {
        "deepseek" => "https://api.deepseek.com/v1",
        "kimi" => "https://api.moonshot.ai/v1",
        _ => DEFAULT_OPENAI_COMPAT_BASE_URL,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, HashMap};
    use tracker_core::config::{LlmConfig, OpenAiConfig};

    fn config(active: &str, profiles: &[(&str, LlmProfile)]) -> Config {
        Config {
            llm: LlmConfig {
                active_profile: active.into(),
                profiles: profiles
                    .iter()
                    .map(|(name, profile)| (name.to_string(), profile.clone()))
                    .collect::<BTreeMap<_, _>>(),
            },
            ..Config::default()
        }
    }

    fn profile(provider: &str, model: &str, api_key: &str, base_url: &str, command: &str) -> LlmProfile {
        LlmProfile {
            provider: provider.into(),
            model: model.into(),
            api_key: api_key.into(),
            base_url: base_url.into(),
            command: command.into(),
        }
    }

    fn build(cfg: &Config, env: &[(&str, &str)]) -> Result<AnyProvider> {
        let env: HashMap<String, String> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let (name, profile) = resolve_profile(cfg, &|key| env.get(key).cloned())?;
        build_provider(&name, profile)
    }

    #[test]
    fn uses_llm_profile_and_generic_env_overrides() {
        let cfg = config(
            "openai",
            &[("openai", profile("openai", "config-model", "config-key", "https://config.example/v1", ""))],
        );
        let env = [
            ("LLM_MODEL", "override-model"),
            ("LLM_BASE_URL", "https://override.example/v1"),
            ("LLM_API_KEY", " override-key "),
        ];
        let Ok(AnyProvider::OpenAi(provider)) = build(&cfg, &env) else { panic!("want OpenAI provider") };
        assert_eq!(provider.model, "override-model");
        assert_eq!(provider.base_url, "https://override.example/v1");
        assert_eq!(provider.api_key, "override-key");
    }

    #[test]
    fn falls_back_to_legacy_openai_block() {
        let cfg = Config { openai: OpenAiConfig { api_key: "legacy-key".into() }, ..Config::default() };
        let Ok(AnyProvider::OpenAi(provider)) = build(&cfg, &[("OPENAI_API_KEY", "")]) else { panic!("want OpenAI") };
        assert_eq!(provider.api_key, "legacy-key");
        assert_eq!(provider.model, "gpt-5.4");
    }

    #[test]
    fn openai_env_fallbacks_fill_gaps_only() {
        let cfg = config("work", &[("work", profile("OpenAI", "", "", "", ""))]);
        let env =
            [("OPENAI_MODEL", "env-model"), ("OPENAI_BASE_URL", "https://env.example"), ("OPENAI_API_KEY", "env-key")];
        let Ok(AnyProvider::OpenAi(provider)) = build(&cfg, &env) else { panic!("want OpenAI") };
        assert_eq!((provider.model.as_str(), provider.base_url.as_str()), ("env-model", "https://env.example"));
        assert_eq!(provider.api_key, "env-key");

        let cfg = config("work", &[("work", profile("openai", "cfg-model", "cfg-key", "", ""))]);
        let Ok(AnyProvider::OpenAi(provider)) = build(&cfg, &env) else { panic!("want OpenAI") };
        assert_eq!((provider.model.as_str(), provider.api_key.as_str()), ("cfg-model", "cfg-key"));
    }

    #[test]
    fn supports_anthropic_profile() {
        let cfg = config("anthropic", &[("anthropic", profile("anthropic", "claude-sonnet-4-5", "key", "", ""))]);
        let Ok(AnyProvider::Anthropic(provider)) = build(&cfg, &[]) else { panic!("want Anthropic") };
        assert_eq!(provider.model, "claude-sonnet-4-5");

        let cfg = config("anthropic", &[("anthropic", profile("anthropic", "m", "", "", ""))]);
        let Ok(AnyProvider::Anthropic(provider)) = build(&cfg, &[("ANTHROPIC_API_KEY", "env")]) else { panic!() };
        assert_eq!(provider.api_key, "env");
    }

    #[test]
    fn supports_google_profile_and_gemini_key_fallback() {
        let cfg = config("google", &[("google", profile("google", "gemini-2.5-pro", "key", "", ""))]);
        let Ok(AnyProvider::Google(provider)) = build(&cfg, &[]) else { panic!("want Google") };
        assert_eq!(provider.model, "gemini-2.5-pro");

        let cfg = config("google", &[("google", profile("google", "m", "", "", ""))]);
        let Ok(AnyProvider::Google(provider)) = build(&cfg, &[("GEMINI_API_KEY", "gem")]) else { panic!() };
        assert_eq!(provider.api_key, "gem");
        let env = [("GOOGLE_API_KEY", "goog"), ("GEMINI_API_KEY", "gem")];
        let Ok(AnyProvider::Google(provider)) = build(&cfg, &env) else { panic!() };
        assert_eq!(provider.api_key, "goog");
    }

    #[test]
    fn supports_openai_compat_profile() {
        let cfg = config("ollama", &[("ollama", profile("openai_compat", "qwen2.5:latest", "", "", ""))]);
        let Ok(AnyProvider::OpenAiCompat(provider)) = build(&cfg, &[]) else { panic!("want OpenAI-compatible") };
        assert_eq!(provider.base_url, "http://localhost:11434/v1");
        assert_eq!(provider.api_key, "");
    }

    #[test]
    fn uses_deepseek_and_kimi_defaults() {
        let cfg = config("deepseek", &[("deepseek", profile("openai_compat", "deepseek-chat", "", "", ""))]);
        let Ok(AnyProvider::OpenAiCompat(provider)) = build(&cfg, &[("DEEPSEEK_API_KEY", "deepseek-key")]) else {
            panic!("want OpenAI-compatible")
        };
        assert_eq!(provider.api_key, "deepseek-key");
        assert_eq!(provider.base_url, "https://api.deepseek.com/v1");

        let cfg = config("Kimi", &[("Kimi", profile("openai_compat", "kimi-k2.5", "", "", ""))]);
        let Ok(AnyProvider::OpenAiCompat(provider)) = build(&cfg, &[("KIMI_API_KEY", "kimi-key")]) else { panic!() };
        assert_eq!(provider.api_key, "kimi-key");
        assert_eq!(provider.base_url, "https://api.moonshot.ai/v1");
    }

    #[test]
    fn supports_claude_cli_profile_without_api_key() {
        let cfg = config("claude_cli", &[("claude_cli", profile("claude_cli", "opus", "", "", "/opt/bin/claude"))]);
        let Ok(AnyProvider::ClaudeCli(provider)) = build(&cfg, &[("ANTHROPIC_API_KEY", ""), ("LLM_API_KEY", "")])
        else {
            panic!("want Claude CLI")
        };
        assert_eq!(provider.model, "opus");
        assert_eq!(provider.command, "/opt/bin/claude");
    }

    #[test]
    fn honors_llm_command_override_for_claude_cli() {
        let cfg = config("claude_cli", &[("claude_cli", profile("claude_cli", "", "", "", "/config/claude"))]);
        let Ok(AnyProvider::ClaudeCli(provider)) = build(&cfg, &[("LLM_COMMAND", "/override/claude")]) else {
            panic!("want Claude CLI")
        };
        assert_eq!(provider.command, "/override/claude");
    }

    #[test]
    fn supports_codex_without_key_or_model() {
        let cfg = config("local-codex", &[("local-codex", profile("codex", "", "", "", "/opt/bin/codex"))]);
        let Ok(AnyProvider::Codex(provider)) = build(&cfg, &[]) else { panic!("want Codex") };
        assert_eq!((provider.model.as_str(), provider.command.as_str()), ("", "/opt/bin/codex"));

        let env = [("LLM_MODEL", "override-model"), ("LLM_COMMAND", "/override/codex")];
        let Ok(AnyProvider::Codex(provider)) = build(&cfg, &env) else { panic!("want Codex") };
        assert_eq!((provider.model.as_str(), provider.command.as_str()), ("override-model", "/override/codex"));
    }

    #[test]
    fn profile_and_provider_selection_errors() {
        let cfg =
            config("a", &[("a", profile("anthropic", "m", "k", "", "")), ("b", profile("google", "m", "k", "", ""))]);
        assert!(matches!(build(&cfg, &[("LLM_PROFILE", "b")]), Ok(AnyProvider::Google(_))));
        assert!(matches!(build(&cfg, &[("LLM_PROVIDER", "codex")]), Ok(AnyProvider::Codex(_))));

        let err = build(&cfg, &[("LLM_PROFILE", "missing")]).err().unwrap();
        assert_eq!(err.to_string(), "LLM profile \"missing\" was not found in llm.profiles");

        let err = build(&cfg, &[("LLM_PROVIDER", "Mystery")]).err().unwrap();
        assert_eq!(err.to_string(), "LLM provider \"Mystery\" for profile \"a\" is not implemented yet");

        let cfg = config("a", &[("a", profile("anthropic", "m", "", "", ""))]);
        assert_eq!(build(&cfg, &[]).err().unwrap().to_string(), "Anthropic API key is required");

        // A blank provider means OpenAI.
        let cfg = config("a", &[("a", profile(" ", "m", "k", "", ""))]);
        assert!(matches!(build(&cfg, &[]), Ok(AnyProvider::OpenAi(_))));
    }

    #[test]
    fn claude_cli_models_are_fixed() {
        assert_eq!(claude_cli_models(), vec!["sonnet", "opus", "haiku", "fable"]);
    }

    /// Explicit opt-in only: this uses CLI account quota, but never reads the
    /// user's tracker database/config or contacts Spotify.
    #[test]
    #[ignore = "set TRACKER_TEST_LIVE_CLI=codex or claude_cli to exercise an authenticated CLI"]
    fn live_cli() {
        use tracker_recommend::{FavoritePianist, TasteSummary, TasteTrack};

        let model = std::env::var("TRACKER_TEST_CLI_MODEL").unwrap_or_default();
        let provider: Box<dyn Provider> = match std::env::var("TRACKER_TEST_LIVE_CLI").unwrap_or_default().as_str() {
            "codex" => Box::new(CodexProvider::new(&model, "")),
            "claude_cli" => Box::new(ClaudeCliProvider::new(&model, "")),
            "" => return,
            other => panic!("unknown TRACKER_TEST_LIVE_CLI {other:?}"),
        };
        let client = crate::Client::new(provider);
        let summary = TasteSummary {
            total_tracks: 3,
            total_ratings: 3,
            comment_count: 1,
            favorite_pianists: vec![FavoritePianist {
                name: "Murray Perahia".into(),
                track_count: 3,
                rated_track_count: 3,
                total_play_count: 3,
                average_stars: 5.0,
            }],
            known_pianists: vec!["Murray Perahia".into()],
            commented_tracks: vec![TasteTrack {
                track_name: "Goldberg Variations".into(),
                artists: vec!["Murray Perahia".into()],
                stars: 5,
                opinion: "Clear counterpoint and warm tone.".into(),
                ..TasteTrack::default()
            }],
            ..TasteSummary::default()
        };

        let text = client.summarize_taste(&summary).unwrap();
        assert!(!text.trim().is_empty(), "empty summary");
        let result = client.suggest_new_pianists(&summary, 5).unwrap();
        assert_eq!(result.recommendations.len(), 5);
    }
}
