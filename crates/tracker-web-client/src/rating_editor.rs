//! The rating editor, with the terminal's focus model: it opens on the stars
//! field, 1-5 sets stars and moves to the opinion, Tab switches fields,
//! Enter saves, Esc cancels. Clicks and the text field feed the same state
//! machine.

use leptos::html::{Div, Section, Textarea};
use leptos::prelude::*;
use tracker_app::presenter::{self, EDITOR_HELP, OPINION_LABEL};
use tracker_app::{EditorField, KeyPress, Msg, WebModel};

#[component]
pub fn RatingEditor(model: RwSignal<WebModel>, send: Callback<Msg>) -> impl IntoView {
    let section = NodeRef::<Section>::new();
    let stars_field = NodeRef::<Div>::new();
    let opinion = NodeRef::<Textarea>::new();
    let editing_opinion = Memo::new(move |_| model.with(|m| m.editing_opinion));
    let draft_stars = Memo::new(move |_| model.with(|m| m.draft_stars));
    let draft_opinion = Memo::new(move |_| model.with(|m| m.draft_opinion.clone()));
    let stars_label = Memo::new(move |_| model.with(presenter::stars_field_label));
    let key = move |name: &str| send.run(Msg::Key(KeyPress::named(name)));

    // The editor opens below the cover; bring all of it, buttons included,
    // into view.
    Effect::new(move |_| {
        if let Some(section) = section.get() {
            let options = web_sys::ScrollIntoViewOptions::new();
            options.set_block(web_sys::ScrollLogicalPosition::Nearest);
            section.scroll_into_view_with_scroll_into_view_options(&options);
        }
    });

    // Mirror the model's focused field into DOM focus.
    Effect::new(move |_| {
        let options = web_sys::FocusOptions::new();
        options.set_prevent_scroll(true);
        let active =
            web_sys::window().and_then(|window| window.document()).and_then(|document| document.active_element());
        if editing_opinion.get() {
            let Some(target) = opinion.get() else { return };
            if active.as_deref() != Some(target.as_ref()) {
                let _ = target.focus_with_options(&options);
                let end = target.value().encode_utf16().count() as u32;
                let _ = target.set_selection_range(end, end);
            }
        } else if let Some(target) = stars_field.get()
            && active.as_deref() != Some(target.as_ref())
        {
            let _ = target.focus_with_options(&options);
        }
    });

    view! {
        <section node_ref=section class="editor" aria-label="Rating editor">
            <div class=move || if editing_opinion.get() { "field" } else { "field field--focused" }>
                <span class="field__label" id="stars-label">
                    {stars_label}
                </span>
                <div
                    node_ref=stars_field
                    class="stars stars--input"
                    role="radiogroup"
                    aria-labelledby="stars-label"
                    tabindex="0"
                    on:focus=move |_| send.run(Msg::FocusField(EditorField::Stars))
                >
                    {(1..=5)
                        .map(|value| {
                            view! {
                                <button
                                    type="button"
                                    role="radio"
                                    aria-checked=move || if draft_stars.get() == value { "true" } else { "false" }
                                    aria-label=format!("{value} star{}", if value == 1 { "" } else { "s" })
                                    class=move || if value <= draft_stars.get() { "star star--on" } else { "star" }
                                    tabindex="-1"
                                    on:click=move |_| send.run(Msg::SetDraftStars(value))
                                >
                                    "★"
                                </button>
                            }
                        })
                        .collect_view()}
                </div>
            </div>
            <div class=move || if editing_opinion.get() { "field field--focused" } else { "field" }>
                <label class="field__label" for="opinion">
                    {OPINION_LABEL}
                </label>
                <textarea
                    id="opinion"
                    node_ref=opinion
                    rows="4"
                    prop:value=draft_opinion
                    placeholder="What stood out in this performance?"
                    on:focus=move |_| send.run(Msg::FocusField(EditorField::Opinion))
                    on:input=move |event| send.run(Msg::SetDraftOpinion(event_target_value(&event)))
                ></textarea>
            </div>
            <div class="editor__actions">
                <button type="button" class="button button--primary" on:click=move |_| key("enter")>
                    "Save rating"
                </button>
                <button type="button" class="button" on:click=move |_| key("esc")>
                    "Cancel"
                </button>
            </div>
            {EDITOR_HELP.map(|line| view! { <p class="muted small">{line}</p> })}
        </section>
    }
}
