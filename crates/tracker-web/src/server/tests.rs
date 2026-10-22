//! Ports of the TypeScript build's `server.test.ts`, so both servers are
//! held to the same contract, plus the theme cookie, the windowed library,
//! the server-rendered page, and compression.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant as StdInstant;

use anyhow::anyhow;
use serde_json::json;
use tracker_core::UpsertTrackParams;

use super::*;

/// A page template the server renders the app into.
const SSR_TEMPLATE: &str = r#"<html data-theme="%TRACKER_THEME%"><meta name="tracker-token" content="%TRACKER_TOKEN%"><div id="root"><!--tracker-app--></div><!--tracker-initial--></html>"#;

/// A script big enough to be compressed, with build-time copies.
fn big_script() -> String {
    "console.log('a fairly long line of JavaScript');\n".repeat(100)
}

fn assets() -> Assets {
    let asset = |content_type, body: &'static str| Asset::new(content_type, Bytes::from_static(body.as_bytes()));
    let big = big_script();
    let big_asset = Asset {
        content_type: "text/javascript; charset=utf-8",
        gzip: Some(compress::compress(big.as_bytes(), Encoding::Gzip).into()),
        brotli: Some(compress::compress(big.as_bytes(), Encoding::Brotli).into()),
        body: big.into(),
    };
    Assets::from([
        ("/assets/big.js".to_string(), big_asset),
        (
            "/".to_string(),
            asset(
                "text/html; charset=utf-8",
                r#"<html data-theme="%TRACKER_THEME%"><meta name="tracker-token" content="%TRACKER_TOKEN%"><script src="/assets/app.js"></script>"#,
            ),
        ),
        ("/assets/app.js".to_string(), asset("text/javascript; charset=utf-8", "console.log(1)")),
        ("/assets/app.css".to_string(), asset("text/css; charset=utf-8", "body{}")),
    ])
}

#[derive(Debug)]
struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|err| panic!("{err}: {:?}", self.body))
    }
}

/// One request on a fresh connection, written byte for byte, so tests
/// control the Host header and the body framing.
fn raw_request(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> Reply {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut request = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\n");
    if !headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("host")) {
        request.push_str(&format!("Host: 127.0.0.1:{port}\r\n"));
    }
    let chunked = headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("transfer-encoding"));
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    let mut bytes = Vec::new();
    if chunked {
        request.push_str("\r\n");
        bytes.extend_from_slice(request.as_bytes());
        bytes.extend_from_slice(format!("{:x}\r\n", body.len()).as_bytes());
        bytes.extend_from_slice(body);
        bytes.extend_from_slice(b"\r\n0\r\n\r\n");
    } else {
        request.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
        bytes.extend_from_slice(request.as_bytes());
        bytes.extend_from_slice(body);
    }
    // The server may answer (and close) before reading an oversized body.
    let _ = stream.write_all(&bytes);
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    parse_response(&response)
}

fn parse_response(response: &[u8]) -> Reply {
    let text = String::from_utf8_lossy(response);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or_else(|| panic!("no response: {text:?}"));
    let mut lines = head.split("\r\n");
    let status = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_string(), value.trim().to_string()))
        .collect();
    Reply { status, headers, body: body.to_string() }
}

/// The first window of the default view, as a page asks for it.
const VIEW: &str = "/api/view?sort=recentDesc&q=&offset=0&limit=100";

/// The presence grace period in these tests.
const GRACE: Duration = Duration::from_millis(60);

struct Harness {
    server: WebServer,
    db: Arc<Db>,
    sync_calls: Arc<AtomicUsize>,
    artwork_calls: Arc<Mutex<Vec<Vec<String>>>>,
}

/// Answers "no art" for every ID and records the calls. Knows the art of
/// `sp-1` already, and that `sp-2` has none.
struct FakeArtwork(Arc<Mutex<Vec<Vec<String>>>>);

fn known_art() -> Artwork {
    Artwork {
        small: Some("https://i.scdn.co/image/s1".into()),
        medium: None,
        large: Some("https://i.scdn.co/image/l1".into()),
    }
}

impl ArtworkLookup for FakeArtwork {
    fn lookup(&self, ids: Vec<String>) -> BoxFuture<ArtworkResponse> {
        self.0.lock().unwrap().push(ids.clone());
        Box::pin(async move { ArtworkResponse(ids.into_iter().map(|id| (id, None)).collect()) })
    }

    fn known(&self, ids: &[&str]) -> Vec<Option<Option<Artwork>>> {
        ids.iter()
            .map(|id| match *id {
                "sp-1" => Some(Some(known_art())),
                "sp-2" => Some(None),
                _ => None,
            })
            .collect()
    }
}

async fn harness() -> Harness {
    let sync_calls = Arc::new(AtomicUsize::new(0));
    let calls = Arc::clone(&sync_calls);
    harness_with(Arc::new(move || {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok(SyncStats { fetched: 3, ..SyncStats::default() })
    }))
    .await
    .with_sync_calls(sync_calls)
}

impl Harness {
    fn with_sync_calls(mut self, sync_calls: Arc<AtomicUsize>) -> Harness {
        self.sync_calls = sync_calls;
        self
    }

