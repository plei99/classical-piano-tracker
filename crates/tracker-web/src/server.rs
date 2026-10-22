//! The local HTTP server behind `tracker web`: the server-rendered page,
//! static assets, and the JSON API from [`tracker_app::api`]. It owns the
//! library ([`Library`]): pages fetch the window they show, never the whole
//! thing. It only ever serves the browser on this machine, so the defenses
//! target other web pages the user has open (DNS rebinding, cross-site
//! POSTs), not remote clients; see the security notes in the API module.
//!
//! Every request goes through one handler, so the checks run in the same
//! order as the TypeScript build's server and give the same answers.

use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, ready};
use std::time::Duration;

use anyhow::{Result, anyhow};
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::Response;
use http_body::Frame;
use http_body_util::BodyExt;
use serde::Serialize;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch};
use tokio::task::{JoinHandle, spawn_blocking};
use tokio::time::{Instant, Interval, interval_at};
use tracker_app::api::{
    ARTWORK_BATCH, ARTWORK_PATH, Artwork, ArtworkResponse, ErrorResponse, INITIAL_STATE_ID, InitialState,
    PRESENCE_PATH, PRESENCE_TOKEN_PARAM, RATINGS_PATH, RELOAD_PATH, ReloadResponse, SYNC_PATH, TOKEN_HEADER, Theme,
    VIEW_PATH,
};
use tracker_core::db::Queries;
use tracker_core::{Db, Rating, SyncStats, UpsertRatingParams};
use url::Url;

use crate::artwork::hex;
use crate::compress::{self, Encoding};
use crate::library::{Library, ViewQuery};

/// Where the page receives its per-launch token; replaced on every `/`
/// response.
pub const TOKEN_PLACEHOLDER: &str = "%TRACKER_TOKEN%";
/// Where the page receives the saved appearance (`data-theme`), read from
/// the theme cookie on every `/` response.
pub const THEME_PLACEHOLDER: &str = "%TRACKER_THEME%";
/// Where the page receives the server-rendered app (inside `#root`).
pub const APP_PLACEHOLDER: &str = "<!--tracker-app-->";
/// Where the page receives the state it was rendered from, as
/// `<script type="application/json" id="tracker-initial">`.
pub const INITIAL_PLACEHOLDER: &str = "<!--tracker-initial-->";

/// How long `/` waits for the library to finish loading before it renders
/// the loading screen instead.
const FIRST_LOAD_WAIT: Duration = Duration::from_secs(1);

/// Spotify's iFrame API loader (open.spotify.com) pulls its code from
/// embed-cdn.spotifycdn.com, and that code evaluates strings, so
/// 'unsafe-eval' is required for in-page playback. It does not allow inline
/// scripts: only this app's bundle and Spotify's scripts can run, and the
/// app never passes strings to eval.
pub const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self' 'unsafe-eval' https://open.spotify.com https://embed-cdn.spotifycdn.com; frame-src https://open.spotify.com; \
     img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; \
     form-action 'none'";

/// Generous for a rating with a long opinion, small enough that no request
/// can exhaust memory.
pub const MAX_BODY_BYTES: usize = 64 * 1024;

/// Assets are rebuilt with the binary, so a short cache only saves reloads
/// within one session.
const ASSET_CACHE_CONTROL: &str = "private, max-age=300";

/// How long no page may hold a presence stream before the server stops:
/// enough for a reload to reconnect.
pub const PRESENCE_GRACE: Duration = Duration::from_secs(3);

/// Keeps presence streams from looking idle to anything between the page
/// and the server.
const PRESENCE_PING: Duration = Duration::from_secs(15);

const JSON_CONTENT_TYPE: &str = "application/json; charset=utf-8";
const TEXT_CONTENT_TYPE: &str = "text/plain; charset=utf-8";

/// A static file, with compressed copies when the build made them.
#[derive(Debug, Clone)]
pub struct Asset {
    pub content_type: &'static str,
    pub body: Bytes,
    pub gzip: Option<Bytes>,
    pub brotli: Option<Bytes>,
}

