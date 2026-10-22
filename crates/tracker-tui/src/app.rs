//! The terminal's side of the shared state machine ([`tracker_app`]):
//! crossterm key events become [`KeyPress`]es, and the model's commands
//! become blocking calls on the injected [`Deps`], which the run loop makes
//! on background threads.

use std::panic::{self, AssertUnwindSafe};

use anyhow::{Result, anyhow};
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use tracker_app::{Cmd, KeyPress, Msg, TracksLoaded};

use crate::{Deps, LoadFn};

/// Calls the injected loader and prepares its output. Blocking.
pub fn fetch_tracks(load: &LoadFn) -> Result<TracksLoaded> {
    let (tracks, ratings) = guarded(|| load())?;
    Ok(TracksLoaded::new(tracks, ratings))
}

/// Runs a command's I/O and returns the message it answers with, or `None`
/// for [`Cmd::Quit`]. Blocking, so the run loop calls it on a worker thread.
pub fn execute(deps: &Deps, cmd: Cmd) -> Option<Msg> {
    Some(match cmd {
        // The terminal's list is never fetched.
        Cmd::Quit => return None,
        Cmd::LoadTracks => Msg::TracksLoaded(fetch_tracks(&deps.load)),
        Cmd::Sync => Msg::SyncFinished(guarded(|| (deps.sync)())),
        Cmd::SaveRating(params) => {
            let track_id = params.track_id;
            Msg::RatingSaved { track_id, result: guarded(|| (deps.save_rating)(params)) }
        }
    })
}

/// Calls an injected callback, turning a panic into an error so a failed
/// worker still reports back and the UI never waits forever.
fn guarded<T>(call: impl FnOnce() -> Result<T>) -> Result<T> {
    panic::catch_unwind(AssertUnwindSafe(call)).unwrap_or_else(|payload| {
        let message = payload
            .downcast_ref::<&str>()
            .map(|message| message.to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".to_string());
        Err(anyhow!("panic: {message}"))
    })
}

/// Names a key press the way Bubble Tea does (see [`KeyPress`]); `None` for
/// key releases.
pub fn key_press(key: &KeyEvent) -> Option<KeyPress> {
    if key.kind == KeyEventKind::Release {
        return None;
    }
    let mut modifiers = key.modifiers;
    let base = match key.code {
        KeyCode::Char(c) => {
            let typing = !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER);
            if typing && c != ' ' {
                return Some(KeyPress::typed(c));
            }
            let text = typing.then_some(c);
            if c == ' ' {
                return Some(KeyPress { name: prefixed(modifiers, "space"), text, is_space: true });
            }
            // Shift is already reflected in the character itself.
            modifiers.remove(KeyModifiers::SHIFT);
            return Some(KeyPress { name: prefixed(modifiers, &c.to_lowercase().to_string()), text, is_space: false });
        }
        KeyCode::BackTab => {
            modifiers.insert(KeyModifiers::SHIFT);
            "tab"
        }
        KeyCode::Tab => "tab",
        KeyCode::Enter => "enter",
        KeyCode::Esc => "esc",
        KeyCode::Backspace => "backspace",
        KeyCode::Delete => "delete",
        KeyCode::Insert => "insert",
        KeyCode::Up => "up",
        KeyCode::Down => "down",
        KeyCode::Left => "left",
        KeyCode::Right => "right",
        KeyCode::Home => "home",
        KeyCode::End => "end",
        KeyCode::PageUp => "pgup",
        KeyCode::PageDown => "pgdown",
        _ => return Some(KeyPress::named("")),
    };
    Some(KeyPress::named(prefixed(modifiers, base)))
}

fn prefixed(modifiers: KeyModifiers, base: &str) -> String {
    let mut name = String::new();
    for (modifier, prefix) in [
        (KeyModifiers::CONTROL, "ctrl+"),
        (KeyModifiers::ALT, "alt+"),
        (KeyModifiers::SHIFT, "shift+"),
        (KeyModifiers::SUPER, "super+"),
    ] {
        if modifiers.contains(modifier) {
            name.push_str(prefix);
        }
    }
    name.push_str(base);
    name
}

#[cfg(test)]
mod tests;
