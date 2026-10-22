use leptos::prelude::*;
use tracker_app::presenter::{self, Hint, Status};
use tracker_app::{BrowserModel, KeyPress, Msg, TrackList, WebModel};

use crate::presence::SERVER_STOPPED_TEXT;

/// Keys the web UI adds for its extra actions; shown only while browsing.
pub const WEB_HINTS: [Hint; 2] = [
    Hint { keys: "p", label: "play", key: Some("p"), terminal_only: false },
    Hint { keys: "a", label: "open in Spotify", key: Some("a"), terminal_only: false },
];

/// The hints a browser shows: the model's, minus terminal-only ones, plus
/// the web actions while browsing.
pub fn web_hints<L: TrackList>(model: &BrowserModel<L>) -> Vec<Hint> {
    let browsing = !model.editing_rating && !model.searching;
    let shown = presenter::hints(model).iter().filter(|hint| !hint.terminal_only).copied();
    shown.chain(WEB_HINTS.into_iter().filter(|_| browsing)).collect()
}

/// The status line: the model's, unless the server has stopped, since then
/// nothing else on the page can work any more.
pub fn footer_status<L: TrackList>(model: &BrowserModel<L>, server_stopped: bool) -> Option<Status> {
    if server_stopped {
        return Some(Status { text: SERVER_STOPPED_TEXT.into(), is_error: true });
    }
    presenter::status(model)
}

#[component]
pub fn Footer(model: RwSignal<WebModel>, send: Callback<Msg>, server_stopped: Signal<bool>) -> impl IntoView {
    let status = Memo::new(move |_| {
        let server_stopped = server_stopped.get();
        model.with(|model| footer_status(model, server_stopped))
    });
    let hints = Memo::new(move |_| model.with(web_hints));
    view! {
        <footer class="footer">
            <p
                class=move || {
                    if status.with(|status| status.as_ref().is_some_and(|status| status.is_error)) {
                        "status status--error"
                    } else {
                        "status"
                    }
                }
                role="status"
                aria-live="polite"
            >
                {move || status.with(|status| status.as_ref().map(|status| status.text.clone()).unwrap_or_default())}
            </p>
            <ul class="hints" aria-label="Keyboard shortcuts">
                {move || {
                    hints
                        .get()
                        .into_iter()
                        .map(|hint| {
                            let label = view! { <kbd class="keycap">{hint.keys}</kbd> " " {hint.label} };
                            view! {
                                <li>
                                    {match hint.key {
                                        None => view! { <span class="hint">{label}</span> }.into_any(),
                                        Some(key) => {
                                            view! {
                                                <button
                                                    type="button"
                                                    class="hint hint--action"
                                                    on:click=move |_| send.run(Msg::Key(KeyPress::named(key)))
                                                >
                                                    {label}
                                                </button>
                                            }
                                                .into_any()
                                        }
                                    }}
                                </li>
                            }
                        })
                        .collect_view()
                }}
            </ul>
        </footer>
    }
}

#[cfg(test)]
mod tests {
    use tracker_app::{Model, Services};

    use super::*;

    #[test]
    fn hides_quit_and_adds_web_actions_while_browsing() {
        let mut model = Model::new(Services::ALL);
        let keys = |model: &Model| web_hints(model).iter().map(|hint| hint.keys).collect::<Vec<_>>();
        assert_eq!(keys(&model), ["j/k or arrows", "g/G", "o", "s", "enter/e", "r", "p", "a"]);
        model.searching = true;
        assert_eq!(keys(&model), ["type", "backspace", "enter", "esc"]);
        model.searching = false;
        model.editing_rating = true;
        assert_eq!(keys(&model), ["1-5", "tab", "ctrl+u", "enter", "esc"]);
    }

    #[test]
    fn the_stopped_notice_replaces_the_status_line() {
        let mut model = Model::new(Services::ALL);
        model.syncing = true;
        let stopped = footer_status(&model, true).unwrap();
        assert_eq!(
            (stopped.text.as_str(), stopped.is_error),
            ("tracker web has stopped. Run tracker web again to reopen this page.", true)
        );
        assert_eq!(footer_status(&model, false), presenter::status(&model));
    }
}
