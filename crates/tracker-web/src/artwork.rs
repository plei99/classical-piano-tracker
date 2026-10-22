//! Album art lookups for the web UI. The local database stores no artwork,
//! so the server asks Spotify on demand and remembers the answers on disk:
//! a library re-renders the same few hundred covers on every launch.
//!
//! Sources, in order: the Web API batch endpoint, the per-track endpoint
//! (Spotify restricts the batch one for some development-mode apps), then
//! the public oEmbed endpoint, which needs no token at all.
//!
//! The cache file (`artwork-cache.json` next to the database) has the same
//! format as the TypeScript build's, so all builds share it.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
use serde::de::{Deserialize, Deserializer, MapAccess, Visitor};
use serde_json::{Map, Value};
use tokio::sync::{Semaphore, watch};
use tokio::task::{JoinSet, spawn_blocking};
use tracker_app::api::{Artwork, ArtworkResponse};
use tracker_core::config;
use tracker_spotify::{AlbumArt, ApiError, Client};

use crate::server::ArtworkLookup;

pub const ARTWORK_CACHE_FILE: &str = "artwork-cache.json";

/// Production oEmbed origin.
pub const OEMBED_BASE_URL: &str = "https://open.spotify.com";

const CACHE_VERSION: u64 = 1;
const DEFAULT_FAILURE_TTL: Duration = Duration::from_secs(10 * 60);
const DEFAULT_PERSIST_DELAY: Duration = Duration::from_secs(2);
const DEFAULT_CONCURRENCY: usize = 4;
const OEMBED_TIMEOUT: Duration = Duration::from_secs(10);

