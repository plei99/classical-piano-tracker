//! `tracker onboarding`: interactive first-run setup for Spotify
//! credentials, the LLM provider, and the pianist allowlist.

use std::io::{BufRead, Write};
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow, bail};
use tracker_core::config::{self, LlmConfig, LlmProfile};
use tracker_llm::providers;

use super::picker::{prompt_pianist_selection, run_single_choice_selection};
use super::{Io, RootOptions, read_line, write_prompt};

const CLAUDE_CLI_PROVIDER_KIND: &str = "claude_cli";
const CODEX_PROVIDER_KIND: &str = "codex";
const PICKER_HELP: &str = "Up/down or j/k: move   enter: confirm   q: cancel";

/// One LLM provider choice offered during onboarding.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OnboardingProvider {
    pub profile_name: &'static str,
    pub display_name: &'static str,
    pub provider_kind: &'static str,
    pub default_model: &'static str,
    pub default_base_url: &'static str,
    pub prompt_api_key: bool,
    pub prompt_base_url: bool,
    /// Offered instead of querying the provider's model-listing API.
    pub fixed_models: Vec<String>,
}

pub type PianistSelectionFn = Box<dyn Fn(&mut dyn Write, &[String]) -> Result<Vec<String>>>;
pub type ProviderSelectionFn = Box<dyn Fn(&mut dyn Write, &[OnboardingProvider], usize) -> Result<OnboardingProvider>>;
pub type ModelSelectionFn = Box<dyn Fn(&mut dyn Write, &str, &[String], usize) -> Result<String>>;
pub type ListModelsFn = Box<dyn Fn(&str, &LlmProfile) -> Result<Vec<String>>>;
pub type LookupCommandFn = Box<dyn Fn() -> Result<String>>;

/// The interactive and environment-dependent steps of onboarding. Tests swap
/// these for deterministic fakes; the defaults use the terminal pickers, the
/// providers' model-listing APIs, and a PATH lookup.
pub struct OnboardingDeps {
    pub select_pianists: PianistSelectionFn,
    pub select_provider: ProviderSelectionFn,
    pub select_model: ModelSelectionFn,
    pub list_models: ListModelsFn,
    /// Resolves the Claude Code CLI so its absolute path can be stored in the
    /// profile.
    pub lookup_claude: LookupCommandFn,
    pub lookup_codex: LookupCommandFn,
}

impl Default for OnboardingDeps {
    fn default() -> Self {
        OnboardingDeps {
            select_pianists: Box::new(prompt_pianist_selection),
            select_provider: Box::new(prompt_provider_selection),
            select_model: Box::new(|out, title, models, initial| {
                run_single_choice_selection(out, title, PICKER_HELP, models, initial)
            }),
            list_models: Box::new(providers::list_models),
            lookup_claude: Box::new(|| look_path("claude")),
            lookup_codex: Box::new(|| look_path(CODEX_PROVIDER_KIND)),
        }
    }
}

