//! The web UI root: the same state machine as the terminal UI, drawn with
//! DOM elements instead of a character grid, over a list the server sorts,
//! filters, and sends a window at a time ([`tracker_app::WebModel`]). Keys
//! reach the model exactly as they do in the terminal; clicks and form
//! fields send the pointer messages the model defines for them; and the
//! model's commands run as fetches against the local server.
//!
//! The server renders this component to HTML for the first screen, and the
//! browser hydrates that markup, so both must render the same initial state
//! identically: nothing here reads the browser during render (effects,
//! which only run in the browser, do that).

use leptos::ev;
use leptos::html::Input;
use leptos::prelude::*;
use tracker_app::api::{InitialState, Theme};
use tracker_app::presenter::{self, LOADING_TEXT, NO_TRACKS_TEXT, SUBTITLE, Screen, TITLE};
use tracker_app::{Cmd, KeyPress, Msg, Services, ViewKind, WebModel};
use wasm_bindgen::JsCast;

use crate::artwork::ArtworkStore;
use crate::deps::HttpDeps;
use crate::footer::Footer;
use crate::keys::{self, Modifiers, Target};
use crate::player::{Player, track_uri};
use crate::theme::ThemeSwitch;
use crate::track_details::TrackDetails;
use crate::track_list::TrackList;

/// Elements that take typed text; radios and buttons don't, so the model's
/// keys still work on them.
const TEXT_ENTRY: &str =
    r#"textarea, select, input:not([type="radio"]):not([type="checkbox"]):not([type="button"]):not([type="submit"])"#;
const CONTROL: &str = r#"button, a, [role="radio"], input"#;