/// Spotify IDs are 22 base62 characters; anything else cannot be a track.
pub fn is_spotify_id(id: &str) -> bool {
    id.len() == 22 && id.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// The slice of the Spotify client the service uses, so tests can stub it.
/// Blocking; the service calls it on the blocking pool.
pub trait ArtworkApi: Send + Sync {
    fn album_art(&self, ids: &[String]) -> Result<HashMap<String, AlbumArt>>;
    fn track_album_art(&self, id: &str) -> Result<AlbumArt>;
}

impl ArtworkApi for Client {
    fn album_art(&self, ids: &[String]) -> Result<HashMap<String, AlbumArt>> {
        Client::album_art(self, ids)
    }

    fn track_album_art(&self, id: &str) -> Result<AlbumArt> {
        Client::track_album_art(self, id)
    }
}

/// An authenticated API client, or `None` when there is no usable token.
/// Called once per lookup (blocking), so a `tracker spotify login` made
/// while the server runs takes effect without a restart.
pub type SpotifyFactory = Arc<dyn Fn() -> Option<Arc<dyn ArtworkApi>> + Send + Sync>;

/// A plain HTTP GET: the status and body. Blocking.
pub type Fetch = Arc<dyn Fn(&str) -> Result<(u16, String)> + Send + Sync>;

/// A clock for the failure memo.
pub type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

pub struct ArtworkServiceOptions {
    /// Where answers persist; `None` keeps them in memory only.
    pub cache_path: Option<PathBuf>,
    pub spotify: SpotifyFactory,
    pub oembed_base_url: String,
    pub fetch: Fetch,
    pub now: Clock,
    /// How long a transient failure is remembered before a retry.
    pub failure_ttl: Duration,
    /// How long new answers wait before the cache file is rewritten, so a
    /// page of covers costs one write.
    pub persist_delay: Duration,
    /// Maximum simultaneous per-track requests to each source.
    pub concurrency: usize,
}

impl ArtworkServiceOptions {
    pub fn new(cache_path: Option<PathBuf>, spotify: SpotifyFactory) -> ArtworkServiceOptions {
        ArtworkServiceOptions {
            cache_path,
            spotify,
            oembed_base_url: OEMBED_BASE_URL.to_string(),
            fetch: http_fetch(OEMBED_TIMEOUT),
            now: Arc::new(Instant::now),
            failure_ttl: DEFAULT_FAILURE_TTL,
            persist_delay: DEFAULT_PERSIST_DELAY,
            concurrency: DEFAULT_CONCURRENCY,
        }
    }
}

/// [`Fetch`] over a real HTTP client.
pub fn http_fetch(timeout: Duration) -> Fetch {
    let agent: ureq::Agent =
        ureq::Agent::config_builder().timeout_global(Some(timeout)).http_status_as_error(false).build().into();
    Arc::new(move |url| {
        let mut response = agent.get(url).call()?;
        let status = response.status().as_u16();
        let body = if status == 200 { response.body_mut().read_to_string()? } else { String::new() };
        Ok((status, body))
    })
}

/// Looks up and caches album art. Cheap to clone; clones share the cache.
#[derive(Clone)]
pub struct ArtworkService {
    inner: Arc<Inner>,
}

struct Inner {
    options: ArtworkServiceOptions,
    state: Mutex<State>,
    api_limit: Semaphore,
    oembed_limit: Semaphore,
}

#[derive(Default)]
struct State {
    /// Settled answers: art, or `None` for "Spotify has none". Persisted.
    cache: HashMap<String, Option<Artwork>>,
    /// Cache keys in insertion order, which the cache file keeps.
    order: Vec<String>,
    /// Transient failures, by retry time. Memory only, so a restart retries.
    failures: HashMap<String, Instant>,
    /// Lookups in progress, so overlapping requests share one fetch per ID.
    /// The flag turns true when the lookup has settled.
    inflight: HashMap<String, watch::Receiver<bool>>,
    /// Set once Spotify refuses the batch endpoint, so later lookups skip
    /// straight to per-track calls.
    batch_refused: bool,
    /// Set once Spotify refuses per-track calls too; later lookups go to
    /// oEmbed.
    api_refused: bool,
    dirty: bool,
    persist_scheduled: bool,
}

impl ArtworkService {
    /// Loads the cache file, if any. A missing, unreadable, or foreign file
    /// starts empty rather than failing the server.
    pub fn new(mut options: ArtworkServiceOptions) -> ArtworkService {
        options.oembed_base_url = options.oembed_base_url.trim_end_matches('/').to_string();
        let mut state = State::default();
        if let Some(path) = &options.cache_path {
            for (id, art) in read_cache(path) {
                state.order.push(id.clone());
                state.cache.insert(id, art);
            }
        }
        let concurrency = options.concurrency.max(1);
        ArtworkService {
            inner: Arc::new(Inner {
                options,
                state: Mutex::new(state),
                api_limit: Semaphore::new(concurrency),
                oembed_limit: Semaphore::new(concurrency),
            }),
        }
    }

    /// Art for each valid ID (invalid ones are dropped), in request order.
    /// Never fails: an ID that could not be looked up maps to `None` and is
    /// retried after the failure TTL.
    pub async fn lookup(&self, ids: &[String]) -> ArtworkResponse {
        let mut seen = HashSet::new();
        let wanted: Vec<&String> = ids.iter().filter(|id| is_spotify_id(id) && seen.insert(id.as_str())).collect();
        let mut waits = Vec::new();
        {
            let mut state = self.inner.state();
            let now = (self.inner.options.now)();
            let mut missing = Vec::new();
            for &id in &wanted {
                if state.cache.contains_key(id) {
                    continue;
                }
                if let Some(&retry_at) = state.failures.get(id) {
                    if retry_at > now {
                        continue;
                    }
                    state.failures.remove(id);
                }
                match state.inflight.get(id) {
                    Some(running) => waits.push(running.clone()),
                    None => missing.push(id.clone()),
                }
            }
            if !missing.is_empty() {
                let (done, running) = watch::channel(false);
                for id in &missing {
                    state.inflight.insert(id.clone(), running.clone());
                }
                waits.push(running);
                // A task of its own, so a client hanging up mid-request
                // cannot strand the lookup other requests are waiting for.
                let inner = Arc::clone(&self.inner);
                tokio::spawn(async move {
                    Arc::clone(&inner).resolve(missing.clone()).await;
                    let mut state = inner.state();
                    for id in &missing {
                        state.inflight.remove(id);
                    }
                    drop(state);
                    let _ = done.send(true);
                });
            }
        }
        for mut running in waits {
            // An error means the lookup task died; its IDs stay unknown.
            let _ = running.wait_for(|settled| *settled).await;
        }

        let state = self.inner.state();
        ArtworkResponse(wanted.into_iter().map(|id| (id.clone(), state.cache.get(id).cloned().flatten())).collect())
    }

    /// Writes pending cache changes now.
    pub fn flush(&self) {
        self.inner.flush();
    }

    /// Saves what is pending; call before the process exits.
    pub fn close(&self) {
        self.flush();
    }
}

impl ArtworkLookup for ArtworkService {
    fn lookup(&self, ids: Vec<String>) -> crate::server::BoxFuture<ArtworkResponse> {
        let service = self.clone();
        Box::pin(async move { service.lookup(&ids).await })
    }

    fn known(&self, ids: &[&str]) -> Vec<Option<Option<Artwork>>> {
        let state = self.inner.state();
        ids.iter().map(|id| state.cache.get(*id).cloned()).collect()
    }
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Records an outcome for every ID.
    async fn resolve(self: Arc<Self>, ids: Vec<String>) {
        let mut remaining = ids;
        let api = if self.state().api_refused {
            None
        } else {
            let spotify = Arc::clone(&self.options.spotify);
            spawn_blocking(move || spotify()).await.ok().flatten()
        };
        if let Some(api) = api {
            remaining = Arc::clone(&self).from_api(api, remaining).await;
        }
        if !remaining.is_empty() {
            self.from_oembed(remaining).await;
        }
    }

    /// Returns the IDs the API could not answer, for the oEmbed fallback.
    async fn from_api(self: Arc<Self>, api: Arc<dyn ArtworkApi>, ids: Vec<String>) -> Vec<String> {
        if !self.state().batch_refused {
            let batch_api = Arc::clone(&api);
            let batch_ids = ids.clone();
            match spawn_blocking(move || batch_api.album_art(&batch_ids)).await {
                Ok(Ok(found)) => {
                    let mut unknown = Vec::new();
                    for id in ids {
                        // An ID the batch did not know gets a second opinion
                        // from oEmbed.
                        match found.get(&id) {
                            Some(art) => self.settle(&id, art),
                            None => unknown.push(id),
                        }
                    }
                    return unknown;
                }
                Ok(Err(err)) if is_refusal(&err) => self.state().batch_refused = true,
                _ => return ids,
            }
        }

        let mut lookups = JoinSet::new();
        for id in ids {
            let inner = Arc::clone(&self);
            let api = Arc::clone(&api);
            lookups.spawn(async move {
                let _permit = inner.api_limit.acquire().await.ok()?;
                if inner.state().api_refused {
                    return Some(id);
                }
                let lookup_id = id.clone();
                match spawn_blocking(move || api.track_album_art(&lookup_id)).await {
                    Ok(Ok(art)) => {
                        inner.settle(&id, &art);
                        None
                    }
                    Ok(Err(err)) => {
                        // A 404 here could be the restriction rather than the
                        // track, so only oEmbed's answer is trusted as "no
                        // such track".
                        if status_of(&err) == Some(403) {
                            inner.state().api_refused = true;
                        }
                        Some(id)
                    }
                    Err(_) => Some(id),
                }
            });
        }
        let mut leftover = Vec::new();
        while let Some(result) = lookups.join_next().await {
            leftover.extend(result.ok().flatten());
        }
        leftover
    }

    async fn from_oembed(self: Arc<Self>, ids: Vec<String>) {
        let mut lookups = JoinSet::new();
        for id in ids {
            let inner = Arc::clone(&self);
            lookups.spawn(async move {
                let Ok(_permit) = inner.oembed_limit.acquire().await else { return };
                let url = format!(
                    "{}/oembed?url=https%3A%2F%2Fopen.spotify.com%2Ftrack%2F{id}",
                    inner.options.oembed_base_url
                );
                let fetch = Arc::clone(&inner.options.fetch);
                match spawn_blocking(move || oembed_thumbnail(&fetch, &url)).await {
                    Ok(Ok(thumbnail)) => inner.settle(
                        &id,
                        &AlbumArt { small: thumbnail.clone(), medium: thumbnail.clone(), large: thumbnail },
                    ),
                    _ => {
                        let retry_at = (inner.options.now)() + inner.options.failure_ttl;
                        inner.state().failures.insert(id, retry_at);
                    }
                }
            });
        }
        while lookups.join_next().await.is_some() {}
    }

    fn settle(self: &Arc<Self>, id: &str, art: &AlbumArt) {
        let has_art = art.small.is_some() || art.medium.is_some() || art.large.is_some();
        let art =
            has_art.then(|| Artwork { small: art.small.clone(), medium: art.medium.clone(), large: art.large.clone() });
        let mut state = self.state();
        if state.cache.insert(id.to_string(), art).is_none() {
            state.order.push(id.to_string());
        }
        state.failures.remove(id);
        state.dirty = true;
        if state.persist_scheduled || self.options.cache_path.is_none() {
            return;
        }
        state.persist_scheduled = true;
        drop(state);
        let inner = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(inner.options.persist_delay).await;
            inner.flush();
        });
    }

    fn flush(&self) {
        let Some(path) = &self.options.cache_path else { return };
        let mut state = self.state();
        state.persist_scheduled = false;
        if !state.dirty {
            return;
        }
        let data = encode_cache(&state);
        state.dirty = false;
        drop(state);
        // The cache is an optimization; a failed write only costs refetches.
        if write_cache(path, data.as_bytes()).is_err() {
            self.state().dirty = true;
        }
    }
}

