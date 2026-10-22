//! The slice of golang.org/x/oauth2 the Go build relied on: the authorize URL,
//! the token endpoint round trip, refresh, and expiry checks. Error wording
//! mirrors oauth2's so failures read the same as they did in Go.

use std::fmt;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use jiff::{SignedDuration, Timestamp};
use serde::Deserialize;
use tracker_core::config::Token;
use ureq::Agent;

/// Default production host for the authorize and token endpoints.
pub const ACCOUNTS_BASE_URL: &str = "https://accounts.spotify.com";

/// oauth2 treats a token as expired this long before its actual expiry so
/// a request never races the deadline.
const EXPIRY_DELTA: SignedDuration = SignedDuration::from_secs(10);

/// oauth2 reads at most 1 MiB of a token response.
const MAX_TOKEN_RESPONSE_BYTES: u64 = 1 << 20;

/// Go's http.Client has no default timeout; a hung Spotify endpoint should
/// not wedge the CLI or a TUI worker forever, so every request gets one.
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// Builds the agent shared by OAuth and API calls. Status codes are handled
/// by the callers so Spotify's error bodies can be surfaced.
pub(crate) fn new_agent() -> Agent {
    Agent::config_builder().timeout_global(Some(HTTP_TIMEOUT)).http_status_as_error(false).build().into()
}

/// Client credentials plus the endpoints derived from the accounts host.
#[derive(Debug, Clone)]
pub(crate) struct OAuthConfig {
    pub client_id: String,
    pub client_secret: String,
    pub auth_url: String,
    pub token_url: String,
    pub redirect_url: String,
    pub scopes: Vec<String>,
}

impl OAuthConfig {
    pub fn new(client_id: &str, client_secret: &str, accounts_base_url: &str, redirect_url: &str) -> OAuthConfig {
        let base = accounts_base_url.trim_end_matches('/');
        OAuthConfig {
            client_id: client_id.to_string(),
            client_secret: client_secret.to_string(),
            auth_url: format!("{base}/authorize"),
            token_url: format!("{base}/api/token"),
            redirect_url: redirect_url.to_string(),
            scopes: Vec::new(),
        }
    }

    /// Mirrors oauth2's `AuthCodeURL`: parameters are encoded in sorted key
    /// order, exactly as Go's `url.Values.Encode` produces them.
    pub fn auth_code_url(&self, state: &str) -> String {
        let mut params = vec![("client_id", self.client_id.clone())];
        if !self.redirect_url.is_empty() {
            params.push(("redirect_uri", self.redirect_url.clone()));
        }
        params.push(("response_type", "code".to_string()));
        if !self.scopes.is_empty() {
            params.push(("scope", self.scopes.join(" ")));
        }
        if !state.is_empty() {
            params.push(("state", state.to_string()));
        }
        let separator = if self.auth_url.contains('?') { '&' } else { '?' };
        format!("{}{separator}{}", self.auth_url, encode_params(&params))
    }

    /// Exchanges an authorization code for a token.
    pub fn exchange(&self, agent: &Agent, code: &str) -> Result<Token> {
        let mut form = vec![("code", code), ("grant_type", "authorization_code")];
        if !self.redirect_url.is_empty() {
            form.push(("redirect_uri", &self.redirect_url));
        }
        self.retrieve_token(agent, &form)
    }

    /// Obtains a new access token. Like oauth2, a response without a refresh
    /// token keeps the one that was just used.
    pub fn refresh(&self, agent: &Agent, refresh_token: &str) -> Result<Token> {
        if refresh_token.is_empty() {
            bail!("oauth2: token expired and refresh token is not set");
        }
        let mut token =
            self.retrieve_token(agent, &[("grant_type", "refresh_token"), ("refresh_token", refresh_token)])?;
        if token.refresh_token.is_empty() {
            token.refresh_token = refresh_token.to_string();
        }
        Ok(token)
    }