fn onboarding_providers() -> Vec<OnboardingProvider> {
    vec![
        OnboardingProvider {
            profile_name: "openai",
            display_name: "OpenAI",
            provider_kind: "openai",
            default_model: "gpt-5.4",
            prompt_api_key: true,
            ..OnboardingProvider::default()
        },
        OnboardingProvider {
            profile_name: CODEX_PROVIDER_KIND,
            display_name: "Codex CLI (uses your Codex login)",
            provider_kind: CODEX_PROVIDER_KIND,
            ..OnboardingProvider::default()
        },
        OnboardingProvider {
            profile_name: "anthropic",
            display_name: "Anthropic",
            provider_kind: "anthropic",
            default_model: "claude-sonnet-4-5",
            prompt_api_key: true,
            ..OnboardingProvider::default()
        },
        OnboardingProvider {
            profile_name: CLAUDE_CLI_PROVIDER_KIND,
            display_name: "Claude Code CLI (claude -p, uses your Claude login)",
            provider_kind: CLAUDE_CLI_PROVIDER_KIND,
            default_model: "sonnet",
            fixed_models: providers::claude_cli_models(),
            ..OnboardingProvider::default()
        },
        OnboardingProvider {
            profile_name: "google",
            display_name: "Google Gemini",
            provider_kind: "google",
            default_model: "gemini-2.5-pro",
            prompt_api_key: true,
            ..OnboardingProvider::default()
        },
        OnboardingProvider {
            profile_name: "ollama",
            display_name: "Ollama",
            provider_kind: "openai_compat",
            default_base_url: "http://localhost:11434/v1",
            prompt_base_url: true,
            ..OnboardingProvider::default()
        },
        OnboardingProvider {
            profile_name: "deepseek",
            display_name: "DeepSeek",
            provider_kind: "openai_compat",
            default_model: "deepseek-chat",
            default_base_url: "https://api.deepseek.com/v1",
            prompt_api_key: true,
            prompt_base_url: true,
            fixed_models: vec!["deepseek-chat".into(), "deepseek-reasoner".into()],
        },
        OnboardingProvider {
            profile_name: "kimi",
            display_name: "Kimi",
            provider_kind: "openai_compat",
            default_model: "kimi-k2.5",
            default_base_url: "https://api.moonshot.ai/v1",
            prompt_api_key: true,
            prompt_base_url: true,
            fixed_models: vec!["kimi-k2.5".into()],
        },
    ]
}

pub(crate) fn run(opts: &RootOptions, io: &mut Io<'_>, deps: &OnboardingDeps) -> Result<()> {
    let config_path = opts.resolve_config_path()?;
    let (mut cfg, _) = config::ensure_loaded(&config_path)?;
    let input = &mut *io.input;
    let out = &mut *io.out;

    writeln!(out, "Config path: {}\n", config_path.display())?;

    let client_id = prompt_required_value(input, out, "Spotify client ID", &cfg.spotify.client_id)?;
    let client_secret = prompt_required_value(input, out, "Spotify client secret", &cfg.spotify.client_secret)?;

    let llm_config = cfg.effective_llm_config();
    let choices = onboarding_providers();
    let provider = (deps.select_provider)(out, &choices, initial_provider_index(&choices, &llm_config))?;
    let current = llm_config.profiles.get(provider.profile_name).cloned().unwrap_or_default();

    let api_key = if provider.prompt_api_key {
        let label = format!("{} API key (optional)", provider.display_name);
        prompt_optional_value(input, out, &label, &current.api_key)?
    } else {
        String::new()
    };

    let mut base_url = current.base_url.clone();
    if base_url.trim().is_empty() {
        base_url = provider.default_base_url.to_string();
    }
    if provider.prompt_base_url {
        base_url = prompt_required_value(input, out, &format!("{} base URL", provider.display_name), &base_url)?;
    }

    let mut command = String::new();
    if provider.provider_kind == CLAUDE_CLI_PROVIDER_KIND || provider.provider_kind == CODEX_PROVIDER_KIND {
        let (binary, lookup) = if provider.provider_kind == CODEX_PROVIDER_KIND {
            ("codex", &deps.lookup_codex)
        } else {
            ("claude", &deps.lookup_claude)
        };
        command = current.command.trim().to_string();
        if command.is_empty() {
            // A missing CLI is not fatal: an empty command means the provider
            // resolves it from PATH at runtime.
            command = lookup().unwrap_or_else(|err| {
                let _ = write!(
                    out,
                    "\nCould not find the {binary} command on PATH ({err:#}).\nInstall the CLI and sign in, or set llm.profiles.{}.command to its path.\n\n",
                    provider.profile_name
                );
                String::new()
            });
        }
        write!(out, "Uses the CLI's existing login. Sign in with `{binary}` first; no tracker API key is needed.\n\n")?;
    }

    let listing_profile = LlmProfile {
        provider: provider.provider_kind.to_string(),
        model: current.model.clone(),
        api_key: api_key.clone(),
        base_url: base_url.clone(),
        command: String::new(),
    };
    let model = prompt_provider_model(input, out, deps, &provider, &listing_profile)?;

    let selected = (deps.select_pianists)(out, &config::default_pianists_allowlist())?;

    cfg.spotify.client_id = client_id;
    cfg.spotify.client_secret = client_secret;
    cfg.set_llm_profile(
        provider.profile_name,
        LlmProfile {
            provider: provider.provider_kind.to_string(),
            model: model.clone(),
            api_key: api_key.trim().to_string(),
            base_url: base_url.trim().to_string(),
            command: command.trim().to_string(),
        },
    );
    cfg.pianists_allowlist = selected;

    config::save(&config_path, &cfg).with_context(|| format!("save config {config_path:?}"))?;

    let model_label = if model.is_empty() { "CLI default model" } else { &model };
    writeln!(out, "\nSaved onboarding config to {}", config_path.display())?;
    writeln!(out, "Selected LLM provider: {} ({model_label})", provider.display_name)?;
    writeln!(out, "Selected {} pianists for pianists_allowlist", cfg.pianists_allowlist.len())?;
    writeln!(out, "Next steps:")?;
    writeln!(out, "  1. Add {} to your Spotify app redirect URIs", tracker_spotify::DEFAULT_REDIRECT_URL)?;
    writeln!(out, "  2. Run `tracker spotify login`")?;
    writeln!(out, "  3. Run `tracker sync`")?;
    Ok(())
}

