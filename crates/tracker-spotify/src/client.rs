use std::collections::HashMap;
use std::fmt;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use jiff::Timestamp;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};
use tracker_core::config::{self, Config, SpotifyConfig, Token};
use tracker_core::{ArtistSearcher, CatalogArtist};
use ureq::Agent;

use crate::auth::{DEFAULT_REDIRECT_URL, authenticator};
use crate::oauth::{self, ACCOUNTS_BASE_URL, OAuthConfig};

/// Default production base for Web API requests.
pub const API_BASE_URL: &str = "https://api.spotify.com/v1/";

/// The most IDs `GET /tracks` accepts in one request.
pub const MAX_TRACK_BATCH: usize = 50;

/// The image width the web UI's mid-size cover aims for.
const MEDIUM_IMAGE_PX: i64 = 300;

/// zmb3/spotify's wait when a 429 carries no usable Retry-After header.
const DEFAULT_RETRY_DURATION: Duration = Duration::from_secs(5);

/// Called with the merged token whenever the client refreshes it, so the
/// caller can save it to the config file.
pub type TokenPersister = Box<dyn Fn(&Token) -> Result<()> + Send + Sync>;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Artist {
    pub id: String,
    pub name: String,
}

/// One play from the recently-played endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentTrack {
    pub spotify_id: String,
    pub name: String,
    pub album_name: String,
    pub artists: Vec<Artist>,
    pub duration_ms: i64,
    pub played_at: Timestamp,
}

impl RecentTrack {
    pub fn artist_names(&self) -> Vec<String> {
        self.artists.iter().map(|artist| artist.name.clone()).collect()
    }
}

/// A track's album cover in three sizes; any can be missing when Spotify has
/// no image.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AlbumArt {
    /// The smallest image (~64 px).
    pub small: Option<String>,
    /// The image closest to 300 px.
    pub medium: Option<String>,
    /// The largest image (~640 px).
    pub large: Option<String>,
}

/// A non-success response from the Web API. The status is kept alongside
/// Spotify's message so callers can tell auth failures from rate limits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "spotify: HTTP {}: {}", self.status, self.message)
    }
}

impl std::error::Error for ApiError {}

/// Authenticated Spotify Web API client. Methods take `&self`; token
/// refresh state is kept behind interior mutability.
pub struct Client {
    agent: Agent,
    oauth: OAuthConfig,
    api_base_url: String,
    persist: TokenPersister,
    tokens: Mutex<TokenState>,
}

/// `current` is what requests use; `last_known` is what was last handed to
/// the persister, so a refresh is written back exactly once.
struct TokenState {
    current: Token,
    last_known: Token,
}

impl Client {
    /// Requires `cfg.token` (see `SpotifyConfig::validate_stored_token`).
    pub fn new(cfg: &SpotifyConfig, persist: TokenPersister) -> Result<Client> {
        Self::with_base_urls(cfg, persist, ACCOUNTS_BASE_URL, API_BASE_URL)
    }

    /// Like [`Client::new`] but against other hosts, so tests can point the
    /// token endpoint (`{accounts}/api/token`) and the Web API at mocks.
    pub fn with_base_urls(
        cfg: &SpotifyConfig,
        persist: TokenPersister,
        accounts_base_url: &str,
        api_base_url: &str,
    ) -> Result<Client> {
        let oauth = authenticator(cfg, accounts_base_url, DEFAULT_REDIRECT_URL)?;
        cfg.validate_stored_token().context("missing stored Spotify token")?;
        let token = cfg.token.clone().context("missing stored Spotify token")?;

        let mut api_base_url = api_base_url.to_string();
        if !api_base_url.ends_with('/') {
            api_base_url.push('/');
        }

        Ok(Client {
            agent: oauth::new_agent(),
            oauth,
            api_base_url,
            persist,
            tokens: Mutex::new(TokenState { last_known: token.clone(), current: token }),
        })
    }

    /// A client whose token refreshes are merged into the config and saved
    /// back to `config_path`, so the next run reuses them. The persister
    /// works on its own copy of the config because callers keep reading
    /// theirs while the client is alive.
    pub fn saving_to_config(cfg: &Config, config_path: &Path) -> Result<Client> {
        Self::saving_to_config_with_base_urls(cfg, config_path, ACCOUNTS_BASE_URL, API_BASE_URL)
    }