impl Asset {
    pub fn new(content_type: &'static str, body: Bytes) -> Asset {
        Asset { content_type, body, gzip: None, brotli: None }
    }
}

/// Static files keyed by URL path (`/`, `/assets/app.js`, ...).
pub type Assets = HashMap<String, Asset>;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// Album-art lookups; [`crate::ArtworkService`] implements it.
pub trait ArtworkLookup: Send + Sync {
    fn lookup(&self, ids: Vec<String>) -> BoxFuture<ArtworkResponse>;

    /// What is already known for each ID, without looking anything up:
    /// `None` when unknown, `Some(None)` when the track has no art.
    fn known(&self, ids: &[&str]) -> Vec<Option<Option<Artwork>>>;
}

/// Runs one Spotify sync into the database. Blocking.
pub type SyncFn = Arc<dyn Fn() -> Result<SyncStats> + Send + Sync>;

pub struct WebServerOptions {
    pub db: Arc<Db>,
    pub assets: Arc<Assets>,
    pub sync: SyncFn,
    pub artwork: Arc<dyn ArtworkLookup>,
    /// 0 picks a free port.
    pub port: u16,
    /// Fixed token for tests; normally random per launch.
    pub token: Option<String>,
    /// [`PRESENCE_GRACE`], or shorter in tests.
    pub presence_grace: Duration,
}

/// A running server; [`WebServer::close`] stops it.
pub struct WebServer {
    /// `http://127.0.0.1:<port>/`
    pub url: String,
    pub port: u16,
    pub token: String,
    activity: watch::Sender<Activity>,
    presence_grace: Duration,
    closing: watch::Sender<bool>,
    stop: oneshot::Sender<()>,
    task: JoinHandle<io::Result<()>>,
    /// Held so [`WebServer::close`] decides where the library is freed.
    app: Arc<App>,
}

impl WebServer {
    /// Resolves once a page has connected and then no page has held a
    /// presence stream for the grace period (so a reload does not count),
    /// with no sync or rating save running (so none is cut short).
    pub fn all_tabs_closed(&self) -> impl Future<Output = ()> + Send + 'static {
        let mut activity = self.activity.subscribe();
        let grace = self.presence_grace;
        async move {
            loop {
                let Ok(emptied) = activity.wait_for(|a| a.tabs == 0 && a.emptied > 0).await.map(|a| a.emptied) else {
                    return std::future::pending().await;
                };
                // Any tab opening, or the last one closing again, restarts the wait.
                let changed = |a: &Activity| a.tabs > 0 || a.emptied != emptied;
                if tokio::time::timeout(grace, activity.wait_for(changed)).await.is_ok() {
                    continue;
                }
                let Ok(now) = activity.wait_for(|a| changed(a) || a.busy == 0).await.map(|a| *a) else {
                    return std::future::pending().await;
                };
                if !changed(&now) {
                    return;
                }
            }
        }
    }

    /// Stops accepting connections and closes the open ones.
    pub async fn close(self) {
        // Presence streams never end on their own.
        self.closing.send_replace(true);
        let _ = self.stop.send(());
        let _ = self.task.await;
        // Freeing a large library (every row, sort order, and cached search)
        // takes milliseconds that the caller, usually about to exit, need
        // not wait for.
        drop_in_background(self.app);
    }
}

/// Drops `value` on a thread of its own. A process that exits meanwhile does
/// not wait for it.
pub fn drop_in_background<T: Send + 'static>(value: T) {
    let _ = std::thread::Builder::new().name("drop".into()).spawn(move || drop(value));
}

/// What keeps the server from stopping when its last tab closes.
#[derive(Debug, Clone, Copy, Default)]
struct Activity {
    /// Open presence streams.
    tabs: usize,
    /// Syncs and rating saves running.
    busy: usize,
    /// How many times the open streams have dropped to none; 0 until the
    /// first page has connected and gone.
    emptied: u64,
}

/// Counts in [`Activity`] while it lives: a tab (presence stream) or a
/// piece of work.
struct Counted {
    activity: watch::Sender<Activity>,
    tab: bool,
}

