//! `tracker web`: serves the browser UI from a local server until its last
//! tab closes (or always, with --keep-running) or Ctrl+C.
//! Like `tracker tui`, it owns the database and the Spotify wiring and hands
//! the server plain callbacks.

use std::future::Future;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use tracker_core::Db;
use tracker_web::{
    ArtworkService, ArtworkServiceOptions, PRESENCE_GRACE, WebServerOptions, artwork_cache_path, config_artwork_api,
};

use super::tui_cmd::tui_sync;
use super::{Io, RootOptions};

pub(crate) const DEFAULT_WEB_PORT: i64 = 8765;

/// How long open connections get to finish after Ctrl+C.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) const ALL_TABS_CLOSED_TEXT: &str = "All tabs closed; stopped the tracker web UI.";

#[derive(Debug, clap::Args)]
pub(crate) struct WebArgs {
    #[arg(
        long,
        value_name = "int",
        default_value_t = DEFAULT_WEB_PORT,
        allow_negative_numbers = true,
        help = "local port to serve on (0 picks a free one)"
    )]
    port: i64,

    #[arg(long = "no-open", help = "print the URL without opening a browser")]
    no_open: bool,

    #[arg(long = "keep-running", help = "keep serving after the last browser tab closes")]
    keep_running: bool,

    /// Serves a directory's files instead of the embedded client:
    /// `index.html` at `/`, the rest under `/assets/` (for development, or
    /// to run another build's client against this server).
    #[arg(long, value_name = "DIR", hide = true)]
    assets_dir: Option<PathBuf>,
}

pub type ShutdownFuture = Pin<Box<dyn Future<Output = ()>>>;

/// Seams that tests replace: nothing here may reach a real browser or signal.
pub struct WebDeps {
    pub open_browser: Box<dyn Fn(&str)>,
    /// Resolves on Ctrl+C or SIGTERM; given the server's URL.
    pub wait_for_shutdown: Box<dyn Fn(String) -> ShutdownFuture>,
    /// [`PRESENCE_GRACE`], or shorter in tests.
    pub presence_grace: Duration,
}

impl Default for WebDeps {
    fn default() -> WebDeps {
        WebDeps {
            open_browser: Box::new(open_browser),
            wait_for_shutdown: Box::new(|_| Box::pin(shutdown_signal())),
            presence_grace: PRESENCE_GRACE,
        }
    }
}

pub(crate) fn run(args: &WebArgs, opts: &RootOptions, io: &mut Io<'_>, deps: &WebDeps) -> Result<()> {
    let port =
        u16::try_from(args.port).map_err(|_| anyhow!("--port must be between 0 and 65535, got {}", args.port))?;
    let config_path = opts.resolve_config_path()?;
    let db_path = opts.resolve_db_path()?;
    let assets = match &args.assets_dir {
        Some(dir) => tracker_web::assets::from_dir(dir).with_context(|| format!("load web UI assets from {dir:?}"))?,
        None => tracker_web::assets::embedded(),
    };
    let db = Arc::new(Db::open(&db_path)?);

    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().context("start async runtime")?;
    let result = runtime.block_on(async {
        let artwork_config = config_path.clone();
        let artwork = ArtworkService::new(ArtworkServiceOptions::new(
            artwork_cache_path(&db_path),
            Arc::new(move || {
                config_artwork_api(&artwork_config, tracker_spotify::ACCOUNTS_BASE_URL, tracker_spotify::API_BASE_URL)
            }),
        ));
        let sync_db = Arc::clone(&db);
        let server = tracker_web::start(WebServerOptions {
            db,
            assets: Arc::new(assets),
            sync: Arc::new(move || tui_sync(&config_path, &sync_db, "the web UI")),
            artwork: Arc::new(artwork.clone()),
            port,
            token: None,
            presence_grace: deps.presence_grace,
        })
        .await;
        let server = match server {
            Ok(server) => server,
            Err(err) if err.kind() == ErrorKind::AddrInUse => {
                bail!("port {port} is in use; pass --port to choose another")
            }
            Err(err) => return Err(anyhow!(err).context("start web server")),
        };

        let served = (|| -> Result<()> {
            if args.keep_running {
                writeln!(io.out, "Serving the tracker web UI at {} (Ctrl+C to stop)", server.url)?;
            } else {
                writeln!(
                    io.out,
                    "Serving the tracker web UI at {} (stops when you close the tab, or press Ctrl+C)",
                    server.url
                )?;
            }
            io.out.flush()?;
            Ok(())
        })();
        if served.is_ok() && !args.no_open {
            (deps.open_browser)(&server.url);
        }
        let mut tabs_closed = false;
        if served.is_ok() {
            let signal = (deps.wait_for_shutdown)(server.url.clone());
            if args.keep_running {
                signal.await;
            } else {
                tokio::select! {
                    () = signal => {}
                    () = server.all_tabs_closed() => tabs_closed = true,
                }
            }
        }
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, server.close()).await;
        artwork.close();
        served?;
        if tabs_closed {
            writeln!(io.out, "{ALL_TABS_CLOSED_TEXT}")?;
            io.out.flush()?;
        }
        Ok(())
    });
    // A sync still running on the blocking pool must not hold the exit.
    runtime.shutdown_background();
    result
}