    /// [`Client::saving_to_config`] against other hosts, for tests.
    pub fn saving_to_config_with_base_urls(
        cfg: &Config,
        config_path: &Path,
        accounts_base_url: &str,
        api_base_url: &str,
    ) -> Result<Client> {
        let saved = Mutex::new(cfg.clone());
        let path = config_path.to_path_buf();
        let persist: TokenPersister = Box::new(move |token: &Token| {
            let mut cfg = saved.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            cfg.spotify.token = Some(Token::merged(token.clone(), cfg.spotify.token.as_ref()));
            config::save(&path, &cfg)
        });
        Self::with_base_urls(&cfg.spotify, persist, accounts_base_url, api_base_url)
    }

    /// Recently played tracks; `limit` must be 1..=50.
    pub fn recent_tracks(&self, limit: usize) -> Result<Vec<RecentTrack>> {
        let limit = normalize_recent_track_limit(limit)?;
        let url = format!("{}me/player/recently-played?limit={limit}", self.api_base_url);
        let result: RecentlyPlayedResult = self.get(&url).context("fetch recently played tracks from Spotify")?;
        self.persist_current_token()?;
        Ok(normalize_recently_played(result.items))
    }

    /// Album art for up to [`MAX_TRACK_BATCH`] tracks via `GET /tracks?ids=`,
    /// keyed by the requested ID; tracks Spotify does not know are absent.
    /// Spotify restricts this endpoint for some development-mode apps
    /// (403/404); the [`ApiError`] status lets callers fall back to
    /// [`Client::track_album_art`].
    pub fn album_art(&self, ids: &[String]) -> Result<HashMap<String, AlbumArt>> {
        if ids.is_empty() || ids.len() > MAX_TRACK_BATCH {
            return Err(anyhow!("track batch must hold 1 to {MAX_TRACK_BATCH} IDs, got {}", ids.len()));
        }
        let url = format!("{}tracks?{}", self.api_base_url, oauth::encode_params(&[("ids", ids.join(","))]));
        let page: FullTrackPage = self.get(&url).context("fetch Spotify tracks")?;
        self.persist_current_token()?;
        // Spotify answers in request order with null for unknown IDs, so
        // results are keyed by position: a relinked track can come back
        // under a different `id`.
        Ok(ids.iter().zip(page.tracks).filter_map(|(id, track)| Some((id.clone(), track?.album_art()))).collect())
    }

    /// Album art for one track via `GET /tracks/{id}`; an unknown track is a
    /// 404 [`ApiError`].
    pub fn track_album_art(&self, id: &str) -> Result<AlbumArt> {
        let url = format!("{}tracks/{}", self.api_base_url, oauth::query_escape(id).replace('+', "%20"));
        let track: FullTrack = self.get(&url).with_context(|| format!("fetch Spotify track {id:?}"))?;
        self.persist_current_token()?;
        Ok(track.album_art())
    }

    /// Returns a usable token, refreshing it first when it is expired or
    /// about to expire. The lock is held across the refresh so concurrent
    /// callers do not each spend the refresh token.
    fn current_token(&self) -> Result<Token> {
        let mut tokens = self.lock_tokens();
        if !oauth::token_valid(&tokens.current, Timestamp::now()) {
            tokens.current = self.oauth.refresh(&self.agent, &tokens.current.refresh_token)?;
        }
        Ok(tokens.current.clone())
    }

    fn lock_tokens(&self) -> MutexGuard<'_, TokenState> {
        self.tokens.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Writes the token back after a successful call, but only when a
    /// refresh actually changed it.
    fn persist_current_token(&self) -> Result<()> {
        let current = self.current_token().context("read current Spotify token")?;
        let last_known = self.lock_tokens().last_known.clone();
        if tokens_equal(&current, &last_known) {
            return Ok(());
        }

        (self.persist)(&Token::merged(current.clone(), Some(&last_known)))
            .context("persist refreshed Spotify token")?;
        self.lock_tokens().last_known = current;
        Ok(())
    }

