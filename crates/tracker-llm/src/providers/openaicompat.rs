//! Chat Completions adapter for OpenAI-compatible APIs such as Ollama, Kimi,
//! and DeepSeek.
//!
//! It deliberately avoids provider-specific JSON features that many
//! compatible backends only partially implement, relying on the shared
//! discovery repair and fallback logic instead.

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde_json::{Value, json};

use super::http::{self, ApiError, DEFAULT_PROVIDER_TIMEOUT, nullable};
use crate::{Provider, Request, gojson};

pub(crate) const DEFAULT_OPENAI_COMPAT_BASE_URL: &str = "http://localhost:11434/v1";

pub struct OpenAiCompatProvider {
    pub(crate) api_key: String,
    pub(crate) model: String,
    pub(crate) base_url: String,
    agent: ureq::Agent,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ResponseEnvelope {
    #[serde(deserialize_with = "nullable")]
    choices: Vec<Choice>,
    error: Option<ApiError>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Choice {
    #[serde(deserialize_with = "nullable")]
    message: ChoiceMessage,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ChoiceMessage {
    /// Either a string or an array of `{"text": ...}` parts.
    content: Value,
}

impl OpenAiCompatProvider {
    /// The API key is optional (local Ollama needs none). The base URL may be
    /// the API root or the full `/chat/completions` endpoint.
    pub fn new(api_key: &str, model: &str, base_url: &str) -> Result<OpenAiCompatProvider> {
        if model.trim().is_empty() {
            bail!("OpenAI-compatible model is required");
        }
        let base_url = if base_url.trim().is_empty() { DEFAULT_OPENAI_COMPAT_BASE_URL } else { base_url };
        Ok(OpenAiCompatProvider {
            api_key: api_key.trim().to_string(),
            model: model.trim().to_string(),
            base_url: base_url.trim_end_matches('/').to_string(),
            agent: http::agent(DEFAULT_PROVIDER_TIMEOUT),
        })
    }

    fn build_request(&self, req: &Request) -> Result<Vec<u8>> {
        let mut body = json!({
            "messages": [
                {"content": req.system_prompt, "role": "system"},
                {"content": req.user_prompt, "role": "user"},
            ],
            "model": self.model,
        });
        if req.temperature > 0.0 {
            body["temperature"] = json!(req.temperature);
        }
        if req.max_output_tokens > 0 {
            body["max_tokens"] = json!(req.max_output_tokens);
        }
        Ok(gojson::to_string(&body).context("marshal OpenAI-compatible request")?.into_bytes())
    }
}

impl Provider for OpenAiCompatProvider {
    fn generate(&self, req: &Request) -> Result<String> {
        let payload = self.build_request(req)?;
        let mut endpoint = self.base_url.clone();
        if !endpoint.ends_with("/chat/completions") {
            endpoint.push_str("/chat/completions");
        }

        let auth = format!("Bearer {}", self.api_key);
        let mut headers = vec![("Content-Type", "application/json")];
        if !self.api_key.is_empty() {
            headers.push(("Authorization", auth.as_str()));
        }
        let response = http::post(&self.agent, &endpoint, &headers, &payload).map_err(|err| {
            err.into_anyhow("call OpenAI-compatible chat completions API", "read OpenAI-compatible response")
        })?;
        if response.status >= 400 {
            bail!(
                "OpenAI-compatible chat completions API returned {}: {}",
                response.status_text(),
                response.body_text()
            );
        }

        let envelope: ResponseEnvelope =
            http::decode_envelope(&response.body).context("decode OpenAI-compatible response envelope")?;
        if let Some(message) = http::api_error_message(envelope.error.as_ref()) {
            return Err(anyhow!("{message}"));
        }

        envelope
            .choices
            .iter()
            .map(|choice| extract_chat_message_content(&choice.message.content).trim().to_string())
            .find(|raw| !raw.is_empty())
            .ok_or_else(|| anyhow!("OpenAI-compatible response did not include message content"))
    }
}

/// Accepts the plain-string form and the array-of-parts form. Anything else
/// (including a malformed parts array) counts as no content, as in Go.
fn extract_chat_message_content(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => {
            let mut texts = Vec::new();
            for part in parts {
                let text = match part {
                    Value::Null => "",
                    Value::Object(map) => match map.get("text") {
                        None | Some(Value::Null) => "",
                        Some(Value::String(text)) => text,
                        Some(_) => return String::new(),
                    },
                    _ => return String::new(),
                };
                if !text.trim().is_empty() {
                    texts.push(text);
                }
            }
            texts.join("\n")
        }
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::StructuredOutputMode;
    use crate::providers::test_support::MockServer;

    fn request() -> Request {
        Request {
            system_prompt: "system prompt".into(),
            user_prompt: "user prompt".into(),
            output_mode: StructuredOutputMode::PromptOnly,
            schema: None,
            temperature: 0.0,
            max_output_tokens: 0,
        }
    }

    #[test]
    fn uses_chat_completions_and_optional_auth() {
        let server = MockServer::start(
            200,
            r#"{"choices":[{"message":{"content":"{\"summary\":\"You like vivid, high-energy pianists.\",\"recommendations\":[{\"pianist_name\":\"Radu Lupu\",\"why_fit\":\"lyrical contrast\",\"similar_to\":[\"Martha Argerich\"],\"confidence\":\"medium\"}]}"}}]}"#,
        );
        let provider = OpenAiCompatProvider::new("", "qwen2.5:latest", &format!("{}/v1", server.url)).unwrap();
        let raw = provider.generate(&request()).unwrap();
        assert!(!raw.is_empty());

        let sent = server.only_request();
        assert_eq!(sent.method, "POST");
        assert_eq!(sent.path, "/v1/chat/completions");
        assert_eq!(sent.header("Authorization"), None, "no-key profile omits auth");
        let body = sent.json();
        assert_eq!(body["model"], "qwen2.5:latest");
        assert_eq!(body["messages"].as_array().unwrap().len(), 2);
        assert!(body.get("temperature").is_none() && body.get("max_tokens").is_none());
    }

    #[test]
    fn uses_auth_when_api_key_present() {
        let server = MockServer::start(200, r#"{"choices":[{"message":{"content":"ok"}}]}"#);
        let provider = OpenAiCompatProvider::new("test-key", "deepseek-chat", &server.url).unwrap();
        let req = Request { temperature: 0.7, max_output_tokens: 512, ..request() };
        assert_eq!(provider.generate(&req).unwrap(), "ok");
        let sent = server.only_request();
        assert_eq!(sent.header("Authorization"), Some("Bearer test-key"));
        assert_eq!(sent.path, "/chat/completions");
        let body = sent.json();
        assert_eq!(body["temperature"], 0.7);
        assert_eq!(body["max_tokens"], 512);
    }

    #[test]
    fn keeps_full_endpoint_and_parses_content_parts() {
        let server = MockServer::start(
            200,
            r#"{"choices":[{"message":{"content":null}},{"message":{"content":[{"type":"text","text":"a"},null,{"text":" "},{"text":"b"}]}}]}"#,
        );
        let provider = OpenAiCompatProvider::new("", " m ", &format!("{}/api/chat/completions/", server.url)).unwrap();
        assert_eq!(provider.model, "m");
        assert_eq!(provider.generate(&request()).unwrap(), "a\nb");
        assert_eq!(server.only_request().path, "/api/chat/completions");

        assert_eq!(extract_chat_message_content(&json!([{"text": 5}, {"text": "x"}])), "");
        assert_eq!(extract_chat_message_content(&json!(["x"])), "");

        let server = MockServer::start(200, r#"{"choices":[]}"#);
        let err = OpenAiCompatProvider::new("", "m", &server.url).unwrap().generate(&request()).unwrap_err();
        assert_eq!(err.to_string(), "OpenAI-compatible response did not include message content");
        assert_eq!(
            OpenAiCompatProvider::new("", " ", "").err().unwrap().to_string(),
            "OpenAI-compatible model is required"
        );
    }
}
