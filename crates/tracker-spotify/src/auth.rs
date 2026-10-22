use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use tracker_core::config::{SpotifyConfig, Token};
use ureq::Agent;

use crate::oauth::{self, ACCOUNTS_BASE_URL, OAuthConfig};

/// The local callback used during the CLI OAuth flow. It must match a
/// redirect URI registered on the Spotify app.
pub const DEFAULT_REDIRECT_URL: &str = "http://127.0.0.1:8000/api/auth/spotify/callback";

/// The app only reads listening history.
pub(crate) const SCOPES: &[&str] = &["user-read-recently-played"];

/// Bounds how long one browser connection may take to send its request, so
/// an idle preconnect cannot hold a handler thread forever.
const CALLBACK_IO_TIMEOUT: Duration = Duration::from_secs(10);

/// Request heads larger than this are rejected rather than buffered.
const MAX_REQUEST_HEAD_BYTES: usize = 64 * 1024;

/// Centralizes the OAuth settings so login and authenticated client creation
/// stay aligned on redirect URL and scopes.
pub(crate) fn authenticator(cfg: &SpotifyConfig, accounts_base_url: &str, redirect_url: &str) -> Result<OAuthConfig> {
    cfg.validate_client_credentials().context("invalid Spotify credentials")?;
    let mut oauth = OAuthConfig::new(&cfg.client_id, &cfg.client_secret, accounts_base_url, redirect_url);
    oauth.scopes = SCOPES.iter().map(|scope| scope.to_string()).collect();
    Ok(oauth)
}

/// Runs the authorization-code flow: hands the authorize URL to
/// `present_url`, waits for the browser callback on DEFAULT_REDIRECT_URL,
/// and exchanges the code for a token.
///
/// Like the Go build there is no timeout: the wait ends when the browser
/// calls back (successfully or not) or the process is interrupted.
pub fn login(cfg: &SpotifyConfig, present_url: &mut dyn FnMut(&str) -> Result<()>) -> Result<Token> {
    let oauth = authenticator(cfg, ACCOUNTS_BASE_URL, DEFAULT_REDIRECT_URL)?;
    let (listen_addr, callback_path) = callback_server_config(DEFAULT_REDIRECT_URL)?;
    let state = random_state().context("generate OAuth state")?;
    let listener =
        TcpListener::bind(&listen_addr).with_context(|| format!("listen for Spotify callback on {listen_addr}"))?;
    login_on(&oauth, &oauth::new_agent(), listener, &callback_path, &state, present_url)
}

/// The listener-level half of [`login`], split out so tests can supply a
/// listener on an ephemeral port and a mock token endpoint.
fn login_on(
    oauth: &OAuthConfig,
    agent: &Agent,
    listener: TcpListener,
    callback_path: &str,
    state: &str,
    present_url: &mut dyn FnMut(&str) -> Result<()>,
) -> Result<Token> {
    let server = CallbackServer::start(listener, callback_path, state)?;
    present_url(&oauth.auth_code_url(state))?;
    let code = server.wait()?;
    oauth.exchange(agent, &code).context("exchange Spotify authorization code")
}

/// Validates the redirect URL and extracts the bind address and callback
/// path used by the local one-shot HTTP server.
fn callback_server_config(raw_url: &str) -> Result<(String, String)> {
    let (scheme, rest) = raw_url.split_once("://").unwrap_or(("", raw_url));
    let (rest, fragment) = rest.split_once('#').unwrap_or((rest, ""));
    let (rest, query) = rest.split_once('?').unwrap_or((rest, ""));
    let (authority, path) = rest.find('/').map_or((rest, ""), |slash| rest.split_at(slash));
    // Drop any userinfo; Go keeps it out of URL.Host.
    let host = authority.rsplit_once('@').map_or(authority, |(_, host)| host);

    if !scheme.eq_ignore_ascii_case("http") {
        return Err(anyhow!("redirect URL {raw_url:?} must use http for local callback handling"));
    }
    if host.is_empty() {
        return Err(anyhow!("redirect URL {raw_url:?} must include a host"));
    }
    if path.is_empty() {
        return Err(anyhow!("redirect URL {raw_url:?} must include a callback path"));
    }
    if !query.is_empty() || !fragment.is_empty() {
        return Err(anyhow!("redirect URL {raw_url:?} must not include query or fragment components"));
    }

    let listen_addr = if host.contains(':') { host.to_string() } else { format!("{host}:80") };
    Ok((listen_addr, path.to_string()))
}