impl Counted {
    fn tab(activity: &watch::Sender<Activity>) -> Counted {
        activity.send_modify(|a| a.tabs += 1);
        Counted { activity: activity.clone(), tab: true }
    }

    fn work(activity: &watch::Sender<Activity>) -> Counted {
        activity.send_modify(|a| a.busy += 1);
        Counted { activity: activity.clone(), tab: false }
    }
}

impl Drop for Counted {
    fn drop(&mut self) {
        let tab = self.tab;
        self.activity.send_modify(|a| {
            if tab {
                a.tabs -= 1;
                if a.tabs == 0 {
                    a.emptied += 1;
                }
            } else {
                a.busy -= 1;
            }
        });
    }
}

/// A presence stream's body: a comment at once, then one per
/// [`PRESENCE_PING`], until the server closes. The page hanging up drops
/// it, which uncounts the tab.
struct PresenceBody {
    greeted: bool,
    ping: Interval,
    closing: Pin<Box<dyn Future<Output = ()> + Send + Sync>>,
    _tab: Counted,
}

impl http_body::Body for PresenceBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        if self.closing.as_mut().poll(cx).is_ready() {
            return Poll::Ready(None);
        }
        if !self.greeted {
            self.greeted = true;
            return Poll::Ready(Some(Ok(Frame::data(Bytes::from_static(b": ok\n\n")))));
        }
        ready!(self.ping.poll_tick(cx));
        Poll::Ready(Some(Ok(Frame::data(Bytes::from_static(b": ping\n\n")))))
    }
}

type SyncResult = Option<Result<SyncStats, String>>;

/// The library as pages see it.
#[derive(Clone)]
enum LibraryState {
    /// The first read has not finished.
    Loading,
    Ready(Arc<Library>),
    /// The last read failed. Every request that needs the library reads the
    /// database again (and reports the error if it fails again).
    Failed(String),
}

struct App {
    db: Arc<Db>,
    library: watch::Sender<LibraryState>,
    /// Serializes everything that replaces the library (reads, saved
    /// ratings), so a version never loses a concurrent change.
    library_writer: tokio::sync::Mutex<()>,
    /// The last version handed out.
    versions: AtomicU64,
    assets: Arc<Assets>,
    sync: SyncFn,
    artwork: Arc<dyn ArtworkLookup>,
    token: String,
    /// The hosts a page served by this server can use.
    hosts: [String; 2],
    /// The sync in progress, if any. One sync at a time: overlapping runs
    /// would both count plays before either saves the checkpoint.
    syncing: Mutex<Option<watch::Receiver<SyncResult>>>,
    activity: watch::Sender<Activity>,
    /// Set when the server is closing.
    closing: watch::Receiver<bool>,
}

/// A failure with a status and a message safe to show the user.
struct HttpError {
    status: StatusCode,
    message: String,
    allow: Option<&'static str>,
}

impl HttpError {
    fn new(status: StatusCode, message: impl Into<String>) -> HttpError {
        HttpError { status, message: message.into(), allow: None }
    }

    fn method_not_allowed(allow: &'static str) -> HttpError {
        HttpError { allow: Some(allow), ..HttpError::new(StatusCode::METHOD_NOT_ALLOWED, "method not allowed") }
    }

    fn internal(err: anyhow::Error) -> HttpError {
        HttpError::new(StatusCode::INTERNAL_SERVER_ERROR, format!("{err:#}"))
    }
}

