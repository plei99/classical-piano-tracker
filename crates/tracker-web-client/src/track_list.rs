//! The list pane. Rows are windowed (only those near the viewport exist in
//! the DOM) so a 25,000-track library scrolls as smoothly as a 500-track
//! one, the same reason the terminal UI only formats its visible rows. The
//! list is as tall as every matching track from the start; a row the
//! server has not sent yet is a placeholder of the same height, and the
//! model fetches ahead of the viewport so scrolling seldom shows one.

use leptos::either::Either;
use leptos::html::{Div, Input};
use leptos::prelude::*;
use tracker_app::presenter::{self, TRACKS_HEADING};
use tracker_app::{KeyPress, Msg, TrackList as _, WebModel};
use wasm_bindgen::JsCast;
use wasm_bindgen::closure::Closure;

use crate::artwork::ArtworkStore;
use crate::cover::{Cover, CoverSize};

/// Row height in CSS pixels, an integer so styles never format a float.
pub const ROW_PX: usize = 60;
pub const ROW_HEIGHT: f64 = ROW_PX as f64;
const OVERSCAN: usize = 6;

/// One rendered row. Rows are keyed by their content, so an element
/// survives scrolling, sorting, and selection changes.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct RowData {
    /// The track ID, or for a row not loaded yet minus its position plus
    /// one, so placeholders have keys of their own.
    id: i64,
    spotify_id: String,
    track_name: String,
    artists: String,
    album_name: String,
}

impl RowData {
    fn placeholder(index: usize) -> RowData {
        RowData {
            id: -(index as i64) - 1,
            spotify_id: String::new(),
            track_name: String::new(),
            artists: String::new(),
            album_name: String::new(),
        }
    }

    fn is_placeholder(&self) -> bool {
        self.id < 0
    }
}

/// The rows near the viewport, plus the selected row wherever it is, and
/// their positions in the filtered list.
#[derive(Debug, Clone, PartialEq)]
struct Shown {
    /// The viewport's rows, `first..last`.
    first: usize,
    last: usize,
    rows: Vec<RowData>,
    /// Each row's position, in the same order as `rows`.
    indexes: Vec<usize>,
}

impl Shown {
    fn index_of(&self, id: i64) -> Option<usize> {
        self.rows.iter().position(|row| row.id == id).map(|offset| self.indexes[offset])
    }
}

/// The track whose row an event happened in; none for placeholders.
fn clicked_track(event: &web_sys::MouseEvent) -> Option<i64> {
    let target = event.target()?.dyn_into::<web_sys::Element>().ok()?;
    let row = target.closest("li.row[id]").ok()??;
    track_id_of(&row.id())
}

/// The track ID in a row's element ID (`track-<id>`).
fn track_id_of(element_id: &str) -> Option<i64> {
    element_id.strip_prefix("track-")?.parse().ok()
}

/// The index range to render for a viewport.
pub fn window_range(len: usize, scroll_top: f64, height: f64) -> (usize, usize) {
    let first = ((scroll_top / ROW_HEIGHT).floor() as usize).saturating_sub(OVERSCAN);
    let last = ((((scroll_top + height) / ROW_HEIGHT).ceil() as usize) + OVERSCAN).min(len);
    (first.min(last), last)
}

