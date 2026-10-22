//! Ports of the TypeScript build's `artwork.test.ts`. Every Spotify host is
//! a local mock; nothing here reaches the network.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use jiff::{SignedDuration, Timestamp};
use serde_json::json;
use tracker_core::config::{Config, SpotifyConfig, Token};
use tracker_spotify::test_support::{MockServer, Recorded, Reply};
use url::Url;

use super::*;

/// A valid 22-character Spotify ID.
fn sid(n: usize) -> String {
    format!("{:x<22}", format!("track{n}"))
}

const IMAGES: &str = r#"[{"url":"https://i.scdn.co/640","width":640},
    {"url":"https://i.scdn.co/300","width":300},{"url":"https://i.scdn.co/64","width":64}]"#;

fn api_art() -> Option<Artwork> {
    Some(Artwork {
        small: Some("https://i.scdn.co/64".into()),
        medium: Some("https://i.scdn.co/300".into()),
        large: Some("https://i.scdn.co/640".into()),
    })
}

fn thumb_art(id: &str) -> Option<Artwork> {
    let url = Some(format!("https://thumb/{id}"));
    Some(Artwork { small: url.clone(), medium: url.clone(), large: url })
}

fn response(entries: Vec<(String, Option<Artwork>)>) -> ArtworkResponse {
    ArtworkResponse(entries)
}

fn token_expiring_in(seconds: i64) -> Token {
    Token {
        access_token: "old-access".into(),
        refresh_token: "refresh".into(),
        token_type: "Bearer".into(),
        expiry: Some(Timestamp::now().checked_add(SignedDuration::from_secs(seconds)).unwrap()),
    }
}

/// Writes a config with credentials and, optionally, a stored token.
fn write_config(dir: &tempfile::TempDir, token: Option<Token>) -> PathBuf {
    let path = dir.path().join("config.json");
    let cfg = Config {
        spotify: SpotifyConfig { client_id: "client-id".into(), client_secret: "client-secret".into(), token },
        ..Config::default()
    };
    config::save(&path, &cfg).unwrap();
    path
}

/// The track ID an oEmbed request asks about.
fn oembed_id(request: &Recorded) -> String {
    let url = Url::parse(&format!("http://x{}", request.target)).unwrap();
    let track_url = url.query_pairs().find(|(name, _)| name == "url").unwrap().1.into_owned();
    track_url.trim_start_matches("https://open.spotify.com/track/").to_string()
}

/// oEmbed that knows every ID except `unknown`.
fn oembed_handler(unknown: Vec<String>) -> impl Fn(&Recorded) -> Reply + Send + Sync + 'static {
    move |request| {
        let id = oembed_id(request);
        if unknown.contains(&id) {
            return Reply::json(404, r#"{"error":"not found"}"#);
        }
        Reply::json(200, &json!({ "type": "rich", "thumbnail_url": format!("https://thumb/{id}") }).to_string())
    }
}