/// oEmbed has one ~300 px thumbnail; `None` when the track does not exist.
/// Fails on transient errors.
fn oembed_thumbnail(fetch: &Fetch, url: &str) -> Result<Option<String>> {
    let (status, body) = fetch(url)?;
    if status == 404 {
        return Ok(None);
    }
    if status != 200 {
        return Err(anyhow!("oEmbed HTTP {status}"));
    }
    let body: Value = serde_json::from_str(&body).context("decode oEmbed response")?;
    Ok(body.get("thumbnail_url").and_then(Value::as_str).filter(|url| !url.is_empty()).map(str::to_string))
}

/// An [`ArtworkApi`] backed by the config's stored Spotify token, or `None`
/// when there is none. Token refreshes are merged and saved back to
/// `config_path` exactly as the CLI's client does, so the web server never
/// strands a refreshed token.
pub fn config_artwork_api(
    config_path: &Path,
    accounts_base_url: &str,
    api_base_url: &str,
) -> Option<Arc<dyn ArtworkApi>> {
    let cfg = config::load(config_path).ok()?;
    cfg.spotify.validate_client_credentials().ok()?;
    cfg.spotify.validate_stored_token().ok()?;
    let client = Client::saving_to_config_with_base_urls(&cfg, config_path, accounts_base_url, api_base_url).ok()?;
    Some(Arc::new(client))
}