/// Best effort: the URL is already printed, so a missing `open`/`xdg-open`
/// (e.g. over SSH) must not fail the command.
fn open_browser(url: &str) {
    let command = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let _ = Command::new(command).arg(url).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
}

/// Ctrl+C or SIGTERM, so the server and artwork cache close cleanly.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut terminate) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::io::{Read, Write as _};
    use std::net::{TcpListener, TcpStream};
    use std::rc::Rc;

    use super::*;
    use crate::cli::testutil::{path_str, run, run_with};
    use crate::cli::{Deps, OnboardingDeps};

    /// One request on a fresh connection; returns the whole response.
    fn request(url: &str, method: &str, path: &str, headers: &str) -> String {
        let host = url.trim_start_matches("http://").trim_end_matches('/');
        let mut stream = TcpStream::connect(host).unwrap();
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Length: 0\r\n{headers}\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    /// The presence grace period in these tests.
    const GRACE: Duration = Duration::from_millis(60);

    /// Opens the page's presence stream, as the client does at start, and
    /// returns once the server has answered; dropping it closes the tab.
    fn open_tab(url: &str) -> TcpStream {
        let page = request(url, "GET", "/", "");
        let token = &page.split(r#"name="tracker-token" content=""#).nth(1).unwrap()[..32];
        let host = url.trim_start_matches("http://").trim_end_matches('/');
        let mut stream = TcpStream::connect(host).unwrap();
        write!(stream, "GET /api/presence?token={token} HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
        let mut head = [0u8; 12];
        stream.read_exact(&mut head).unwrap();
        assert_eq!(&head, b"HTTP/1.1 200");
        stream
    }

    /// Deps whose Ctrl+C never comes: `visit` runs while the server is up,
    /// then only the last tab closing can stop it.
    fn no_signal_deps(visit: impl Fn(String) + Send + Sync + Clone + 'static) -> Deps {
        Deps {
            onboarding: OnboardingDeps::default(),
            web: WebDeps {
                open_browser: Box::new(|_| {}),
                wait_for_shutdown: Box::new(move |url| {
                    let visit = visit.clone();
                    Box::pin(async move {
                        tokio::task::spawn_blocking(move || visit(url)).await.unwrap();
                        std::future::pending::<()>().await;
                    })
                }),
                presence_grace: GRACE,
            },
        }
    }

    /// A real server on a free port; `visit` runs while it is up, standing
    /// in for the user's browser session before Ctrl+C.
    fn web_deps(
        opened: Rc<RefCell<Vec<String>>>,
        visit: impl Fn(String) -> String + Send + Sync + Clone + 'static,
        seen: Rc<RefCell<Vec<String>>>,
    ) -> Deps {
        Deps {
            onboarding: OnboardingDeps::default(),
            web: WebDeps {
                open_browser: Box::new(move |url| opened.borrow_mut().push(url.to_string())),
                wait_for_shutdown: Box::new(move |url| {
                    let visit = visit.clone();
                    let seen = Rc::clone(&seen);
                    Box::pin(async move {
                        let result = tokio::task::spawn_blocking(move || visit(url)).await.unwrap();
                        seen.borrow_mut().push(result);
                    })
                }),
                presence_grace: GRACE,
            },
        }
    }

    #[test]
    fn prints_the_url_opens_the_browser_serves_until_shutdown_then_closes() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.json");
        let db = dir.path().join("tracker.db");
        let (opened, seen) = (Rc::default(), Rc::default());
        let deps = web_deps(
            Rc::clone(&opened),
            |url| {
                let page = request(&url, "GET", "/", "");
                let token = page.split(r#"name="tracker-token" content=""#).nth(1).unwrap()[..32].to_string();
                let sync = request(&url, "POST", "/api/sync", &format!("X-Tracker-Token: {token}\r\n"));
                format!("{url}\n{sync}")
            },
            Rc::clone(&seen),
        );
        let (result, out) =
            run_with(&["--config", path_str(&config), "--db", path_str(&db), "web", "--port", "0"], "", &deps);
        result.unwrap();

        let seen = seen.borrow();
        let (url, sync) = seen[0].split_once('\n').unwrap();
        assert_eq!(
            out,
            format!("Serving the tracker web UI at {url} (stops when you close the tab, or press Ctrl+C)\n")
        );
        assert_eq!(*opened.borrow(), [url.to_string()]);
        // Sync goes through the CLI's config path, with the hint naming the web UI.
        assert!(sync.starts_with("HTTP/1.1 500"), "{sync}");
        let body: serde_json::Value = serde_json::from_str(sync.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(
            body["error"],
            format!(
                "created default config at {config:?}; set spotify.client_id and spotify.client_secret, \
                 run `tracker --config {config:?} spotify login`, then retry sync from the web UI"
            )
        );
        assert!(TcpStream::connect(url.trim_start_matches("http://").trim_end_matches('/')).is_err(), "closed");
    }

    #[test]
    fn stops_on_its_own_once_the_last_tab_closes() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("tracker.db");
        let seen = Arc::new(std::sync::Mutex::new((String::new(), None)));
        let record = Arc::clone(&seen);
        let deps = no_signal_deps(move |url| {
            let (first, second) = (open_tab(&url), open_tab(&url));
            drop(first);
            // A reload: the old stream closes, the new one opens within the grace period.
            std::thread::sleep(GRACE / 3);
            drop(second);
            let reloaded = open_tab(&url);
            std::thread::sleep(GRACE * 3);
            assert!(request(&url, "GET", "/", "").starts_with("HTTP/1.1 200"));
            *record.lock().unwrap() = (url, Some(std::time::Instant::now()));
            drop(reloaded);
        });
        let (result, out) = run_with(&["--db", path_str(&db), "web", "--port", "0", "--no-open"], "", &deps);
        result.unwrap();

        let (url, closed_at) = seen.lock().unwrap().clone();
        assert!(closed_at.unwrap().elapsed() >= GRACE);
        assert_eq!(
            out,
            format!(
                "Serving the tracker web UI at {url} (stops when you close the tab, or press Ctrl+C)\n\
                 All tabs closed; stopped the tracker web UI.\n"
            )
        );
        assert!(TcpStream::connect(url.trim_start_matches("http://").trim_end_matches('/')).is_err(), "closed");
    }

    #[test]
    fn keeps_serving_after_the_last_tab_closes_with_keep_running() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("tracker.db");
        let (opened, seen) = (Rc::default(), Rc::default());
        let deps = web_deps(
            opened,
            |url| {
                drop(open_tab(&url));
                std::thread::sleep(GRACE * 3);
                let page = request(&url, "GET", "/", "");
                format!("{url}\n{}", &page[..15])
            },
            Rc::clone(&seen),
        );
        let (result, out) =
            run_with(&["--db", path_str(&db), "web", "--port", "0", "--no-open", "--keep-running"], "", &deps);
        result.unwrap();

        let seen = seen.borrow();
        let (url, status) = seen[0].split_once('\n').unwrap();
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert_eq!(out, format!("Serving the tracker web UI at {url} (Ctrl+C to stop)\n"));
    }

    #[test]
    fn skips_the_browser_with_no_open() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("tracker.db");
        let (opened, seen) = (Rc::default(), Rc::default());
        let deps = web_deps(Rc::clone(&opened), |url| url, seen);
        let (result, out) = run_with(&["--db", path_str(&db), "web", "--port", "0", "--no-open"], "", &deps);
        result.unwrap();
        assert!(out.starts_with("Serving the tracker web UI at http://127.0.0.1:"), "{out}");
        assert!(opened.borrow().is_empty());
    }

    #[test]
    fn reports_a_busy_port() {
        let blocker = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = blocker.local_addr().unwrap().port();
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("tracker.db");
        let deps = web_deps(Rc::default(), |url| url, Rc::default());
        let (result, _) = run_with(&["--db", path_str(&db), "web", "--port", &port.to_string()], "", &deps);
        assert_eq!(result.unwrap_err().to_string(), format!("port {port} is in use; pass --port to choose another"));
    }

    #[test]
    fn is_registered_with_help_a_default_port_and_port_validation() {
        let (result, help) = run(&["web", "--help"]);
        result.unwrap();
        for want in [
            "Browse, sync, and rate tracks in a local web UI",
            "--port <int>",
            "[default: 8765]",
            "--no-open",
            "--keep-running",
            "keep serving after the last browser tab closes",
            "tracker web --port 9000 --no-open",
        ] {
            assert!(help.contains(want), "{want}: {help}");
        }
        assert!(!help.contains("assets-dir"), "{help}");

        for port in ["70000", "-1"] {
            let (result, _) = run(&["web", "--port", port]);
            assert_eq!(result.unwrap_err().to_string(), format!("--port must be between 0 and 65535, got {port}"));
        }
        let (result, _) = run(&["web", "--port", "abc"]);
        assert!(result.unwrap_err().to_string().contains("--port"));
    }
}