    /// GETs a JSON resource. Like zmb3/spotify with retries enabled, a 429
    /// waits for Retry-After and tries again, and a 204 yields an empty
    /// result.
    fn get<T: DeserializeOwned + Default>(&self, url: &str) -> Result<T> {
        loop {
            let token = self.current_token().with_context(|| format!("Get {url:?}"))?;
            let authorization = format!("{} {}", oauth::authorization_type(&token.token_type), token.access_token);
            let mut response = self
                .agent
                .get(url)
                .header("Authorization", authorization)
                .call()
                .with_context(|| format!("Get {url:?}"))?;

            let status = response.status().as_u16();
            if status == 429 {
                thread::sleep(retry_duration(
                    response.headers().get("Retry-After").and_then(|value| value.to_str().ok()),
                ));
                continue;
            }
            if status == 204 {
                return Ok(T::default());
            }
            if status != 200 {
                let body = response.body_mut().read_to_string()?;
                return Err(decode_error(status, &body).into());
            }
            return Ok(response.body_mut().read_json()?);
        }
    }
}

impl ArtistSearcher for Client {
    fn search_artists(&self, query: &str, limit: usize) -> Result<Vec<CatalogArtist>> {
        let limit = if limit < 1 { 5 } else { limit };
        let url = format!(
            "{}search?{}",
            self.api_base_url,
            oauth::encode_params(&[("limit", limit.to_string()), ("q", query.to_string()), ("type", "artist".into())])
        );
        let result: SearchResult = self.get(&url).with_context(|| format!("search Spotify artists for {query:?}"))?;

        let artists = result
            .artists
            .unwrap_or_default()
            .items
            .into_iter()
            .map(|artist| CatalogArtist {
                name: artist.name,
                id: artist.id,
                popularity: artist.popularity.0,
                genres: artist.genres,
            })
            .collect();
        self.persist_current_token()?;
        Ok(artists)
    }
}

/// Picks small, medium, and large images by width (not position): the
/// smallest, the one closest to 300 px, and the largest.
pub fn pick_album_art(images: &[(String, i64)]) -> AlbumArt {
    let mut usable: Vec<&(String, i64)> = images.iter().filter(|(url, _)| !url.is_empty()).collect();
    usable.sort_by_key(|(_, width)| *width);
    let (Some(smallest), Some(largest)) = (usable.first(), usable.last()) else {
        return AlbumArt::default();
    };
    let mut medium = smallest;
    for image in &usable {
        if (image.1 - MEDIUM_IMAGE_PX).abs() < (medium.1 - MEDIUM_IMAGE_PX).abs() {
            medium = image;
        }
    }
    AlbumArt { small: Some(smallest.0.clone()), medium: Some(medium.0.clone()), large: Some(largest.0.clone()) }
}

/// 0 means "the API maximum", matching the CLI's default.
fn normalize_recent_track_limit(limit: usize) -> Result<usize> {
    match limit {
        0 => Ok(50),
        1..=50 => Ok(limit),
        _ => Err(anyhow!("recent track limit must be between 1 and 50, got {limit}")),
    }
}

/// Converts wire types into the app's smaller normalized shape so
/// downstream crates do not depend on the API's JSON layout.
fn normalize_recently_played(items: Vec<RecentlyPlayedItem>) -> Vec<RecentTrack> {
    items
        .into_iter()
        .map(|item| RecentTrack {
            spotify_id: item.track.id,
            name: item.track.name,
            album_name: item.track.album.name,
            artists: item.track.artists.into_iter().map(|artist| Artist { id: artist.id, name: artist.name }).collect(),
            duration_ms: item.track.duration_ms.0,
            played_at: item.played_at,
        })
        .collect()
}

fn tokens_equal(left: &Token, right: &Token) -> bool {
    left.access_token == right.access_token
        && left.refresh_token == right.refresh_token
        && left.token_type == right.token_type
        && left.expiry == right.expiry
}

/// Retry-After in whole seconds; anything unparseable falls back to the
/// default wait, and negative values retry immediately as in Go.
fn retry_duration(header: Option<&str>) -> Duration {
    match header.filter(|raw| !raw.is_empty()).map(str::parse::<i32>) {
        Some(Ok(seconds)) => Duration::from_secs(u64::try_from(seconds).unwrap_or(0)),
        _ => DEFAULT_RETRY_DURATION,
    }
}