/// Preselects the provider of the currently active profile.
fn initial_provider_index(choices: &[OnboardingProvider], cfg: &LlmConfig) -> usize {
    let active = cfg.active_profile.trim();
    choices.iter().position(|choice| choice.profile_name == active).unwrap_or(0)
}

fn prompt_provider_model(
    input: &mut dyn BufRead,
    out: &mut dyn Write,
    deps: &OnboardingDeps,
    provider: &OnboardingProvider,
    profile: &LlmProfile,
) -> Result<String> {
    if provider.provider_kind == CODEX_PROVIDER_KIND {
        // Codex has no simple model-list command. Avoid hardcoded choices
        // that may not be available to the user's CLI account.
        return prompt_optional_value(input, out, "Codex model (optional; unset uses CLI default)", &profile.model);
    }

    let mut current_model = profile.model.trim();
    if current_model.is_empty() {
        current_model = provider.default_model;
    }
    let manual_label = format!("{} model", provider.display_name);

    let mut models = provider.fixed_models.clone();
    if models.is_empty() {
        match (deps.list_models)(provider.profile_name, profile) {
            Ok(listed) => models = listed,
            Err(err) => {
                write!(
                    out,
                    "\nCould not list models for {}: {err:#}\nFalling back to manual model entry.\n\n",
                    provider.display_name
                )?;
                return prompt_required_value(input, out, &manual_label, current_model);
            }
        }
    }

    let models = compact_non_empty(&models);
    match models.as_slice() {
        [] => {
            write!(
                out,
                "\nNo models were returned for {}.\nFalling back to manual model entry.\n\n",
                provider.display_name
            )?;
            prompt_required_value(input, out, &manual_label, current_model)
        }
        [only] => {
            write!(out, "{} model: {only}\n\n", provider.display_name)?;
            Ok(only.clone())
        }
        _ => {
            let initial = models.iter().position(|model| model == current_model).unwrap_or(0);
            (deps.select_model)(out, &format!("Select model for {}", provider.display_name), &models, initial)
        }
    }
}

/// Trims, drops blanks and duplicates, and sorts.
fn compact_non_empty(values: &[String]) -> Vec<String> {
    let mut result: Vec<String> =
        values.iter().map(|value| value.trim()).filter(|value| !value.is_empty()).map(str::to_string).collect();
    result.sort();
    result.dedup();
    result
}

fn prompt_provider_selection(
    out: &mut dyn Write,
    choices: &[OnboardingProvider],
    initial: usize,
) -> Result<OnboardingProvider> {
    let labels: Vec<String> = choices.iter().map(|choice| choice.display_name.to_string()).collect();
    let selected = run_single_choice_selection(out, "Select LLM provider", PICKER_HELP, &labels, initial)?;
    choices
        .iter()
        .find(|choice| choice.display_name == selected)
        .cloned()
        .ok_or_else(|| anyhow!("selected provider {selected:?} was not found"))
}