#[component]
pub fn TrackList(model: RwSignal<WebModel>, send: Callback<Msg>, search_ref: NodeRef<Input>) -> impl IntoView {
    let store = expect_context::<ArtworkStore>();
    let viewport = NodeRef::<Div>::new();
    let scroll_top = RwSignal::new(0.0);
    let height = RwSignal::new(600.0);

    Effect::new(move |observer: Option<Option<web_sys::ResizeObserver>>| {
        if let Some(observer) = observer {
            return observer;
        }
        let element = viewport.get()?;
        let measured = element.clone();
        let resized = Closure::<dyn FnMut()>::new(move || height.set(f64::from(measured.client_height())));
        let observer = web_sys::ResizeObserver::new(resized.as_ref().unchecked_ref()).ok()?;
        observer.observe(&element);
        resized.forget();
        height.set(f64::from(element.client_height()));
        Some(observer)
    });

    // Keep the selection in view, the way the terminal's window follows it.
    // Rows arriving do not count: they must not pull a scrolled list back.
    let selection = Memo::new(move |_| {
        model.with(|m| (m.selected_index, m.shown_sort_mode(), m.shown_query().to_string(), m.list.len()))
    });
    Effect::new(move |_| {
        let (selected_index, len) = selection.with(|selection| (selection.0, selection.3));
        let Some(element) = viewport.get() else { return };
        // The scroll position and height as the scroll event and the resize
        // observer last reported them: reading the element's would force a
        // layout in the middle of handling the key.
        let (scroll, client_height) = (scroll_top.get_untracked(), height.get_untracked());
        let row_top = selected_index as f64 * ROW_HEIGHT;
        let target = if row_top < scroll {
            row_top
        } else if row_top + ROW_HEIGHT > scroll + client_height {
            row_top + ROW_HEIGHT - client_height
        } else {
            return;
        };
        let target = target.min(len as f64 * ROW_HEIGHT - client_height).max(0.0).round();
        element.set_scroll_top(target as i32);
        // Window the rows now rather than on the scroll event, which the
        // browser only fires with its next frame: a jump shows the selected
        // row at once, and the scroll event then finds nothing to do.
        scroll_top.set(target);
    });

    let shown = Memo::new(move |_| {
        let (scroll_top, height) = (scroll_top.get(), height.get());
        model.with(|m| {
            let len = m.list.len();
            let (first, last) = window_range(len, scroll_top, height);
            let mut indexes: Vec<usize> = (first..last).collect();
            // The selection is always in the DOM: after a jump it shows (and
            // is the listbox's active descendant) before the scroll event
            // moves the window, and it stays when the list scrolls away.
            if m.selected_index < len && !(first..last).contains(&m.selected_index) {
                indexes.push(m.selected_index);
            }
            let rows = indexes
                .iter()
                .map(|&index| match m.list.row(index) {
                    Some(row) => RowData {
                        id: row.track.id,
                        spotify_id: row.track.spotify_id.clone(),
                        track_name: row.track.track_name.clone(),
                        artists: row.artists.clone(),
                        album_name: row.track.album_name.clone(),
                    },
                    None => RowData::placeholder(index),
                })
                .collect();
            Shown { first, last, rows, indexes }
        })
    });
    Effect::new(move |_| shown.with(|shown| store.request(shown.rows.iter().map(|row| row.spotify_id.as_str()))));
    // Keep the rows around the viewport loaded.
    let range = Memo::new(move |_| shown.with(|shown| (shown.first, shown.last)));
    Effect::new(move |_| {
        let (first, last) = range.get();
        send.run(Msg::Viewport { first, last });
    });

    let selected_index = Memo::new(move |_| model.with(|m| m.selected_index));
    let summary = Memo::new(move |_| model.with(presenter::track_list_summary));
    let searching = Memo::new(move |_| model.with(|m| m.searching));
    let query = Memo::new(move |_| model.with(|m| m.search_query.clone()));
    let active = Memo::new(move |_| model.with(|m| m.selected_track().map(|track| format!("track-{}", track.id))));
    let list_height = Memo::new(move |_| model.with(|m| m.list.len() * ROW_PX));

    let row = move |row: RowData| {
        let id = row.id;
        let index = Memo::new(move |_| shown.with(|shown| shown.index_of(id)));
        let top = move || format!("translateY({}px)", index.get().unwrap_or(0) * ROW_PX);
        let selected = move || index.get().is_some_and(|index| index == selected_index.get());
        if row.is_placeholder() {
            return Either::Left(view! {
                <li
                    role="option"
                    aria-selected=move || if selected() { "true" } else { "false" }
                    aria-busy="true"
                    aria-label="Loading"
                    class="row row--placeholder"
                    style:transform=top
                >
                    <div class="cover cover--small cover--empty" aria-hidden="true"></div>
                </li>
            });
        }
        let spotify_id = row.spotify_id.clone();
        let url = Memo::new(move |_| store.url(&spotify_id, false));
        Either::Right(view! {
            <li
                id=format!("track-{id}")
                role="option"
                aria-selected=move || if selected() { "true" } else { "false" }
                class=move || if selected() { "row row--selected" } else { "row" }
                style:transform=top
            >
                <Cover url=url size=CoverSize::Small album_name=row.album_name.clone() />
                <span class="row__id">{id}</span>
                <span class="row__title">{row.track_name}</span>
                <span class="row__artists">{row.artists}</span>
            </li>
        })
    };

    view! {
        <section class="pane pane--list" aria-labelledby="tracks-heading">
            <header class="pane__header">
                <h2 id="tracks-heading">{TRACKS_HEADING}</h2>
                <p class="muted">{summary}</p>
                <label class=move || {
                    if searching.get() || !query.with(String::is_empty) { "search search--active" } else { "search" }
                }>
                    <span class="keycap" aria-hidden="true">
                        "/"
                    </span>
                    <input
                        node_ref=search_ref
                        type="search"
                        placeholder="Search titles, artists, albums"
                        aria-label="Search tracks"
                        prop:value=query
                        on:focus=move |_| {
                            if !searching.get_untracked() {
                                send.run(Msg::Key(KeyPress::typed('/')));
                            }
                        }
                        on:blur=move |_| {
                            if searching.get_untracked() {
                                send.run(Msg::Key(KeyPress::named("enter")));
                            }
                        }
                        on:input=move |event| send.run(Msg::SetSearch(event_target_value(&event)))
                    />
                </label>
            </header>
            <div
                node_ref=viewport
                class="list-viewport"
                on:scroll=move |_| {
                    if let Some(element) = viewport.get_untracked() {
                        scroll_top.set(f64::from(element.scroll_top()));
                    }
                }
            >
                // One pair of listeners for every row, as React delegates
                // events: rows come and go as the list scrolls, and
                // attaching listeners to each costs more than the lookup.
                <ul
                    class="rows"
                    role="listbox"
                    aria-label="Tracks"
                    aria-activedescendant=active
                    style:height=move || format!("{}px", list_height.get())
                    on:click=move |event| {
                        if let Some(id) = clicked_track(&event) {
                            send.run(Msg::Select { track_id: id });
                        }
                    }
                    on:dblclick=move |event| {
                        if let Some(id) = clicked_track(&event) {
                            send.run(Msg::Select { track_id: id });
                            send.run(Msg::Key(KeyPress::typed('e')));
                        }
                    }
                >
                    <For each=move || shown.get().rows key=|row| row.clone() children=row />
                </ul>
            </div>
        </section>
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_track_ids_from_row_element_ids() {
        assert_eq!(track_id_of("track-42"), Some(42));
        assert_eq!(track_id_of("track-"), None);
        assert_eq!(track_id_of("tracks-heading"), None);
    }

    #[test]
    fn windows_the_rows_near_the_viewport() {
        assert_eq!(window_range(0, 0.0, 600.0), (0, 0));
        assert_eq!(window_range(543, 0.0, 600.0), (0, 16));
        // Scrolled to row 100 with 10 rows visible: 6 rows of overscan each way.
        assert_eq!(window_range(543, 6000.0, 600.0), (94, 116));
        assert_eq!(window_range(543, 6030.0, 600.0), (94, 117));
        assert_eq!(window_range(120, 6900.0, 600.0), (109, 120));
    }
}