    /// POSTs to the token endpoint with HTTP Basic client credentials and
    /// parses the response the way oauth2's `doTokenRoundTrip` does.
    fn retrieve_token(&self, agent: &Agent, form: &[(&str, &str)]) -> Result<Token> {
        let credentials = format!("{}:{}", query_escape(&self.client_id), query_escape(&self.client_secret));
        let mut response = agent
            .post(&self.token_url)
            .header("Authorization", format!("Basic {}", BASE64.encode(credentials)))
            .send_form(form.iter().copied())
            .with_context(|| format!("Post {:?}", self.token_url))?;

        let status = response.status();
        let content_type = response
            .headers()
            .get("Content-Type")
            .and_then(|value| value.to_str().ok())
            .map(media_type)
            .unwrap_or_default();
        let body = response
            .body_mut()
            .with_config()
            .limit(MAX_TOKEN_RESPONSE_BYTES)
            .read_to_string()
            .context("oauth2: cannot fetch token")?;

        let failure = !status.is_success();
        let mut retrieve_error = RetrieveError {
            status: status.as_u16(),
            reason: status.canonical_reason().unwrap_or_default(),
            body: body.clone(),
            ..RetrieveError::default()
        };

        let token = match content_type.as_str() {
            "application/x-www-form-urlencoded" | "text/plain" => {
                let value = |key: &str| {
                    form_urlencoded::parse(body.as_bytes())
                        .find(|(name, _)| name == key)
                        .map(|(_, value)| value.into_owned())
                        .unwrap_or_default()
                };
                retrieve_error.code = value("error");
                retrieve_error.description = value("error_description");
                retrieve_error.uri = value("error_uri");
                TokenResponse {
                    access_token: value("access_token"),
                    token_type: value("token_type"),
                    refresh_token: value("refresh_token"),
                    expires_in: value("expires_in").parse().unwrap_or(0),
                }
            }
            _ => match serde_json::from_str::<TokenJson>(&body) {
                Ok(json) => {
                    retrieve_error.code = json.error.unwrap_or_default();
                    retrieve_error.description = json.error_description.unwrap_or_default();
                    retrieve_error.uri = json.error_uri.unwrap_or_default();
                    TokenResponse {
                        access_token: json.access_token.unwrap_or_default(),
                        token_type: json.token_type.unwrap_or_default(),
                        refresh_token: json.refresh_token.unwrap_or_default(),
                        expires_in: json.expires_in.map_or(0, |ExpiresIn(seconds)| seconds),
                    }
                }
                Err(_) if failure => return Err(retrieve_error.into()),
                Err(err) => bail!("oauth2: cannot parse json: {err}"),
            },
        };

        // Some servers report errors with a 200, so a populated error code
        // is a failure regardless of status.
        if failure || !retrieve_error.code.is_empty() {
            return Err(retrieve_error.into());
        }
        if token.access_token.is_empty() {
            bail!("oauth2: server response missing access_token");
        }

        let expiry = if token.expires_in == 0 {
            None
        } else {
            let lifetime = SignedDuration::from_secs(token.expires_in);
            Some(Timestamp::now().checked_add(lifetime).context("compute token expiry")?)
        };
        Ok(Token {
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            token_type: token.token_type,
            expiry,
        })
    }
}

/// Whether the token can be used as-is (oauth2's `Token.Valid`). A missing
/// expiry is Go's zero time, which oauth2 treats as never expiring.
pub(crate) fn token_valid(token: &Token, now: Timestamp) -> bool {
    !token.access_token.is_empty() && !token_expired(token, now)
}

fn token_expired(token: &Token, now: Timestamp) -> bool {
    token.expiry.is_some_and(|expiry| expiry.duration_since(now) < EXPIRY_DELTA)
}

/// The Authorization scheme for a token, normalized the way oauth2's
/// `Token.Type` does (empty means Bearer).
pub(crate) fn authorization_type(token_type: &str) -> &str {
    if token_type.eq_ignore_ascii_case("bearer") || token_type.is_empty() {
        "Bearer"
    } else if token_type.eq_ignore_ascii_case("mac") {
        "MAC"
    } else if token_type.eq_ignore_ascii_case("basic") {
        "Basic"
    } else {
        token_type
    }
}

/// Token endpoint failure, formatted like oauth2's `RetrieveError`.
#[derive(Debug, Default)]
pub(crate) struct RetrieveError {
    status: u16,
    reason: &'static str,
    body: String,
    code: String,
    description: String,
    uri: String,
}

impl fmt::Display for RetrieveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.code.is_empty() {
            return write!(f, "oauth2: cannot fetch token: {} {}\nResponse: {}", self.status, self.reason, self.body);
        }
        write!(f, "oauth2: {:?}", self.code)?;
        if !self.description.is_empty() {
            write!(f, " {:?}", self.description)?;
        }
        if !self.uri.is_empty() {
            write!(f, " {:?}", self.uri)?;
        }
        Ok(())
    }
}