/// Binds 127.0.0.1 and serves until [`WebServer::close`]. Fails with the
/// listen error (e.g. `AddrInUse`) when the port cannot be bound.
pub async fn start(options: WebServerOptions) -> io::Result<WebServer> {
    let token = match options.token {
        Some(token) => token,
        None => {
            let mut bytes = [0u8; 16];
            getrandom::fill(&mut bytes).map_err(io::Error::other)?;
            hex(&bytes)
        }
    };
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, options.port))).await?;
    let port = listener.local_addr()?.port();
    let activity = watch::Sender::new(Activity::default());
    let (closing, closing_rx) = watch::channel(false);
    let app = Arc::new(App {
        db: options.db,
        library: watch::Sender::new(LibraryState::Loading),
        library_writer: tokio::sync::Mutex::new(()),
        versions: AtomicU64::new(0),
        assets: options.assets,
        sync: options.sync,
        artwork: options.artwork,
        token: token.clone(),
        hosts: [format!("127.0.0.1:{port}"), format!("localhost:{port}")],
        syncing: Mutex::new(None),
        activity: activity.clone(),
        closing: closing_rx,
    });
    // The first read starts at once, so the page rarely waits for it.
    tokio::spawn(reload(Arc::clone(&app), Keep::Nothing));
    let router = Router::new().fallback(handle).with_state(Arc::clone(&app));
    let (stop, stopped) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
    });
    Ok(WebServer {
        url: format!("http://127.0.0.1:{port}/"),
        port,
        token,
        activity,
        presence_grace: options.presence_grace,
        closing,
        stop,
        task,
        app,
    })
}

async fn handle(State(app): State<Arc<App>>, request: Request) -> Response {
    // Resolved like the browser's URL parser, so `/api/../x` is `/x`.
    let url = Url::parse("http://127.0.0.1/")
        .and_then(|base| base.join(&request.uri().to_string()))
        .unwrap_or_else(|_| Url::parse("http://127.0.0.1/").expect("a valid base URL"));
    let path = url.path().to_string();
    let is_api = path == "/api" || path.starts_with("/api/");
    let encoding = compress::negotiate(&header_text(request.headers(), header::ACCEPT_ENCODING.as_str()));
    let response = match route(&app, &url, &path, is_api, encoding, request).await {
        Ok(response) => response,
        Err(failure) => error_response(failure, is_api),
    };
    with_security_headers(compressed(response, encoding).await)
}

/// Compresses a finished JSON, HTML, or text body over [`compress::MIN_SIZE`]
/// as the client allows. Streams (presence) and already encoded bodies
/// (precompressed assets) pass through.
async fn compressed(response: Response, encoding: Option<Encoding>) -> Response {
    // Errors go out as they are, without `Vary`.
    if !response.status().is_success() {
        return response;
    }
    let headers = response.headers();
    let content_type = headers.get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or_default();
    let size = http_body::Body::size_hint(response.body()).exact();
    if !compress::compressible(content_type) || headers.contains_key(header::CONTENT_ENCODING) {
        return response;
    }
    let Some(size) = size else { return response };
    let (mut parts, body) = response.into_parts();
    parts.headers.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    let Some(encoding) = encoding.filter(|_| size >= compress::MIN_SIZE as u64) else {
        return Response::from_parts(parts, body);
    };
    let Ok(data) = axum::body::to_bytes(body, usize::MAX).await else {
        return Response::from_parts(parts, Body::empty());
    };
    parts.headers.insert(header::CONTENT_ENCODING, encoding.header());
    parts.headers.remove(header::CONTENT_LENGTH);
    Response::from_parts(parts, Body::from(compress::compress(&data, encoding)))
}