/// Turns a failed response into an error the way zmb3/spotify's
/// `decodeError` does, keeping its fallbacks for empty or non-JSON bodies.
fn decode_error(status: u16, body: &str) -> ApiError {
    let reason = ureq::http::StatusCode::from_u16(status).ok().and_then(|code| code.canonical_reason()).unwrap_or("");
    let message = if body.is_empty() {
        format!("spotify: HTTP {status}: {reason} (body empty)")
    } else {
        // Like json.Decoder, only the first JSON value is considered.
        match serde_json::Deserializer::from_str(body).into_iter::<ErrorEnvelope>().next() {
            Some(Ok(envelope)) if !envelope.error.message.is_empty() => envelope.error.message,
            Some(Ok(_)) => format!("spotify: unexpected HTTP {status}: {reason} (empty error)"),
            _ => format!("spotify: couldn't decode error: ({}) [{body}]", body.len()),
        }
    };
    ApiError { status, message }
}

// Wire types. Go's encoding/json leaves a field at its zero value when the
// JSON holds null; `nullable` gives serde the same tolerance.

fn nullable<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// Spotify timestamps are RFC 3339, which is what Go's time.Time decodes.
fn timestamp<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Timestamp, D::Error> {
    String::deserialize(deserializer)?.parse().map_err(serde::de::Error::custom)
}

/// zmb3's `Numeric`: Spotify sometimes sends integers as floats.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
struct Numeric(i64);

impl<'de> Deserialize<'de> for Numeric {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Truncation toward zero is exactly Go's int(float64).
        Ok(Numeric(Option::<f64>::deserialize(deserializer)?.unwrap_or_default() as i64))
    }
}

#[derive(Debug, Default, Deserialize)]
struct ErrorEnvelope {
    #[serde(default, deserialize_with = "nullable")]
    error: ErrorBody,
}

#[derive(Debug, Default, Deserialize)]
struct ErrorBody {
    #[serde(default, deserialize_with = "nullable")]
    message: String,
}

#[derive(Debug, Default, Deserialize)]
struct RecentlyPlayedResult {
    #[serde(default, deserialize_with = "nullable")]
    items: Vec<RecentlyPlayedItem>,
}

#[derive(Debug, Deserialize)]
struct RecentlyPlayedItem {
    #[serde(default, deserialize_with = "nullable")]
    track: SimpleTrack,
    #[serde(deserialize_with = "timestamp")]
    played_at: Timestamp,
}

#[derive(Debug, Default, Deserialize)]
struct SimpleTrack {
    #[serde(default, deserialize_with = "nullable")]
    id: String,
    #[serde(default, deserialize_with = "nullable")]
    name: String,
    #[serde(default, deserialize_with = "nullable")]
    album: SimpleAlbum,
    #[serde(default, deserialize_with = "nullable")]
    artists: Vec<SimpleArtist>,
    #[serde(default)]
    duration_ms: Numeric,
}

#[derive(Debug, Default, Deserialize)]
struct SimpleAlbum {
    #[serde(default, deserialize_with = "nullable")]
    name: String,
}

#[derive(Debug, Default, Deserialize)]
struct SimpleArtist {
    #[serde(default, deserialize_with = "nullable")]
    id: String,
    #[serde(default, deserialize_with = "nullable")]
    name: String,
}

#[derive(Debug, Default, Deserialize)]
struct FullTrackPage {
    #[serde(default, deserialize_with = "nullable")]
    tracks: Vec<Option<FullTrack>>,
}

#[derive(Debug, Default, Deserialize)]
struct FullTrack {
    #[serde(default, deserialize_with = "nullable")]
    album: AlbumImages,
}

impl FullTrack {
    fn album_art(self) -> AlbumArt {
        let images: Vec<(String, i64)> =
            self.album.images.into_iter().map(|image| (image.url, image.width.0)).collect();
        pick_album_art(&images)
    }
}

#[derive(Debug, Default, Deserialize)]
struct AlbumImages {
    #[serde(default, deserialize_with = "nullable")]
    images: Vec<Image>,
}

#[derive(Debug, Default, Deserialize)]
struct Image {
    #[serde(default, deserialize_with = "nullable")]
    url: String,
    #[serde(default)]
    width: Numeric,
}

#[derive(Debug, Default, Deserialize)]
struct SearchResult {
    #[serde(default, deserialize_with = "nullable")]
    artists: Option<FullArtistPage>,
}

#[derive(Debug, Default, Deserialize)]
struct FullArtistPage {
    #[serde(default, deserialize_with = "nullable")]
    items: Vec<FullArtist>,
}