/// Generates the anti-CSRF OAuth state token for one login attempt.
fn random_state() -> Result<String> {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).map_err(|err| anyhow!("{err}"))?;
    Ok(buf.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// One-shot callback server: an accept loop on its own thread hands each
/// connection to a short-lived handler, and the first callback outcome
/// (code or error) is delivered over a channel.
struct CallbackServer {
    addr: SocketAddr,
    stop: Arc<AtomicBool>,
    outcomes: Receiver<Result<String>>,
    accept_thread: Option<JoinHandle<()>>,
}

impl CallbackServer {
    fn start(listener: TcpListener, callback_path: &str, state: &str) -> Result<CallbackServer> {
        let addr = listener.local_addr().context("read Spotify callback listener address")?;
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, outcomes) = mpsc::channel();
        let accept_thread = {
            let stop = Arc::clone(&stop);
            let callback_path = callback_path.to_string();
            let state = state.to_string();
            thread::spawn(move || accept_loop(listener, &callback_path, &state, &tx, &stop))
        };
        Ok(CallbackServer { addr, stop, outcomes, accept_thread: Some(accept_thread) })
    }

    fn wait(&self) -> Result<String> {
        self.outcomes.recv().map_err(|_| anyhow!("serve Spotify callback listener: server stopped unexpectedly"))?
    }
}

impl Drop for CallbackServer {
    /// Stops accepting and releases the port. The accept loop is blocked in
    /// `accept`, so a throwaway connection wakes it to observe the flag.
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let wake_ip = match self.addr.ip() {
            IpAddr::V4(ip) if ip.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(ip) if ip.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
            ip => ip,
        };
        let woke = TcpStream::connect_timeout(&SocketAddr::new(wake_ip, self.addr.port()), Duration::from_secs(1));
        if let (Ok(_), Some(handle)) = (woke, self.accept_thread.take()) {
            let _ = handle.join();
        }
    }
}

fn accept_loop(
    listener: TcpListener,
    callback_path: &str,
    state: &str,
    tx: &Sender<Result<String>>,
    stop: &AtomicBool,
) {
    for conn in listener.incoming() {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        match conn {
            Ok(stream) => {
                let (callback_path, state, tx) = (callback_path.to_string(), state.to_string(), tx.clone());
                thread::spawn(move || handle_connection(stream, &callback_path, &state, &tx));
            }
            // Per-connection failures (like Go's temporary accept errors)
            // should not end the login.
            Err(err)
                if matches!(
                    err.kind(),
                    std::io::ErrorKind::ConnectionAborted
                        | std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::Interrupted
                ) => {}
            Err(err) => {
                let _ = tx.send(Err(anyhow!(err).context("serve Spotify callback listener")));
                return;
            }
        }
    }
}

/// A response the callback server sends back to the browser.
struct Response {
    status: &'static str,
    body: &'static str,
}

const NOT_FOUND: Response = Response { status: "404 Not Found", body: "404 page not found\n" };

fn bad_request(body: &'static str) -> Response {
    Response { status: "400 Bad Request", body }
}

fn handle_connection(stream: TcpStream, callback_path: &str, state: &str, tx: &Sender<Result<String>>) {
    let _ = stream.set_read_timeout(Some(CALLBACK_IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(CALLBACK_IO_TIMEOUT));
    let Some(target) = read_request_target(&stream) else {
        write_response(&stream, &bad_request("400 Bad Request"));
        return;
    };

    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    if path != callback_path {
        write_response(&stream, &NOT_FOUND);
        return;
    }

    let (response, outcome) = callback_outcome(query, state);
    write_response(&stream, &response);
    let _ = tx.send(outcome);
}

/// Decides the browser response and login outcome for a callback, checking
/// state, then an `error` parameter, then the code, in Go's order.
fn callback_outcome(query: &str, state: &str) -> (Response, Result<String>) {
    // url.Values.Get returns the first value for a key.
    let mut params: HashMap<String, String> = HashMap::new();
    for (key, value) in form_urlencoded::parse(query.as_bytes()) {
        params.entry(key.into_owned()).or_insert_with(|| value.into_owned());
    }
    let param = |key: &str| params.get(key).map(String::as_str).unwrap_or_default();

    if param("state") != state {
        return (
            bad_request("spotify login failed: state mismatch\n"),
            Err(anyhow!("spotify login failed: callback state mismatch")),
        );
    }
    let auth_error = param("error");
    if !auth_error.is_empty() {
        return (bad_request("spotify login failed\n"), Err(anyhow!("spotify login failed: {auth_error}")));
    }
    let code = param("code");
    if code.is_empty() {
        return (
            bad_request("spotify login failed: missing code\n"),
            Err(anyhow!("spotify login failed: missing authorization code")),
        );
    }
    (
        Response { status: "200 OK", body: "Spotify authentication complete. You can close this window.\n" },
        Ok(code.to_string()),
    )
}

/// Reads the request line and drains the headers, returning the
/// request-target. `None` for anything that is not a parseable request.
fn read_request_target(stream: &TcpStream) -> Option<String> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let mut total = reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let (_method, target, _version) = (parts.next()?, parts.next()?.to_string(), parts.next()?);

    loop {
        let mut header = String::new();
        let read = reader.read_line(&mut header).ok()?;
        total += read;
        if read == 0 || header.trim_end().is_empty() {
            break;
        }
        if total > MAX_REQUEST_HEAD_BYTES {
            return None;
        }
    }
    Some(target)
}

