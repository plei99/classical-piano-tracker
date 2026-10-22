//! Browser key events, named the way the shared model expects (Bubble Tea's
//! key names, as the terminal produces them), so `j`, `/`, `enter`, `esc`
//! and the rest mean the same thing in both front ends; and which of them
//! the page hands to the model rather than to the browser.

use tracker_app::KeyPress;

fn named(key: &str) -> Option<&'static str> {
    Some(match key {
        "Enter" => "enter",
        "Escape" => "esc",
        "Tab" => "tab",
        "Backspace" => "backspace",
        "ArrowUp" => "up",
        "ArrowDown" => "down",
        "ArrowLeft" => "left",
        "ArrowRight" => "right",
        "Home" => "home",
        "End" => "end",
        "PageUp" => "pgup",
        "PageDown" => "pgdown",
        "Delete" => "delete",
        " " => "space",
        _ => return None,
    })
}

/// The modifier state of a key event.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Modifiers {
    pub ctrl: bool,
    pub meta: bool,
    pub alt: bool,
    pub shift: bool,
}

/// Translates a keydown (`KeyboardEvent.key` plus modifiers) into a model
/// key press, or `None` for keys the model never sees.
pub fn key_press(key: &str, modifiers: Modifiers) -> Option<KeyPress> {
    // Browser and OS shortcuts (copy, reload, tab switching) stay theirs.
    if modifiers.meta || modifiers.alt {
        return None;
    }
    if let Some(name) = named(key) {
        let full = if modifiers.shift && name == "tab" {
            "shift+tab".to_string()
        } else if modifiers.ctrl {
            format!("ctrl+{name}")
        } else {
            name.to_string()
        };
        let is_space = name == "space" && !modifiers.ctrl;
        return Some(KeyPress { name: full, text: is_space.then_some(' '), is_space });
    }
    let mut chars = key.chars();
    let (Some(c), None) = (chars.next(), chars.next()) else {
        // Modifier and function keys.
        return None;
    };
    if modifiers.ctrl {
        return Some(KeyPress::named(format!("ctrl+{}", key.to_lowercase())));
    }
    Some(KeyPress::typed(c))
}

/// Keys the model handles while browsing; anything else keeps its browser
/// meaning (Tab, Space on a button, ...). `p` and `a` are the web UI's own
/// actions (play, open in Spotify).
const BROWSING_KEYS: [&str; 17] =
    ["j", "k", "up", "down", "g", "G", "home", "end", "o", "s", "e", "enter", "r", "/", "esc", "p", "a"];
/// Keys that leave a text field for the model.
const FIELD_KEYS: [&str; 5] = ["enter", "esc", "tab", "shift+tab", "ctrl+u"];
const ARROWS: [&str; 4] = ["up", "down", "left", "right"];

/// What a key event was aimed at.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Target {
    /// Inside an element that takes typed text (a text input or textarea;
    /// radios and buttons don't, so the model's keys still work on them).
    pub text_entry: bool,
    /// Inside a button, link, radio, or input, which Enter and Space
    /// activate natively.
    pub control: bool,
    /// A radio input, where arrow keys move between choices.
    pub radio_input: bool,
}

