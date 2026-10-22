//! Anthropic via the Messages API. Structured output is obtained by forcing a
//! tool call, so Claude returns JSON-shaped tool input instead of free text.

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::http::{self, ApiError, DEFAULT_PROVIDER_TIMEOUT, nullable};
use crate::{Provider, Request, gojson};

pub(crate) const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com/v1/messages";
const DEFAULT_ANTHROPIC_MODEL: &str = "claude-sonnet-4-5";
pub(crate) const ANTHROPIC_VERSION: &str = "2023-06-01";
const ANTHROPIC_TOOL_NAME: &str = "emit_recommendations";
const MIN_MAX_TOKENS: usize = 1024;

pub struct AnthropicProvider {
    pub(crate) api_key: String,
    pub(crate) model: String,
    pub(crate) base_url: String,
    agent: ureq::Agent,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ResponseEnvelope {
    #[serde(deserialize_with = "nullable")]
    content: Vec<ContentItem>,
    error: Option<ApiError>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ContentItem {
    #[serde(rename = "type", deserialize_with = "nullable")]
    kind: String,
    #[serde(deserialize_with = "nullable")]
    text: String,
    #[serde(deserialize_with = "nullable")]
    input: Map<String, Value>,
}

impl AnthropicProvider {
    pub fn new(api_key: &str, model: &str, base_url: &str) -> Result<AnthropicProvider> {
        if api_key.trim().is_empty() {
            bail!("Anthropic API key is required");
        }
        let model = if model.trim().is_empty() { DEFAULT_ANTHROPIC_MODEL } else { model };
        let base_url = if base_url.trim().is_empty() { DEFAULT_ANTHROPIC_BASE_URL } else { base_url };
        Ok(AnthropicProvider {
            api_key: api_key.to_string(),
            model: model.to_string(),
            base_url: base_url.to_string(),
            agent: http::agent(DEFAULT_PROVIDER_TIMEOUT),
        })
    }

    fn build_request(&self, req: &Request) -> Result<Vec<u8>> {
        let mut body = json!({
            "max_tokens": req.max_output_tokens.max(MIN_MAX_TOKENS),
            "messages": [{
                "content": [{"text": req.user_prompt, "type": "text"}],
                "role": "user",
            }],
            "model": self.model,
            "system": req.system_prompt,
        });
        if req.temperature > 0.0 {
            body["temperature"] = json!(req.temperature);
        }
        if let Some(schema) = &req.schema {
            body["tools"] = json!([{
                "description": "Return the final pianist recommendation result as structured JSON. The input must include both a non-empty summary and a non-empty recommendations array.",
                "input_schema": schema.schema,
                "name": ANTHROPIC_TOOL_NAME,
            }]);
            body["tool_choice"] = json!({"name": ANTHROPIC_TOOL_NAME, "type": "tool"});
        }
        Ok(gojson::to_string(&body).context("marshal Anthropic request")?.into_bytes())
    }
}

impl Provider for AnthropicProvider {
    fn generate(&self, req: &Request) -> Result<String> {
        let payload = self.build_request(req)?;
        let headers = [
            ("x-api-key", self.api_key.as_str()),
            ("anthropic-version", ANTHROPIC_VERSION),
            ("Content-Type", "application/json"),
        ];
        let response = http::post(&self.agent, &self.base_url, &headers, &payload)
            .map_err(|err| err.into_anyhow("call Anthropic Messages API", "read Anthropic response"))?;
        if response.status >= 400 {
            bail!("Anthropic Messages API returned {}: {}", response.status_text(), response.body_text());
        }

        let envelope: ResponseEnvelope =
            http::decode_envelope(&response.body).context("decode Anthropic response envelope")?;
        if let Some(message) = http::api_error_message(envelope.error.as_ref()) {
            return Err(anyhow!("{message}"));
        }

        if let Some(item) = envelope.content.iter().find(|item| item.kind == "tool_use" && !item.input.is_empty()) {
            return gojson::to_string(&item.input).context("marshal Anthropic tool result");
        }

        let raw = envelope
            .content
            .iter()
            .filter(|item| !item.text.trim().is_empty())
            .map(|item| item.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();
        if raw.is_empty() {
            bail!("Anthropic response did not include tool output or text content");
        }
        Ok(raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::test_support::MockServer;
    use crate::{JsonSchema, StructuredOutputMode};
    use std::time::Duration;

    fn request() -> Request {
        Request {
            system_prompt: "system prompt".into(),
            user_prompt: "user prompt".into(),
            output_mode: StructuredOutputMode::Strict,
            schema: Some(JsonSchema {
                name: "pianist_discovery".into(),
                schema: json!({"type": "object"}),
                strict: true,
            }),
            temperature: 0.0,
            max_output_tokens: 0,
        }
    }

    #[test]
    fn uses_tool_schema_and_parses_tool_input() {
        let server = MockServer::start(
            200,
            r#"{"content":[{"type":"tool_use","name":"emit_recommendations","input":{"summary":"You like vivid, high-energy pianists.","recommendations":[{"pianist_name":"Radu Lupu","why_fit":"lyrical contrast","similar_to":["Martha Argerich"],"confidence":"medium"}]}}]}"#,
        );
        let provider = AnthropicProvider::new("test-key", "claude-sonnet-4-5", &server.url).unwrap();
        let raw = provider.generate(&request()).unwrap();
        // Re-marshaled the way Go's json.Marshal does: sorted keys.
        assert_eq!(
            raw,
            r#"{"recommendations":[{"confidence":"medium","pianist_name":"Radu Lupu","similar_to":["Martha Argerich"],"why_fit":"lyrical contrast"}],"summary":"You like vivid, high-energy pianists."}"#
        );

        let sent = server.only_request();
        assert_eq!(sent.method, "POST");
        assert_eq!(sent.header("x-api-key"), Some("test-key"));
        assert_eq!(sent.header("anthropic-version"), Some(ANTHROPIC_VERSION));
        let body = sent.json();
        let tools = body["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], ANTHROPIC_TOOL_NAME);
        assert_eq!(tools[0]["input_schema"], json!({"type": "object"}));
        assert_eq!(body["tool_choice"], json!({"type": "tool", "name": ANTHROPIC_TOOL_NAME}));
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["content"].as_array().unwrap().len(), 1);
        assert_eq!(messages[0]["content"][0], json!({"type": "text", "text": "user prompt"}));
        assert_eq!(body["system"], "system prompt");
        assert_eq!(body["max_tokens"], 1024);
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn sends_temperature_and_larger_max_tokens_and_reads_text() {
        let server = MockServer::start(
            200,
            r#"{"content":[{"type":"text","text":" line one "},{"type":"tool_use","input":{}},{"type":"text","text":"two"}]}"#,
        );
        let provider = AnthropicProvider::new("k", "", &server.url).unwrap();
        let req = Request { schema: None, temperature: 0.3, max_output_tokens: 4096, ..request() };
        assert_eq!(provider.generate(&req).unwrap(), "line one \ntwo");
        let body = server.only_request().json();
        assert_eq!(body["temperature"], 0.3);
        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["model"], DEFAULT_ANTHROPIC_MODEL);
        assert!(body.get("tools").is_none());

        let server = MockServer::start(200, r#"{"content":[]}"#);
        let err = AnthropicProvider::new("k", "", &server.url).unwrap().generate(&req).unwrap_err();
        assert_eq!(err.to_string(), "Anthropic response did not include tool output or text content");

        let server = MockServer::start(529, "overloaded");
        let err = AnthropicProvider::new("k", "", &server.url).unwrap().generate(&req).unwrap_err();
        assert_eq!(err.to_string(), "Anthropic Messages API returned 529: overloaded");
    }

    #[test]
    fn uses_longer_default_timeout() {
        let provider = AnthropicProvider::new("test-key", "claude-sonnet-4-5", DEFAULT_ANTHROPIC_BASE_URL).unwrap();
        assert_eq!(provider.agent.config().timeouts().global, Some(DEFAULT_PROVIDER_TIMEOUT));
        assert!(provider.agent.config().timeouts().global > Some(Duration::from_secs(30)));
        assert_eq!(AnthropicProvider::new("", "", "").err().unwrap().to_string(), "Anthropic API key is required");
    }
}