    async fn call(&self, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> Reply {
        let (port, method, path, body) = (self.server.port, method.to_string(), path.to_string(), body.to_string());
        let headers: Vec<(String, String)> =
            headers.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect();
        spawn_blocking(move || {
            let headers: Vec<(&str, &str)> =
                headers.iter().map(|(name, value)| (name.as_str(), value.as_str())).collect();
            raw_request(port, &method, &path, &headers, body.as_bytes())
        })
        .await
        .unwrap()
    }

    async fn get(&self, path: &str) -> Reply {
        self.call("GET", path, &[], "").await
    }

    async fn post(&self, path: &str, body: &Value) -> Reply {
        let token = self.server.token.clone();
        self.call("POST", path, &[(TOKEN_HEADER, &token), ("Content-Type", "application/json")], &body.to_string())
            .await
    }

    fn seed_track(&self) -> i64 {
        self.seed("sp-1", "Scarbo", 100)
    }

    fn seed(&self, spotify_id: &str, name: &str, last_played_at: i64) -> i64 {
        self.db
            .conn()
            .upsert_track(&UpsertTrackParams {
                spotify_id: spotify_id.into(),
                track_name: name.into(),
                album_name: "Gaspard".into(),
                artists: r#"["Martha Argerich"]"#.into(),
                last_played_at,
            })
            .unwrap()
            .id
    }

    /// Has the server re-read the database; returns the new version.
    async fn reload(&self) -> u64 {
        let reply = self.post(RELOAD_PATH, &json!(null)).await;
        assert_eq!(reply.status, 200, "{}", reply.body);
        reply.json()["version"].as_u64().unwrap()
    }

    /// Waits for the first read, so seeding after it is deterministic.
    async fn first_read(&self) -> Value {
        let reply = self.get(VIEW).await;
        assert_eq!(reply.status, 200, "{}", reply.body);
        reply.json()
    }
}

async fn harness_with(sync: SyncFn) -> Harness {
    harness_on(Arc::new(Db::open_in_memory().unwrap()), sync, assets()).await
}

async fn harness_on(db: Arc<Db>, sync: SyncFn, assets: Assets) -> Harness {
    let artwork_calls = Arc::new(Mutex::new(Vec::new()));
    let server = start(WebServerOptions {
        db: Arc::clone(&db),
        assets: Arc::new(assets),
        sync,
        artwork: Arc::new(FakeArtwork(Arc::clone(&artwork_calls))),
        port: 0,
        token: None,
        presence_grace: GRACE,
    })
    .await
    .unwrap();
    Harness { server, db, sync_calls: Arc::new(AtomicUsize::new(0)), artwork_calls }
}

#[tokio::test]
async fn binds_loopback_with_a_random_token() {
    let h = harness().await;
    assert_eq!(h.server.url, format!("http://127.0.0.1:{}/", h.server.port));
    assert!(h.server.token.len() == 32 && h.server.token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert!(!h.server.token.bytes().any(|byte| byte.is_ascii_uppercase()));
    let other = harness().await;
    assert_ne!(h.server.token, other.server.token);
}

#[tokio::test]
async fn serves_the_page_with_the_token_and_theme_substituted_the_csp_and_no_caching() {
    let h = harness().await;
    let page = h.get("/").await;
    assert_eq!(page.status, 200);
    assert_eq!(
        page.body,
        format!(
            r#"<html data-theme="auto"><meta name="tracker-token" content="{}"><script src="/assets/app.js"></script>"#,
            h.server.token
        )
    );
    assert_eq!(page.header("content-type"), Some("text/html; charset=utf-8"));
    assert_eq!(
        page.header("content-security-policy"),
        Some(
            "default-src 'self'; script-src 'self' 'unsafe-eval' https://open.spotify.com https://embed-cdn.spotifycdn.com; frame-src https://open.spotify.com; \
             img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; \
             form-action 'none'"
        )
    );
    assert_eq!(page.header("cache-control"), Some("no-store"));
    assert_eq!(page.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(page.header("referrer-policy"), Some("no-referrer"));
    assert_eq!(page.header("x-frame-options"), Some("DENY"));
    assert_eq!(page.header("access-control-allow-origin"), None);
}

#[tokio::test]
async fn the_theme_cookie_sets_data_theme() {
    let h = harness().await;
    for (cookie, theme) in
        [("tracker-theme=dark", "dark"), ("a=b; tracker-theme=light", "light"), ("tracker-theme=\"><script>", "auto")]
    {
        let page = h.call("GET", "/", &[("Cookie", cookie)], "").await;
        assert!(page.body.starts_with(&format!(r#"<html data-theme="{theme}">"#)), "{cookie}: {}", page.body);
    }
}

#[tokio::test]
async fn serves_assets_as_is_with_a_short_cache() {
    let h = harness().await;
    let js = h.get("/assets/app.js?v=1").await;
    assert_eq!(js.status, 200);
    assert_eq!(js.body, "console.log(1)");
    assert_eq!(js.header("content-type"), Some("text/javascript; charset=utf-8"));
    assert_eq!(js.header("cache-control"), Some("private, max-age=300"));
    assert_eq!(js.header("content-security-policy"), Some(CONTENT_SECURITY_POLICY));
}

#[tokio::test]
async fn accepts_localhost_and_rejects_any_other_host() {
    let h = harness().await;
    let port = h.server.port;
    let localhost = format!("localhost:{port}");
    assert_eq!(h.call("GET", "/", &[("Host", &localhost)], "").await.status, 200);
    assert_eq!(h.call("GET", "/", &[("Host", &localhost.to_uppercase())], "").await.status, 200);
    for host in [
        "evil.example".to_string(),
        format!("evil.example:{port}"),
        "127.0.0.1".into(),
        format!("127.0.0.1:{}", port + 1),
    ] {
        let reply = h.call("GET", VIEW, &[("Host", &host)], "").await;
        assert_eq!(reply.status, 403, "{host}");
        assert_eq!(reply.json(), json!({ "error": "forbidden host" }));
    }
    let page = h.call("GET", "/", &[("Host", "evil.example")], "").await;
    assert_eq!((page.status, page.body.as_str()), (403, "forbidden host\n"));
    assert_eq!(page.header("content-type"), Some("text/plain; charset=utf-8"));
}

#[tokio::test]
async fn requires_the_token_on_post() {
    let h = harness().await;
    let wrong = "f".repeat(32);
    for headers in [vec![], vec![(TOKEN_HEADER, wrong.as_str())], vec![(TOKEN_HEADER, "short")]] {
        let reply = h.call("POST", SYNC_PATH, &headers, "").await;
        assert_eq!(reply.status, 403);
        assert_eq!(reply.json(), json!({ "error": "missing or invalid token" }));
    }
    assert_eq!(h.sync_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn rejects_other_methods_and_wrong_methods_per_route() {
    let h = harness().await;
    let token = h.server.token.clone();
    for method in ["PUT", "DELETE", "OPTIONS", "PATCH", "HEAD"] {
        let reply = h.call(method, RATINGS_PATH, &[(TOKEN_HEADER, &token)], "").await;
        assert_eq!(reply.status, 405, "{method}");
        assert_eq!(reply.header("allow"), Some("GET, POST"));
        assert_eq!(reply.header("access-control-allow-origin"), None);
    }
    let get_sync = h.get(SYNC_PATH).await;
    assert_eq!((get_sync.status, get_sync.header("allow")), (405, Some("POST")));
    let post_view = h.post(VIEW_PATH, &json!({})).await;
    assert_eq!((post_view.status, post_view.header("allow")), (405, Some("GET")));
    assert_eq!(post_view.json(), json!({ "error": "method not allowed" }));
    let get_reload = h.get(RELOAD_PATH).await;
    assert_eq!((get_reload.status, get_reload.header("allow")), (405, Some("POST")));
    let post_asset = h.post("/assets/app.js", &json!({})).await;
    assert_eq!((post_asset.status, post_asset.header("allow")), (405, Some("GET")));
}

#[tokio::test]
async fn answers_unknown_paths_with_json_under_api_and_text_elsewhere() {
    let h = harness().await;
    let api = h.get("/api/nope").await;
    assert_eq!(api.status, 404);
    assert_eq!(api.header("content-type"), Some("application/json; charset=utf-8"));
    assert_eq!(api.json(), json!({ "error": "no API route /api/nope" }));
    assert_eq!(h.get("/api").await.json(), json!({ "error": "no API route /api" }));
    let page = h.get("/nope").await;
    assert_eq!(page.status, 404);
    assert_eq!(page.header("content-type"), Some("text/plain; charset=utf-8"));
    assert_eq!(page.body, "404 page not found\n");
    assert_eq!(h.get("/constructor").await.status, 404);
    // Paths resolve like the browser's URL parser.
    assert_eq!(h.get("/api/../assets/app.js").await.body, "console.log(1)");
}

#[tokio::test]
async fn serves_windows_of_the_library_and_rereads_it_on_reload() {
    let h = harness().await;
    let first = h.first_read().await;
    assert_eq!(first, json!({ "version": 1, "total": 0, "matched": 0, "offset": 0, "rows": [], "index": null }));

    let track_id = h.seed_track();
    h.db.conn()
        .upsert_rating(&UpsertRatingParams { track_id, stars: 4, opinion: "Glittering".into(), updated_at: 200 })
        .unwrap();
    assert_eq!(h.get(VIEW).await.json()["total"], 0, "the library is read once, not per request");
    let token = h.server.token.clone();
    let reload = h.call("POST", RELOAD_PATH, &[(TOKEN_HEADER, &token)], "").await;
    assert_eq!((reload.status, reload.json()), (200, json!({ "version": 2, "total": 1 })));
    assert_eq!(reload.header("cache-control"), Some("no-store"));

    let reply = h.get(VIEW).await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("cache-control"), Some("no-store"));
    let track = serde_json::to_value(h.db.conn().track_by_id(track_id).unwrap().unwrap()).unwrap();
    assert_eq!(
        reply.json(),
        json!({
            "version": 2, "total": 1, "matched": 1, "offset": 0, "index": null,
            "rows": [{
                "track": track,
                "rating": { "trackId": track_id, "stars": 4, "opinion": "Glittering", "updatedAt": 200 },
                "artists": "Martha Argerich",
                "art": { "small": "https://i.scdn.co/image/s1", "medium": null, "large": "https://i.scdn.co/image/l1" },
            }],
        })
    );
    assert!(h.artwork_calls.lock().unwrap().is_empty(), "known art only: nothing is looked up");
    // The removed whole-library route.
    assert_eq!(h.get("/api/library").await.json(), json!({ "error": "no API route /api/library" }));
}

#[tokio::test]
async fn views_sort_search_window_and_center() {
    let h = harness().await;
    h.first_read().await;
    let ids: Vec<i64> = (0..30).map(|i| h.seed(&format!("sp-{}", i + 1), &format!("Prelude {i}"), 1000 - i)).collect();
    h.seed("sp-x", "Ballade", 5);
    h.reload().await;
    let h = &h;
    let view = |query: &str| {
        let path = format!("{VIEW_PATH}?{query}");
        async move { h.get(&path).await.json() }
    };
    let got = view("sort=recentDesc&q=PRELUDE%201&offset=0&limit=3").await;
    assert_eq!((got["total"].as_u64(), got["matched"].as_u64()), (Some(31), Some(11)));
    let names: Vec<&str> =
        got["rows"].as_array().unwrap().iter().map(|row| row["track"]["trackName"].as_str().unwrap()).collect();
    assert_eq!(names, ["Prelude 1", "Prelude 10", "Prelude 11"]);
    let got = view(&format!("sort=idAsc&offset=0&limit=4&around={}", ids[20])).await;
    assert_eq!((got["offset"].as_u64(), got["index"].as_u64()), (Some(18), Some(20)));
    assert_eq!(got["rows"][2]["track"]["id"], ids[20]);
    let got = view("sort=idAsc&q=ballade&offset=5&limit=4&around=1").await;
    assert_eq!(
        (got["offset"].as_u64(), got["index"].clone(), got["rows"].as_array().unwrap().len()),
        (Some(5), Value::Null, 0)
    );
    // Art: known, known to be missing (null), and unknown (absent).
    let got = view("sort=idAsc&limit=3").await;
    assert_eq!(got["rows"][0]["art"]["small"], "https://i.scdn.co/image/s1");
    assert_eq!(got["rows"][1]["art"], Value::Null);
    assert!(got["rows"][1].as_object().unwrap().contains_key("art"));
    assert!(!got["rows"][2].as_object().unwrap().contains_key("art"));
}

#[tokio::test]
async fn rejects_bad_view_parameters() {
    let h = harness().await;
    let sort = "sort must be one of recentDesc, idAsc, topPlayed, unratedFirst";
    let limit = "limit must be an integer from 1 to 500";
    for (query, error) in [
        ("limit=10", sort),
        ("sort=recent&limit=10", sort),
        ("sort=idAsc", limit),
        ("sort=idAsc&limit=0", limit),
        ("sort=idAsc&limit=501", limit),
        ("sort=idAsc&limit=10&offset=-3", "offset must be a non-negative integer"),
        ("sort=idAsc&limit=10&around=x", "around must be a positive track ID"),
        ("sort=idAsc&limit=10&around=0", "around must be a positive track ID"),
    ] {
        let reply = h.get(&format!("{VIEW_PATH}?{query}")).await;
        assert_eq!((reply.status, reply.json()), (400, json!({ "error": error })), "{query}");
    }
    assert_eq!(h.get(&format!("{VIEW_PATH}?sort=idAsc&limit=500")).await.status, 200);
}

#[tokio::test]
async fn reload_requires_the_token_and_reports_failures() {
    let h = harness().await;
    h.first_read().await;
    assert_eq!(h.call("POST", RELOAD_PATH, &[], "").await.status, 403);
    h.db.conn().execute_batch("DROP TABLE ratings").unwrap();
    let reply = h.post(RELOAD_PATH, &json!(null)).await;
    assert_eq!(reply.status, 500);
    let error = reply.json()["error"].as_str().unwrap().to_string();
    assert!(error.contains("ratings"), "{error}");
    let view = h.get(VIEW).await;
    assert_eq!((view.status, view.json()), (500, json!({ "error": error })));
}

#[tokio::test]
async fn a_sync_rereads_the_library() {
    let db = Arc::new(Db::open_in_memory().unwrap());
    let synced = Arc::clone(&db);
    let h = harness_on(
        db,
        Arc::new(move || {
            synced.conn().upsert_track(&UpsertTrackParams {
                spotify_id: "sp-9".into(),
                track_name: "Ondine".into(),
                last_played_at: 1,
                ..UpsertTrackParams::default()
            })?;
            Ok(SyncStats { inserted: 1, ..SyncStats::default() })
        }),
        assets(),
    )
    .await;
    assert_eq!(h.first_read().await["version"], 1);
    assert_eq!(h.post(SYNC_PATH, &json!({})).await.status, 200);
    let view = h.get(VIEW).await.json();
    assert_eq!((view["version"].as_u64(), view["total"].as_u64()), (Some(2), Some(1)));
    assert_eq!(view["rows"][0]["track"]["trackName"], "Ondine");
}

#[tokio::test]
async fn a_saved_rating_moves_the_library_to_a_new_version() {
    let h = harness().await;
    h.first_read().await;
    let older = h.seed("sp-a", "Older", 100);
    let newer = h.seed("sp-b", "Newer", 200);
    let version = h.reload().await;
    let unrated = || async {
        let view = h.get(&format!("{VIEW_PATH}?sort=unratedFirst&limit=100")).await.json();
        let ids: Vec<i64> =
            view["rows"].as_array().unwrap().iter().map(|row| row["track"]["id"].as_i64().unwrap()).collect();
        (view["version"].as_u64().unwrap(), ids, view["rows"][1]["rating"].clone())
    };
    assert_eq!(unrated().await, (version, vec![newer, older], Value::Null));
    let rating = json!({ "trackId": newer, "stars": 5, "opinion": "", "updatedAt": 3 });
    assert_eq!(h.post(RATINGS_PATH, &rating).await.json(), rating);
    assert_eq!(unrated().await, (version + 1, vec![older, newer], rating));
}

#[tokio::test]
async fn runs_sync_sharing_one_run_between_overlapping_requests() {
    let calls = Arc::new(AtomicUsize::new(0));
    let (release, released) = mpsc::channel::<SyncStats>();
    let released = Mutex::new(released);
    let counter = Arc::clone(&calls);
    let h = harness_with(Arc::new(move || {
        if counter.fetch_add(1, Ordering::SeqCst) == 0 {
            Ok(released.lock().unwrap().recv().unwrap())
        } else {
            Ok(SyncStats::default())
        }
    }))
    .await;
    let empty = json!({});
    let (first, second) = (h.post(SYNC_PATH, &empty), h.post(SYNC_PATH, &empty));
    let releaser = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        release.send(SyncStats { inserted: 2, ..SyncStats::default() }).unwrap();
    };
    let (first, second, ()) = tokio::join!(first, second, releaser);
    let want = json!({ "fetched": 0, "blocked": 0, "skipped": 0, "accepted": 0, "inserted": 2, "updated": 0, "alreadySynced": 0 });
    assert_eq!((first.json(), second.json()), (want.clone(), want));
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // A finished run does not stick: the next request syncs again.
    assert_eq!(h.post(SYNC_PATH, &json!({})).await.status, 200);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn reports_sync_failures_as_json_500s() {
    let h = harness_with(Arc::new(|| Err(anyhow!("login required").context("spotify")))).await;
    let reply = h.post(SYNC_PATH, &json!({})).await;
    assert_eq!((reply.status, reply.json()), (500, json!({ "error": "spotify: login required" })));
}

#[tokio::test]
async fn saves_a_valid_rating_and_returns_it() {
    let h = harness().await;
    let track_id = h.seed_track();
    let rating = json!({ "trackId": track_id, "stars": 5, "opinion": "Electric", "updatedAt": 300 });
    let reply = h.post(RATINGS_PATH, &rating).await;
    assert_eq!((reply.status, reply.json()), (200, rating));
    let saved = h.db.conn().rating_by_track_id(track_id).unwrap().unwrap();
    assert_eq!((saved.stars, saved.opinion.as_str(), saved.updated_at), (5, "Electric", 300));
}

#[tokio::test]
async fn validates_ratings() {
    let h = harness().await;
    let track_id = h.seed_track();
    let valid = json!({ "trackId": track_id, "stars": 3, "opinion": "", "updatedAt": 1 });
    let with = |key: &str, value: Value| {
        let mut body = valid.clone();
        match value {
            Value::Null if key == "stars" => {
                body.as_object_mut().unwrap().remove(key);
            }
            value => body[key] = value,
        }
        body.to_string()
    };
    let cases = [
        ("not json".to_string(), "request body must be JSON"),
        ("[]".to_string(), "request body must be a JSON object"),
        (with("trackId", json!(0)), "trackId must be a positive integer"),
        (with("trackId", json!("1")), "trackId must be a positive integer"),
        (with("trackId", json!(1.5)), "trackId must be a positive integer"),
        (with("stars", json!(0)), "stars must be between 1 and 5, got 0"),
        (with("stars", json!(6)), "stars must be between 1 and 5, got 6"),
        (with("stars", json!(2.5)), "stars must be between 1 and 5, got 2.5"),
        (with("stars", json!("3")), r#"stars must be between 1 and 5, got "3""#),
        (with("stars", Value::Null), "stars must be between 1 and 5, got nothing"),
        (with("opinion", Value::Null), "opinion must be a string"),
        (with("updatedAt", json!(-1)), "updatedAt must be a positive integer"),
    ];
    let token = h.server.token.clone();
    for (body, error) in cases {
        let reply = h.call("POST", RATINGS_PATH, &[(TOKEN_HEADER, &token)], &body).await;
        assert_eq!((reply.status, reply.json()), (400, json!({ "error": error })), "{body}");
    }
    let missing =
        h.post(RATINGS_PATH, &json!({ "trackId": track_id + 1, "stars": 3, "opinion": "", "updatedAt": 1 })).await;
    assert_eq!(
        (missing.status, missing.json()),
        (404, json!({ "error": format!("track {} not found", track_id + 1) }))
    );
    // JavaScript reads 4.0 as the integer 4.
    let float =
        h.post(RATINGS_PATH, &json!({ "trackId": track_id, "stars": 4.0, "opinion": "", "updatedAt": 1 })).await;
    assert_eq!(float.json()["stars"], json!(4));
    assert!(h.db.conn().list_all_ratings().unwrap().iter().all(|rating| rating.stars == 4));
}

#[tokio::test]
async fn limits_request_bodies_to_64_kib() {
    let h = harness().await;
    let track_id = h.seed_track();
    let at_limit = json!({ "trackId": track_id, "stars": 1, "opinion": "", "updatedAt": 1 }).to_string();
    let padded =
        at_limit.replace(r#""opinion":"""#, &format!(r#""opinion":"{}""#, "x".repeat(MAX_BODY_BYTES - at_limit.len())));
    assert_eq!(padded.len(), MAX_BODY_BYTES);
    let token = h.server.token.clone();
    assert_eq!(h.call("POST", RATINGS_PATH, &[(TOKEN_HEADER, &token)], &padded).await.status, 200);

    let too_big = h.call("POST", RATINGS_PATH, &[(TOKEN_HEADER, &token)], &format!("{padded} ")).await;
    assert_eq!((too_big.status, too_big.json()), (413, json!({ "error": "request body exceeds 65536 bytes" })));
    assert_eq!(too_big.header("connection"), Some("close"));
}

#[tokio::test]
async fn limits_chunked_bodies_without_a_content_length() {
    let h = harness().await;
    let token = h.server.token.clone();
    let body = "x".repeat(MAX_BODY_BYTES + 1);
    let reply = h.call("POST", SYNC_PATH, &[(TOKEN_HEADER, &token), ("Transfer-Encoding", "chunked")], &body).await;
    assert_eq!(reply.status, 413);
    assert_eq!(h.sync_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn looks_up_artwork_refusing_oversized_batches() {
    let h = harness().await;
    let reply = h.get(&format!("{ARTWORK_PATH}?ids=a,%20b")).await;
    assert_eq!((reply.status, reply.json()), (200, json!({ "a": null, "b": null })));
    assert_eq!(*h.artwork_calls.lock().unwrap(), vec![vec!["a".to_string(), "b".to_string()]]);

    assert_eq!(h.get(ARTWORK_PATH).await.json(), json!({}));
    let ids: Vec<String> = (0..51).map(|i| format!("id{i}")).collect();
    let too_many = h.get(&format!("{ARTWORK_PATH}?ids={}", ids.join(","))).await;
    assert_eq!((too_many.status, too_many.json()), (400, json!({ "error": "at most 50 ids per request, got 51" })));
}

#[tokio::test]
async fn fails_to_start_on_a_busy_port_and_stops_on_close() {
    let h = harness().await;
    let err = start(WebServerOptions {
        db: Arc::clone(&h.db),
        assets: Arc::new(assets()),
        sync: Arc::new(|| Ok(SyncStats::default())),
        artwork: Arc::new(FakeArtwork(Arc::default())),
        port: h.server.port,
        token: None,
        presence_grace: GRACE,
    })
    .await
    .err()
    .unwrap();
    assert_eq!(err.kind(), io::ErrorKind::AddrInUse);

    let port = h.server.port;
    h.server.close().await;
    assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
}

/// An open presence stream, as a page holds one; dropping it hangs up.
struct Tab {
    stream: TcpStream,
    /// The response so far: head and the first bytes of the stream.
    received: String,
}

impl Harness {
    fn presence_query(&self) -> String {
        format!("{PRESENCE_PATH}?{PRESENCE_TOKEN_PARAM}={}", self.server.token)
    }

    /// Opens a presence stream and returns once its first comment arrives.
    async fn open_tab(&self) -> Tab {
        let (port, path) = (self.server.port, self.presence_query());
        spawn_blocking(move || {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            write!(stream, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").unwrap();
            let mut received = Vec::new();
            let mut buffer = [0u8; 1024];
            while !String::from_utf8_lossy(&received).contains(": ok\n\n") {
                let read = stream.read(&mut buffer).unwrap();
                assert!(read > 0, "stream ended: {}", String::from_utf8_lossy(&received));
                received.extend_from_slice(&buffer[..read]);
            }
            Tab { stream, received: String::from_utf8_lossy(&received).into_owned() }
        })
        .await
        .unwrap()
    }

    /// Whether `all_tabs_closed` resolves within `wait`.
    async fn closed_within(&self, wait: Duration) -> bool {
        tokio::time::timeout(wait, self.server.all_tabs_closed()).await.is_ok()
    }
}

#[tokio::test]
async fn presence_waits_3_s_by_default() {
    assert_eq!(PRESENCE_GRACE, Duration::from_secs(3));
}

#[tokio::test]
async fn presence_streams_comments_to_a_page_with_the_token() {
    let h = harness().await;
    let tab = h.open_tab().await;
    let reply = parse_response(tab.received.as_bytes());
    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("content-type"), Some("text/event-stream"));
    assert_eq!(reply.header("cache-control"), Some("no-store"));
    assert_eq!(reply.header("content-security-policy"), Some(CONTENT_SECURITY_POLICY));
    assert_eq!(reply.header("transfer-encoding"), Some("chunked"));
    assert_eq!(reply.body, "6\r\n: ok\n\n\r\n");
    drop(tab.stream);
}

#[tokio::test]
async fn presence_rejects_a_missing_or_wrong_token_and_a_foreign_host_without_counting_them() {
    let h = harness().await;
    let wrong = format!("{PRESENCE_PATH}?{PRESENCE_TOKEN_PARAM}={}", "f".repeat(32));
    let empty = format!("{PRESENCE_PATH}?{PRESENCE_TOKEN_PARAM}=");
    for path in [PRESENCE_PATH, empty.as_str(), wrong.as_str()] {
        let reply = h.get(path).await;
        assert_eq!((reply.status, reply.json()), (403, json!({ "error": "missing or invalid token" })), "{path}");
    }
    // The token in the header (as POSTs send it) does not count either.
    let token = h.server.token.clone();
    assert_eq!(h.call("GET", PRESENCE_PATH, &[(TOKEN_HEADER, &token)], "").await.status, 403);
    let query = h.presence_query();
    let foreign = h.call("GET", &query, &[("Host", "evil.example")], "").await;
    assert_eq!((foreign.status, foreign.json()), (403, json!({ "error": "forbidden host" })));
    let post = h.post(&query, &json!({})).await;
    assert_eq!((post.status, post.header("allow")), (405, Some("GET")));
    assert!(!h.closed_within(GRACE * 3).await);
}

#[tokio::test]
async fn presence_never_stops_before_a_page_has_connected() {
    let h = harness().await;
    assert_eq!(h.get("/").await.status, 200);
    assert!(!h.closed_within(GRACE * 3).await);
}

#[tokio::test]
async fn presence_stops_once_the_last_stream_has_been_closed_for_the_grace_period() {
    let h = harness().await;
    let tab = h.open_tab().await;
    assert!(!h.closed_within(GRACE * 2).await);
    let closed_at = std::time::Instant::now();
    drop(tab);
    assert!(h.closed_within(Duration::from_secs(5)).await);
    assert!(closed_at.elapsed() >= GRACE, "{:?}", closed_at.elapsed());
}

#[tokio::test]
async fn presence_keeps_running_through_a_reload() {
    let h = harness().await;
    drop(h.open_tab().await);
    tokio::time::sleep(GRACE / 3).await;
    let after = h.open_tab().await;
    assert!(!h.closed_within(GRACE * 3).await);
    drop(after);
    assert!(h.closed_within(GRACE * 3).await);
}

#[tokio::test]
async fn presence_stops_only_after_the_last_of_several_tabs_closes() {
    let h = harness().await;
    let (first, second) = tokio::join!(h.open_tab(), h.open_tab());
    drop(first);
    assert!(!h.closed_within(GRACE * 3).await);
    drop(second);
    assert!(h.closed_within(GRACE * 3).await);
}

#[tokio::test]
async fn presence_waits_for_a_running_sync_before_stopping() {
    let (release, released) = mpsc::channel::<()>();
    let released = Mutex::new(released);
    let h = harness_with(Arc::new(move || {
        released.lock().unwrap().recv().unwrap();
        Ok(SyncStats::default())
    }))
    .await;
    let tab = h.open_tab().await;
    let checks = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(tab);
        assert!(!h.closed_within(GRACE * 3).await);
        release.send(()).unwrap();
    };
    let empty = json!({});
    let (reply, ()) = tokio::join!(h.post(SYNC_PATH, &empty), checks);
    assert_eq!(reply.status, 200);
    assert!(h.closed_within(GRACE).await);
}

#[tokio::test]
async fn presence_waits_for_a_rating_save_and_keeps_running_if_a_tab_returns_meanwhile() {
    let h = harness().await;
    let track_id = h.seed_track();
    let tab = h.open_tab().await;
    // Holding the database stalls the save once it has started.
    let held = h.db.conn();
    let rating = json!({ "trackId": track_id, "stars": 4, "opinion": "", "updatedAt": 1 });
    let checks = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(tab);
        assert!(!h.closed_within(GRACE * 3).await);
        let back = h.open_tab().await;
        drop(held);
        back
    };
    let (reply, back) = tokio::join!(h.post(RATINGS_PATH, &rating), checks);
    assert_eq!(reply.status, 200);
    assert!(!h.closed_within(GRACE * 3).await);
    drop(back);
    assert!(h.closed_within(GRACE * 3).await);
}

#[tokio::test]
async fn close_ends_presence_streams() {
    let h = harness().await;
    let mut tab = h.open_tab().await;
    let started = std::time::Instant::now();
    h.server.close().await;
    assert!(started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
    let mut rest = String::new();
    let _ = tab.stream.read_to_string(&mut rest);
    assert_eq!(rest, "0\r\n\r\n");
}

// ---- Compression ----

fn decode(reply: &Reply, raw: &[u8]) -> String {
    let mut text = String::new();
    match reply.header("content-encoding") {
        Some("br") => brotli::Decompressor::new(raw, 4096).read_to_string(&mut text).unwrap(),
        Some("gzip") => flate2::read::GzDecoder::new(raw).read_to_string(&mut text).unwrap(),
        other => panic!("not compressed: {other:?}"),
    };
    text
}

/// One request whose body is kept as bytes.
async fn raw_get(h: &Harness, path: &str, accept: &str) -> (Reply, Vec<u8>) {
    let (port, path, accept) = (h.server.port, path.to_string(), accept.to_string());
    spawn_blocking(move || {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept-Encoding: {accept}\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response);
        let split = response.windows(4).position(|window| window == b"\r\n\r\n").unwrap() + 4;
        (parse_response(&response[..split]), response[split..].to_vec())
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn compresses_json_and_html_over_1_kib_as_the_client_allows() {
    let h = harness().await;
    h.first_read().await;
    for i in 0..20 {
        h.seed(&format!("sp-{i}"), &format!("Etude {i}"), i + 1);
    }
    h.reload().await;
    let plain = h.get(VIEW).await;
    assert!(plain.body.len() > compress::MIN_SIZE);
    assert_eq!((plain.header("content-encoding"), plain.header("vary")), (None, Some("accept-encoding")));
    for (accept, encoding) in [("gzip, deflate, br, zstd", "br"), ("gzip", "gzip"), ("br;q=0, gzip", "gzip")] {
        let (reply, raw) = raw_get(&h, VIEW, accept).await;
        assert_eq!(reply.header("content-encoding"), Some(encoding), "{accept}");
        assert_eq!(reply.header("vary"), Some("accept-encoding"));
        assert!(raw.len() < plain.body.len() / 3, "{accept}: {} bytes", raw.len());
        assert_eq!(decode(&reply, &raw), plain.body);
    }
    // Small answers go out as they are.
    let (small, raw) = raw_get(&h, &format!("{VIEW_PATH}?sort=idAsc&limit=1"), "br").await;
    assert_eq!((small.header("content-encoding"), small.header("vary")), (None, Some("accept-encoding")));
    assert!(serde_json::from_slice::<Value>(&raw).is_ok());
    // So do error bodies, which are small.
    let (error, _) = raw_get(&h, "/api/nope", "br").await;
    assert_eq!((error.status, error.header("content-encoding")), (404, None));
}

#[tokio::test]
async fn serves_build_time_compressed_assets() {
    let h = harness().await;
    for (accept, encoding) in [("br, gzip", "br"), ("gzip", "gzip")] {
        let (reply, raw) = raw_get(&h, "/assets/big.js", accept).await;
        assert_eq!(reply.header("content-encoding"), Some(encoding));
        assert_eq!(reply.header("vary"), Some("accept-encoding"));
        assert_eq!(reply.header("cache-control"), Some("private, max-age=300"));
        assert_eq!(reply.header("content-type"), Some("text/javascript; charset=utf-8"));
        assert_eq!(decode(&reply, &raw), big_script());
    }
    let (identity, raw) = raw_get(&h, "/assets/big.js", "identity").await;
    assert_eq!((identity.header("content-encoding"), raw), (None, big_script().into_bytes()));
}

#[tokio::test]
async fn never_compresses_the_presence_stream() {
    let h = harness().await;
    let (port, path) = (h.server.port, h.presence_query());
    let head = spawn_blocking(move || {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        write!(stream, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept-Encoding: br, gzip\r\n\r\n").unwrap();
        let mut received = Vec::new();
        let mut buffer = [0u8; 1024];
        while !String::from_utf8_lossy(&received).contains(": ok\n\n") {
            let read = stream.read(&mut buffer).unwrap();
            assert!(read > 0);
            received.extend_from_slice(&buffer[..read]);
        }
        String::from_utf8_lossy(&received).into_owned()
    })
    .await
    .unwrap();
    let reply = parse_response(head.as_bytes());
    assert_eq!((reply.header("content-type"), reply.header("content-encoding")), (Some("text/event-stream"), None));
    assert_eq!(reply.body, "6\r\n: ok\n\n\r\n");
}

// ---- The server-rendered page ----

async fn ssr_harness() -> Harness {
    let mut assets = assets();
    assets.insert("/".into(), Asset::new("text/html; charset=utf-8", Bytes::from_static(SSR_TEMPLATE.as_bytes())));
    harness_on(Arc::new(Db::open_in_memory().unwrap()), Arc::new(|| Ok(SyncStats::default())), assets).await
}

/// The `{"view": ...}` the page was rendered from.
fn initial_json(page: &str) -> Value {
    let start = page.find(r#"<script type="application/json" id="tracker-initial">"#).expect("the initial state");
    let json = &page[start..];
    let json = &json[json.find('>').unwrap() + 1..json.find("</script>").unwrap()];
    serde_json::from_str(json).unwrap()
}

#[tokio::test]
async fn renders_the_first_screen_and_the_state_it_came_from() {
    let h = ssr_harness().await;
    h.first_read().await;
    let first = h.seed("sp-1", "Gaspard </script><script>alert(1)</script> & \u{2028}", 300);
    h.seed("sp-2", "Ondine", 200);
    h.seed("sp-3", "Le Gibet", 100);
    h.reload().await;

    let page = h.call("GET", "/", &[("Cookie", "tracker-theme=dark")], "").await;
    assert_eq!(page.status, 200);
    assert_eq!(page.header("content-security-policy"), Some(CONTENT_SECURITY_POLICY));
    let body = &page.body;
    assert!(
        body.starts_with(&format!(
            r#"<html data-theme="dark"><meta name="tracker-token" content="{}">"#,
            h.server.token
        ))
    );
    // The app, rendered: the list with the first track selected, its
    // details with its known art, and the footer.
    assert!(body.contains(r#"<div id="root"><div class="app">"#), "{body}");
    assert!(body.contains(r#"<p class="muted">3 loaded · sort: recent</p>"#), "{body}");
    assert!(
        body.contains(&format!(
            r#"<li id="track-{first}" role="option" aria-selected="true" class="row row--selected""#
        )),
        "{body}"
    );
    assert!(
        body.contains(r#"<h2 class="hero__title">Gaspard &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; "#),
        "{body}"
    );
    assert!(body.contains(r#"src="https://i.scdn.co/image/s1""#), "known art is in the first render: {body}");
    assert!(body.contains(r#"<input type="radio" name="theme" value="dark" checked>"#), "{body}");
    assert!(body.contains(r#"<footer class="footer">"#), "{body}");
    // The data only appears escaped: nothing in it can end the script.
    assert_eq!(body.matches("</script>").count(), 1, "{body}");
    let script = &body[body.find("tracker-initial").unwrap()..];
    assert!(!script.contains('\u{2028}') && !script.contains('&'), "{script}");
    let initial = initial_json(body);
    assert_eq!((initial["view"]["version"].as_u64(), initial["view"]["matched"].as_u64()), (Some(2), Some(3)));
    assert_eq!(
        initial["view"]["rows"][0]["track"]["trackName"],
        "Gaspard </script><script>alert(1)</script> & \u{2028}"
    );
    assert_eq!(initial["view"]["index"], Value::Null);
    assert!(!initial.as_object().unwrap().contains_key("error"));
    // Compressed like any HTML.
    let (compressed, _) = raw_get(&h, "/", "br").await;
    assert_eq!(compressed.header("content-encoding"), Some("br"));
}

#[tokio::test]
async fn renders_the_error_screen_when_the_library_cannot_be_read() {
    let h = ssr_harness().await;
    h.first_read().await;
    h.db.conn().execute_batch("DROP TABLE tracks").unwrap();
    assert_eq!(h.post(RELOAD_PATH, &json!(null)).await.status, 500);
    let page = h.get("/").await.body;
    let error = initial_json(&page)["error"].as_str().unwrap().to_string();
    assert!(error.contains("tracks"), "{error}");
    assert_eq!(initial_json(&page)["view"], Value::Null);
    assert!(page.contains(r#"<p class="error">Error: "#), "{page}");
    assert!(page.contains(">Retry</button>"), "{page}");
}

#[tokio::test]
async fn the_page_waits_briefly_for_the_first_read() {
    let db = Arc::new(Db::open_in_memory().unwrap());
    // Holding the database (on a thread of its own) stalls the first read.
    let (release, released) = mpsc::channel::<()>();
    let (locked, held) = mpsc::channel::<()>();
    let holder = {
        let db = Arc::clone(&db);
        std::thread::spawn(move || {
            let _conn = db.conn();
            locked.send(()).unwrap();
            released.recv().unwrap();
        })
    };
    held.recv().unwrap();
    let mut assets = assets();
    assets.insert("/".into(), Asset::new("text/html; charset=utf-8", Bytes::from_static(SSR_TEMPLATE.as_bytes())));
    let h = harness_on(Arc::clone(&db), Arc::new(|| Ok(SyncStats::default())), assets).await;
    let started = StdInstant::now();
    let page = h.get("/").await.body;
    let waited = started.elapsed();
    assert!(waited >= Duration::from_millis(900) && waited < Duration::from_secs(5), "{waited:?}");
    assert_eq!(initial_json(&page), json!({ "view": null }));
    assert!(page.contains("Loading local tracks..."), "{page}");
    release.send(()).unwrap();
    holder.join().unwrap();
    assert_eq!(h.first_read().await["version"], 1);
}

#[tokio::test]
async fn pages_without_the_placeholders_are_served_as_before() {
    let h = harness().await;
    let page = h.get("/").await;
    assert!(!page.body.contains("tracker-initial"), "{}", page.body);
}
