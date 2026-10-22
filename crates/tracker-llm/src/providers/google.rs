//! Google Gemini via the generateContent endpoint, requesting JSON output
//! when the discovery layer provides a schema.

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::http::{self, DEFAULT_PROVIDER_TIMEOUT, nullable};
use crate::{Provider, Request, gojson};

pub(crate) const DEFAULT_GOOGLE_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_GOOGLE_MODEL: &str = "gemini-2.5-pro";

pub struct GoogleProvider {
    pub(crate) api_key: String,
    pub(crate) model: String,
    pub(crate) base_url: String,
    agent: ureq::Agent,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ResponseEnvelope {
    #[serde(deserialize_with = "nullable")]
    candidates: Vec<Candidate>,
    error: Option<GoogleError>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Candidate {
    #[serde(deserialize_with = "nullable")]
    content: CandidateContent,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct CandidateContent {
    #[serde(deserialize_with = "nullable")]
    parts: Vec<Part>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Part {
    #[serde(deserialize_with = "nullable")]
    text: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct GoogleError {
    #[serde(deserialize_with = "nullable")]
    message: String,
}

impl GoogleProvider {
    /// The base URL is the models collection; the model name and
    /// `:generateContent` are appended per request.
    pub fn new(api_key: &str, model: &str, base_url: &str) -> Result<GoogleProvider> {
        if api_key.trim().is_empty() {
            bail!("Google API key is required");
        }
        let model = if model.trim().is_empty() { DEFAULT_GOOGLE_MODEL } else { model };
        let base_url = if base_url.trim().is_empty() { DEFAULT_GOOGLE_BASE_URL } else { base_url };
        Ok(GoogleProvider {
            api_key: api_key.to_string(),
            model: model.to_string(),
            base_url: base_url.trim_end_matches('/').to_string(),
            agent: http::agent(DEFAULT_PROVIDER_TIMEOUT),
        })
    }

    fn build_request(&self, req: &Request) -> Result<Vec<u8>> {
        let mut body = json!({
            "contents": [{
                "parts": [{"text": req.user_prompt}],
                "role": "user",
            }],
        });
        if !req.system_prompt.trim().is_empty() {
            body["systemInstruction"] = json!({"parts": [{"text": req.system_prompt}]});
        }

        let mut generation_config = Map::new();
        if req.temperature > 0.0 {
            generation_config.insert("temperature".into(), json!(req.temperature));
        }
        if req.max_output_tokens > 0 {
            generation_config.insert("maxOutputTokens".into(), json!(req.max_output_tokens));
        }
        if let Some(schema) = &req.schema {
            generation_config.insert("responseMimeType".into(), json!("application/json"));
            generation_config.insert("responseJsonSchema".into(), schema.schema.clone());
        }
        if !generation_config.is_empty() {
            body["generationConfig"] = Value::Object(generation_config);
        }
        Ok(gojson::to_string(&body).context("marshal Google request")?.into_bytes())
    }
}

impl Provider for GoogleProvider {
    fn generate(&self, req: &Request) -> Result<String> {
        let payload = self.build_request(req)?;
        let endpoint = format!("{}/{}:generateContent", self.base_url, self.model);
        let headers = [("x-goog-api-key", self.api_key.as_str()), ("Content-Type", "application/json")];
        let response = http::post(&self.agent, &endpoint, &headers, &payload)
            .map_err(|err| err.into_anyhow("call Gemini generateContent API", "read Google response"))?;
        if response.status >= 400 {
            bail!("Gemini generateContent API returned {}: {}", response.status_text(), response.body_text());
        }

        let envelope: ResponseEnvelope =
            http::decode_envelope(&response.body).context("decode Google response envelope")?;
        if let Some(error) = &envelope.error
            && !error.message.trim().is_empty()
        {
            return Err(anyhow!("{}", error.message));
        }

        envelope
            .candidates
            .iter()
            .flat_map(|candidate| &candidate.content.parts)
            .map(|part| part.text.trim())
            .find(|text| !text.is_empty())
            .map(str::to_string)
            .ok_or_else(|| anyhow!("Gemini response did not include generated text"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::test_support::MockServer;
    use crate::{JsonSchema, StructuredOutputMode};

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
    fn uses_json_schema_and_parses_response_text() {
        let server = MockServer::start(
            200,
            r#"{"candidates":[{"content":{"parts":[{"text":"{\"summary\":\"You like vivid, high-energy pianists.\",\"recommendations\":[{\"pianist_name\":\"Radu Lupu\",\"why_fit\":\"lyrical contrast\",\"similar_to\":[\"Martha Argerich\"],\"confidence\":\"medium\"}]}"}]}}]}"#,
        );
        let provider =
            GoogleProvider::new("test-key", "gemini-2.5-pro", &format!("{}/v1beta/models/", server.url)).unwrap();
        let raw = provider.generate(&request()).unwrap();
        assert!(raw.starts_with("{\"summary\""), "{raw}");

        let sent = server.only_request();
        assert_eq!(sent.method, "POST");
        assert_eq!(sent.path, "/v1beta/models/gemini-2.5-pro:generateContent");
        assert_eq!(sent.header("x-goog-api-key"), Some("test-key"));
        let body = sent.json();
        assert_eq!(body["generationConfig"]["responseMimeType"], "application/json");
        assert_eq!(body["generationConfig"]["responseJsonSchema"], json!({"type": "object"}));
        assert!(body["generationConfig"].get("temperature").is_none());
        assert_eq!(body["systemInstruction"], json!({"parts": [{"text": "system prompt"}]}));
        assert_eq!(body["contents"], json!([{"role": "user", "parts": [{"text": "user prompt"}]}]));
    }

    #[test]
    fn omits_empty_config_and_reports_errors() {
        let server = MockServer::start(
            200,
            r#"{"candidates":[{"content":{"parts":[{"text":"  "}]}},{"content":{"parts":[{"text":" ok "}]}}]}"#,
        );
        let provider = GoogleProvider::new("k", "", &server.url).unwrap();
        let req = Request { system_prompt: " ".into(), schema: None, ..request() };
        assert_eq!(provider.generate(&req).unwrap(), "ok");
        let sent = server.only_request();
        assert_eq!(sent.path, "/gemini-2.5-pro:generateContent");
        let body = sent.json();
        assert!(body.get("generationConfig").is_none());
        assert!(body.get("systemInstruction").is_none());

        let server = MockServer::start(200, r#"{"candidates":[]}"#);
        let req = Request { temperature: 0.5, max_output_tokens: 99, ..request() };
        let err = GoogleProvider::new("k", "", &server.url).unwrap().generate(&req).unwrap_err();
        assert_eq!(err.to_string(), "Gemini response did not include generated text");
        let body = server.only_request().json();
        assert_eq!(body["generationConfig"]["temperature"], 0.5);
        assert_eq!(body["generationConfig"]["maxOutputTokens"], 99);

        let server = MockServer::start(200, r#"{"error":{"message":"API key not valid","status":"INVALID_ARGUMENT"}}"#);
        let err = GoogleProvider::new("k", "", &server.url).unwrap().generate(&req).unwrap_err();
        assert_eq!(err.to_string(), "API key not valid");
    }

    #[test]
    fn uses_longer_default_timeout() {
        let provider = GoogleProvider::new("test-key", "", "").unwrap();
        assert_eq!(provider.agent.config().timeouts().global, Some(DEFAULT_PROVIDER_TIMEOUT));
        assert_eq!(provider.model, DEFAULT_GOOGLE_MODEL);
        assert_eq!(provider.base_url, DEFAULT_GOOGLE_BASE_URL);
    }
}