#[derive(Debug, Default, Deserialize)]
struct FullArtist {
    #[serde(default, deserialize_with = "nullable")]
    id: String,
    #[serde(default, deserialize_with = "nullable")]
    name: String,
    #[serde(default)]
    popularity: Numeric,
    #[serde(default, deserialize_with = "nullable")]
    genres: Vec<String>,
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use jiff::SignedDuration;

    use super::*;
    use crate::test_support::{MockServer, Recorded, Reply};

    const RECENT_JSON: &str = r#"{"items":[{
        "track":{"id":"track-id","name":"Piano Sonata No. 14","album":{"name":"Beethoven Favorites"},
                 "artists":[{"id":"artist-id","name":"Martha Argerich"}],"duration_ms":1234},
        "played_at":"2026-03-31T12:00:00Z"}]}"#;

    #[test]
    fn normalize_recent_track_limit_defaults_and_bounds() {
        assert_eq!(normalize_recent_track_limit(0).unwrap(), 50);
        assert_eq!(normalize_recent_track_limit(1).unwrap(), 1);
        assert_eq!(normalize_recent_track_limit(50).unwrap(), 50);
        assert_eq!(
            normalize_recent_track_limit(51).unwrap_err().to_string(),
            "recent track limit must be between 1 and 50, got 51"
        );
    }

    #[test]
    fn normalize_recently_played_maps_fields() {
        let result: RecentlyPlayedResult = serde_json::from_str(RECENT_JSON).unwrap();
        let tracks = normalize_recently_played(result.items);
        assert_eq!(
            tracks,
            vec![RecentTrack {
                spotify_id: "track-id".into(),
                name: "Piano Sonata No. 14".into(),
                album_name: "Beethoven Favorites".into(),
                artists: vec![Artist { id: "artist-id".into(), name: "Martha Argerich".into() }],
                duration_ms: 1234,
                played_at: "2026-03-31T12:00:00Z".parse().unwrap(),
            }]
        );
        assert_eq!(tracks[0].artist_names(), vec!["Martha Argerich"]);
    }

    #[test]
    fn wire_types_tolerate_nulls_and_float_numbers() {
        let result: RecentlyPlayedResult = serde_json::from_str(
            r#"{"items":[{"track":{"id":null,"name":"N","album":null,"artists":null,"duration_ms":1234.9},
                "played_at":"2026-03-31T12:00:00.123Z"}]}"#,
        )
        .unwrap();
        let tracks = normalize_recently_played(result.items);
        assert_eq!(tracks[0].spotify_id, "");
        assert_eq!(tracks[0].album_name, "");
        assert!(tracks[0].artists.is_empty());
        assert_eq!(tracks[0].duration_ms, 1234);
        let empty: RecentlyPlayedResult = serde_json::from_str(r#"{"items":null}"#).unwrap();
        assert!(empty.items.is_empty());
    }

    #[test]
    fn tokens_equal_compares_every_field() {
        let left = Token {
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            token_type: "Bearer".into(),
            expiry: Some("2026-03-31T12:00:00Z".parse().unwrap()),
        };
        let mut right = left.clone();
        assert!(tokens_equal(&left, &right));
        right.access_token = "different".into();
        assert!(!tokens_equal(&left, &right));
    }

    #[test]
    fn decode_error_mirrors_zmb3_fallbacks() {
        let err = decode_error(401, r#"{"error":{"status":401,"message":"The access token expired"}}"#);
        assert_eq!(err, ApiError { status: 401, message: "The access token expired".into() });
        assert_eq!(err.to_string(), "spotify: HTTP 401: The access token expired");
        assert_eq!(decode_error(503, "").message, "spotify: HTTP 503: Service Unavailable (body empty)");
        assert_eq!(
            decode_error(500, "{}").message,
            "spotify: unexpected HTTP 500: Internal Server Error (empty error)"
        );
        assert_eq!(decode_error(502, "<html>").message, "spotify: couldn't decode error: (6) [<html>]");
        assert_eq!(
            decode_error(400, r#"{"error":"invalid_token"}"#).message,
            r#"spotify: couldn't decode error: (25) [{"error":"invalid_token"}]"#
        );
    }

    #[test]
    fn retry_duration_parses_seconds() {
        assert_eq!(retry_duration(None), DEFAULT_RETRY_DURATION);
        assert_eq!(retry_duration(Some("")), DEFAULT_RETRY_DURATION);
        assert_eq!(retry_duration(Some("soon")), DEFAULT_RETRY_DURATION);
        assert_eq!(retry_duration(Some("3")), Duration::from_secs(3));
        assert_eq!(retry_duration(Some("-1")), Duration::ZERO);
    }

    fn token_expiring_in(seconds: i64) -> Token {
        Token {
            access_token: "old-access".into(),
            refresh_token: "refresh".into(),
            token_type: "Bearer".into(),
            expiry: Some(Timestamp::now().checked_add(SignedDuration::from_secs(seconds)).unwrap()),
        }
    }

    fn spotify_config(token: Option<Token>) -> SpotifyConfig {
        SpotifyConfig { client_id: "id".into(), client_secret: "secret".into(), token }
    }

    struct Harness {
        accounts: MockServer,
        api: MockServer,
        persisted: Arc<Mutex<Vec<Token>>>,
        client: Client,
    }

    fn harness(token: Token, api: impl Fn(&Recorded) -> Reply + Send + Sync + 'static) -> Harness {
        let accounts = MockServer::start(|_| {
            Reply::json(200, r#"{"access_token":"new-access","token_type":"Bearer","expires_in":3600}"#)
        });
        let api = MockServer::start(api);
        let persisted = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&persisted);
        let client = Client::with_base_urls(
            &spotify_config(Some(token)),
            Box::new(move |token| {
                sink.lock().unwrap().push(token.clone());
                Ok(())
            }),
            &accounts.base_url,
            &api.base_url,
        )
        .unwrap();
        Harness { accounts, api, persisted, client }
    }

    #[test]
    fn new_validates_credentials_then_token() {
        let persist = || -> TokenPersister { Box::new(|_| Ok(())) };
        let err = Client::new(&SpotifyConfig::default(), persist()).err().unwrap();
        assert_eq!(
            format!("{err:#}"),
            "invalid Spotify credentials: spotify.client_id is required; spotify.client_secret is required"
        );
        let err = Client::new(&spotify_config(None), persist()).err().unwrap();
        assert_eq!(format!("{err:#}"), "missing stored Spotify token: spotify.token is required");
    }

    #[test]
    fn recent_tracks_uses_valid_token_without_refreshing() {
        let h = harness(token_expiring_in(3600), |_| Reply::json(200, RECENT_JSON));
        let tracks = h.client.recent_tracks(10).unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].spotify_id, "track-id");

        let request = h.api.single_request();
        assert_eq!(request.method, "GET");
        assert_eq!(request.target, "/me/player/recently-played?limit=10");
        assert_eq!(request.header("authorization"), Some("Bearer old-access"));
        assert!(h.accounts.requests().is_empty());
        assert!(h.persisted.lock().unwrap().is_empty());
    }

    #[test]
    fn recent_tracks_refreshes_expired_token_and_persists_once() {
        let h = harness(token_expiring_in(-60), |_| Reply::json(200, RECENT_JSON));
        h.client.recent_tracks(0).unwrap();
        h.client.recent_tracks(0).unwrap();

        assert_eq!(h.accounts.single_request().form("refresh_token"), "refresh");
        let api_requests = h.api.requests();
        assert_eq!(api_requests[0].target, "/me/player/recently-played?limit=50");
        assert!(api_requests.iter().all(|request| request.header("authorization") == Some("Bearer new-access")));

        let persisted = h.persisted.lock().unwrap();
        assert_eq!(persisted.len(), 1, "a refresh is persisted exactly once");
        assert_eq!(persisted[0].access_token, "new-access");
        assert_eq!(persisted[0].refresh_token, "refresh", "refresh token is retained");
        assert_eq!(persisted[0].token_type, "Bearer");
        assert!(persisted[0].expiry.unwrap() > Timestamp::now());
    }

    #[test]
    fn token_inside_expiry_delta_is_refreshed() {
        let h = harness(token_expiring_in(5), |_| Reply::json(200, RECENT_JSON));
        h.client.recent_tracks(1).unwrap();
        assert_eq!(h.accounts.requests().len(), 1);
        assert_eq!(h.persisted.lock().unwrap().len(), 1);
    }

    #[test]
    fn failed_call_does_not_persist_refreshed_token() {
        let h = harness(token_expiring_in(-60), |_| {
            Reply::json(401, r#"{"error":{"status":401,"message":"The access token expired"}}"#)
        });
        let err = h.client.recent_tracks(5).unwrap_err();
        assert_eq!(
            format!("{err:#}"),
            "fetch recently played tracks from Spotify: spotify: HTTP 401: The access token expired"
        );
        let api_err = err.downcast_ref::<ApiError>().unwrap();
        assert_eq!(api_err.status, 401);
        assert!(h.persisted.lock().unwrap().is_empty());
    }

    #[test]
    fn refresh_failure_is_reported_like_a_transport_error() {
        let accounts = MockServer::start(|_| {
            Reply::json(400, r#"{"error":"invalid_grant","error_description":"Refresh token revoked"}"#)
        });
        let api = MockServer::start(|_| Reply::json(200, RECENT_JSON));
        let client = Client::with_base_urls(
            &spotify_config(Some(token_expiring_in(-60))),
            Box::new(|_| Ok(())),
            &accounts.base_url,
            &api.base_url,
        )
        .unwrap();
        let err = client.recent_tracks(50).unwrap_err();
        assert_eq!(
            format!("{err:#}"),
            format!(
                "fetch recently played tracks from Spotify: Get \"{}/me/player/recently-played?limit=50\": \
                 oauth2: \"invalid_grant\" \"Refresh token revoked\"",
                api.base_url
            )
        );
        assert!(api.requests().is_empty());
    }

    #[test]
    fn persist_failure_is_wrapped() {
        let accounts = MockServer::start(|_| Reply::json(200, r#"{"access_token":"new"}"#));
        let api = MockServer::start(|_| Reply::json(200, RECENT_JSON));
        let client = Client::with_base_urls(
            &spotify_config(Some(token_expiring_in(-60))),
            Box::new(|_| Err(anyhow!("disk full"))),
            &accounts.base_url,
            &api.base_url,
        )
        .unwrap();
        let err = client.recent_tracks(50).unwrap_err();
        assert_eq!(format!("{err:#}"), "persist refreshed Spotify token: disk full");
    }

    #[test]
    fn limit_is_validated_before_any_request() {
        let h = harness(token_expiring_in(-60), |_| Reply::json(200, RECENT_JSON));
        let err = h.client.recent_tracks(51).unwrap_err();
        assert_eq!(err.to_string(), "recent track limit must be between 1 and 50, got 51");
        assert!(h.accounts.requests().is_empty());
        assert!(h.api.requests().is_empty());
    }

    #[test]
    fn rate_limited_requests_are_retried() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&calls);
        let h = harness(token_expiring_in(3600), move |_| {
            if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                Reply::text(429, "").with_header("Retry-After", "0")
            } else {
                Reply::json(200, RECENT_JSON)
            }
        });
        assert_eq!(h.client.recent_tracks(50).unwrap().len(), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn no_content_yields_no_tracks() {
        let h = harness(token_expiring_in(3600), |_| Reply::text(204, ""));
        assert!(h.client.recent_tracks(50).unwrap().is_empty());
    }

    #[test]
    fn search_artists_maps_results_and_defaults_limit() {
        let h = harness(token_expiring_in(3600), |_| {
            Reply::json(
                200,
                r#"{"artists":{"items":[
                    {"id":"a1","name":"Martha Argerich","popularity":61,"genres":["classical","classical piano"]},
                    {"id":null,"name":"No Id","popularity":null,"genres":null}]}}"#,
            )
        });
        let artists = h.client.search_artists("Martha Argerich & co", 0).unwrap();
        assert_eq!(
            artists,
            vec![
                CatalogArtist {
                    name: "Martha Argerich".into(),
                    id: "a1".into(),
                    popularity: 61,
                    genres: vec!["classical".into(), "classical piano".into()],
                },
                CatalogArtist { name: "No Id".into(), ..CatalogArtist::default() },
            ]
        );
        assert_eq!(h.api.single_request().target, "/search?limit=5&q=Martha+Argerich+%26+co&type=artist");
    }

    #[test]
    fn search_artists_handles_missing_results_and_persists_refresh() {
        let h = harness(token_expiring_in(-60), |_| Reply::json(200, "{}"));
        assert!(h.client.search_artists("nobody", 3).unwrap().is_empty());
        assert!(h.api.single_request().target.starts_with("/search?limit=3&"));
        assert_eq!(h.persisted.lock().unwrap().len(), 1);
    }

    #[test]
    fn pick_album_art_chooses_by_width_not_position() {
        let image = |url: &str, width| (url.to_string(), width);
        let art = |s: &str, m: &str, l: &str| AlbumArt {
            small: Some(s.into()),
            medium: Some(m.into()),
            large: Some(l.into()),
        };
        assert_eq!(pick_album_art(&[image("m", 300), image("l", 640), image("s", 64)]), art("s", "m", "l"));
        assert_eq!(pick_album_art(&[image("only", 640)]), art("only", "only", "only"));
        assert_eq!(pick_album_art(&[image("", 64)]), AlbumArt::default());
    }

    const IMAGES: &str = r#"[{"url":"https://i.scdn.co/640","width":640,"height":640},
        {"url":"https://i.scdn.co/300","width":300,"height":300},
        {"url":"https://i.scdn.co/64","width":64,"height":64}]"#;

    fn api_art() -> AlbumArt {
        AlbumArt {
            small: Some("https://i.scdn.co/64".into()),
            medium: Some("https://i.scdn.co/300".into()),
            large: Some("https://i.scdn.co/640".into()),
        }
    }

    #[test]
    fn album_art_batches_ids_keys_by_request_and_skips_unknown_tracks() {
        let h = harness(token_expiring_in(-60), |_| {
            Reply::json(200, &format!(r#"{{"tracks":[{{"id":"relinked","album":{{"images":{IMAGES}}}}},null]}}"#))
        });
        let art = h.client.album_art(&["a".into(), "b".into()]).unwrap();
        assert_eq!(art, HashMap::from([("a".to_string(), api_art())]));
        assert_eq!(h.api.single_request().target, "/tracks?ids=a%2Cb");
        // The refreshed token goes through the same persister as every other call.
        assert_eq!(h.persisted.lock().unwrap().len(), 1);
    }

    #[test]
    fn album_art_rejects_empty_and_oversized_batches_before_any_request() {
        let h = harness(token_expiring_in(3600), |_| Reply::json(200, "{}"));
        assert_eq!(h.client.album_art(&[]).unwrap_err().to_string(), "track batch must hold 1 to 50 IDs, got 0");
        let ids: Vec<String> = (0..51).map(|i| format!("id{i}")).collect();
        assert!(h.client.album_art(&ids).unwrap_err().to_string().ends_with("got 51"));
        assert!(h.api.requests().is_empty());
    }

    #[test]
    fn album_art_keeps_the_status_of_a_refused_batch() {
        let h = harness(token_expiring_in(3600), |_| Reply::json(403, r#"{"error":{"status":403,"message":"no"}}"#));
        let err = h.client.album_art(&["a".into()]).unwrap_err();
        assert_eq!(format!("{err:#}"), "fetch Spotify tracks: spotify: HTTP 403: no");
        assert_eq!(err.downcast_ref::<ApiError>().unwrap().status, 403);
    }

    #[test]
    fn track_album_art_looks_up_one_track() {
        let h = harness(token_expiring_in(3600), |request| {
            if request.target == "/tracks/known" {
                Reply::json(200, &format!(r#"{{"id":"known","album":{{"images":{IMAGES}}}}}"#))
            } else {
                Reply::json(404, r#"{"error":{"status":404,"message":"Not found."}}"#)
            }
        });
        assert_eq!(h.client.track_album_art("known").unwrap(), api_art());
        let err = h.client.track_album_art("gone").unwrap_err();
        assert_eq!(format!("{err:#}"), "fetch Spotify track \"gone\": spotify: HTTP 404: Not found.");
        let h = harness(token_expiring_in(3600), |_| Reply::json(200, r#"{"album":null}"#));
        assert_eq!(h.client.track_album_art("a b").unwrap(), AlbumArt::default());
        assert_eq!(h.api.single_request().target, "/tracks/a%20b");
    }

    #[test]
    fn search_artists_wraps_errors_with_query() {
        let h = harness(token_expiring_in(3600), |_| Reply::json(400, r#"{"error":{"message":"Bad limit"}}"#));
        let err = h.client.search_artists("Gould", 99).unwrap_err();
        assert_eq!(format!("{err:#}"), "search Spotify artists for \"Gould\": spotify: HTTP 400: Bad limit");
    }
}