/// Prompts until a non-blank value is given (Enter keeps a non-blank
/// current value). Input ending with nothing to use is an error rather than
/// an endless re-prompt.
fn prompt_required_value(input: &mut dyn BufRead, out: &mut dyn Write, label: &str, current: &str) -> Result<String> {
    loop {
        let (value, eof) = prompt_value(input, out, label, current)?;
        if !value.trim().is_empty() {
            return Ok(value);
        }
        writeln!(out, "{label} is required.")?;
        if eof {
            bail!("read {label}: EOF");
        }
    }
}

/// Like [`prompt_required_value`] but accepts blank input.
fn prompt_optional_value(input: &mut dyn BufRead, out: &mut dyn Write, label: &str, current: &str) -> Result<String> {
    Ok(prompt_value(input, out, label, current)?.0)
}

/// The shared "show the current value, Enter keeps it" prompt. Also reports
/// whether input has ended.
fn prompt_value(input: &mut dyn BufRead, out: &mut dyn Write, label: &str, current: &str) -> Result<(String, bool)> {
    if current.trim().is_empty() {
        write_prompt(out, &format!("{label}: "))?;
    } else {
        write_prompt(out, &format!("{label} [{current}]: "))?;
    }

    let (line, eof) = read_line(input).with_context(|| format!("read {label}"))?;
    let trimmed = line.trim();
    let value = if trimmed.is_empty() { current.to_string() } else { trimmed.to_string() };
    Ok((value, eof))
}

/// Go's `exec.LookPath`: the first executable named `name` on PATH.
fn look_path(name: &str) -> Result<String> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path) {
        let dir = if dir.as_os_str().is_empty() { PathBuf::from(".") } else { dir };
        for candidate in executable_candidates(&dir, name) {
            if is_executable(&candidate) {
                return Ok(candidate.to_string_lossy().into_owned());
            }
        }
    }
    bail!("exec: {name:?}: executable file not found in $PATH")
}

#[cfg(unix)]
fn executable_candidates(dir: &std::path::Path, name: &str) -> Vec<PathBuf> {
    vec![dir.join(name)]
}

#[cfg(not(unix))]
fn executable_candidates(dir: &std::path::Path, name: &str) -> Vec<PathBuf> {
    ["", ".exe", ".cmd", ".bat"].iter().map(|ext| dir.join(format!("{name}{ext}"))).collect()
}

