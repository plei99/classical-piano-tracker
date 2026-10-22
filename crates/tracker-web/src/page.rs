//! The first screen of `GET /`, rendered on the server into `#root`: the
//! markup the browser client's components (web/src/client) produce for the
//! page's initial state, so the browser shows rows before any script runs and
//! the client adopts this markup as it is. Each function below mirrors one
//! component; the strings and decisions come from the shared presenter.
//!
//! The two must stay identical, character for character: the fixtures in
//! web/test/pages are rendered by the client's components into golden files
//! (`npm test` in web/), and the tests here render the same fixtures and
//! compare against those goldens.

use std::collections::HashMap;
use std::fmt::Write as _;

use tracker_app::api::{Artwork, InitialState, Theme, ViewResponse};
use tracker_app::presenter::{self, RatingView, Screen};
use tracker_app::{BrowserModel, Services, SortMode, TrackList, TrackRow, TracksLoaded, Zone};
use tracker_core::Rating;

/// The list's row height and the viewport the first screen assumes (the
/// client's ROW_HEIGHT and INITIAL_HEIGHT), and the rows drawn beyond it.
const ROW_HEIGHT: usize = 60;
const INITIAL_HEIGHT: usize = 600;
const OVERSCAN: usize = 6;

/// Keys only the web UI has, shown after the model's while browsing (the
/// client's WEB_HINTS).
const WEB_HINTS: [(&str, &str); 2] = [("p", "play"), ("a", "open in Spotify")];

/// `#root`'s markup for a page rendered from `initial`, with times in `zone`.
pub fn render_app(initial: &InitialState, theme: Theme, zone: Zone) -> String {
    let art: HashMap<&str, Option<&Artwork>> = initial
        .view
        .iter()
        .flat_map(|view| &view.rows)
        .filter_map(|row| row.art.as_ref().map(|art| (row.track.spotify_id.as_str(), art.as_ref())))
        .collect();
    let mut model = PageModel { services: Services::ALL, time_zone: zone, ..PageModel::default() };
    match (&initial.view, &initial.error) {
        (Some(view), _) => {
            model.list = PageList::new(view);
            model.selected_index = view.index.unwrap_or(0);
        }
        (None, Some(error)) => model.err = Some(error.clone()),
        (None, None) => model.loading_tracks = true,
    }
    let mut html = Html(String::with_capacity(16 * 1024));
    web_app(&mut html, &model, &art, theme);
    html.0
}

/// Art the page was sent with, by Spotify ID: absent while unknown, `None`
/// when the track has none.
type ArtLookup<'a> = HashMap<&'a str, Option<&'a Artwork>>;

/// The model a page starts from: the client's starting state (newest
/// first, no search, the first row selected) over the window it was sent.
type PageModel = BrowserModel<PageList>;

/// The rows a page is sent: a window of the sorted list; the rest are not
/// loaded yet.
#[derive(Default)]
struct PageList {
    matched: usize,
    total: usize,
    offset: usize,
    rows: Vec<TrackRow>,
    ratings: HashMap<i64, Rating>,
}

impl PageList {
    fn new(view: &ViewResponse) -> PageList {
        PageList {
            matched: view.matched,
            total: view.total,
            offset: view.offset,
            rows: view
                .rows
                .iter()
                .map(|row| TrackRow { artists: row.artists.clone(), ..TrackRow::new(row.track.clone()) })
                .collect(),
            ratings: view.rows.iter().filter_map(|row| Some((row.track.id, row.rating.clone()?))).collect(),
        }
    }
}

impl TrackList for PageList {
    fn len(&self) -> usize {
        self.matched
    }

    fn total(&self) -> usize {
        self.total
    }

    fn row(&self, index: usize) -> Option<&TrackRow> {
        self.rows.get(index.checked_sub(self.offset)?)
    }

    fn rating(&self, track_id: i64) -> Option<&Rating> {
        self.ratings.get(&track_id)
    }

    fn index_of(&self, track_id: i64) -> Option<usize> {
        self.rows.iter().position(|row| row.track.id == track_id).map(|position| self.offset + position)
    }

    // A page is rendered once: nothing re-sorts or loads it.
    fn refresh(&mut self, _sort: SortMode, _query: &str, selected: i64) -> Option<usize> {
        self.index_of(selected)
    }

    fn rating_saved(&mut self, _track_id: i64, _rating: Rating, _sort: SortMode) -> bool {
        false
    }

    fn tracks_loaded(&mut self, _loaded: TracksLoaded) {}
}