/// Whether a key press goes to the model (and its default is prevented).
pub fn routes_to_model(key: &KeyPress, target: Target, editing_rating: bool, searching: bool) -> bool {
    let name = key.name.as_str();
    if target.text_entry {
        // Text fields keep their typing; only the model's commands leave them.
        FIELD_KEYS.contains(&name)
            && !(name == "ctrl+u" && !editing_rating)
            && !(name.ends_with("tab") && !editing_rating)
    } else if target.control && (name == "enter" || name == "space") {
        // Let a focused control activate natively.
        false
    } else if target.radio_input && ARROWS.contains(&name) {
        // Arrow keys move between the theme choices.
        false
    } else if searching {
        FIELD_KEYS.contains(&name)
    } else {
        editing_rating || BROWSING_KEYS.contains(&name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn press(key: &str) -> Option<KeyPress> {
        key_press(key, Modifiers::default())
    }

    #[test]
    fn names_keys_the_way_the_model_expects() {
        assert_eq!(press("j"), Some(KeyPress::typed('j')));
        assert_eq!(key_press("G", Modifiers { shift: true, ..Modifiers::default() }), Some(KeyPress::typed('G')));
        assert_eq!(press("Enter"), Some(KeyPress::named("enter")));
        assert_eq!(press("Escape").unwrap().name, "esc");
        assert_eq!(key_press("Tab", Modifiers { shift: true, ..Modifiers::default() }).unwrap().name, "shift+tab");
        assert_eq!(key_press("u", Modifiers { ctrl: true, ..Modifiers::default() }), Some(KeyPress::named("ctrl+u")));
        assert_eq!(key_press("U", Modifiers { ctrl: true, ..Modifiers::default() }).unwrap().name, "ctrl+u");
        assert_eq!(press(" "), Some(KeyPress { name: "space".into(), text: Some(' '), is_space: true }));
        assert_eq!(
            key_press(" ", Modifiers { ctrl: true, ..Modifiers::default() }),
            Some(KeyPress::named("ctrl+space"))
        );
        assert_eq!(press("é").unwrap().text, Some('é'));
        assert_eq!(press("ArrowDown").unwrap().name, "down");
    }

    #[test]
    fn leaves_modifiers_and_browser_shortcuts_alone() {
        assert_eq!(press("Shift"), None);
        assert_eq!(press("F5"), None);
        assert_eq!(press("Dead"), None);
        assert_eq!(key_press("r", Modifiers { meta: true, ..Modifiers::default() }), None);
        assert_eq!(key_press("j", Modifiers { alt: true, ..Modifiers::default() }), None);
    }

    fn routes(key: &str, target: Target, editing: bool, searching: bool) -> bool {
        routes_to_model(&press(key).unwrap(), target, editing, searching)
    }

    const PAGE: Target = Target { text_entry: false, control: false, radio_input: false };
    const FIELD: Target = Target { text_entry: true, control: true, radio_input: false };
    const BUTTON: Target = Target { text_entry: false, control: true, radio_input: false };
    const RADIO: Target = Target { text_entry: false, control: true, radio_input: true };

    #[test]
    fn browsing_keys_reach_the_model_and_others_stay_with_the_browser() {
        for key in ["j", "k", "ArrowUp", "G", "Home", "o", "s", "e", "Enter", "r", "/", "Escape", "p", "a"] {
            assert!(routes(key, PAGE, false, false), "{key}");
        }
        for key in ["Tab", " ", "x", "1", "PageDown"] {
            assert!(!routes(key, PAGE, false, false), "{key}");
        }
    }

    #[test]
    fn text_fields_keep_their_typing() {
        for key in ["j", "/", " ", "Backspace", "p"] {
            assert!(!routes(key, FIELD, false, true), "{key}");
            assert!(!routes(key, FIELD, true, false), "{key}");
        }
        assert!(routes("Enter", FIELD, false, true));
        assert!(routes("Escape", FIELD, false, true));
        // Tab and ctrl+u belong to the field except in the rating editor.
        let ctrl_u = KeyPress::named("ctrl+u");
        assert!(!routes_to_model(&ctrl_u, FIELD, false, true));
        assert!(routes_to_model(&ctrl_u, FIELD, true, false));
        assert!(!routes("Tab", FIELD, false, true));
        assert!(routes("Tab", FIELD, true, false));
    }

    #[test]
    fn controls_activate_natively() {
        assert!(!routes("Enter", BUTTON, false, false));
        assert!(!routes(" ", BUTTON, true, false));
        assert!(routes("j", BUTTON, false, false), "the model's keys still work on a focused button");
        assert!(!routes("ArrowDown", RADIO, false, false), "arrows move between theme choices");
        assert!(routes("j", RADIO, false, false));
    }

    #[test]
    fn searching_and_editing_modes() {
        assert!(!routes("j", PAGE, false, true));
        assert!(routes("Escape", PAGE, false, true));
        // The editor takes every key (digits set stars, text starts the opinion).
        for key in ["4", "x", " ", "Backspace", "Tab"] {
            assert!(routes(key, PAGE, true, false), "{key}");
        }
    }
}
