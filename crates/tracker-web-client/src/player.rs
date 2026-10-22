//! In-page playback through Spotify's iFrame embed API. The embed plays full
//! tracks when the browser is signed in to a Spotify Premium account, and
//! 30-second previews otherwise; it needs no extra OAuth scopes, unlike the
//! Web Playback SDK.
//!
//! One embed is created on first use and kept for the life of the page, so
//! music keeps playing while you browse; playing another track loads it into
//! the same embed. This module is the client's only hand-written JavaScript
//! interop: the embed API is a JavaScript library loaded from Spotify.

use std::cell::RefCell;
use std::time::Duration;

use js_sys::{Function, Object, Promise, Reflect};
use leptos::html::Div;
use leptos::prelude::*;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

pub const IFRAME_API_URL: &str = "https://open.spotify.com/embed/iframe-api/v1";

/// The loader fetches more code from Spotify's CDN, and a failure there
/// never reaches the script's onerror, so a timeout turns a silent stall
/// into a visible error.
const LOAD_TIMEOUT: Duration = Duration::from_secs(10);

const LOAD_ERROR: &str = "Could not load the Spotify player. Check your internet connection and try again.";

#[wasm_bindgen]
extern "C" {
    /// The object Spotify passes to `window.onSpotifyIframeApiReady`.
    pub type IFrameApi;

    #[wasm_bindgen(method, js_name = createController)]
    fn create_controller(this: &IFrameApi, element: &web_sys::Element, options: &Object, callback: &Function);

    #[derive(Clone)]
    pub type EmbedController;

    #[wasm_bindgen(method, js_name = loadUri)]
    fn load_uri(this: &EmbedController, uri: &str);

    #[wasm_bindgen(method)]
    fn play(this: &EmbedController);

    #[wasm_bindgen(method, js_name = togglePlay)]
    fn toggle_play(this: &EmbedController);

    #[wasm_bindgen(method, js_name = addListener)]
    fn add_listener(this: &EmbedController, event: &str, listener: &Function);
}

thread_local! {
    /// The embed script, loaded once per page; cleared after a failure so
    /// the next play retries.
    static API: RefCell<Option<Promise>> = const { RefCell::new(None) };
}

/// Loads Spotify's embed script once per page.
async fn load_iframe_api() -> Result<IFrameApi, String> {
    let promise = API.with_borrow_mut(|api| api.get_or_insert_with(start_loading).clone());
    JsFuture::from(promise).await.map(JsCast::unchecked_into).map_err(|_| {
        API.with_borrow_mut(|api| *api = None);
        LOAD_ERROR.to_string()
    })
}

fn start_loading() -> Promise {
    Promise::new(&mut |resolve, reject| {
        let Some(window) = web_sys::window() else {
            let _ = reject.call0(&JsValue::NULL);
            return;
        };
        // Either the timer or the script's onerror can fire first, and both
        // may fire, so this closure outlives a single call.
        let fail = Closure::<dyn FnMut()>::new(move || {
            let _ = reject.call0(&JsValue::NULL);
        });
        let fail: Function = fail.into_js_value().unchecked_into();
        let timer = window
            .set_timeout_with_callback_and_timeout_and_arguments_0(&fail, LOAD_TIMEOUT.as_millis() as i32)
            .unwrap_or_default();
        let ready_window = window.clone();
        let ready = Closure::once_into_js(move |api: JsValue| {
            ready_window.clear_timeout_with_handle(timer);
            let _ = resolve.call1(&JsValue::NULL, &api);
        });
        let _ = Reflect::set(&window, &"onSpotifyIframeApiReady".into(), &ready);

        let Some(document) = window.document() else { return };
        let Ok(script) = document.create_element("script") else { return };
        let _ = script.set_attribute("src", IFRAME_API_URL);
        let _ = Reflect::set(&script, &"async".into(), &JsValue::TRUE);
        let error_window = window.clone();
        let on_error = Closure::once_into_js(move || {
            error_window.clear_timeout_with_handle(timer);
            let _ = fail.call0(&JsValue::NULL);
        });
        let _ = Reflect::set(&script, &"onerror".into(), &on_error);
        if let Some(head) = document.head() {
            let _ = head.append_child(&script);
        }
    })
}