/// Writes a plain-text response the way Go's `http.Error` does.
fn write_response(mut stream: &TcpStream, response: &Response) {
    let head = format!(
        "HTTP/1.1 {}\r\nContent-Type: text/plain; charset=utf-8\r\nX-Content-Type-Options: nosniff\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n",
        response.status,
        response.body.len()
    );
    let _ = stream.write_all(head.as_bytes()).and_then(|()| stream.write_all(response.body.as_bytes()));
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::test_support::{MockServer, Reply, raw_get};

    const CALLBACK_PATH: &str = "/api/auth/spotify/callback";

    #[test]
    fn callback_server_config_extracts_addr_and_path() {
        assert_eq!(
            callback_server_config(DEFAULT_REDIRECT_URL).unwrap(),
            ("127.0.0.1:8000".to_string(), CALLBACK_PATH.to_string())
        );
        assert_eq!(callback_server_config("HTTP://localhost/cb").unwrap(), ("localhost:80".into(), "/cb".into()));

        let err = |raw: &str| callback_server_config(raw).unwrap_err().to_string();
        assert_eq!(
            err("https://127.0.0.1/cb"),
            r#"redirect URL "https://127.0.0.1/cb" must use http for local callback handling"#
        );
        assert_eq!(err("http:///cb"), r#"redirect URL "http:///cb" must include a host"#);
        assert_eq!(
            err("http://127.0.0.1:8000"),
            r#"redirect URL "http://127.0.0.1:8000" must include a callback path"#
        );
        assert_eq!(
            err("http://127.0.0.1/cb?x=1"),
            r#"redirect URL "http://127.0.0.1/cb?x=1" must not include query or fragment components"#
        );
        assert_eq!(
            err("http://127.0.0.1/cb#frag"),
            r#"redirect URL "http://127.0.0.1/cb#frag" must not include query or fragment components"#
        );
    }

    #[test]
    fn random_state_is_hex_and_unique() {
        let first = random_state().unwrap();
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(first, random_state().unwrap());
    }

    #[test]
    fn login_requires_client_credentials() {
        let err = login(&SpotifyConfig::default(), &mut |_| panic!("must not present a URL")).unwrap_err();
        assert_eq!(
            format!("{err:#}"),
            "invalid Spotify credentials: spotify.client_id is required; spotify.client_secret is required"
        );
    }

    /// Runs `login_on` against a mock token endpoint; `browse` plays the
    /// browser, given the callback address and the presented authorize URL.
    fn run_login(
        token_reply: fn() -> Reply,
        browse: impl Fn(SocketAddr) -> Vec<String> + Send + Sync + 'static,
    ) -> (Result<Token>, Vec<String>, MockServer, String) {
        let accounts = MockServer::start(move |_| token_reply());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let redirect = format!("http://{addr}{CALLBACK_PATH}");
        let cfg = SpotifyConfig { client_id: "id".into(), client_secret: "secret".into(), token: None };
        let oauth = authenticator(&cfg, &accounts.base_url, &redirect).unwrap();

        let responses = Arc::new(Mutex::new(Vec::new()));
        let presented = Arc::new(Mutex::new(String::new()));
        let browse = Arc::new(browse);
        let (sink, seen) = (Arc::clone(&responses), Arc::clone(&presented));
        let result = login_on(&oauth, &oauth::new_agent(), listener, CALLBACK_PATH, "state123", &mut |url| {
            *seen.lock().unwrap() = url.to_string();
            let (browse, sink) = (Arc::clone(&browse), Arc::clone(&sink));
            // A real browser runs independently of the waiting CLI. It must
            // not panic, or the login would wait forever.
            thread::spawn(move || {
                let responses = browse(addr);
                sink.lock().unwrap().extend(responses);
            });
            Ok(())
        });
        // Responses are written before the outcome is sent, but the browser
        // thread may still be pushing; give it a moment to land.
        for _ in 0..200 {
            if Arc::strong_count(&browse) == 1 && !responses.lock().unwrap().is_empty() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let responses = responses.lock().unwrap().clone();
        let presented = presented.lock().unwrap().clone();
        (result, responses, accounts, presented)
    }

    fn token_ok() -> Reply {
        Reply::json(
            200,
            r#"{"access_token":"access","token_type":"Bearer","refresh_token":"refresh","expires_in":3600}"#,
        )
    }

    #[test]
    fn login_exchanges_callback_code() {
        let (result, responses, accounts, presented) = run_login(token_ok, |addr| {
            // Unrelated requests (like favicon fetches) do not end the login.
            vec![raw_get(addr, "/favicon.ico"), raw_get(addr, &format!("{CALLBACK_PATH}?code=the+code&state=state123"))]
        });

        let token = result.unwrap();
        assert_eq!(token.access_token, "access");
        assert_eq!(token.refresh_token, "refresh");
        assert!(token.expiry.is_some());

        let auth_prefix =
            format!("{}/authorize?client_id=id&redirect_uri=http%3A%2F%2F127.0.0.1%3A", accounts.base_url);
        assert!(presented.starts_with(&auth_prefix), "{presented}");
        assert!(presented.ends_with("&response_type=code&scope=user-read-recently-played&state=state123"));

        assert!(responses[0].starts_with("HTTP/1.1 404 Not Found"), "{}", responses[0]);
        assert!(responses[0].ends_with("\r\n\r\n404 page not found\n"));
        let response = &responses[1];
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        assert!(response.contains("Content-Type: text/plain; charset=utf-8"));
        assert!(response.ends_with("\r\n\r\nSpotify authentication complete. You can close this window.\n"));

        let exchange = accounts.single_request();
        assert_eq!(exchange.form("code"), "the code");
        assert_eq!(exchange.form("grant_type"), "authorization_code");
        assert!(exchange.form("redirect_uri").ends_with(CALLBACK_PATH));
    }

    fn assert_callback_failure(target: &'static str, want_err: &str, want_body: &str) {
        let (result, responses, accounts, _) = run_login(token_ok, move |addr| vec![raw_get(addr, target)]);
        assert_eq!(result.unwrap_err().to_string(), want_err);
        assert!(responses[0].starts_with("HTTP/1.1 400 Bad Request"), "{}", responses[0]);
        assert!(responses[0].ends_with(&format!("\r\n\r\n{want_body}")), "{}", responses[0]);
        assert!(accounts.requests().is_empty(), "no exchange after a failed callback");
    }

    #[test]
    fn login_rejects_state_mismatch() {
        assert_callback_failure(
            "/api/auth/spotify/callback?code=c&state=evil",
            "spotify login failed: callback state mismatch",
            "spotify login failed: state mismatch\n",
        );
    }

    #[test]
    fn login_reports_authorization_error() {
        assert_callback_failure(
            "/api/auth/spotify/callback?error=access_denied&state=state123",
            "spotify login failed: access_denied",
            "spotify login failed\n",
        );
    }

    #[test]
    fn login_requires_code() {
        assert_callback_failure(
            "/api/auth/spotify/callback?state=state123",
            "spotify login failed: missing authorization code",
            "spotify login failed: missing code\n",
        );
    }

    #[test]
    fn login_wraps_exchange_failure() {
        let (result, _, _, _) = run_login(
            || Reply::json(400, r#"{"error":"invalid_grant","error_description":"Invalid authorization code"}"#),
            |addr| vec![raw_get(addr, &format!("{CALLBACK_PATH}?code=c&state=state123"))],
        );
        assert_eq!(
            format!("{:#}", result.unwrap_err()),
            r#"exchange Spotify authorization code: oauth2: "invalid_grant" "Invalid authorization code""#
        );
    }

    #[test]
    fn present_url_error_aborts_and_releases_port() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let cfg = SpotifyConfig { client_id: "id".into(), client_secret: "secret".into(), token: None };
        let oauth = authenticator(&cfg, "http://127.0.0.1:1", DEFAULT_REDIRECT_URL).unwrap();
        let err =
            login_on(&oauth, &oauth::new_agent(), listener, CALLBACK_PATH, "s", &mut |_| Err(anyhow!("no browser")))
                .unwrap_err();
        assert_eq!(err.to_string(), "no browser");
        TcpListener::bind(addr).expect("callback port is released after login returns");
    }
}
