//! Shared blocking HTTP plumbing for the API-backed providers and the model
//! catalog.

use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};
use ureq::Agent;

/// Model calls can take well over the 30s that many clients default to.
pub(crate) const DEFAULT_PROVIDER_TIMEOUT: Duration = Duration::from_secs(90);

/// An agent that reports HTTP error statuses as responses, so callers can
/// include the status and body in their own error messages as Go does.
pub(crate) fn agent(timeout: Duration) -> Agent {
    Agent::new_with_config(Agent::config_builder().timeout_global(Some(timeout)).http_status_as_error(false).build())
}

pub(crate) struct HttpResponse {
    pub status: u16,
    reason: Option<&'static str>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    /// The status the way Go's `resp.Status` renders it, e.g. "404 Not Found".
    pub fn status_text(&self) -> String {
        match self.reason {
            Some(reason) => format!("{} {reason}", self.status),
            None => self.status.to_string(),
        }
    }

    /// The body as text with surrounding whitespace removed.
    pub fn body_text(&self) -> String {
        String::from_utf8_lossy(&self.body).trim().to_string()
    }
}

/// Separates connection failures from body-read failures because Go words
/// them differently ("call ..." vs "read ...").
pub(crate) enum HttpError {
    Send(ureq::Error),
    Read(ureq::Error),
}

impl HttpError {
    pub fn into_anyhow(self, send_context: &str, read_context: &str) -> anyhow::Error {
        match self {
            HttpError::Send(err) => anyhow::Error::new(err).context(send_context.to_string()),
            HttpError::Read(err) => anyhow::Error::new(err).context(read_context.to_string()),
        }
    }
}

pub(crate) fn post(agent: &Agent, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<HttpResponse, HttpError> {
    let mut request = agent.post(url);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    finish(request.send(body))
}

pub(crate) fn get(agent: &Agent, url: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, HttpError> {
    let mut request = agent.get(url);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    finish(request.call())
}

fn finish(result: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> Result<HttpResponse, HttpError> {
    let mut response = result.map_err(HttpError::Send)?;
    let status = response.status();
    // Go's io.ReadAll has no cap; lift ureq's default 10 MB limit to match.
    let body = response.body_mut().with_config().limit(u64::MAX).read_to_vec().map_err(HttpError::Read)?;
    Ok(HttpResponse { status: status.as_u16(), reason: status.canonical_reason(), body })
}

/// Decodes a response envelope where a top-level `null` means "all fields
/// empty", as with Go's json.Unmarshal into a struct.
pub(crate) fn decode_envelope<T: DeserializeOwned + Default>(body: &[u8]) -> serde_json::Result<T> {
    serde_json::from_slice::<Option<T>>(body).map(Option::unwrap_or_default)
}

/// Treats an explicit JSON `null` like a missing field, as Go does.
pub(crate) fn nullable<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// The `{"error": {"message": ...}}` shape shared by several APIs.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct ApiError {
    #[serde(deserialize_with = "nullable")]
    pub message: String,
}

/// Go returns a provider's error message verbatim as the error text.
pub(crate) fn api_error_message(error: Option<&ApiError>) -> Option<&str> {
    error.map(|error| error.message.as_str()).filter(|message| !message.trim().is_empty())
}