async fn route(
    app: &Arc<App>,
    url: &Url,
    path: &str,
    is_api: bool,
    encoding: Option<Encoding>,
    request: Request,
) -> Result<Response, HttpError> {
    // A rebinding attack reaches us under the attacker's host name.
    let host = header_text(request.headers(), header::HOST.as_str()).to_ascii_lowercase();
    if !app.hosts.contains(&host) {
        return Err(HttpError::new(StatusCode::FORBIDDEN, "forbidden host"));
    }
    let method = request.method().clone();
    if method != Method::GET && method != Method::POST {
        return Err(HttpError::method_not_allowed("GET, POST"));
    }
    if method != Method::GET
        && !token_matches(request.headers().get(TOKEN_HEADER).map(HeaderValue::as_bytes), &app.token)
    {
        return Err(HttpError::new(StatusCode::FORBIDDEN, "missing or invalid token"));
    }

    if is_api {
        let route_method = match path {
            VIEW_PATH | ARTWORK_PATH | PRESENCE_PATH => Method::GET,
            RELOAD_PATH | SYNC_PATH | RATINGS_PATH => Method::POST,
            _ => return Err(HttpError::new(StatusCode::NOT_FOUND, format!("no API route {path}"))),
        };
        if route_method != method {
            return Err(HttpError::method_not_allowed(if route_method == Method::GET { "GET" } else { "POST" }));
        }
        if path == PRESENCE_PATH {
            return presence(app, url);
        }
        let body = match path {
            VIEW_PATH => json(&view(app, url).await?),
            RELOAD_PATH => {
                read_body(request).await?;
                // A failed re-read keeps serving the library pages have.
                let library = reload(Arc::clone(app), Keep::Library).await?;
                json(&ReloadResponse { version: library.version(), total: library.total() })
            }
            SYNC_PATH => {
                read_body(request).await?;
                json(&sync(app).await?)
            }
            RATINGS_PATH => {
                let params = parse_rating(&read_body(request).await?)?;
                json(&save_rating(app, params).await?)
            }
            _ => json(&artwork(app, url).await?),
        };
        return Ok(send(StatusCode::OK, JSON_CONTENT_TYPE, body, "no-store"));
    }

    let Some(asset) = app.assets.get(path) else {
        return Err(HttpError::new(StatusCode::NOT_FOUND, "404 page not found"));
    };
    if method != Method::GET {
        return Err(HttpError::method_not_allowed("GET"));
    }
    if path == "/" {
        let theme = Theme::from_cookie_header(&header_text(request.headers(), header::COOKIE.as_str()));
        let page = page(app, &String::from_utf8_lossy(&asset.body), theme).await;
        return Ok(send(StatusCode::OK, asset.content_type, page.into(), "no-store"));
    }
    let mut response = send(StatusCode::OK, asset.content_type, asset.body.clone(), ASSET_CACHE_CONTROL);
    let variant = match encoding {
        Some(Encoding::Brotli) => asset.brotli.clone().map(|body| (body, Encoding::Brotli)),
        Some(Encoding::Gzip) => asset.gzip.clone().map(|body| (body, Encoding::Gzip)),
        None => None,
    };
    if let Some((body, encoding)) = variant {
        let headers = response.headers_mut();
        headers.insert(header::CONTENT_ENCODING, encoding.header());
        headers.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
        *response.body_mut() = Body::from(body);
    }
    Ok(response)
}

/// The page with its token and theme, and, when the template has the
/// placeholders (the embedded client does), the first screen rendered on
/// the server plus the state it was rendered from, for the client to
/// hydrate.
async fn page(app: &Arc<App>, template: &str, theme: Theme) -> String {
    // Substituted first, so nothing from the library can be taken for them.
    let page = template.replace(TOKEN_PLACEHOLDER, &app.token).replace(THEME_PLACEHOLDER, theme.as_str());
    if !page.contains(APP_PLACEHOLDER) && !page.contains(INITIAL_PLACEHOLDER) {
        return page;
    }
    let initial = initial_state(app).await;
    let script =
        format!(r#"<script type="application/json" id="{INITIAL_STATE_ID}">{}</script>"#, initial.to_script_json());
    let markup = crate::page::render_app(&initial, theme, tracker_app::Zone::System);
    page.replacen(APP_PLACEHOLDER, &markup, 1).replacen(INITIAL_PLACEHOLDER, &script, 1)
}

/// What the page shows first. Waits briefly for the first read, so a fresh
/// server rarely renders the loading screen.
async fn initial_state(app: &Arc<App>) -> InitialState {
    let mut library = app.library.subscribe();
    let state =
        match tokio::time::timeout(FIRST_LOAD_WAIT, library.wait_for(|state| !matches!(state, LibraryState::Loading)))
            .await
        {
            Ok(Ok(state)) => state.clone(),
            _ => LibraryState::Loading,
        };
    let state = match state {
        LibraryState::Failed(_) => match reload(Arc::clone(app), Keep::Nothing).await {
            Ok(library) => LibraryState::Ready(library),
            Err(failure) => LibraryState::Failed(failure.message),
        },
        state => state,
    };
    match state {
        LibraryState::Loading => InitialState::default(),
        LibraryState::Ready(library) => {
            InitialState { view: Some(library.view(&ViewQuery::initial(), &|ids| app.artwork.known(ids))), error: None }
        }
        LibraryState::Failed(error) => InitialState { view: None, error: Some(error) },
    }
}

/// The library once the first read has finished. After a failed read, the
/// database is read again.
async fn ready_library(app: &Arc<App>) -> Result<Arc<Library>, HttpError> {
    let mut library = app.library.subscribe();
    let state = library
        .wait_for(|state| !matches!(state, LibraryState::Loading))
        .await
        .map(|state| state.clone())
        .map_err(|_| HttpError::new(StatusCode::INTERNAL_SERVER_ERROR, "the library is unavailable"))?;
    match state {
        LibraryState::Ready(library) => Ok(library),
        LibraryState::Failed(_) => reload(Arc::clone(app), Keep::Nothing).await,
        LibraryState::Loading => unreachable!("waited for the first read"),
    }
}

async fn view(app: &Arc<App>, url: &Url) -> Result<tracker_app::api::ViewResponse, HttpError> {
    let query = ViewQuery::parse(url).map_err(|message| HttpError::new(StatusCode::BAD_REQUEST, message))?;
    let library = ready_library(app).await?;
    Ok(library.view(&query, &|ids| app.artwork.known(ids)))
}

/// What a failed read leaves in place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Keep {
    /// The library pages already have (`POST /api/reload`).
    Library,
    /// Nothing: the failure is recorded, and the next request reads again.
    Nothing,
}

