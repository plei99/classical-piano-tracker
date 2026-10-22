//! The page's presence stream ([`PRESENCE_PATH`]): while it is open the
//! server knows this tab is still using it, and when it fails for good the
//! server has stopped, which the footer then says.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use leptos::prelude::*;
use tracker_app::api::{PRESENCE_PATH, PRESENCE_TOKEN_PARAM, encode_uri_component};
use wasm_bindgen::prelude::*;
use web_sys::EventSource;

pub const SERVER_STOPPED_TEXT: &str = "tracker web has stopped. Run tracker web again to reopen this page.";

/// How long the stream may stay down before the page says so, so a
/// reconnect blip does not flash the notice.
pub const STOPPED_NOTICE_DELAY: Duration = Duration::from_secs(1);

pub fn presence_url(token: &str) -> String {
    format!("{PRESENCE_PATH}?{PRESENCE_TOKEN_PARAM}={}", encode_uri_component(token))
}

/// When to report the server stopped, apart from the stream and timers that
/// drive it.
#[derive(Debug, Default)]
pub struct PresenceState {
    pub server_stopped: bool,
    /// The pending delay, if any; a delay that was cancelled no longer
    /// matches when it fires.
    waiting: Option<u32>,
    delays: u32,
}

impl PresenceState {
    /// The stream (re)connected.
    pub fn opened(&mut self) {
        self.waiting = None;
        self.server_stopped = false;
    }

    /// The stream failed; returns the delay to start, unless one is running.
    /// `EventSource` retries on its own, so give it a moment.
    pub fn errored(&mut self) -> Option<u32> {
        if self.waiting.is_some() {
            return None;
        }
        self.delays += 1;
        self.waiting = Some(self.delays);
        self.waiting
    }

    /// Delay `id` is over; `open` is whether the stream is up again.
    pub fn waited(&mut self, id: u32, open: bool) {
        if self.waiting == Some(id) {
            self.waiting = None;
            self.server_stopped = !open;
        }
    }
}

/// Opens the stream and keeps it for the life of the page; the signal is
/// true while the server looks stopped.
pub fn watch(token: &str) -> ArcRwSignal<bool> {
    let stopped = ArcRwSignal::new(false);
    let Ok(stream) = EventSource::new(&presence_url(token)) else { return stopped };
    let state = Rc::new(RefCell::new(PresenceState::default()));
    let publish = {
        let stopped = stopped.clone();
        move |state: &PresenceState| {
            if stopped.get_untracked() != state.server_stopped {
                stopped.set(state.server_stopped);
            }
        }
    };

    let on_open = {
        let (state, publish) = (Rc::clone(&state), publish.clone());
        Closure::<dyn FnMut()>::new(move || {
            let mut state = state.borrow_mut();
            state.opened();
            publish(&state);
        })
    };
    let on_error = {
        let stream = stream.clone();
        Closure::<dyn FnMut()>::new(move || {
            let Some(id) = state.borrow_mut().errored() else { return };
            let (state, stream, publish) = (Rc::clone(&state), stream.clone(), publish.clone());
            set_timeout(
                move || {
                    let mut state = state.borrow_mut();
                    state.waited(id, stream.ready_state() == EventSource::OPEN);
                    publish(&state);
                },
                STOPPED_NOTICE_DELAY,
            );
        })
    };
    stream.set_onopen(Some(on_open.as_ref().unchecked_ref()));
    stream.set_onerror(Some(on_error.as_ref().unchecked_ref()));
    // The page's whole life.
    on_open.forget();
    on_error.forget();
    stopped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn puts_the_token_in_the_query() {
        assert_eq!(presence_url("abc123"), "/api/presence?token=abc123");
        assert_eq!(presence_url("tok/en é"), "/api/presence?token=tok%2Fen%20%C3%A9");
    }

    #[test]
    fn reports_the_server_stopped_once_the_stream_has_been_down_for_the_delay() {
        let mut state = PresenceState::default();
        state.opened();
        let delay = state.errored().unwrap();
        // A failed reconnect does not restart the wait.
        assert_eq!(state.errored(), None);
        assert!(!state.server_stopped);
        state.waited(delay, false);
        assert!(state.server_stopped);

        state.opened();
        assert!(!state.server_stopped);
    }

    #[test]
    fn ignores_a_blip_that_reconnects_within_the_delay() {
        let mut state = PresenceState::default();
        let first = state.errored().unwrap();
        state.opened();
        let second = state.errored().unwrap();
        // The first delay was cancelled by the reconnect.
        state.waited(first, false);
        assert!(!state.server_stopped);
        state.waited(second, true);
        assert!(!state.server_stopped);
    }
}
