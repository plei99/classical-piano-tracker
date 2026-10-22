//! OpenAI via the Responses API with strict JSON-schema output.

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde_json::json;

use super::http::{self, ApiError, DEFAULT_PROVIDER_TIMEOUT, nullable};
use crate::{Provider, Request, gojson};

pub(crate) const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1/responses";
pub(crate) const DEFAULT_OPENAI_MODEL: &str = "gpt-5.4";

pub struct OpenAiProvider {
    pub(crate) api_key: String,
    pub(crate) model: String,
    pub(crate) base_url: String,
    agent: ureq::Agent,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ResponseEnvelope {
    #[serde(deserialize_with = "nullable")]
    output_text: String,
    #[serde(deserialize_with = "nullable")]
    output: Vec<OutputItem>,
    error: Option<ApiError>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct OutputItem {
    #[serde(deserialize_with = "nullable")]
    content: Vec<OutputContent>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct OutputContent {
    #[serde(deserialize_with = "nullable")]
    text: String,
}

impl OpenAiProvider {
    /// Blank model and base URL fall back to the defaults; the base URL is
    /// the full Responses endpoint so tests and proxies can redirect it.
    pub fn new(api_key: &str, model: &str, base_url: &str) -> Result<OpenAiProvider> {
        if api_key.trim().is_empty() {
            bail!("OpenAI API key is required");
        }
        let model = if model.trim().is_empty() { DEFAULT_OPENAI_MODEL } else { model };
        let base_url = if base_url.trim().is_empty() { DEFAULT_OPENAI_BASE_URL } else { base_url };
        Ok(OpenAiProvider {
            api_key: api_key.to_string(),
            model: model.to_string(),
            base_url: base_url.to_string(),
            agent: http::agent(DEFAULT_PROVIDER_TIMEOUT),
        })
    }

    fn build_request(&self, req: &Request) -> Result<Vec<u8>> {
        let mut body = json!({
            "input": [
                {"content": req.system_prompt, "role": "system"},
                {"content": req.user_prompt, "role": "user"},
            ],
            "model": self.model,
        });
        if let Some(schema) = &req.schema {
            body["text"] = json!({
                "format": {
                    "name": schema.name,
                    "schema": schema.schema,
                    "strict": schema.strict,
                    "type": "json_schema",
                },
            });
        }
        Ok(gojson::to_string(&body).context("marshal OpenAI request")?.into_bytes())
    }
}

impl Provider for OpenAiProvider {
    fn generate(&self, req: &Request) -> Result<String> {
        let payload = self.build_request(req)?;
        let auth = format!("Bearer {}", self.api_key);
        let response = http::post(
            &self.agent,
            &self.base_url,
            &[("Authorization", &auth), ("Content-Type", "application/json")],
            &payload,
        )
        .map_err(|err| err.into_anyhow("call OpenAI Responses API", "read OpenAI response"))?;
        if response.status >= 400 {
            bail!("OpenAI Responses API returned {}: {}", response.status_text(), response.body_text());
        }

        let envelope: ResponseEnvelope =
            http::decode_envelope(&response.body).context("decode OpenAI response envelope")?;
        if let Some(message) = http::api_error_message(envelope.error.as_ref()) {
            return Err(anyhow!("{message}"));
        }

        let mut raw = envelope.output_text.trim().to_string();
        if raw.is_empty() {
            raw = extract_output_text(&envelope);
        }
        if raw.is_empty() {
            bail!("OpenAI response did not include structured output text");
        }
        Ok(raw)
    }
}

/// Falls back to joining the text parts when `output_text` is absent.
fn extract_output_text(envelope: &ResponseEnvelope) -> String {
    envelope
        .output
        .iter()
        .flat_map(|item| &item.content)
        .filter(|content| !content.text.trim().is_empty())
        .map(|content| content.text.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::StructuredOutputMode;
    use crate::providers::test_support::MockServer;
    use std::time::Duration;

    fn request() -> Request {
        Request {
            system_prompt: "system prompt".into(),
            user_prompt: "user prompt".into(),
            output_mode: StructuredOutputMode::Strict,
            schema: Some(crate::JsonSchema {
                name: "pianist_discovery".into(),
                schema: json!({"type": "object"}),
                strict: true,
            }),
            temperature: 0.0,
            max_output_tokens: 0,
        }
    }

    #[test]
    fn uses_structured_request_and_parses_response_text() {
        let server = MockServer::start(
            200,
            r#"{"output_text":"{\"summary\":\"You like vivid, high-energy pianists.\",\"recommendations\":[{\"pianist_name\":\"Radu Lupu\",\"why_fit\":\"lyrical contrast\",\"similar_to\":[\"Martha Argerich\"],\"confidence\":\"medium\"}]}"}"#,
        );
        let provider = OpenAiProvider::new("test-key", "gpt-4o-mini", &server.url).unwrap();
        let raw = provider.generate(&request()).unwrap();
        assert!(raw.starts_with("{\"summary\""), "{raw}");

        let sent = server.only_request();
        assert_eq!(sent.method, "POST");
        assert_eq!(sent.header("Authorization"), Some("Bearer test-key"));
        assert_eq!(sent.header("Content-Type"), Some("application/json"));
        let body = sent.json();
        assert_eq!(body["model"], "gpt-4o-mini");
        assert_eq!(body["input"][0], json!({"role": "system", "content": "system prompt"}));
        assert_eq!(body["input"][1], json!({"role": "user", "content": "user prompt"}));
        assert_eq!(body["text"]["format"]["type"], "json_schema");
        assert_eq!(body["text"]["format"]["name"], "pianist_discovery");
        assert_eq!(body["text"]["format"]["strict"], true);
        assert_eq!(body["text"]["format"]["schema"], json!({"type": "object"}));
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn falls_back_to_output_parts_and_reports_errors() {
        let server = MockServer::start(
            200,
            r#"{"output_text":null,"output":[{"type":"message","content":[{"type":"output_text","text":"part one"},{"text":"  "},{"text":"part two"}]}]}"#,
        );
        let provider = OpenAiProvider::new("k", "", &server.url).unwrap();
        let req = Request { schema: None, ..request() };
        assert_eq!(provider.generate(&req).unwrap(), "part one\npart two");
        assert!(server.only_request().json().get("text").is_none());

        let server = MockServer::start(200, r#"{"error":{"message":"quota exceeded"}}"#);
        let err = OpenAiProvider::new("k", "", &server.url).unwrap().generate(&req).unwrap_err();
        assert_eq!(format!("{err:#}"), "quota exceeded");

        let server = MockServer::start(200, "null");
        let err = OpenAiProvider::new("k", "", &server.url).unwrap().generate(&req).unwrap_err();
        assert_eq!(format!("{err:#}"), "OpenAI response did not include structured output text");

        let server = MockServer::start(401, " {\"error\":\"bad key\"}\n");
        let err = OpenAiProvider::new("k", "", &server.url).unwrap().generate(&req).unwrap_err();
        assert_eq!(format!("{err:#}"), r#"OpenAI Responses API returned 401 Unauthorized: {"error":"bad key"}"#);

        let server = MockServer::start(200, "not json");
        let err = OpenAiProvider::new("k", "", &server.url).unwrap().generate(&req).unwrap_err();
        assert!(format!("{err:#}").starts_with("decode OpenAI response envelope: "), "{err:#}");
    }

    #[test]
    fn uses_longer_default_timeout_and_defaults() {
        let provider = OpenAiProvider::new("test-key", "gpt-5.4", "https://api.openai.com/v1/responses").unwrap();
        assert_eq!(provider.agent.config().timeouts().global, Some(DEFAULT_PROVIDER_TIMEOUT));
        assert!(provider.agent.config().timeouts().global > Some(Duration::from_secs(30)));

        let provider = OpenAiProvider::new("k", " ", "").unwrap();
        assert_eq!(provider.model, DEFAULT_OPENAI_MODEL);
        assert_eq!(provider.base_url, DEFAULT_OPENAI_BASE_URL);
        assert_eq!(OpenAiProvider::new(" ", "", "").err().unwrap().to_string(), "OpenAI API key is required");
    }
}