/// What a key event was aimed at, for [`keys::routes_to_model`].
fn target_of(event: &web_sys::KeyboardEvent) -> Target {
    let Some(element) = event.target().and_then(|target| target.dyn_into::<web_sys::Element>().ok()) else {
        return Target::default();
    };
    let inside = |selector| element.closest(selector).ok().flatten().is_some();
    Target {
        text_entry: inside(TEXT_ENTRY),
        control: inside(CONTROL),
        radio_input: element.matches(r#"input[type="radio"]"#).unwrap_or(false),
    }
}

/// The model and what runs its commands.
#[derive(Clone, Copy)]
struct Runtime {
    model: RwSignal<WebModel>,
    deps: StoredValue<HttpDeps>,
    store: ArtworkStore,
}

impl Runtime {
    /// Feeds a message to the model and runs the command it returns.
    fn dispatch(self, msg: Msg) {
        // What is on screen never changes the page, only which rows get
        // fetched next, so it does not re-render anything.
        let cmd = if matches!(msg, Msg::Viewport { .. }) {
            self.model.try_update_untracked(|model| model.update(msg))
        } else {
            self.model.try_update(|model| model.update(msg))
        };
        if let Some(Some(cmd)) = cmd {
            self.run(cmd);
        }
    }

    /// Carries out a command as a fetch; its result comes back as a message.
    fn run(self, cmd: Cmd) {
        let http = self.deps.get_value();
        leptos::task::spawn_local(async move {
            let msg = match cmd {
                // Quitting a browser tab is the browser's job, and the web
                // list loads through FetchView.
                Cmd::Quit | Cmd::LoadTracks => return,
                Cmd::FetchView(request) => {
                    let reloaded = match request.kind {
                        ViewKind::Reload => http.reload().await.map(drop),
                        _ => Ok(()),
                    };
                    let result = match reloaded {
                        Ok(()) => http.view(&request.url()).await,
                        Err(err) => Err(err),
                    };
                    if let Ok(view) = &result {
                        self.store.seed(&view.rows);
                    }
                    Msg::ViewLoaded { request, result }
                }
                Cmd::Sync => Msg::SyncFinished(http.sync().await),
                Cmd::SaveRating(params) => {
                    let track_id = params.track_id;
                    Msg::RatingSaved { track_id, result: http.save_rating(&params).await }
                }
            };
            self.dispatch(msg);
        });
    }
}

#[component]
pub fn WebApp(
    /// What the server rendered the page from.
    initial: InitialState,
    /// The appearance the page was rendered with.
    theme: Theme,
    deps: HttpDeps,
    /// From the page's presence stream: true while the server looks stopped.
    server_stopped: Signal<bool>,
) -> impl IntoView {
    let store = ArtworkStore::new();
    if let Some(view) = &initial.view {
        store.seed(&view.rows);
    }
    provide_context(store);
    #[allow(unused_mut)]
    let mut start = WebModel::from_initial(Services::ALL, initial);
    #[cfg(target_arch = "wasm32")]
    {
        start.time_zone = tracker_app::Zone::Offset(crate::deps::local_offset);
    }
    let model = RwSignal::new(start);
    let runtime = Runtime { model, deps: StoredValue::new(deps), store };
    let player = Player::new();
    let theme = RwSignal::new(theme);
    let search_ref = NodeRef::<Input>::new();

    let screen = Memo::new(move |_| model.with(presenter::screen));
    let searching = Memo::new(move |_| model.with(|m| m.searching));
    let selected_spotify_id =
        Memo::new(move |_| model.with(|m| m.selected_track().map(|track| track.spotify_id.clone())));

    // Web-only actions ride on keys the model doesn't use ('p', 'a'); every
    // other message goes to the shared state machine.
    let send = Callback::new(move |msg: Msg| {
        if let Msg::Key(key) = &msg
            && model.with_untracked(|m| !m.editing_rating && !m.searching)
            && let Some(spotify_id) = selected_spotify_id.get_untracked()
        {
            match key.name.as_str() {
                "p" => return player.play(&spotify_id),
                "a" => {
                    if let Some(window) = web_sys::window() {
                        let _ = window.location().set_href(&track_uri(&spotify_id));
                    }
                    return;
                }
                _ => {}
            }
        }
        runtime.dispatch(msg);
    });

    // The page was rendered while the library was still loading: fetch it
    // now, like Bubble Tea's Init. (Effects run only in the browser.)
    Effect::new(move |_| {
        if let Some(Some(cmd)) = model.try_update_untracked(|m| if m.loading_tracks { m.init() } else { None }) {
            runtime.run(cmd);
        }
    });

    let keydown = window_event_listener(ev::keydown, move |event| {
        let modifiers = Modifiers {
            ctrl: event.ctrl_key(),
            meta: event.meta_key(),
            alt: event.alt_key(),
            shift: event.shift_key(),
        };
        let Some(key) = keys::key_press(&event.key(), modifiers) else { return };
        let (editing, searching) = model.with_untracked(|m| (m.editing_rating, m.searching));
        if !keys::routes_to_model(&key, target_of(&event), editing, searching) {
            return;
        }
        event.prevent_default();
        send.run(Msg::Key(key));
    });
    on_cleanup(move || keydown.remove());

    // '/' opens search in the model; give the field focus to match. Enter
    // or Esc closes it; hand focus back to the page so j/k work again.
    Effect::new(move |_| {
        let searching = searching.get();
        let Some(input) = search_ref.get() else { return };
        let active =
            web_sys::window().and_then(|window| window.document()).and_then(|document| document.active_element());
        let focused = active.as_deref() == Some(input.as_ref());
        if searching && !focused {
            let _ = input.focus();
        } else if !searching && focused {
            let _ = input.blur();
        }
    });

    // The selected track's art, ahead of the list's own requests.
    Effect::new(move |_| {
        if let Some(spotify_id) = selected_spotify_id.get() {
            store.request([spotify_id.as_str()]);
        }
    });

    let panes = Memo::new(move |_| matches!(screen.get(), Screen::Browse | Screen::NoMatch));
    view! {
        <div class="app">
            <header class="masthead">
                <div>
                    <h1>{TITLE}</h1>
                    <p class="muted">{SUBTITLE}</p>
                </div>
                <ThemeSwitch theme=theme />
            </header>

            <main class="body">
                {move || match screen.get() {
                    Screen::Loading => view! { <p class="notice">{LOADING_TEXT}</p> }.into_any(),
                    Screen::Error => {
                        view! {
                            <div class="notice">
                                <p class="error">{move || model.with(presenter::error_text)}</p>
                                <button
                                    type="button"
                                    class="button"
                                    on:click=move |_| send.run(Msg::Key(KeyPress::typed('r')))
                                >
                                    "Retry"
                                </button>
                            </div>
                        }
                            .into_any()
                    }
                    Screen::Empty => view! { <p class="notice muted">{NO_TRACKS_TEXT}</p> }.into_any(),
                    Screen::Browse | Screen::NoMatch => ().into_any(),
                }}
                <Show when=move || panes.get()>
                    <div class="panes">
                        <TrackList model=model send=send search_ref=search_ref />
                        <Show
                            when=move || screen.get() == Screen::Browse
                            fallback=move || {
                                view! {
                                    <section class="pane pane--detail">
                                        <p class="muted">{move || model.with(presenter::no_match_text)}</p>
                                    </section>
                                }
                            }
                        >
                            <TrackDetails model=model send=send player=player />
                        </Show>
                    </div>
                </Show>
                // Mounted once and never moved, so playback survives browsing.
                <div
                    class=move || {
                        if player.state.with(|state| state.loaded_id.is_none()) { "player player--idle" } else { "player" }
                    }
                    aria-label="Spotify player"
                >
                    <div node_ref=player.slot></div>
                </div>
            </main>

            <Show when=move || !matches!(screen.get(), Screen::Loading | Screen::Error)>
                <Footer model=model send=send server_stopped=server_stopped />
            </Show>
        </div>
    }
}
