//! The HTTP contract between `tracker web`'s local server and the browser
//! client. Both sides use these types, so a shape change breaks the build
//! rather than the page. The routes and JSON match the TypeScript build's
//! `web/api.ts`, so either build's client works against either server.
//!
//! Security model: the server binds 127.0.0.1 only and rejects requests
//! whose Host header is not the address it serves (blocks DNS rebinding).
//! Every request that changes state must carry the per-launch token from the
//! page's `<meta name="tracker-token">` in the [`TOKEN_HEADER`] header; other
//! sites can neither read the token nor send that header without a CORS
//! preflight, which the server never approves.
//!
//! The presence stream is a GET, because `EventSource` cannot send headers,
//! so it takes the token as a query parameter instead. A wrong or missing
//! token gets the usual 403, so another site cannot hold the server open.

use std::fmt;

use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use tracker_core::{Rating, Track};

use crate::model::SortMode;

pub const TOKEN_HEADER: &str = "X-Tracker-Token";
pub const TOKEN_META: &str = "tracker-token";

/// GET ?sort=<[`SortMode::param`]>&q=<query>&offset=<n>&limit=<n>[&around=<track ID>]
/// -> [`ViewResponse`]: one window of the library, sorted and filtered
/// exactly as the terminal UI does. With `around`, the window is centered on
/// that track when it matches (and `offset` is ignored).
pub const VIEW_PATH: &str = "/api/view";
/// POST (no body) -> [`ReloadResponse`]: re-reads the database.
pub const RELOAD_PATH: &str = "/api/reload";
/// POST (no body) -> `SyncStats`; the server then re-reads the database.
pub const SYNC_PATH: &str = "/api/sync";
/// POST `UpsertRatingParams` -> `Rating`
pub const RATINGS_PATH: &str = "/api/ratings";
/// GET ?ids=<spotify id>,<spotify id>... (at most [`ARTWORK_BATCH`]) -> [`ArtworkResponse`]
pub const ARTWORK_PATH: &str = "/api/artwork";
/// GET ?token=<page token> -> `text/event-stream` that sends only comments
/// (one at once, then one every 15 s) and never ends on its own. Each open
/// page holds one; the server stops a few seconds after the last closes.
pub const PRESENCE_PATH: &str = "/api/presence";

/// The query parameter that carries the page token on [`PRESENCE_PATH`].
pub const PRESENCE_TOKEN_PARAM: &str = "token";

/// Spotify's track lookup accepts at most 50 IDs per request.
pub const ARTWORK_BATCH: usize = 50;

/// The most rows one [`VIEW_PATH`] request returns.
pub const MAX_VIEW_LIMIT: usize = 500;

/// The `<script type="application/json">` element in the server-rendered
/// page that holds the [`InitialState`] the page was rendered from.
pub const INITIAL_STATE_ID: &str = "tracker-initial";

/// One window of the sorted, filtered library.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewResponse {
    /// Increases whenever the library or a rating changes; rows from an
    /// older version may be out of date.
    pub version: u64,
    /// Every track in the library.
    pub total: usize,
    /// Tracks that pass the query.
    pub matched: usize,
    /// The index (in the matched list) of `rows[0]`.
    pub offset: usize,
    pub rows: Vec<Row>,
    /// The `around` track's index in the matched list, or `None` when it
    /// does not match (or none was asked for).
    pub index: Option<usize>,
}

/// One track as the list and the detail pane show it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Row {
    pub track: Track,
    pub rating: Option<Rating>,
    /// The display label, as the terminal formats it.
    pub artists: String,
    /// Present only when the server already knows the track's art; `null`
    /// means it has none.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub art: Option<Option<Artwork>>,
}

/// Tells a field that is `null` (`Some(None)`) from one that is absent
/// (`None`, through `#[serde(default)]`).
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReloadResponse {
    pub version: u64,
    pub total: usize,
}

/// What the server rendered the page from: the first window of the default
/// view, or why the library could not be read. `view` and `error` are both
/// absent while the library is still loading.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InitialState {
    pub view: Option<ViewResponse>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl InitialState {
    /// JSON safe to place inside a `<script>` element: `<`, `>`, `&`, and the
    /// two JavaScript line terminators are escaped, so the text can neither
    /// close the element nor open a comment.
    pub fn to_script_json(&self) -> String {
        let json = serde_json::to_string(self).unwrap_or_else(|_| "{}".into());
        let mut escaped = String::with_capacity(json.len() + 16);
        for c in json.chars() {
            match c {
                '<' => escaped.push_str("\\u003c"),
                '>' => escaped.push_str("\\u003e"),
                '&' => escaped.push_str("\\u0026"),
                '\u{2028}' => escaped.push_str("\\u2028"),
                '\u{2029}' => escaped.push_str("\\u2029"),
                c => escaped.push(c),
            }
        }
        escaped
    }
}