/// A Spotify API mock answering batch and single lookups from IMAGES.
fn api_handler(batch_status: u16) -> impl Fn(&Recorded) -> Reply + Send + Sync + 'static {
    move |request| {
        let url = Url::parse(&format!("http://x{}", request.target)).unwrap();
        if url.path() == "/tracks" {
            if batch_status != 200 {
                return Reply::json(
                    batch_status,
                    &format!(r#"{{"error":{{"status":{batch_status},"message":"refused"}}}}"#),
                );
            }
            let ids = url.query_pairs().find(|(name, _)| name == "ids").unwrap().1.into_owned();
            let tracks: Vec<String> =
                ids.split(',').map(|id| format!(r#"{{"id":"{id}","album":{{"images":{IMAGES}}}}}"#)).collect();
            return Reply::json(200, &format!(r#"{{"tracks":[{}]}}"#, tracks.join(",")));
        }
        let id = url.path().trim_start_matches("/tracks/");
        Reply::json(200, &format!(r#"{{"id":"{id}","album":{{"images":{IMAGES}}}}}"#))
    }
}

struct Setup {
    api: Option<MockServer>,
    oembed: Option<MockServer>,
    token: Option<Token>,
    cache_path: Option<PathBuf>,
    tweak: Box<dyn FnOnce(&mut ArtworkServiceOptions)>,
}

impl Default for Setup {
    fn default() -> Setup {
        Setup {
            api: None,
            oembed: None,
            token: Some(token_expiring_in(3600)),
            cache_path: None,
            tweak: Box::new(|_| {}),
        }
    }
}

struct Service {
    svc: ArtworkService,
    config_path: PathBuf,
    accounts: MockServer,
    api: Option<MockServer>,
    oembed: Option<MockServer>,
    _dir: tempfile::TempDir,
}

fn service(setup: Setup) -> Service {
    let dir = tempfile::tempdir().unwrap();
    let accounts = MockServer::start(|_| {
        Reply::json(200, r#"{"access_token":"new-access","token_type":"Bearer","expires_in":3600}"#)
    });
    let config_path = write_config(&dir, setup.token);
    let spotify: SpotifyFactory = match &setup.api {
        None => Arc::new(|| None),
        Some(api) => {
            let (path, accounts_url, api_url) = (config_path.clone(), accounts.base_url.clone(), api.base_url.clone());
            Arc::new(move || config_artwork_api(&path, &accounts_url, &api_url))
        }
    };
    let mut options = ArtworkServiceOptions::new(setup.cache_path, spotify);
    options.oembed_base_url =
        setup.oembed.as_ref().map_or("http://127.0.0.1:1".to_string(), |oembed| oembed.base_url.clone());
    (setup.tweak)(&mut options);
    Service {
        svc: ArtworkService::new(options),
        config_path,
        accounts,
        api: setup.api,
        oembed: setup.oembed,
        _dir: dir,
    }
}

fn targets(server: &MockServer) -> Vec<String> {
    server.requests().into_iter().map(|request| request.target).collect()
}

#[tokio::test]
async fn uses_the_batch_endpoint_dropping_invalid_and_duplicate_ids() {
    let s = service(Setup {
        api: Some(MockServer::start(api_handler(200))),
        oembed: Some(MockServer::start(oembed_handler(Vec::new()))),
        ..Setup::default()
    });
    let result = s.svc.lookup(&[sid(1), "not-an-id".into(), sid(2), sid(1), format!("{}!", sid(3))]).await;
    assert_eq!(result, response(vec![(sid(1), api_art()), (sid(2), api_art())]));
    assert_eq!(targets(s.api.as_ref().unwrap()), [format!("/tracks?ids={}%2C{}", sid(1), sid(2))]);
    assert!(s.oembed.unwrap().requests().is_empty());
}

#[tokio::test]
async fn persists_a_refreshed_token_to_the_config_like_the_cli() {
    let s = service(Setup {
        api: Some(MockServer::start(api_handler(200))),
        token: Some(token_expiring_in(-60)),
        ..Setup::default()
    });
    s.svc.lookup(&[sid(1)]).await;
    assert_eq!(s.accounts.requests().len(), 1);
    assert_eq!(s.api.unwrap().single_request().header("authorization"), Some("Bearer new-access"));
    let token = config::load(&s.config_path).unwrap().spotify.token.unwrap();
    assert_eq!((token.access_token.as_str(), token.refresh_token.as_str()), ("new-access", "refresh"));
}

#[tokio::test]
async fn falls_back_to_per_track_lookups_when_the_batch_is_refused_and_remembers() {
    let s = service(Setup { api: Some(MockServer::start(api_handler(403))), ..Setup::default() });
    assert_eq!(s.svc.lookup(&[sid(1), sid(2)]).await, response(vec![(sid(1), api_art()), (sid(2), api_art())]));
    assert_eq!(s.svc.lookup(&[sid(3)]).await, response(vec![(sid(3), api_art())]));
    let mut requests = targets(s.api.as_ref().unwrap());
    requests[1..3].sort();
    assert_eq!(
        requests,
        [
            format!("/tracks?ids={}%2C{}", sid(1), sid(2)),
            format!("/tracks/{}", sid(1)),
            format!("/tracks/{}", sid(2)),
            format!("/tracks/{}", sid(3)),
        ]
    );
}

#[tokio::test]
async fn falls_back_to_per_track_lookups_on_a_404_batch_too() {
    let s = service(Setup { api: Some(MockServer::start(api_handler(404))), ..Setup::default() });
    assert_eq!(s.svc.lookup(&[sid(1)]).await, response(vec![(sid(1), api_art())]));
    assert_eq!(targets(s.api.as_ref().unwrap()), [format!("/tracks?ids={}", sid(1)), format!("/tracks/{}", sid(1))]);
}

#[tokio::test]
async fn uses_oembed_when_there_is_no_stored_token() {
    let s = service(Setup {
        api: Some(MockServer::start(api_handler(200))),
        oembed: Some(MockServer::start(oembed_handler(vec![sid(2)]))),
        token: None,
        ..Setup::default()
    });
    assert_eq!(s.svc.lookup(&[sid(1), sid(2)]).await, response(vec![(sid(1), thumb_art(&sid(1))), (sid(2), None)]));
    assert!(s.api.unwrap().requests().is_empty());
    let mut asked: Vec<String> = s.oembed.unwrap().requests().iter().map(oembed_id).collect();
    asked.sort();
    assert_eq!(asked, [sid(1), sid(2)]);
}

#[tokio::test]
async fn uses_oembed_when_the_api_fails_or_refuses_every_path() {
    let failing = service(Setup {
        api: Some(MockServer::start(|_| Reply::json(500, ""))),
        oembed: Some(MockServer::start(oembed_handler(Vec::new()))),
        ..Setup::default()
    });
    assert_eq!(failing.svc.lookup(&[sid(1)]).await, response(vec![(sid(1), thumb_art(&sid(1)))]));

    let refusing = service(Setup {
        api: Some(MockServer::start(|_| Reply::json(403, ""))),
        oembed: Some(MockServer::start(oembed_handler(Vec::new()))),
        ..Setup::default()
    });
    assert_eq!(refusing.svc.lookup(&[sid(2)]).await, response(vec![(sid(2), thumb_art(&sid(2)))]));
    // Both endpoints refused: later lookups skip the API entirely.
    assert_eq!(refusing.svc.lookup(&[sid(3)]).await, response(vec![(sid(3), thumb_art(&sid(3)))]));
    assert_eq!(refusing.api.unwrap().requests().len(), 2);
}

#[tokio::test]
async fn asks_oembed_about_ids_the_batch_did_not_know() {
    let s = service(Setup {
        api: Some(MockServer::start(|_| Reply::json(200, r#"{"tracks":[null,{"album":{"images":[]}}]}"#))),
        oembed: Some(MockServer::start(oembed_handler(vec![sid(1)]))),
        ..Setup::default()
    });
    assert_eq!(s.svc.lookup(&[sid(1), sid(2)]).await, response(vec![(sid(1), None), (sid(2), None)]));
    // sid(2) was found without images: a definitive "no art" with no second opinion.
    assert_eq!(s.oembed.unwrap().requests().iter().map(oembed_id).collect::<Vec<_>>(), [sid(1)]);
}

#[tokio::test]
async fn persists_answers_atomically_with_owner_only_permissions_and_reloads_them() {
    let dir = tempfile::tempdir().unwrap();
    let cache_path = artwork_cache_path(&dir.path().join("tracker.db")).unwrap();
    assert_eq!(cache_path, dir.path().join(ARTWORK_CACHE_FILE));

    let s = service(Setup {
        oembed: Some(MockServer::start(oembed_handler(vec![sid(2)]))),
        cache_path: Some(cache_path.clone()),
        tweak: Box::new(|options| options.persist_delay = Duration::from_secs(60)),
        ..Setup::default()
    });
    s.svc.lookup(&[sid(1), sid(2)]).await;
    s.svc.close();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&cache_path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let written: Value = serde_json::from_str(&fs::read_to_string(&cache_path).unwrap()).unwrap();
    assert_eq!(written, json!({ "version": 1, "artwork": { sid(1): thumb_art(&sid(1)), sid(2): null } }));
    assert!(
        fs::read_dir(dir.path()).unwrap().all(|entry| !entry.unwrap().file_name().to_string_lossy().starts_with('.'))
    );

    let mut options = ArtworkServiceOptions::new(Some(cache_path), Arc::new(|| panic!("unexpected Spotify lookup")));
    options.fetch = Arc::new(|_| panic!("unexpected fetch"));
    let reloaded = ArtworkService::new(options);
    assert_eq!(reloaded.lookup(&[sid(2), sid(1)]).await, response(vec![(sid(2), None), (sid(1), thumb_art(&sid(1)))]));
}

#[tokio::test]
async fn keeps_the_typescript_file_format_and_order() {
    let dir = tempfile::tempdir().unwrap();
    let cache_path = dir.path().join(ARTWORK_CACHE_FILE);
    let existing = format!(
        r#"{{"version":1,"artwork":{{"{}":{{"small":"s","medium":null,"large":"l"}},"{}":null}}}}"#,
        sid(9),
        sid(3)
    );
    fs::write(&cache_path, &existing).unwrap();
    let s = service(Setup {
        oembed: Some(MockServer::start(oembed_handler(Vec::new()))),
        cache_path: Some(cache_path.clone()),
        ..Setup::default()
    });
    s.svc.lookup(&[sid(1)]).await;
    s.svc.flush();
    let thumb = format!("https://thumb/{}", sid(1));
    assert_eq!(
        fs::read_to_string(&cache_path).unwrap(),
        format!(
            r#"{{"version":1,"artwork":{{"{}":{{"small":"s","medium":null,"large":"l"}},"{}":null,"{}":{{"small":"{thumb}","medium":"{thumb}","large":"{thumb}"}}}}}}"#,
            sid(9),
            sid(3),
            sid(1)
        )
    );
}

#[tokio::test]
async fn writes_on_the_debounce_timer() {
    let dir = tempfile::tempdir().unwrap();
    let cache_path = dir.path().join(ARTWORK_CACHE_FILE);
    let s = service(Setup {
        oembed: Some(MockServer::start(oembed_handler(Vec::new()))),
        cache_path: Some(cache_path.clone()),
        tweak: Box::new(|options| options.persist_delay = Duration::from_millis(1)),
        ..Setup::default()
    });
    s.svc.lookup(&[sid(1)]).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let written: Value = serde_json::from_str(&fs::read_to_string(&cache_path).unwrap()).unwrap();
    assert!(written["artwork"].get(sid(1)).is_some());
}

#[tokio::test]
async fn ignores_a_corrupt_cache_file() {
    let dir = tempfile::tempdir().unwrap();
    let cache_path = dir.path().join(ARTWORK_CACHE_FILE);
    fs::write(&cache_path, r#"{"version":1,"artwork":{"bad":{"small":1}}"#).unwrap();
    let s = service(Setup {
        oembed: Some(MockServer::start(oembed_handler(Vec::new()))),
        cache_path: Some(cache_path),
        ..Setup::default()
    });
    assert_eq!(s.svc.lookup(&[sid(1)]).await, response(vec![(sid(1), thumb_art(&sid(1)))]));

    // Well-formed files skip only their malformed entries.
    let path = dir.path().join("partial.json");
    fs::write(
        &path,
        format!(
            r#"{{"version":1,"artwork":{{"short":null,"{}":{{"small":1,"medium":null,"large":null}},"{}":{{"small":"s","medium":null}},"{}":{{"small":"s","medium":null,"large":"l"}}}}}}"#,
            sid(1),
            sid(2),
            sid(3)
        ),
    )
    .unwrap();
    assert_eq!(
        read_cache(&path),
        vec![(sid(3), Some(Artwork { small: Some("s".into()), medium: None, large: Some("l".into()) }))]
    );
    fs::write(&path, format!(r#"{{"version":2,"artwork":{{"{}":null}}}}"#, sid(1))).unwrap();
    assert!(read_cache(&path).is_empty());
}

#[tokio::test]
async fn remembers_transient_failures_in_memory_for_the_ttl_only() {
    let healthy = Arc::new(AtomicUsize::new(0));
    let flag = Arc::clone(&healthy);
    let handler = oembed_handler(Vec::new());
    let oembed = MockServer::start(move |request| {
        if flag.load(Ordering::SeqCst) == 1 { handler(request) } else { Reply::json(503, r#"{"error":"busy"}"#) }
    });
    let dir = tempfile::tempdir().unwrap();
    let cache_path = dir.path().join(ARTWORK_CACHE_FILE);
    let elapsed_ms = Arc::new(AtomicU64::new(0));
    let clock_ms = Arc::clone(&elapsed_ms);
    let start = Instant::now();
    let s = service(Setup {
        oembed: Some(oembed),
        cache_path: Some(cache_path.clone()),
        tweak: Box::new(move |options| {
            options.now = Arc::new(move || start + Duration::from_millis(clock_ms.load(Ordering::SeqCst)));
            options.failure_ttl = Duration::from_secs(600);
        }),
        ..Setup::default()
    });

    assert_eq!(s.svc.lookup(&[sid(1)]).await, response(vec![(sid(1), None)]));
    healthy.store(1, Ordering::SeqCst);
    assert_eq!(s.svc.lookup(&[sid(1)]).await, response(vec![(sid(1), None)]));
    assert_eq!(s.oembed.as_ref().unwrap().requests().len(), 1);
    s.svc.flush();
    assert!(!cache_path.exists(), "failures are never persisted");

    elapsed_ms.store(600_001, Ordering::SeqCst);
    assert_eq!(s.svc.lookup(&[sid(1)]).await, response(vec![(sid(1), thumb_art(&sid(1)))]));
    assert_eq!(s.oembed.unwrap().requests().len(), 2);
}

#[tokio::test]
async fn coalesces_concurrent_lookups_of_the_same_ids() {
    let s = service(Setup { api: Some(MockServer::start(api_handler(200))), ..Setup::default() });
    let (forward, backward) = ([sid(1), sid(2)], [sid(2), sid(1)]);
    let (first, second) = tokio::join!(s.svc.lookup(&forward), s.svc.lookup(&backward));
    assert_eq!(first.0.iter().rev().cloned().collect::<Vec<_>>(), second.0);
    assert_eq!(s.api.as_ref().unwrap().requests().len(), 1);

    // Only the IDs not already in flight are fetched.
    let (one, two) = ([sid(3)], [sid(3), sid(4)]);
    tokio::join!(s.svc.lookup(&one), s.svc.lookup(&two));
    let mut later = targets(s.api.as_ref().unwrap()).split_off(1);
    later.sort();
    assert_eq!(later, [format!("/tracks?ids={}", sid(3)), format!("/tracks?ids={}", sid(4))]);
}

#[tokio::test]
async fn limits_concurrent_oembed_requests() {
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let (now_active, max_active) = (Arc::clone(&active), Arc::clone(&peak));
    let mut options = ArtworkServiceOptions::new(None, Arc::new(|| None));
    options.concurrency = 4;
    options.fetch = Arc::new(move |url| {
        let running = now_active.fetch_add(1, Ordering::SeqCst) + 1;
        max_active.fetch_max(running, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(20));
        now_active.fetch_sub(1, Ordering::SeqCst);
        let id = url.rsplit("%2F").next().unwrap();
        Ok((200, json!({ "thumbnail_url": format!("https://thumb/{id}") }).to_string()))
    });
    let svc = ArtworkService::new(options);
    let ids: Vec<String> = (0..12).map(sid).collect();
    let result = svc.lookup(&ids).await;
    assert!(result.0.iter().all(|(id, art)| *art == thumb_art(id)));
    assert_eq!(peak.load(Ordering::SeqCst), 4);
}

#[test]
fn spotify_ids_are_22_base62_characters() {
    assert!(is_spotify_id("4uLU6hMCjMI75M1A2tKUQC"));
    for id in
        ["", "4uLU6hMCjMI75M1A2tKUQ", "4uLU6hMCjMI75M1A2tKUQC1", "4uLU6hMCjMI75M1A2tKU-C", "4uLU6hMCjMI75M1A2tKUQé"]
    {
        assert!(!is_spotify_id(id), "{id}");
    }
    assert_eq!(artwork_cache_path(Path::new("tracker.db")), Some(PathBuf::from(ARTWORK_CACHE_FILE)));
    for path in ["", ":memory:", "file:x.db?mode=memory"] {
        assert_eq!(artwork_cache_path(Path::new(path)), None, "{path}");
    }
}
