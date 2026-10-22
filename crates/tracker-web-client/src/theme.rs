//! Light/dark appearance. "Auto" follows the operating system; an explicit
//! choice is remembered in a cookie, which the server reads to set
//! `data-theme` on the page it serves, so the page never flashes the wrong
//! theme and needs no boot script.

use leptos::prelude::*;
use tracker_app::api::Theme;
use wasm_bindgen::JsCast;

/// The theme the server rendered the page with.
pub fn current_theme() -> Theme {
    document_element()
        .and_then(|root| root.get_attribute("data-theme"))
        .map_or(Theme::Auto, |value| Theme::parse(&value))
}

fn document_element() -> Option<web_sys::Element> {
    web_sys::window()?.document()?.document_element()
}

/// Applies a choice now and remembers it for the next page load.
pub fn apply_theme(theme: Theme) {
    if let Some(root) = document_element() {
        let _ = root.set_attribute("data-theme", theme.as_str());
    }
    if let Some(document) = web_sys::window().and_then(|window| window.document()) {
        let _ = document.unchecked_into::<web_sys::HtmlDocument>().set_cookie(&theme.cookie());
    }
}

#[component]
pub fn ThemeSwitch(theme: RwSignal<Theme>) -> impl IntoView {
    view! {
        <fieldset class="theme-switch">
            <legend class="visually-hidden">"Appearance"</legend>
            {Theme::ALL
                .into_iter()
                .map(|choice| {
                    view! {
                        <label class="theme-switch__option">
                            <input
                                type="radio"
                                name="theme"
                                value=choice.as_str()
                                // The attribute for the server-rendered page, the
                                // property once the browser owns the state.
                                checked=move || theme.get() == choice
                                prop:checked=move || theme.get() == choice
                                on:change=move |_| {
                                    apply_theme(choice);
                                    theme.set(choice);
                                }
                            />
                            <span>{choice.label()}</span>
                        </label>
                    }
                })
                .collect_view()}
        </fieldset>
    }
}