/// The URL of one [`VIEW_PATH`] request.
pub fn view_url(sort: SortMode, query: &str, offset: usize, limit: usize, around: Option<i64>) -> String {
    let mut url =
        format!("{VIEW_PATH}?sort={}&q={}&offset={offset}&limit={limit}", sort.param(), encode_uri_component(query));
    if let Some(around) = around {
        url.push_str(&format!("&around={around}"));
    }
    url
}

/// JavaScript's `encodeURIComponent`.
pub fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                encoded.push(char::from(byte))
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// Album art in Spotify's three sizes; any can be missing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Artwork {
    /// ~64 px, for list rows.
    pub small: Option<String>,
    /// ~300 px.
    pub medium: Option<String>,
    /// ~640 px, for the detail pane.
    pub large: Option<String>,
}

impl Artwork {
    /// The best URL for a list row: the smallest available.
    pub fn small_url(&self) -> Option<&str> {
        self.small.as_deref().or(self.medium.as_deref()).or(self.large.as_deref())
    }

    /// The best URL for the detail pane: the largest available.
    pub fn large_url(&self) -> Option<&str> {
        self.large.as_deref().or(self.medium.as_deref()).or(self.small.as_deref())
    }
}

/// Art keyed by Spotify track ID, in request order; `None` when the track
/// has no art or could not be looked up. A JSON object on the wire.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ArtworkResponse(pub Vec<(String, Option<Artwork>)>);

impl Serialize for ArtworkResponse {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (id, art) in &self.0 {
            map.serialize_entry(id, art)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for ArtworkResponse {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct EntriesVisitor;

        impl<'de> Visitor<'de> for EntriesVisitor {
            type Value = ArtworkResponse;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an object of artwork by track ID")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<ArtworkResponse, A::Error> {
                let mut entries = Vec::with_capacity(access.size_hint().unwrap_or(0));
                while let Some(entry) = access.next_entry()? {
                    entries.push(entry);
                }
                Ok(ArtworkResponse(entries))
            }
        }

        deserializer.deserialize_map(EntriesVisitor)
    }
}

/// Every non-2xx response has this body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: String,
}

/// The cookie holding the appearance choice. The server reads it to set
/// `data-theme` on the page it serves, so the page never flashes the wrong
/// theme and needs no boot script.
pub const THEME_COOKIE: &str = "tracker-theme";

/// Light/dark appearance. `Auto` follows the operating system.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Theme {
    #[default]
    Auto,
    Light,
    Dark,
}

impl Theme {
    pub const ALL: [Theme; 3] = [Theme::Auto, Theme::Light, Theme::Dark];

