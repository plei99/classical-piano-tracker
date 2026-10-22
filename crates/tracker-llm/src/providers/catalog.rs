//! Onboarding model lists. Dynamic providers use their listing APIs;
//! DeepSeek and Kimi use fixed options.

use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use tracker_core::config::LlmProfile;
use url::Url;

use super::anthropic::{ANTHROPIC_VERSION, DEFAULT_ANTHROPIC_BASE_URL};
use super::claudecli::CLAUDE_CLI_MODELS;
use super::google::DEFAULT_GOOGLE_BASE_URL;
use super::http::{self, HttpError, nullable};
use super::openai::DEFAULT_OPENAI_BASE_URL;
use super::openaicompat::DEFAULT_OPENAI_COMPAT_BASE_URL;

const DEFAULT_MODEL_LIST_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) fn list_models(profile_name: &str, profile: &LlmProfile) -> Result<Vec<String>> {
    match profile.provider.trim().to_lowercase().as_str() {
        "openai" => list_openai_models(profile),
        "anthropic" => list_anthropic_models(profile),
        "google" => list_google_models(profile),
        "claude_cli" => Ok(CLAUDE_CLI_MODELS.iter().map(|model| model.to_string()).collect()),
        "codex" => bail!(
            "Codex CLI model listing is unavailable; omit model to use the CLI default or enter a model ID manually"
        ),
        "openai_compat" => match profile_name.trim().to_lowercase().as_str() {
            "ollama" => list_ollama_models(profile),
            "deepseek" => Ok(vec!["deepseek-chat".to_string(), "deepseek-reasoner".to_string()]),
            "kimi" => Ok(vec!["kimi-k2.5".to_string()]),
            _ => bail!("model listing is not implemented for openai_compat profile {profile_name:?}"),
        },
        _ => bail!("model listing is not implemented for provider {:?}", profile.provider),
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct IdListEnvelope {
    #[serde(deserialize_with = "nullable")]
    data: Vec<IdItem>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct IdItem {
    #[serde(deserialize_with = "nullable")]
    id: String,
}

fn list_openai_models(profile: &LlmProfile) -> Result<Vec<String>> {
    if profile.api_key.trim().is_empty() {
        bail!("OpenAI API key is required to list models");
    }
    let base_url = non_blank_or(&profile.base_url, DEFAULT_OPENAI_BASE_URL);
    let endpoint = sibling_endpoint(base_url, "models")?;

    let auth = format!("Bearer {}", profile.api_key);
    let envelope: IdListEnvelope = get_json(&endpoint, &[("Authorization", &auth)]).context("list OpenAI models")?;

    // Embedding and moderation models cannot generate recommendations.
    let mut models: Vec<String> = envelope
        .data
        .iter()
        .map(|item| item.id.trim())
        .filter(|id| !id.is_empty() && !id.starts_with("text-embedding") && !id.contains("moderation"))
        .map(str::to_string)
        .collect();
    models.sort();
    Ok(models)
}

fn list_anthropic_models(profile: &LlmProfile) -> Result<Vec<String>> {
    if profile.api_key.trim().is_empty() {
        bail!("Anthropic API key is required to list models");
    }
    let base_url = non_blank_or(&profile.base_url, DEFAULT_ANTHROPIC_BASE_URL);
    let endpoint = sibling_endpoint(base_url, "models")?;

    let headers = [("x-api-key", profile.api_key.as_str()), ("anthropic-version", ANTHROPIC_VERSION)];
    let envelope: IdListEnvelope = get_json(&endpoint, &headers).context("list Anthropic models")?;

    let mut models: Vec<String> =
        envelope.data.iter().map(|item| item.id.trim()).filter(|id| !id.is_empty()).map(str::to_string).collect();
    models.sort();
    Ok(models)
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct GoogleModelsEnvelope {
    #[serde(deserialize_with = "nullable")]
    models: Vec<GoogleModel>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct GoogleModel {
    #[serde(deserialize_with = "nullable")]
    name: String,
    #[serde(deserialize_with = "nullable")]
    base_model_id: String,
    #[serde(deserialize_with = "nullable")]
    supported_generation_methods: Vec<Option<String>>,
}

fn list_google_models(profile: &LlmProfile) -> Result<Vec<String>> {
    if profile.api_key.trim().is_empty() {
        bail!("Google API key is required to list models");
    }
    let base_url = non_blank_or(&profile.base_url, DEFAULT_GOOGLE_BASE_URL);
    let mut endpoint = base_url.trim_end_matches('/').to_string();
    if !endpoint.ends_with("/models") {
        endpoint.push_str("/models");
    }
    let mut url = Url::parse(&endpoint).with_context(|| format!("parse Google model list URL {endpoint:?}"))?;
    set_query_param(&mut url, "key", &profile.api_key);

    let envelope: GoogleModelsEnvelope = get_json(url.as_str(), &[]).context("list Google models")?;

    let mut models: Vec<String> = envelope
        .models
        .iter()
        .filter(|item| {
            item.supported_generation_methods
                .iter()
                .any(|method| method.as_deref().unwrap_or("").trim().eq_ignore_ascii_case("generateContent"))
        })
        .map(|item| {
            let name = item.name.strip_prefix("models/").unwrap_or(&item.name);
            first_non_empty(&item.base_model_id, name).trim().to_string()
        })
        .filter(|id| !id.is_empty())
        .collect();
    models.sort();
    models.dedup();
    Ok(models)
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct OllamaTagsEnvelope {
    #[serde(deserialize_with = "nullable")]
    models: Vec<OllamaModel>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct OllamaModel {
    #[serde(deserialize_with = "nullable")]
    name: String,
    #[serde(deserialize_with = "nullable")]
    model: String,
}

fn list_ollama_models(profile: &LlmProfile) -> Result<Vec<String>> {
    let base_url = non_blank_or(&profile.base_url, DEFAULT_OPENAI_COMPAT_BASE_URL);
    let endpoint = ollama_tags_endpoint(base_url)?;

    let envelope: OllamaTagsEnvelope = get_json(&endpoint, &[]).context("list Ollama models")?;

    let mut models: Vec<String> = envelope
        .models
        .iter()
        .map(|item| first_non_empty(&item.model, &item.name).trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    models.sort();
    Ok(models)
}

fn get_json<T: DeserializeOwned + Default>(endpoint: &str, headers: &[(&str, &str)]) -> Result<T> {
    let agent = http::agent(DEFAULT_MODEL_LIST_TIMEOUT);
    let response = http::get(&agent, endpoint, headers).map_err(|err| match err {
        HttpError::Send(err) => anyhow::Error::new(err).context(format!("request {endpoint:?}")),
        HttpError::Read(err) => anyhow::Error::new(err).context(format!("read response {endpoint:?}")),
    })?;
    if response.status >= 400 {
        return Err(anyhow!("{endpoint} returned {}: {}", response.status_text(), response.body_text()));
    }
    http::decode_envelope(&response.body).with_context(|| format!("decode response {endpoint:?}"))
}

/// Derives a sibling endpoint (e.g. `/v1/models`) from a configured
/// generation endpoint such as `/v1/responses` or `/v1/messages`.
fn sibling_endpoint(base_url: &str, sibling: &str) -> Result<String> {
    let mut url = Url::parse(base_url.trim()).with_context(|| format!("parse base URL {base_url:?}"))?;

    let mut path = url.path().trim_end_matches('/').to_string();
    let mut trimmed_known_leaf = false;
    for leaf in ["/responses", "/messages"] {
        if let Some(parent) = path.strip_suffix(leaf) {
            path = parent.to_string();
            trimmed_known_leaf = true;
            break;
        }
    }

    let path = if path.is_empty() {
        format!("/{sibling}")
    } else if trimmed_known_leaf {
        format!("{path}/{sibling}")
    } else {
        // Replace the last path segment.
        match path.rsplit_once('/') {
            Some((parent, _)) => format!("{parent}/{sibling}"),
            None => sibling.to_string(),
        }
    };
    url.set_path(&path);
    url.set_query(None);
    Ok(url.to_string())
}

/// Ollama's native model list lives at `/api/tags` on the same host as its
/// OpenAI-compatible `/v1` API.
fn ollama_tags_endpoint(base_url: &str) -> Result<String> {
    let mut url = Url::parse(base_url.trim()).with_context(|| format!("parse Ollama base URL {base_url:?}"))?;
    url.set_query(None);
    url.set_path("/api/tags");
    Ok(url.to_string())
}

/// Like Go's `query.Set(key, value)` followed by `Encode()`: replaces the
/// key and writes parameters sorted by key.
fn set_query_param(url: &mut Url, key: &str, value: &str) {
    let mut pairs: Vec<(String, String)> =
        url.query_pairs().filter(|(name, _)| name != key).map(|(name, value)| (name.into(), value.into())).collect();
    pairs.push((key.to_string(), value.to_string()));
    pairs.sort_by(|left, right| left.0.cmp(&right.0));
    url.query_pairs_mut().clear().extend_pairs(pairs);
}

fn non_blank_or<'a>(value: &'a str, default: &'a str) -> &'a str {
    if value.trim().is_empty() { default } else { value.trim() }
}

fn first_non_empty<'a>(first: &'a str, second: &'a str) -> &'a str {
    if !first.trim().is_empty() {
        first
    } else if !second.trim().is_empty() {
        second
    } else {
        ""
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::test_support::MockServer;

    fn profile(provider: &str, api_key: &str, base_url: &str) -> LlmProfile {
        LlmProfile {
            provider: provider.into(),
            api_key: api_key.into(),
            base_url: base_url.into(),
            ..LlmProfile::default()
        }
    }

    #[test]
    fn returns_fixed_deepseek_and_kimi_choices() {
        assert_eq!(
            list_models("deepseek", &profile("openai_compat", "", "")).unwrap(),
            vec!["deepseek-chat", "deepseek-reasoner"]
        );
        assert_eq!(list_models("kimi", &profile("openai_compat", "", "")).unwrap(), vec!["kimi-k2.5"]);
    }

    #[test]
    fn openai_removes_responses_suffix_and_uses_auth() {
        let server = MockServer::start(
            200,
            r#"{"data":[{"id":"gpt-5.4"},{"id":"text-embedding-3-large"},{"id":"omni-moderation-latest"},{"id":"gpt-4o"}]}"#,
        );
        let models =
            list_models("openai", &profile("openai", "test-key", &format!("{}/v1/responses", server.url))).unwrap();
        assert_eq!(models, vec!["gpt-4o", "gpt-5.4"]);
        let sent = server.only_request();
        assert_eq!(sent.method, "GET");
        assert_eq!(sent.path, "/v1/models");
        assert_eq!(sent.header("Authorization"), Some("Bearer test-key"));
    }

    #[test]
    fn anthropic_uses_models_endpoint() {
        let server = MockServer::start(200, r#"{"data":[{"id":"claude-sonnet-4-5"}]}"#);
        let models =
            list_models("anthropic", &profile("anthropic", "test-key", &format!("{}/v1/messages", server.url)))
                .unwrap();
        assert_eq!(models, vec!["claude-sonnet-4-5"]);
        let sent = server.only_request();
        assert_eq!(sent.path, "/v1/models");
        assert_eq!(sent.header("x-api-key"), Some("test-key"));
        assert_eq!(sent.header("anthropic-version"), Some(ANTHROPIC_VERSION));
    }

    #[test]
    fn google_filters_generate_content_models() {
        let server = MockServer::start(
            200,
            r#"{"models":[
                {"name":"models/gemini-2.5-pro","baseModelId":"gemini-2.5-pro","supportedGenerationMethods":["generateContent"]},
                {"name":"models/text-embedding-004","baseModelId":"text-embedding-004","supportedGenerationMethods":["embedContent"]},
                {"name":"models/gemini-2.5-pro-001","supportedGenerationMethods":[" GENERATECONTENT "]},
                {"name":"models/gemini-2.5-pro","supportedGenerationMethods":["generateContent"]}
            ]}"#,
        );
        let models =
            list_models("google", &profile("google", "test-key", &format!("{}/v1beta/models", server.url))).unwrap();
        assert_eq!(models, vec!["gemini-2.5-pro", "gemini-2.5-pro-001"]);
        let sent = server.only_request();
        assert_eq!(sent.path, "/v1beta/models");
        assert_eq!(sent.query_param("key").as_deref(), Some("test-key"));
    }

    #[test]
    fn ollama_uses_tags_endpoint() {
        let server = MockServer::start(200, r#"{"models":[{"name":"qwen2.5:latest"},{"name":"llama3.1:8b"}]}"#);
        let models = list_models("ollama", &profile("openai_compat", "", &format!("{}/v1", server.url))).unwrap();
        assert_eq!(models, vec!["llama3.1:8b", "qwen2.5:latest"]);
        assert_eq!(server.only_request().path, "/api/tags");
    }

    #[test]
    fn returns_fixed_claude_cli_choices() {
        assert_eq!(
            list_models("claude_cli", &profile("claude_cli", "", "")).unwrap(),
            vec!["sonnet", "opus", "haiku", "fable"]
        );
    }

    #[test]
    fn reports_unsupported_and_missing_keys() {
        let err = |name: &str, provider: &str| list_models(name, &profile(provider, "", "")).unwrap_err().to_string();
        assert_eq!(
            err("codex", "codex"),
            "Codex CLI model listing is unavailable; omit model to use the CLI default or enter a model ID manually"
        );
        assert_eq!(
            err("local", "openai_compat"),
            "model listing is not implemented for openai_compat profile \"local\""
        );
        assert_eq!(err("x", "mystery"), "model listing is not implemented for provider \"mystery\"");
        assert_eq!(err("openai", "openai"), "OpenAI API key is required to list models");
        assert_eq!(err("anthropic", "anthropic"), "Anthropic API key is required to list models");
        assert_eq!(err("google", "google"), "Google API key is required to list models");

        let server = MockServer::start(403, "forbidden\n");
        let endpoint = format!("{}/v1/models", server.url);
        let err = list_models("openai", &profile("openai", "k", &format!("{}/v1/responses", server.url))).unwrap_err();
        assert_eq!(format!("{err:#}"), format!("list OpenAI models: {endpoint} returned 403 Forbidden: forbidden"));
    }

    #[test]
    fn endpoint_derivation() {
        let cases = [
            ("https://api.openai.com/v1/responses", "https://api.openai.com/v1/models"),
            ("https://api.anthropic.com/v1/messages/", "https://api.anthropic.com/v1/models"),
            ("https://proxy.example/v1/chat?x=1", "https://proxy.example/v1/models"),
            ("https://proxy.example", "https://proxy.example/models"),
            ("https://proxy.example/v1", "https://proxy.example/models"),
        ];
        for (base, want) in cases {
            assert_eq!(sibling_endpoint(base, "models").unwrap(), want, "{base}");
        }
        assert_eq!(ollama_tags_endpoint("http://localhost:11434/v1?x=1").unwrap(), "http://localhost:11434/api/tags");

        let mut url = Url::parse("https://g.example/models?z=1&key=old&a=2").unwrap();
        set_query_param(&mut url, "key", "new");
        assert_eq!(url.as_str(), "https://g.example/models?a=2&key=new&z=1");
    }
}