fn web_app(h: &mut Html, m: &PageModel, art: &ArtLookup<'_>, theme: Theme) {
    let current = presenter::screen(m);
    h.open("div", &[("class", Some("app"))]);
    h.open("header", &[("class", Some("masthead"))]);
    h.open("div", &[]);
    h.element("h1", &[], presenter::TITLE);
    h.element("p", &[("class", Some("muted"))], presenter::SUBTITLE);
    h.close("div");
    theme_switch(h, theme);
    h.close("header");

    h.open("main", &[("class", Some("body"))]);
    match current {
        Screen::Loading => h.element("p", &[("class", Some("notice"))], presenter::LOADING_TEXT),
        Screen::Error => {
            h.open("div", &[("class", Some("notice"))]);
            h.element("p", &[("class", Some("error"))], &presenter::error_text(m));
            h.element("button", &[("type", Some("button")), ("class", Some("button"))], "Retry");
            h.close("div");
        }
        Screen::Empty => h.element("p", &[("class", Some("notice muted"))], presenter::NO_TRACKS_TEXT),
        Screen::Browse | Screen::NoMatch => {
            h.open("div", &[("class", Some("panes"))]);
            track_list(h, m, art);
            if current == Screen::Browse {
                track_details(h, m, art);
            } else {
                h.open("section", &[("class", Some("pane pane--detail"))]);
                h.element("p", &[("class", Some("muted"))], &presenter::no_match_text(m));
                h.close("section");
            }
            h.close("div");
        }
    }
    h.open("div", &[("aria-label", Some("Spotify player")), ("class", Some("player player--idle"))]);
    h.open("div", &[]);
    h.close("div");
    h.close("div");
    h.close("main");

    if current != Screen::Loading && current != Screen::Error {
        footer(h, m);
    }
    h.close("div");
}

fn theme_switch(h: &mut Html, theme: Theme) {
    h.open("fieldset", &[("class", Some("theme-switch"))]);
    h.element("legend", &[("class", Some("visually-hidden"))], "Appearance");
    for choice in Theme::ALL {
        h.open("label", &[("class", Some("theme-switch__option"))]);
        let checked = (choice == theme).then_some("");
        h.void(
            "input",
            &[("type", Some("radio")), ("name", Some("theme")), ("value", Some(choice.as_str())), ("checked", checked)],
        );
        h.element("span", &[], choice.label());
        h.close("label");
    }
    h.close("fieldset");
}

fn track_list(h: &mut Html, m: &PageModel, art: &ArtLookup<'_>) {
    let count = m.list.len();
    let searching = m.searching || !m.search_query.is_empty();
    h.open("section", &[("aria-labelledby", Some("tracks-heading")), ("class", Some("pane pane--list"))]);
    h.open("header", &[("class", Some("pane__header"))]);
    h.element("h2", &[("id", Some("tracks-heading"))], presenter::TRACKS_HEADING);
    h.element("p", &[("class", Some("muted"))], &presenter::track_list_summary(m));
    h.open("label", &[("class", Some(if searching { "search search--active" } else { "search" }))]);
    h.element("span", &[("aria-hidden", Some("true")), ("class", Some("keycap"))], "/");
    h.void(
        "input",
        &[
            ("type", Some("search")),
            ("placeholder", Some("Search titles, artists, albums")),
            ("aria-label", Some("Search tracks")),
            ("value", Some(&m.search_query)),
        ],
    );
    h.close("label");
    h.close("header");

    h.open("div", &[("class", Some("list-viewport"))]);
    let active = m.list.row(m.selected_index).map(|row| format!("track-{}", row.track.id));
    let height = format!("height:{}px;", count * ROW_HEIGHT);
    h.open(
        "ul",
        &[
            ("role", Some("listbox")),
            ("aria-label", Some("Tracks")),
            ("aria-activedescendant", active.as_deref()),
            ("style", Some(&height)),
            ("class", Some("rows")),
        ],
    );
    // The window the client draws at scroll position 0, plus the selection
    // wherever it is.
    let last = count.min(INITIAL_HEIGHT.div_ceil(ROW_HEIGHT) + OVERSCAN);
    let mut indexes: Vec<usize> = (0..last).collect();
    if m.selected_index < count && m.selected_index >= last {
        indexes.push(m.selected_index);
    }
    for index in indexes {
        let selected = if index == m.selected_index { "true" } else { "false" };
        let top = format!("transform:translateY({}px);", index * ROW_HEIGHT);
        let Some(row) = m.list.row(index) else {
            h.open(
                "li",
                &[
                    ("role", Some("option")),
                    ("aria-selected", Some(selected)),
                    ("aria-busy", Some("true")),
                    ("aria-label", Some("Loading")),
                    ("style", Some(&top)),
                    ("class", Some("row row--placeholder")),
                ],
            );
            h.open("div", &[("aria-hidden", Some("true")), ("class", Some("cover cover--small cover--empty"))]);
            h.close("div");
            h.close("li");
            continue;
        };
        let track = &row.track;
        h.open(
            "li",
            &[
                ("id", Some(&format!("track-{}", track.id))),
                ("role", Some("option")),
                ("aria-selected", Some(selected)),
                ("style", Some(&top)),
                ("class", Some(if index == m.selected_index { "row row--selected" } else { "row" })),
            ],
        );
        cover(h, art, &track.spotify_id, &track.album_name, CoverSize::Small);
        h.element("span", &[("class", Some("row__id"))], &track.id.to_string());
        h.element("span", &[("class", Some("row__title"))], &track.track_name);
        h.element("span", &[("class", Some("row__artists"))], &row.artists);
        h.close("li");
    }
    h.close("ul");
    h.close("div");
    h.close("section");
}