/// The cache file sits next to the database, which is per-user state like it.
pub fn artwork_cache_path(database_path: &Path) -> Option<PathBuf> {
    let raw = database_path.to_string_lossy();
    if raw.is_empty() || raw == ":memory:" || raw.starts_with("file:") {
        return None;
    }
    Some(database_path.parent().unwrap_or(Path::new("")).join(ARTWORK_CACHE_FILE))
}

/// 403 and 404 are how Spotify refuses restricted endpoints to
/// development-mode apps.
fn is_refusal(err: &anyhow::Error) -> bool {
    matches!(status_of(err), Some(403 | 404))
}

/// The HTTP status of an [`ApiError`] anywhere in the chain.
fn status_of(err: &anyhow::Error) -> Option<u16> {
    err.chain().find_map(|cause| cause.downcast_ref::<ApiError>()).map(|api| api.status)
}

// ---- Disk cache ----

fn optional_string(art: &Map<String, Value>, key: &str) -> Option<Option<String>> {
    match art.get(key)? {
        Value::Null => Some(None),
        Value::String(url) => Some(Some(url.clone())),
        _ => None,
    }
}

/// A JSON object's entries in file order (`serde_json::Map` sorts them).
struct Entries(Vec<(String, Value)>);

impl<'de> Deserialize<'de> for Entries {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Entries, D::Error> {
        struct EntriesVisitor;

        impl<'de> Visitor<'de> for EntriesVisitor {
            type Value = Entries;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Entries, A::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = access.next_entry()? {
                    entries.push(entry);
                }
                Ok(Entries(entries))
            }
        }

        deserializer.deserialize_map(EntriesVisitor)
    }
}

#[derive(serde::Deserialize)]
struct CacheFile {
    version: Value,
    artwork: Entries,
}

/// The entries of a cache file, in file order; anything malformed is
/// skipped, and a file that is not a version 1 cache yields nothing.
fn read_cache(path: &Path) -> Vec<(String, Option<Artwork>)> {
    let Ok(text) = fs::read_to_string(path) else { return Vec::new() };
    let Ok(file) = serde_json::from_str::<CacheFile>(&text) else { return Vec::new() };
    if file.version.as_f64() != Some(CACHE_VERSION as f64) {
        return Vec::new();
    }
    let mut cache = Vec::with_capacity(file.artwork.0.len());
    for (id, art) in file.artwork.0 {
        if !is_spotify_id(&id) {
            continue;
        }
        let art = match art {
            Value::Null => None,
            Value::Object(art) => {
                let (Some(small), Some(medium), Some(large)) =
                    (optional_string(&art, "small"), optional_string(&art, "medium"), optional_string(&art, "large"))
                else {
                    continue;
                };
                Some(Artwork { small, medium, large })
            }
            _ => continue,
        };
        cache.push((id, art));
    }
    cache
}

/// The TypeScript build's format: compact JSON, entries in insertion order,
/// sizes in the order small, medium, large.
fn encode_cache(state: &State) -> String {
    let mut data = format!(r#"{{"version":{CACHE_VERSION},"artwork":{{"#);
    for (index, id) in state.order.iter().enumerate() {
        if let Some(art) = state.cache.get(id) {
            if index > 0 {
                data.push(',');
            }
            // Strings and derived structs always encode.
            data.push_str(&serde_json::to_string(id).unwrap_or_default());
            data.push(':');
            data.push_str(&serde_json::to_string(art).unwrap_or_default());
        }
    }
    data.push_str("}}");
    data
}

/// Atomic replace with owner-only permissions, like the config file.
fn write_cache(path: &Path, data: &[u8]) -> Result<()> {
    let dir = path.parent().filter(|dir| !dir.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)?;

    let mut suffix = [0u8; 6];
    getrandom::fill(&mut suffix).map_err(|err| anyhow!("random temp name: {err}"))?;
    let temp_path = dir.join(format!(".artwork-cache-{}.json", hex(&suffix)));
    let written = (|| -> Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options.open(&temp_path)?.write_all(data)?;
        fs::rename(&temp_path, path)?;
        Ok(())
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    written
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests;