    /// The cookie and `data-theme` value.
    pub fn as_str(self) -> &'static str {
        match self {
            Theme::Auto => "auto",
            Theme::Light => "light",
            Theme::Dark => "dark",
        }
    }

    /// The switch's label.
    pub fn label(self) -> &'static str {
        match self {
            Theme::Auto => "Auto",
            Theme::Light => "Light",
            Theme::Dark => "Dark",
        }
    }

    /// Anything unrecognized is `Auto`.
    pub fn parse(value: &str) -> Theme {
        match value {
            "light" => Theme::Light,
            "dark" => Theme::Dark,
            _ => Theme::Auto,
        }
    }

    /// The choice stored in a `Cookie` request header.
    pub fn from_cookie_header(header: &str) -> Theme {
        header
            .split(';')
            .filter_map(|pair| pair.trim().split_once('='))
            .find(|(name, _)| *name == THEME_COOKIE)
            .map_or(Theme::Auto, |(_, value)| Theme::parse(value.trim()))
    }

    /// The `document.cookie` assignment that remembers this choice for a year.
    pub fn cookie(self) -> String {
        format!("{THEME_COOKIE}={}; Path=/; Max-Age=31536000; SameSite=Strict", self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use tracker_core::{SyncStats, UpsertRatingParams};

    use super::*;

    #[test]
    fn json_uses_the_typescript_field_names() {
        let track = Track {
            id: 1,
            spotify_id: "sp".into(),
            track_name: "Scarbo".into(),
            album_name: "Gaspard".into(),
            artists: r#"["Martha Argerich"]"#.into(),
            play_count: 2,
            last_played_at: 100,
            created_at: 50,
        };
        let rating = Rating { track_id: 1, stars: 4, opinion: "Glittering".into(), updated_at: 200 };
        let view = ViewResponse {
            version: 7,
            total: 3,
            matched: 2,
            offset: 1,
            rows: vec![
                Row { track: track.clone(), rating: Some(rating), artists: "Martha Argerich".into(), art: None },
                Row { track, rating: None, artists: "A".into(), art: Some(None) },
            ],
            index: Some(1),
        };
        let json = serde_json::to_string(&view).unwrap();
        assert_eq!(
            json,
            r#"{"version":7,"total":3,"matched":2,"offset":1,"rows":[{"track":{"id":1,"spotifyId":"sp","trackName":"Scarbo","albumName":"Gaspard","artists":"[\"Martha Argerich\"]","playCount":2,"lastPlayedAt":100,"createdAt":50},"rating":{"trackId":1,"stars":4,"opinion":"Glittering","updatedAt":200},"artists":"Martha Argerich"},{"track":{"id":1,"spotifyId":"sp","trackName":"Scarbo","albumName":"Gaspard","artists":"[\"Martha Argerich\"]","playCount":2,"lastPlayedAt":100,"createdAt":50},"rating":null,"artists":"A","art":null}],"index":1}"#
        );
        // `art` absent (unknown) and `null` (none) stay apart.
        assert_eq!(serde_json::from_str::<ViewResponse>(&json).unwrap(), view);
        assert_eq!(
            serde_json::to_string(&ReloadResponse { version: 2, total: 9 }).unwrap(),
            r#"{"version":2,"total":9}"#
        );
        assert_eq!(
            serde_json::to_string(&SyncStats { already_synced: 3, ..SyncStats::default() }).unwrap(),
            r#"{"fetched":0,"blocked":0,"skipped":0,"accepted":0,"inserted":0,"updated":0,"alreadySynced":3}"#
        );
        let params: UpsertRatingParams =
            serde_json::from_str(r#"{"trackId":1,"stars":5,"opinion":"","updatedAt":9}"#).unwrap();
        assert_eq!(params, UpsertRatingParams { track_id: 1, stars: 5, opinion: String::new(), updated_at: 9 });
    }

    #[test]
    fn initial_state_json_cannot_break_out_of_its_script_element() {
        let track = Track { track_name: "</script><!-- & \u{2028}\u{2029}".into(), ..Track::default() };
        let view = ViewResponse {
            rows: vec![Row { track, artists: "<b>".into(), ..Row::default() }],
            matched: 1,
            total: 1,
            ..ViewResponse::default()
        };
        let initial = InitialState { view: Some(view), error: None };
        let json = initial.to_script_json();
        for raw in ['<', '>', '&', '\u{2028}', '\u{2029}'] {
            assert!(!json.contains(raw), "{raw:?} in {json}");
        }
        assert!(json.contains(r"\u003c/script\u003e\u003c!-- \u0026 \u2028\u2029"), "{json}");
        assert_eq!(serde_json::from_str::<InitialState>(&json).unwrap(), initial);
        assert!(json.starts_with(r#"{"view":{"#), "{json}");

        let failed = InitialState { view: None, error: Some("database is locked".into()) };
        assert_eq!(failed.to_script_json(), r#"{"view":null,"error":"database is locked"}"#);
        assert_eq!(InitialState::default().to_script_json(), r#"{"view":null}"#);
    }

    #[test]
    fn view_urls_name_the_sort_and_encode_the_query() {
        assert_eq!(view_url(SortMode::RecentDesc, "", 0, 100, None), "/api/view?sort=recentDesc&q=&offset=0&limit=100");
        assert_eq!(
            view_url(SortMode::UnratedFirst, "a b&c/é", 200, 50, Some(42)),
            "/api/view?sort=unratedFirst&q=a%20b%26c%2F%C3%A9&offset=200&limit=50&around=42"
        );
        for mode in [SortMode::RecentDesc, SortMode::IdAsc, SortMode::TopPlayed, SortMode::UnratedFirst] {
            assert_eq!(SortMode::from_param(mode.param()), Some(mode));
        }
        assert_eq!(SortMode::from_param("recent"), None);
    }

    #[test]
    fn artwork_response_is_an_ordered_object() {
        let art = Artwork { small: Some("s".into()), medium: None, large: Some("l".into()) };
        let response = ArtworkResponse(vec![("b".into(), Some(art.clone())), ("a".into(), None)]);
        let json = serde_json::to_string(&response).unwrap();
        assert_eq!(json, r#"{"b":{"small":"s","medium":null,"large":"l"},"a":null}"#);
        assert_eq!(serde_json::from_str::<ArtworkResponse>(&json).unwrap(), response);
        assert_eq!((art.small_url(), art.large_url()), (Some("s"), Some("l")));
        let medium_only = Artwork { medium: Some("m".into()), ..Artwork::default() };
        assert_eq!((medium_only.small_url(), medium_only.large_url()), (Some("m"), Some("m")));
    }

    #[test]
    fn theme_cookie_round_trips() {
        assert_eq!(Theme::from_cookie_header("a=1; tracker-theme=dark; b=2"), Theme::Dark);
        assert_eq!(Theme::from_cookie_header("tracker-theme=light"), Theme::Light);
        assert_eq!(Theme::from_cookie_header("tracker-theme=purple"), Theme::Auto);
        assert_eq!(Theme::from_cookie_header("xtracker-theme=dark"), Theme::Auto);
        assert_eq!(Theme::from_cookie_header(""), Theme::Auto);
        assert_eq!(Theme::Dark.cookie(), "tracker-theme=dark; Path=/; Max-Age=31536000; SameSite=Strict");
        for theme in Theme::ALL {
            assert_eq!(Theme::parse(theme.as_str()), theme);
        }
    }
}