/// Reads the database into the next library version, in a task of its own
/// so a client hanging up cannot leave it half done.
async fn reload(app: Arc<App>, keep: Keep) -> Result<Arc<Library>, HttpError> {
    let task = tokio::spawn(async move {
        let _writer = app.library_writer.lock().await;
        let db = Arc::clone(&app.db);
        let version = app.versions.fetch_add(1, Ordering::SeqCst) + 1;
        let read = blocking(move || {
            let conn = db.conn();
            let (tracks, ratings) = (conn.list_all_tracks()?, conn.list_all_ratings()?);
            drop(conn);
            Ok(Library::new(version, tracks, ratings))
        })
        .await;
        match read {
            Ok(library) => {
                let library = Arc::new(library);
                app.library.send_replace(LibraryState::Ready(Arc::clone(&library)));
                Ok(library)
            }
            Err(failure) => {
                let has_library = matches!(*app.library.borrow(), LibraryState::Ready(_));
                if !(keep == Keep::Library && has_library) {
                    app.library.send_replace(LibraryState::Failed(failure.message.clone()));
                }
                Err(failure)
            }
        }
    });
    task.await.unwrap_or_else(|err| Err(HttpError::internal(anyhow!("reload failed: {err}"))))
}

/// Holds the page's presence stream open; see [`PRESENCE_PATH`].
fn presence(app: &App, url: &Url) -> Result<Response, HttpError> {
    let given = url.query_pairs().find(|(name, _)| name == PRESENCE_TOKEN_PARAM).map(|(_, value)| value);
    if !token_matches(given.as_deref().map(str::as_bytes), &app.token) {
        return Err(HttpError::new(StatusCode::FORBIDDEN, "missing or invalid token"));
    }
    let mut closing = app.closing.clone();
    let body = PresenceBody {
        greeted: false,
        ping: interval_at(Instant::now() + PRESENCE_PING, PRESENCE_PING),
        closing: Box::pin(async move {
            let _ = closing.wait_for(|closing| *closing).await;
        }),
        _tab: Counted::tab(&app.activity),
    };
    let mut response = Response::new(Body::new(body));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

/// Runs one sync, or joins the one already running.
async fn sync(app: &Arc<App>) -> Result<SyncStats, HttpError> {
    let mut running = {
        let mut syncing = app.syncing.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match &*syncing {
            Some(running) => running.clone(),
            None => {
                let (done, running) = watch::channel(None);
                *syncing = Some(running.clone());
                let app = Arc::clone(app);
                let work = Counted::work(&app.activity);
                // A task of its own, so a client hanging up cannot cancel a
                // sync other requests are waiting for.
                tokio::spawn(async move {
                    let _work = work;
                    let sync = Arc::clone(&app.sync);
                    let result = match spawn_blocking(move || sync()).await {
                        Ok(result) => result.map_err(|err| format!("{err:#}")),
                        Err(err) => Err(format!("sync failed: {err}")),
                    };
                    if result.is_ok() {
                        // Pages refetch after a sync; have the new plays ready.
                        // A failed read shows on the pages instead.
                        let _ = reload(Arc::clone(&app), Keep::Nothing).await;
                    }
                    // A finished run does not stick: the next request syncs again.
                    *app.syncing.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
                    let _ = done.send(Some(result));
                });
                running
            }
        }
    };
    let result = running
        .wait_for(Option::is_some)
        .await
        .map_err(|_| HttpError::new(StatusCode::INTERNAL_SERVER_ERROR, "sync stopped unexpectedly"))?
        .clone();
    result
        .unwrap_or_else(|| Err("sync stopped unexpectedly".into()))
        .map_err(|message| HttpError::new(StatusCode::INTERNAL_SERVER_ERROR, message))
}

/// Saves a rating and moves the library to a version with it, in a task of
/// its own so the two never come apart, even if the page hangs up.
async fn save_rating(app: &Arc<App>, params: UpsertRatingParams) -> Result<Rating, HttpError> {
    let track_id = params.track_id;
    // It counts until the write is done even if the page hangs up first.
    let work = Counted::work(&app.activity);
    let app = Arc::clone(app);
    let task = tokio::spawn(async move {
        let _work = work;
        let _writer = app.library_writer.lock().await;
        let db = Arc::clone(&app.db);
        let saved = blocking(move || {
            let conn = db.conn();
            if conn.track_by_id(params.track_id)?.is_none() {
                return Ok(None);
            }
            Ok(Some(conn.upsert_rating(&params)?))
        })
        .await?;
        let rating =
            saved.ok_or_else(|| HttpError::new(StatusCode::NOT_FOUND, format!("track {track_id} not found")))?;
        let current = app.library.borrow().clone();
        if let LibraryState::Ready(library) = current {
            let version = app.versions.fetch_add(1, Ordering::SeqCst) + 1;
            let saved = rating.clone();
            let next = blocking(move || Ok(library.with_rating(version, saved))).await?;
            app.library.send_replace(LibraryState::Ready(Arc::new(next)));
        }
        Ok(rating)
    });
    task.await.unwrap_or_else(|err| Err(HttpError::internal(anyhow!("save failed: {err}"))))
}

async fn artwork(app: &App, url: &Url) -> Result<ArtworkResponse, HttpError> {
    let raw =
        url.query_pairs().find(|(name, _)| name == "ids").map(|(_, value)| value.into_owned()).unwrap_or_default();
    let ids: Vec<&str> = if raw.is_empty() { Vec::new() } else { raw.split(',').collect() };
    if ids.len() > ARTWORK_BATCH {
        return Err(HttpError::new(
            StatusCode::BAD_REQUEST,
            format!("at most {ARTWORK_BATCH} ids per request, got {}", ids.len()),
        ));
    }
    Ok(app.artwork.lookup(ids.into_iter().map(|id| id.trim().to_string()).collect()).await)
}

/// Runs database work on the blocking pool.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T, HttpError> {
    match spawn_blocking(work).await {
        Ok(result) => result.map_err(HttpError::internal),
        Err(err) => Err(HttpError::internal(anyhow!("{err}"))),
    }
}