pub fn track_uri(spotify_id: &str) -> String {
    format!("spotify:track:{spotify_id}")
}

/// What the page shows about playback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlayerState {
    /// The Spotify ID loaded in the embed, if any.
    pub loaded_id: Option<String>,
    pub is_paused: bool,
    pub error: Option<String>,
}

/// The embed and its state. Copy, so event handlers can share it.
#[derive(Clone, Copy)]
pub struct Player {
    pub state: RwSignal<PlayerState>,
    /// Where the embed lives; attach to an element that stays mounted.
    pub slot: NodeRef<Div>,
    controller: StoredValue<Option<EmbedController>, LocalStorage>,
    loaded_id: StoredValue<Option<String>>,
    /// Play once the embed reports ready: calling play() before a freshly
    /// loaded track is ready is silently ignored by the embed.
    play_when_ready: StoredValue<bool>,
}

impl Player {
    pub fn new() -> Player {
        Player {
            state: RwSignal::new(PlayerState { loaded_id: None, is_paused: true, error: None }),
            slot: NodeRef::new(),
            controller: StoredValue::new_local(None),
            loaded_id: StoredValue::new(None),
            play_when_ready: StoredValue::new(false),
        }
    }

    /// Plays a track, or toggles pause when it is already loaded.
    pub fn play(self, spotify_id: &str) {
        let has_controller = self.controller.with_value(|controller| {
            let controller = controller.as_ref()?;
            if self.loaded_id.with_value(|loaded| loaded.as_deref() == Some(spotify_id)) {
                controller.toggle_play();
            } else {
                self.start(spotify_id);
                controller.load_uri(&track_uri(spotify_id));
            }
            Some(())
        });
        if has_controller.is_some() {
            return;
        }
        let Some(element) = self.slot.get_untracked() else { return };
        self.start(spotify_id);
        // The API replaces the element it is given, so hand it a child and
        // keep the slot the view owns intact.
        let Some(host) = web_sys::window()
            .and_then(|window| window.document())
            .and_then(|document| document.create_element("div").ok())
        else {
            return;
        };
        element.replace_children_with_node_1(&host);
        let uri = track_uri(spotify_id);
        leptos::task::spawn_local(async move {
            match load_iframe_api().await {
                Ok(api) => self.create(&api, &host, &uri),
                Err(error) => self.state.update(|state| state.error = Some(error)),
            }
        });
    }

    fn start(self, spotify_id: &str) {
        self.loaded_id.set_value(Some(spotify_id.to_string()));
        self.play_when_ready.set_value(true);
        self.state.update(|state| {
            state.loaded_id = Some(spotify_id.to_string());
            state.error = None;
        });
    }

    fn create(self, api: &IFrameApi, host: &web_sys::Element, uri: &str) {
        let options = Object::new();
        let _ = Reflect::set(&options, &"uri".into(), &uri.into());
        let _ = Reflect::set(&options, &"width".into(), &"100%".into());
        let _ = Reflect::set(&options, &"height".into(), &152.into());
        let created = Closure::once_into_js(move |controller: EmbedController| {
            let ready_controller = controller.clone();
            let ready = Closure::<dyn FnMut()>::new(move || {
                if self.play_when_ready.get_value() {
                    self.play_when_ready.set_value(false);
                    ready_controller.play();
                }
            });
            controller.add_listener("ready", ready.as_ref().unchecked_ref());
            let update = Closure::<dyn FnMut(JsValue)>::new(move |update: JsValue| {
                let is_paused = Reflect::get(&update, &"data".into())
                    .and_then(|data| Reflect::get(&data, &"isPaused".into()))
                    .map(|paused| paused.is_truthy())
                    .unwrap_or(true);
                if self.state.with_untracked(|state| state.is_paused != is_paused) {
                    self.state.update(|state| state.is_paused = is_paused);
                }
            });
            controller.add_listener("playback_update", update.as_ref().unchecked_ref());
            // The embed lives as long as the page, and so do its listeners.
            ready.forget();
            update.forget();
            self.controller.set_value(Some(controller));
        });
        api.create_controller(host, &options, created.unchecked_ref());
    }
}
