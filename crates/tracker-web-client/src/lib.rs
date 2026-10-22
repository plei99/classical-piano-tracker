//! The `tracker web` browser client: Leptos components over the shared
//! track-browser state machine (`tracker_app`). The server renders them to
//! HTML for the first screen ([`render_app`], feature `ssr`); the browser
//! runs them compiled to WebAssembly and hydrates that markup ([`start`],
//! feature `hydrate`), embedded in the `tracker` binary by `tracker-web`'s
//! build script.
//!
//! Each module ports one file of the TypeScript build's React client, and
//! the DOM structure and class names match it, so the same stylesheet
//! applies unchanged.

mod app;
mod artwork;
mod cover;
mod deps;
mod footer;
pub mod keys;
mod player;
mod presence;
mod rating_editor;
mod theme;
mod track_details;
mod track_list;

/// Hydrates the server-rendered page in `#root`. Runs when the boot script
/// initializes the module, which is a deferred module script, so the page
/// has been parsed; only the `hydrate` build mounts anything.
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
    boot();
}

fn boot() {
    use wasm_bindgen::JsCast;

    let token = deps::page_token();
    // First thing, ahead of hydrating and so of any request.
    let server_stopped = presence::watch(&token);
    let root = web_sys::window()
        .and_then(|window| window.document())
        .and_then(|document| document.get_element_by_id("root"))
        .and_then(|root| root.dyn_into::<web_sys::HtmlElement>().ok());
    let Some(root) = root else { return };
    let initial = deps::initial_state();
    let theme = theme::current_theme();
    let deps = deps::HttpDeps::new(token);
    let server_stopped: leptos::prelude::Signal<bool> = server_stopped.into();
    #[cfg(feature = "hydrate")]
    leptos::mount::hydrate_from(root, move || leptos::view! { <app::WebApp initial theme deps server_stopped /> })
        .forget();
    #[cfg(not(feature = "hydrate"))]
    let _ = (root, initial, theme, deps, server_stopped);
}

/// The app's markup for `initial`, which the browser then hydrates: the
/// contents of `#root`.
#[cfg(feature = "ssr")]
pub fn render_app(initial: tracker_app::api::InitialState, theme: tracker_app::api::Theme) -> String {
    use std::sync::Arc;

    use leptos::prelude::*;

    // A server context, so browser-only helpers (window listeners) stand down.
    let owner = Owner::new_root(Some(Arc::new(hydration_context::SsrSharedContext::new())));
    let html = owner.with(|| {
        let deps = deps::HttpDeps::new(String::new());
        let server_stopped = Signal::stored(false);
        view! { <app::WebApp initial theme deps server_stopped /> }.to_html()
    });
    owner.cleanup();
    html
}