fn header_text(headers: &HeaderMap, name: &str) -> String {
    headers.get(name).and_then(|value| value.to_str().ok()).unwrap_or_default().to_string()
}

/// Compares in constant time, so the token cannot be guessed byte by byte.
fn token_matches(given: Option<&[u8]>, token: &str) -> bool {
    let Some(given) = given else { return false };
    let expected = token.as_bytes();
    given.len() == expected.len() && given.iter().zip(expected).fold(0u8, |diff, (a, b)| diff | (a ^ b)) == 0
}

/// Reads the body as UTF-8, refusing anything over [`MAX_BODY_BYTES`]
/// before buffering it.
async fn read_body(request: Request) -> Result<String, HttpError> {
    let too_big =
        || HttpError::new(StatusCode::PAYLOAD_TOO_LARGE, format!("request body exceeds {MAX_BODY_BYTES} bytes"));
    let declared = header_text(request.headers(), header::CONTENT_LENGTH.as_str()).parse::<u64>().unwrap_or(0);
    if declared > MAX_BODY_BYTES as u64 {
        return Err(too_big());
    }
    let mut body = request.into_body();
    let mut data = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame =
            frame.map_err(|err| HttpError::new(StatusCode::BAD_REQUEST, format!("read request body: {err}")))?;
        if let Ok(chunk) = frame.into_data() {
            if data.len() + chunk.len() > MAX_BODY_BYTES {
                return Err(too_big());
            }
            data.extend_from_slice(&chunk);
        }
    }
    Ok(String::from_utf8_lossy(&data).into_owned())
}