fn track_details(h: &mut Html, m: &PageModel, art: &ArtLookup<'_>) {
    let Some(details) = presenter::details(m) else {
        if m.list.is_empty() {
            h.open("section", &[("aria-label", Some("Track details")), ("class", Some("pane pane--detail"))]);
            h.element("h2", &[], presenter::DETAILS_HEADING);
            h.element("p", &[("class", Some("muted"))], presenter::NO_SELECTION_TEXT);
            h.close("section");
            return;
        }
        // The selected row is still on its way.
        h.open(
            "section",
            &[("aria-label", Some("Track details")), ("aria-busy", Some("true")), ("class", Some("pane pane--detail"))],
        );
        h.open("div", &[("class", Some("hero"))]);
        h.open("div", &[("aria-hidden", Some("true")), ("class", Some("cover cover--large cover--empty hero__cover"))]);
        h.close("div");
        h.open("div", &[("class", Some("hero__text"))]);
        h.element("h2", &[("class", Some("hero__title muted"))], presenter::LOADING_DETAILS_TEXT);
        h.close("div");
        h.close("div");
        h.close("section");
        return;
    };
    let track = details.track;
    h.open("section", &[("aria-label", Some("Track details")), ("class", Some("pane pane--detail"))]);
    h.open("div", &[("class", Some("hero"))]);
    cover(h, art, &track.spotify_id, &track.album_name, CoverSize::Large);
    h.open("div", &[("class", Some("hero__text"))]);
    h.element("h2", &[("class", Some("hero__title"))], &track.track_name);
    h.element("p", &[("class", Some("hero__artists"))], details.artists);
    h.element("p", &[("class", Some("hero__album"))], &track.album_name);
    h.open("div", &[("class", Some("hero__actions"))]);
    h.element(
        "button",
        &[("type", Some("button")), ("aria-pressed", Some("false")), ("class", Some("button button--primary"))],
        "Play",
    );
    let href = format!("spotify:track:{}", track.spotify_id);
    h.element("a", &[("href", Some(&href)), ("class", Some("button"))], "Open in Spotify");
    if !m.editing_rating {
        let label = if matches!(details.rating, RatingView::Rated(_)) { "Edit rating" } else { "Rate" };
        h.element("button", &[("type", Some("button")), ("class", Some("button"))], label);
    }
    h.close("div");
    h.close("div");
    h.close("div");

    // The rating editor never opens on a fresh page.
    h.open("section", &[("aria-label", Some("Rating")), ("class", Some("rating"))]);
    match details.rating {
        RatingView::Saving => h.element("p", &[("class", Some("muted"))], presenter::RATING_SAVING_TEXT),
        RatingView::Unrated => h.element("p", &[("class", Some("muted"))], presenter::RATING_NONE_TEXT),
        RatingView::Rated(rating) => {
            h.open("p", &[("class", Some("rating__stars"))]);
            let label = format!("{} out of 5 stars", rating.stars);
            h.open("span", &[("aria-label", Some(&label)), ("class", Some("stars"))]);
            for value in 1..=5 {
                let class = if value <= rating.stars { "star star--on" } else { "star" };
                h.element("span", &[("aria-hidden", Some("true")), ("class", Some(class))], "★");
            }
            h.close("span");
            h.text(" ");
            h.element("span", &[], &format!("{}/5", rating.stars));
            h.close("p");
            if !rating.opinion.is_empty() {
                h.element("blockquote", &[("class", Some("rating__opinion"))], &rating.opinion);
            }
            h.element("p", &[("class", Some("muted small"))], &presenter::updated_text(m, rating));
        }
    }
    h.close("section");
    h.open("dl", &[("class", Some("facts"))]);
    for field in &details.fields {
        h.open("div", &[("class", Some("facts__row"))]);
        h.element("dt", &[], field.label);
        h.element("dd", &[], &field.value);
        h.close("div");
    }
    h.close("dl");
    h.close("section");
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CoverSize {
    Small,
    Large,
}

fn cover(h: &mut Html, art: &ArtLookup<'_>, spotify_id: &str, album_name: &str, size: CoverSize) {
    let (url, mut classes) = match size {
        CoverSize::Small => {
            (art.get(spotify_id).copied().flatten().and_then(Artwork::small_url), "cover cover--small".to_string())
        }
        CoverSize::Large => (
            art.get(spotify_id).copied().flatten().and_then(Artwork::large_url),
            "cover cover--large hero__cover".to_string(),
        ),
    };
    match url {
        Some(url) => {
            let alt = format!("Cover of {album_name}");
            h.void(
                "img",
                &[
                    ("src", Some(url)),
                    ("alt", Some(&alt)),
                    ("loading", Some("lazy")),
                    ("decoding", Some("async")),
                    ("class", Some(&classes)),
                ],
            );
        }
        None => {
            classes.push_str(" cover--empty");
            h.open("div", &[("aria-hidden", Some("true")), ("class", Some(&classes))]);
            let initial = album_name.trim().chars().next().map_or_else(|| "♪".to_string(), String::from);
            h.element("span", &[], &initial);
            h.close("div");
        }
    }
}

fn footer(h: &mut Html, m: &PageModel) {
    let status = presenter::status(m);
    let is_error = status.as_ref().is_some_and(|status| status.is_error);
    h.open("footer", &[("class", Some("footer"))]);
    h.element(
        "p",
        &[
            ("role", Some("status")),
            ("aria-live", Some("polite")),
            ("class", Some(if is_error { "status status--error" } else { "status" })),
        ],
        status.as_ref().map_or("", |status| status.text.as_str()),
    );
    h.open("ul", &[("aria-label", Some("Keyboard shortcuts")), ("class", Some("hints"))]);
    let browsing = !m.editing_rating && !m.searching;
    let hints = presenter::hints(m)
        .iter()
        .filter(|hint| !hint.terminal_only)
        .map(|hint| (hint.keys, hint.label, hint.key.is_some()))
        .chain(WEB_HINTS.into_iter().filter(|_| browsing).map(|(keys, label)| (keys, label, true)));
    for (keys, label, action) in hints {
        h.open("li", &[]);
        if action {
            h.open("button", &[("type", Some("button")), ("class", Some("hint hint--action"))]);
        } else {
            h.open("span", &[("class", Some("hint"))]);
        }
        h.element("kbd", &[("class", Some("keycap"))], keys);
        h.text(" ");
        h.text(label);
        h.close(if action { "button" } else { "span" });
        h.close("li");
    }
    h.close("ul");
    h.close("footer");
}

/// Markup in the form preact-render-to-string writes it: attributes in the
/// components' order (with `class` last, where the client's renderer puts
/// it), `&`, `<`, and `"` escaped in text and attributes alike, empty and
/// boolean attributes as bare names, and void elements closed with `/>`.
struct Html(String);

type Attrs<'a> = [(&'a str, Option<&'a str>)];

impl Html {
    fn open(&mut self, tag: &str, attrs: &Attrs<'_>) {
        self.start(tag, attrs);
        self.0.push('>');
    }

    fn void(&mut self, tag: &str, attrs: &Attrs<'_>) {
        self.start(tag, attrs);
        self.0.push_str("/>");
    }

    fn close(&mut self, tag: &str) {
        let _ = write!(self.0, "</{tag}>");
    }

    fn element(&mut self, tag: &str, attrs: &Attrs<'_>, text: &str) {
        self.open(tag, attrs);
        self.text(text);
        self.close(tag);
    }

    fn text(&mut self, text: &str) {
        escape_into(&mut self.0, text);
    }

    fn start(&mut self, tag: &str, attrs: &Attrs<'_>) {
        self.0.push('<');
        self.0.push_str(tag);
        for (name, value) in attrs {
            let Some(value) = value else { continue };
            self.0.push(' ');
            self.0.push_str(name);
            if !value.is_empty() {
                self.0.push_str("=\"");
                escape_into(&mut self.0, value);
                self.0.push('"');
            }
        }
    }
}

fn escape_into(out: &mut String, text: &str) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use jiff::tz::TimeZone;
    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    struct Fixture {
        theme: String,
        initial: InitialState,
    }

    fn pages() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/test/pages")
    }

    /// Every fixture renders to the golden the client's components rendered.
    #[test]
    fn renders_the_first_screen_as_the_client_does() {
        let mut checked = 0;
        for entry in std::fs::read_dir(pages()).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let fixture: Fixture = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let html = render_app(&fixture.initial, Theme::parse(&fixture.theme), Zone::Tz(TimeZone::UTC)) + "\n";
            let golden = std::fs::read_to_string(path.with_extension("html")).unwrap();
            assert_eq!(html, golden, "{}", path.display());
            checked += 1;
        }
        assert!(checked > 5, "only {checked} fixtures");
    }
}