impl std::error::Error for RetrieveError {}

struct TokenResponse {
    access_token: String,
    token_type: String,
    refresh_token: String,
    expires_in: i64,
}

#[derive(Deserialize)]
struct TokenJson {
    access_token: Option<String>,
    token_type: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<ExpiresIn>,
    error: Option<String>,
    error_description: Option<String>,
    error_uri: Option<String>,
}

/// oauth2's `expirationTime`: an integer (or numeric string) clamped to i32.
struct ExpiresIn(i64);

impl<'de> Deserialize<'de> for ExpiresIn {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let seconds = match serde_json::Value::deserialize(deserializer)? {
            serde_json::Value::Number(number) => number.as_i64(),
            serde_json::Value::String(raw) => raw.parse().ok(),
            _ => None,
        }
        .ok_or_else(|| D::Error::custom("expires_in is not an integer"))?;
        Ok(ExpiresIn(seconds.min(i64::from(i32::MAX))))
    }
}

/// The media type of a Content-Type header, lowercased and without params.
fn media_type(content_type: &str) -> String {
    content_type.split(';').next().unwrap_or_default().trim().to_ascii_lowercase()
}

/// Go's `url.QueryEscape`: unreserved characters pass through, spaces
/// become `+`, and everything else is percent-encoded.
pub(crate) fn query_escape(raw: &str) -> String {
    let mut escaped = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => escaped.push(char::from(byte)),
            b' ' => escaped.push('+'),
            _ => escaped.push_str(&format!("%{byte:02X}")),
        }
    }
    escaped
}