/// A JSON number that is a safe integer (as JavaScript's
/// `Number.isSafeInteger` sees it).
fn safe_integer(value: Option<&Value>) -> Option<i64> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && number.abs() <= MAX_SAFE).then_some(number as i64)
}

/// A value as JavaScript's `JSON.stringify` writes it, for error messages.
fn js_json(value: Option<&Value>) -> String {
    match value {
        None => "nothing".into(),
        Some(Value::Number(number)) => match number.as_f64() {
            Some(float) if float.fract() == 0.0 && float.abs() < 1e21 => format!("{}", float as i128),
            Some(float) => float.to_string(),
            None => number.to_string(),
        },
        Some(value) => value.to_string(),
    }
}

/// Validates a rating request with the same limits the CLI's `rate`
/// enforces, and the TypeScript server's messages.
fn parse_rating(text: &str) -> Result<UpsertRatingParams, HttpError> {
    let bad_request = |message: String| HttpError::new(StatusCode::BAD_REQUEST, message);
    let value: Value = serde_json::from_str(text).map_err(|_| bad_request("request body must be JSON".into()))?;
    let Value::Object(fields) = value else {
        return Err(bad_request("request body must be a JSON object".into()));
    };
    let positive = |name: &str| safe_integer(fields.get(name)).filter(|value| *value > 0);
    let track_id = positive("trackId").ok_or_else(|| bad_request("trackId must be a positive integer".into()))?;
    let stars = safe_integer(fields.get("stars"))
        .filter(|stars| (1..=5).contains(stars))
        .ok_or_else(|| bad_request(format!("stars must be between 1 and 5, got {}", js_json(fields.get("stars")))))?;
    let Some(Value::String(opinion)) = fields.get("opinion") else {
        return Err(bad_request("opinion must be a string".into()));
    };
    let updated_at = positive("updatedAt").ok_or_else(|| bad_request("updatedAt must be a positive integer".into()))?;
    Ok(UpsertRatingParams { track_id, stars, opinion: opinion.clone(), updated_at })
}

fn json(value: &impl Serialize) -> Bytes {
    // The API's types always encode.
    serde_json::to_vec(value).unwrap_or_default().into()
}

fn send(status: StatusCode, content_type: &'static str, body: Bytes, cache_control: &'static str) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache_control));
    response
}

fn error_response(failure: HttpError, is_api: bool) -> Response {
    let mut response = if is_api {
        send(failure.status, JSON_CONTENT_TYPE, json(&ErrorResponse { error: failure.message }), "no-store")
    } else {
        send(failure.status, TEXT_CONTENT_TYPE, format!("{}\n", failure.message).into(), "no-store")
    };
    let headers = response.headers_mut();
    if let Some(allow) = failure.allow {
        headers.insert(header::ALLOW, HeaderValue::from_static(allow));
    }
    if failure.status == StatusCode::PAYLOAD_TOO_LARGE {
        // The unread rest of the body would otherwise be parsed as the next request.
        headers.insert(header::CONNECTION, HeaderValue::from_static("close"));
    }
    response
}

fn with_security_headers(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CONTENT_SECURITY_POLICY));
    response
}

#[cfg(test)]
mod tests;