fn is_executable(path: &std::path::Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else { return false };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        metadata.is_file()
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::path::Path;

    use tracker_core::config::{Config, SpotifyConfig};

    use super::super::Deps;
    use super::super::testutil::{path_str, run_with, temp_path};
    use super::*;

    /// Fakes that fail loudly unless a test overrides them, so no test can
    /// reach a real terminal, network, or PATH.
    fn fake_deps() -> OnboardingDeps {
        OnboardingDeps {
            select_pianists: Box::new(|_, _| panic!("unexpected pianist selection")),
            select_provider: Box::new(|_, _, _| panic!("unexpected provider selection")),
            select_model: Box::new(|_, _, _, _| panic!("unexpected model selection")),
            list_models: Box::new(|_, _| panic!("unexpected model listing")),
            lookup_claude: Box::new(|| panic!("unexpected claude lookup")),
            lookup_codex: Box::new(|| panic!("unexpected codex lookup")),
        }
    }

    fn choose(profile_name: &'static str) -> ProviderSelectionFn {
        Box::new(move |_, choices, _| {
            Ok(choices
                .iter()
                .find(|choice| choice.profile_name == profile_name)
                .unwrap_or_else(|| panic!("{profile_name} choice not found"))
                .clone())
        })
    }

    fn run_onboarding(config_path: &Path, stdin: &str, onboarding: OnboardingDeps) -> String {
        let deps = Deps { onboarding, ..Deps::default() };
        let (result, out) = run_with(&["--config", path_str(config_path), "onboarding"], stdin, &deps);
        result.unwrap_or_else(|err| panic!("onboarding failed: {err:#}\noutput: {out}"));
        out
    }

    #[test]
    fn onboarding_command_writes_selected_config() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = temp_path(&dir, "config.json");
        let defaults = config::default_pianists_allowlist();
        let want_allowlist = vec![defaults[0].clone(), defaults[2].clone()];
        let picked = want_allowlist.clone();

        let out = run_onboarding(
            &config_path,
            "spotify-client\nspotify-secret\nopenai-key\n",
            OnboardingDeps {
                select_pianists: Box::new(move |_, _| Ok(picked.clone())),
                select_provider: Box::new(|_, choices, _| Ok(choices[0].clone())),
                select_model: Box::new(|_, _, _, _| Ok("gpt-5.4".into())),
                list_models: Box::new(|_, _| Ok(vec!["gpt-5.4".into(), "gpt-4o-mini".into()])),
                ..fake_deps()
            },
        );

        let cfg = config::load(&config_path).unwrap();
        assert_eq!(cfg.spotify.client_id, "spotify-client");
        assert_eq!(cfg.spotify.client_secret, "spotify-secret");
        let llm = cfg.effective_llm_config();
        assert_eq!(llm.active_profile, "openai");
        assert_eq!(llm.profiles["openai"].api_key, "openai-key");
        assert_eq!(llm.profiles["openai"].model, "gpt-5.4");
        assert_eq!(cfg.pianists_allowlist, want_allowlist);
        assert!(out.contains("Saved onboarding config"), "output = {out:?}, want save confirmation");
    }

    #[test]
    fn onboarding_command_keeps_full_default_allowlist_on_blank_selection() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = temp_path(&dir, "config.json");

        run_onboarding(
            &config_path,
            "spotify-client\nspotify-secret\n\n",
            OnboardingDeps {
                select_pianists: Box::new(|_, pianists| Ok(pianists.to_vec())),
                select_provider: Box::new(|_, choices, _| Ok(choices[0].clone())),
                select_model: Box::new(|_, _, _, _| Ok("gpt-5.4".into())),
                list_models: Box::new(|_, _| Ok(vec!["gpt-5.4".into()])),
                ..fake_deps()
            },
        );

        let cfg = config::load(&config_path).unwrap();
        assert_eq!(cfg.pianists_allowlist.len(), config::default_pianists_allowlist().len());
        assert_eq!(cfg.effective_llm_config().profiles["openai"].api_key, "", "want blank optional key");
    }

    #[test]
    fn onboarding_command_writes_fixed_deepseek_model() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = temp_path(&dir, "config.json");
        let first = config::default_pianists_allowlist()[0].clone();

        run_onboarding(
            &config_path,
            "spotify-client\nspotify-secret\ndeepseek-key\nhttps://api.deepseek.com/v1\n",
            OnboardingDeps {
                select_pianists: Box::new(move |_, _| Ok(vec![first.clone()])),
                select_provider: choose("deepseek"),
                select_model: Box::new(|_, _, models, _| Ok(models[1].clone())),
                list_models: Box::new(|_, _| panic!("list_models should not be called for fixed-model provider")),
                ..fake_deps()
            },
        );

        let cfg = config::load(&config_path).unwrap();
        let llm = cfg.effective_llm_config();
        assert_eq!(llm.active_profile, "deepseek");
        let profile = &llm.profiles["deepseek"];
        assert_eq!(
            (profile.provider.as_str(), profile.model.as_str(), profile.api_key.as_str()),
            ("openai_compat", "deepseek-reasoner", "deepseek-key"),
            "want selected fixed-model profile: {profile:?}"
        );
    }

    #[test]
    fn onboarding_command_writes_claude_cli_profile_with_resolved_command() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = temp_path(&dir, "config.json");
        let first = config::default_pianists_allowlist()[0].clone();

        run_onboarding(
            &config_path,
            "spotify-client\nspotify-secret\n",
            OnboardingDeps {
                select_pianists: Box::new(move |_, _| Ok(vec![first.clone()])),
                select_provider: Box::new(|_, choices, _| {
                    let choice = choices.iter().find(|c| c.profile_name == "claude_cli").expect("claude_cli choice");
                    assert!(!choice.prompt_api_key, "claude_cli choice should not prompt for an API key");
                    Ok(choice.clone())
                }),
                select_model: Box::new(|_, _, models, initial| {
                    assert_eq!(models[initial], "sonnet", "want default sonnet preselected");
                    Ok(models[initial].clone())
                }),
                list_models: Box::new(|_, _| panic!("list_models should not be called for fixed-model provider")),
                lookup_claude: Box::new(|| Ok("/stub/bin/claude".into())),
                ..fake_deps()
            },
        );

        let cfg = config::load(&config_path).unwrap();
        let llm = cfg.effective_llm_config();
        assert_eq!(llm.active_profile, "claude_cli");
        assert_eq!(
            llm.profiles["claude_cli"],
            LlmProfile {
                provider: "claude_cli".into(),
                model: "sonnet".into(),
                command: "/stub/bin/claude".into(),
                ..LlmProfile::default()
            }
        );
    }

    #[test]
    fn onboarding_command_warns_when_claude_cli_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = temp_path(&dir, "config.json");
        let first = config::default_pianists_allowlist()[0].clone();

        let out = run_onboarding(
            &config_path,
            "spotify-client\nspotify-secret\n",
            OnboardingDeps {
                select_pianists: Box::new(move |_, _| Ok(vec![first.clone()])),
                select_provider: choose("claude_cli"),
                select_model: Box::new(|_, _, models, _| Ok(models[0].clone())),
                lookup_claude: Box::new(|| Err(anyhow!("executable file not found in $PATH"))),
                ..fake_deps()
            },
        );

        assert!(out.contains("Could not find the claude command"), "output = {out:?}, want missing-claude warning");
        let cfg = config::load(&config_path).unwrap();
        assert_eq!(
            cfg.effective_llm_config().profiles["claude_cli"].command,
            "",
            "want empty so PATH lookup happens at runtime"
        );
    }

    #[test]
    fn onboarding_codex_profile() {
        struct Case {
            name: &'static str,
            model: &'static str,
            existing_command: &'static str,
            found_command: &'static str,
            missing: bool,
        }
        let cases = [
            Case {
                name: "default model",
                model: "",
                existing_command: "",
                found_command: "/opt/bin/codex",
                missing: false,
            },
            Case {
                name: "manual model",
                model: "chosen-model",
                existing_command: "",
                found_command: "/opt/bin/codex",
                missing: false,
            },
            Case { name: "missing command", model: "", existing_command: "", found_command: "", missing: true },
            Case {
                name: "preserve custom command",
                model: "",
                existing_command: "/custom/codex",
                found_command: "",
                missing: false,
            },
        ];

        for case in cases {
            let dir = tempfile::tempdir().unwrap();
            let path = temp_path(&dir, "config.json");
            if !case.existing_command.is_empty() {
                let mut cfg = Config {
                    spotify: SpotifyConfig { client_id: "old".into(), client_secret: "old".into(), token: None },
                    ..Config::default()
                };
                cfg.set_llm_profile(
                    "codex",
                    LlmProfile {
                        provider: "codex".into(),
                        command: case.existing_command.into(),
                        ..LlmProfile::default()
                    },
                );
                config::save(&path, &cfg).unwrap();
            }

            let (existing, missing, found) = (case.existing_command, case.missing, case.found_command);
            let out = run_onboarding(
                &path,
                &format!("spotify-client\nspotify-secret\n{}\n", case.model),
                OnboardingDeps {
                    select_pianists: Box::new(|_, _| Ok(vec!["Martha Argerich".into()])),
                    select_provider: Box::new(|_, choices, _| {
                        let choice = choices.iter().find(|c| c.provider_kind == "codex").expect("Codex choice");
                        assert!(
                            !choice.prompt_api_key && !choice.prompt_base_url,
                            "Codex must not prompt for API credentials"
                        );
                        Ok(choice.clone())
                    }),
                    lookup_codex: Box::new(move || {
                        assert!(existing.is_empty(), "must preserve existing executable path");
                        if missing { Err(anyhow!("not installed")) } else { Ok(found.into()) }
                    }),
                    list_models: Box::new(|_, _| panic!("Codex onboarding must not use API model listing")),
                    ..fake_deps()
                },
            );

            let cfg = config::load(&path).unwrap();
            cfg.validate().unwrap_or_else(|err| panic!("{}: {err}", case.name));
            let profile = &cfg.effective_llm_config().profiles["codex"];
            let command = if case.existing_command.is_empty() { case.found_command } else { case.existing_command };
            assert_eq!(cfg.llm.active_profile, "codex", "{}", case.name);
            assert_eq!(
                profile,
                &LlmProfile {
                    provider: "codex".into(),
                    model: case.model.into(),
                    command: command.into(),
                    ..LlmProfile::default()
                },
                "{}: unexpected Codex profile",
                case.name
            );
            if case.missing {
                assert!(out.contains("Could not find the codex command"), "{}: missing warning: {out}", case.name);
            }
        }
    }

    #[test]
    fn provider_model_listing_falls_back_to_manual_entry() {
        let provider = onboarding_providers().into_iter().find(|p| p.profile_name == "anthropic").unwrap();
        let mut out = Vec::new();
        let deps = OnboardingDeps {
            list_models: Box::new(|_, _| Err(anyhow!("Anthropic API key is required to list models"))),
            ..fake_deps()
        };
        let model =
            prompt_provider_model(&mut Cursor::new("\n"), &mut out, &deps, &provider, &LlmProfile::default()).unwrap();
        assert_eq!(model, "claude-sonnet-4-5", "Enter keeps the default model");
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains("Could not list models for Anthropic: Anthropic API key is required to list models"));
        assert!(out.ends_with("Anthropic model [claude-sonnet-4-5]: "), "{out}");

        let deps = OnboardingDeps {
            list_models: Box::new(|_, _| Ok(vec![" ".into(), "x".into(), "x ".into()])),
            ..fake_deps()
        };
        let mut out = Vec::new();
        let model =
            prompt_provider_model(&mut Cursor::new(""), &mut out, &deps, &provider, &LlmProfile::default()).unwrap();
        assert_eq!(model, "x");
        assert_eq!(String::from_utf8(out).unwrap(), "Anthropic model: x\n\n");
    }

    #[test]
    fn required_prompts_retry_and_stop_at_eof() {
        let mut out = Vec::new();
        let value = prompt_required_value(&mut Cursor::new("\n  id  \n"), &mut out, "Spotify client ID", "").unwrap();
        assert_eq!(value, "id");
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "Spotify client ID: Spotify client ID is required.\nSpotify client ID: "
        );

        let err = prompt_required_value(&mut Cursor::new(""), &mut Vec::new(), "Spotify client ID", "").unwrap_err();
        assert_eq!(err.to_string(), "read Spotify client ID: EOF");
        let kept = prompt_required_value(&mut Cursor::new(""), &mut Vec::new(), "Spotify client ID", "old").unwrap();
        assert_eq!(kept, "old");
    }

    #[test]
    fn compact_non_empty_trims_dedupes_and_sorts() {
        let values: Vec<String> = ["b", " a ", "", "b ", "c"].iter().map(|s| s.to_string()).collect();
        assert_eq!(compact_non_empty(&values), vec!["a", "b", "c"]);
    }

    #[test]
    fn initial_provider_index_follows_active_profile() {
        let choices = onboarding_providers();
        let cfg = LlmConfig { active_profile: " deepseek ".into(), ..LlmConfig::default() };
        assert_eq!(choices[initial_provider_index(&choices, &cfg)].profile_name, "deepseek");
        assert_eq!(initial_provider_index(&choices, &LlmConfig::default()), 0);
    }

    #[test]
    fn look_path_reports_go_style_error() {
        let err = look_path("definitely-not-a-real-tracker-binary").unwrap_err();
        assert_eq!(
            err.to_string(),
            "exec: \"definitely-not-a-real-tracker-binary\": executable file not found in $PATH"
        );
    }
}