/// Encodes already-sorted key/value pairs as a query string.
pub(crate) fn encode_params<V: AsRef<str>>(params: &[(&str, V)]) -> String {
    params
        .iter()
        .map(|(key, value)| format!("{}={}", query_escape(key), query_escape(value.as_ref())))
        .collect::<Vec<_>>()
        .join("&")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{MockServer, Reply};

    fn config(base: &str) -> OAuthConfig {
        OAuthConfig::new("client id", "secret&", base, "http://127.0.0.1:8000/cb")
    }

    #[test]
    fn query_escape_matches_go() {
        assert_eq!(query_escape("a b+c/d~e*f"), "a+b%2Bc%2Fd~e%2Af");
        assert_eq!(query_escape("Frédéric"), "Fr%C3%A9d%C3%A9ric");
    }

    #[test]
    fn auth_code_url_sorts_and_encodes_params() {
        let mut cfg = config("https://accounts.example");
        cfg.scopes = vec!["user-read-recently-played".into()];
        assert_eq!(
            cfg.auth_code_url("abc"),
            "https://accounts.example/authorize?client_id=client+id&redirect_uri=http%3A%2F%2F127.0.0.1%3A8000%2Fcb\
             &response_type=code&scope=user-read-recently-played&state=abc"
        );
    }

    #[test]
    fn expiry_uses_ten_second_delta() {
        let now: Timestamp = "2026-03-31T12:00:00Z".parse().unwrap();
        let token = |offset: i64| Token {
            access_token: "a".into(),
            expiry: Some(now.checked_add(SignedDuration::from_secs(offset)).unwrap()),
            ..Token::default()
        };
        assert!(token_valid(&token(10), now), "expiry - delta must be strictly before now");
        assert!(!token_valid(&token(9), now));
        assert!(!token_valid(&token(5), now));
        assert!(!token_valid(&token(-5), now));
        assert!(token_valid(&Token { access_token: "a".into(), ..Token::default() }, now), "zero expiry never expires");
        assert!(!token_valid(&Token::default(), now), "empty access token is invalid");
    }

    #[test]
    fn authorization_type_normalizes_like_oauth2() {
        assert_eq!(authorization_type(""), "Bearer");
        assert_eq!(authorization_type("bearer"), "Bearer");
        assert_eq!(authorization_type("mac"), "MAC");
        assert_eq!(authorization_type("basic"), "Basic");
        assert_eq!(authorization_type("Custom"), "Custom");
    }

    #[test]
    fn exchange_posts_form_with_basic_auth() {
        let server = MockServer::start(|_| {
            Reply::json(
                200,
                r#"{"access_token":"access","token_type":"Bearer","refresh_token":"refresh","expires_in":3600}"#,
            )
        });
        let before = Timestamp::now();
        let token = config(&server.base_url).exchange(&new_agent(), "the code").unwrap();
        assert_eq!(token.access_token, "access");
        assert_eq!(token.refresh_token, "refresh");
        assert_eq!(token.token_type, "Bearer");
        let lifetime = token.expiry.unwrap().duration_since(before);
        assert!(lifetime >= SignedDuration::from_secs(3600) && lifetime < SignedDuration::from_secs(3660));

        let request = server.single_request();
        assert_eq!(request.method, "POST");
        assert_eq!(request.target, "/api/token");
        assert_eq!(request.header("authorization").unwrap(), format!("Basic {}", BASE64.encode("client+id:secret%26")));
        assert_eq!(request.header("content-type").unwrap(), "application/x-www-form-urlencoded");
        assert_eq!(request.form("grant_type"), "authorization_code");
        assert_eq!(request.form("code"), "the code");
        assert_eq!(request.form("redirect_uri"), "http://127.0.0.1:8000/cb");
    }

    #[test]
    fn refresh_keeps_previous_refresh_token_and_zero_expiry() {
        let server = MockServer::start(|_| Reply::json(200, r#"{"access_token":"new"}"#));
        let token = config(&server.base_url).refresh(&new_agent(), "old-refresh").unwrap();
        assert_eq!(token.access_token, "new");
        assert_eq!(token.refresh_token, "old-refresh");
        assert_eq!(token.expiry, None);
        let request = server.single_request();
        assert_eq!(request.form("grant_type"), "refresh_token");
        assert_eq!(request.form("refresh_token"), "old-refresh");
    }

    #[test]
    fn refresh_without_refresh_token_fails_before_network() {
        let err = config("http://127.0.0.1:1").refresh(&new_agent(), "").unwrap_err();
        assert_eq!(err.to_string(), "oauth2: token expired and refresh token is not set");
    }

    #[test]
    fn token_errors_are_formatted_like_oauth2() {
        let server = MockServer::start(|_| {
            Reply::json(400, r#"{"error":"invalid_grant","error_description":"Refresh token revoked"}"#)
        });
        let err = config(&server.base_url).refresh(&new_agent(), "r").unwrap_err();
        assert_eq!(err.to_string(), r#"oauth2: "invalid_grant" "Refresh token revoked""#);

        let server = MockServer::start(|_| Reply::text(502, "upstream down"));
        let err = config(&server.base_url).refresh(&new_agent(), "r").unwrap_err();
        assert_eq!(err.to_string(), "oauth2: cannot fetch token: 502 Bad Gateway\nResponse: upstream down");

        let server = MockServer::start(|_| Reply::json(200, r#"{"error":"server_error"}"#));
        let err = config(&server.base_url).refresh(&new_agent(), "r").unwrap_err();
        assert_eq!(err.to_string(), r#"oauth2: "server_error""#);

        let server = MockServer::start(|_| Reply::json(200, r#"{"token_type":"Bearer"}"#));
        let err = config(&server.base_url).refresh(&new_agent(), "r").unwrap_err();
        assert_eq!(err.to_string(), "oauth2: server response missing access_token");
    }

    #[test]
    fn form_encoded_token_responses_are_accepted() {
        let server = MockServer::start(|_| {
            Reply::text(200, "access_token=a&token_type=bearer&expires_in=60")
                .with_header("Content-Type", "application/x-www-form-urlencoded")
        });
        let token = config(&server.base_url).exchange(&new_agent(), "c").unwrap();
        assert_eq!(token.access_token, "a");
        assert_eq!(token.token_type, "bearer");
        assert!(token.expiry.is_some());
    }

    #[test]
    fn expires_in_accepts_numeric_strings_and_clamps() {
        let parse = |raw: &str| serde_json::from_str::<TokenJson>(raw).map(|json| json.expires_in.map(|e| e.0));
        assert_eq!(parse(r#"{"expires_in":"120"}"#).unwrap(), Some(120));
        assert_eq!(parse(r#"{"expires_in":99999999999}"#).unwrap(), Some(i64::from(i32::MAX)));
        assert!(parse(r#"{"expires_in":1.5}"#).is_err());
    }
}
