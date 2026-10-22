//! Small one-screen pickers used only during onboarding: a multi-select for
//! the pianist allowlist and a single-choice list for providers and models.
//! They exist so curation can use real key bindings without pulling the main
//! TUI into the setup flow.
//!
//! Each picker is a plain state machine (`handle_key` / `lines`), so tests
//! drive it without a terminal; [`run_picker`] is the only terminal I/O.

use std::collections::BTreeSet;
use std::io::{self, Write};

use anyhow::{Result, bail};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode};
use crossterm::{cursor, execute};
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;

/// The terminal height assumed before the first draw reports the real one.
const DEFAULT_HEIGHT: usize = 24;

/// What a key press means to a picker. Key names follow the Go build's
/// Bubble Tea bindings exactly; anything else is ignored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PickerKey {
    Cancel,
    Up,
    Down,
    Toggle,
    Confirm,
}

fn picker_key(key: &KeyEvent) -> Option<PickerKey> {
    if key.kind != KeyEventKind::Press {
        return None;
    }
    if key.modifiers == KeyModifiers::CONTROL {
        return (key.code == KeyCode::Char('c')).then_some(PickerKey::Cancel);
    }
    if !key.modifiers.is_empty() {
        return None;
    }
    match key.code {
        KeyCode::Char('q') => Some(PickerKey::Cancel),
        KeyCode::Up | KeyCode::Char('k') => Some(PickerKey::Up),
        KeyCode::Down | KeyCode::Char('j') => Some(PickerKey::Down),
        KeyCode::Char(' ') => Some(PickerKey::Toggle),
        KeyCode::Enter => Some(PickerKey::Confirm),
        _ => None,
    }
}

/// A picker state machine that [`run_picker`] can drive.
pub(crate) trait Picker {
    /// Applies one key press; returns true when the picker is finished.
    fn handle_key(&mut self, key: KeyEvent) -> bool;
    fn set_height(&mut self, height: usize);
    fn lines(&self) -> Vec<Line<'static>>;
}

/// The picker's frame as plain text, one line per row.
#[cfg(test)]
fn render(picker: &impl Picker) -> String {
    picker
        .lines()
        .iter()
        .map(|line| line.spans.iter().map(|span| span.content.as_ref()).collect::<String>() + "\n")
        .collect()
}

/// The `[start, end)` window of a list that fits on screen when `reserved`
/// rows go to headers, keeping the cursor centered when possible so long
/// lists stay usable in small terminals.
fn visible_range(len: usize, cursor: usize, height: usize, reserved: usize) -> (usize, usize) {
    if len == 0 {
        return (0, 0);
    }
    let height = if height == 0 { DEFAULT_HEIGHT } else { height };
    let available = height.saturating_sub(reserved).max(3).min(len);
    let start = cursor.saturating_sub(available / 2).min(len - available);
    (start, start + available)
}

/// Pushes the list rows plus "... N more above/below" hints.
fn push_window(
    lines: &mut Vec<Line<'static>>,
    len: usize,
    (start, end): (usize, usize),
    row: impl Fn(usize) -> Line<'static>,
) {
    if start > 0 {
        lines.push(Line::raw(format!("  ... {start} more above")));
    }
    lines.extend((start..end).map(row));
    if end < len {
        lines.push(Line::raw(format!("  ... {} more below", len - end)));
    }
}

/// Multi-select for the initial pianist allowlist.
#[derive(Debug, Clone)]
pub(crate) struct PianistSelection {
    pianists: Vec<String>,
    selected: BTreeSet<usize>,
    cursor: usize,
    canceled: bool,
    height: usize,
}

impl PianistSelection {
    /// Starts with every pianist selected, so confirming right away keeps
    /// the full default list.
    pub(crate) fn new(pianists: &[String]) -> PianistSelection {
        PianistSelection {
            pianists: pianists.to_vec(),
            selected: (0..pianists.len()).collect(),
            cursor: 0,
            canceled: false,
            height: 0,
        }
    }

    fn visible_pianists(&self) -> (&[String], usize, bool, bool) {
        let (start, end) = visible_range(self.pianists.len(), self.cursor, self.height, 6);
        (&self.pianists[start..end], start, start > 0, end < self.pianists.len())
    }

    /// The selection in original display order, ready for the allowlist.
    pub(crate) fn selected_pianists(&self) -> Result<Vec<String>> {
        if self.pianists.is_empty() {
            bail!("selection source must not be empty");
        }
        if self.selected.is_empty() {
            bail!("selection must include at least one pianist");
        }
        Ok(self.selected.iter().map(|&idx| self.pianists[idx].clone()).collect())
    }
}

impl Picker for PianistSelection {
    fn handle_key(&mut self, key: KeyEvent) -> bool {
        match picker_key(&key) {
            Some(PickerKey::Cancel) => {
                self.canceled = true;
                return true;
            }
            Some(PickerKey::Up) => self.cursor = self.cursor.saturating_sub(1),
            Some(PickerKey::Down) => {
                if self.cursor + 1 < self.pianists.len() {
                    self.cursor += 1;
                }
            }
            Some(PickerKey::Toggle) => {
                if !self.selected.remove(&self.cursor) {
                    self.selected.insert(self.cursor);
                }
            }
            Some(PickerKey::Confirm) => return true,
            None => {}
        }
        false
    }

    fn set_height(&mut self, height: usize) {
        self.height = height;
    }

    fn lines(&self) -> Vec<Line<'static>> {
        let len = self.pianists.len();
        let mut lines = vec![
            Line::raw("Select pianists for the initial allowlist."),
            Line::raw("Up/down or j/k: move   space: toggle   enter: confirm   q: cancel"),
            Line::raw(format!("Selected: {} of {len}   Current: {} of {len}", self.selected.len(), self.cursor + 1)),
            Line::default(),
        ];
        let (visible, offset, _, _) = self.visible_pianists();
        push_window(&mut lines, len, (offset, offset + visible.len()), |idx| {
            let cursor = if idx == self.cursor { ">" } else { " " };
            let check = if self.selected.contains(&idx) { "x" } else { " " };
            let line = Line::raw(format!("{cursor} [{check}] {}", self.pianists[idx]));
            if idx == self.cursor { line.bold() } else { line }
        });
        if self.selected.is_empty() {
            lines.push(Line::default());
            lines.push(Line::raw("Select at least one pianist before confirming."));
        }
        lines
    }
}

/// Single-choice list used for the LLM provider and model.
#[derive(Debug, Clone)]
pub(crate) struct SingleChoice {
    title: String,
    help: String,
    options: Vec<String>,
    cursor: usize,
    canceled: bool,
    height: usize,
}

impl SingleChoice {
    pub(crate) fn new(title: &str, help: &str, options: &[String], initial: usize) -> SingleChoice {
        SingleChoice {
            title: title.to_string(),
            help: help.to_string(),
            options: options.to_vec(),
            cursor: if initial < options.len() { initial } else { 0 },
            canceled: false,
            height: 0,
        }
    }

    fn visible_options(&self) -> (&[String], usize, bool, bool) {
        let (start, end) = visible_range(self.options.len(), self.cursor, self.height, 5);
        (&self.options[start..end], start, start > 0, end < self.options.len())
    }
}

impl Picker for SingleChoice {
    fn handle_key(&mut self, key: KeyEvent) -> bool {
        match picker_key(&key) {
            Some(PickerKey::Cancel) => {
                self.canceled = true;
                return true;
            }
            Some(PickerKey::Up) => self.cursor = self.cursor.saturating_sub(1),
            Some(PickerKey::Down) => {
                if self.cursor + 1 < self.options.len() {
                    self.cursor += 1;
                }
            }
            Some(PickerKey::Confirm) => return true,
            Some(PickerKey::Toggle) | None => {}
        }
        false
    }

    fn set_height(&mut self, height: usize) {
        self.height = height;
    }

    fn lines(&self) -> Vec<Line<'static>> {
        let len = self.options.len();
        let mut lines = vec![Line::raw(self.title.clone()), Line::raw(self.help.clone())];
        if len > 0 {
            lines.push(Line::raw(format!("Current: {} of {len}", self.cursor + 1)));
            lines.push(Line::default());
        }
        let (visible, offset, _, _) = self.visible_options();
        push_window(&mut lines, len, (offset, offset + visible.len()), |idx| {
            let cursor = if idx == self.cursor { ">" } else { " " };
            let line = Line::raw(format!("{cursor} {}", self.options[idx]));
            if idx == self.cursor { line.bold() } else { line }
        });
        lines
    }
}

/// Runs the pianist multi-select on the alternate screen with raw key input,
/// so arrow keys and space toggles work.
pub(crate) fn prompt_pianist_selection(out: &mut dyn Write, pianists: &[String]) -> Result<Vec<String>> {
    let mut picker = PianistSelection::new(pianists);
    if let Err(err) = run_picker(out, &mut picker) {
        bail!("run pianist selection: {err}");
    }
    if picker.canceled {
        bail!("pianist selection canceled");
    }
    let selected = picker.selected_pianists()?;
    writeln!(out)?;
    Ok(selected)
}

/// Runs a single-choice picker on the alternate screen and returns the
/// chosen option.
pub(crate) fn run_single_choice_selection(
    out: &mut dyn Write,
    title: &str,
    help: &str,
    options: &[String],
    initial: usize,
) -> Result<String> {
    if options.is_empty() {
        bail!("single-choice selection requires at least one option");
    }
    let mut picker = SingleChoice::new(title, help, options, initial);
    if let Err(err) = run_picker(out, &mut picker) {
        bail!("run selection {title:?}: {err}");
    }
    if picker.canceled {
        bail!("selection canceled");
    }
    let Some(choice) = picker.options.get(picker.cursor) else {
        bail!("selection cursor {} out of range", picker.cursor);
    };
    let choice = choice.clone();
    writeln!(out)?;
    Ok(choice)
}

/// Takes over the terminal (raw mode, alternate screen) until the picker
/// finishes, restoring it even when drawing or reading input fails.
fn run_picker(mut out: &mut dyn Write, picker: &mut impl Picker) -> io::Result<()> {
    enable_raw_mode()?;
    let result = execute!(&mut out, EnterAlternateScreen, cursor::Hide).and_then(|()| event_loop(&mut *out, picker));
    let restored = execute!(&mut out, cursor::Show, LeaveAlternateScreen).and(disable_raw_mode());
    result.and(restored)
}

fn event_loop(out: &mut dyn Write, picker: &mut impl Picker) -> io::Result<()> {
    let mut terminal = Terminal::new(CrosstermBackend::new(out))?;
    loop {
        terminal.draw(|frame| {
            let area = frame.area();
            picker.set_height(usize::from(area.height));
            frame.render_widget(Paragraph::new(picker.lines()), area);
        })?;
        // Resizes need no handling beyond the redraw at the top of the loop.
        if let Event::Key(key) = event::read()?
            && picker.handle_key(key)
        {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn press(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn names(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn pianist_selection_toggle_and_selection_order() {
        let mut model = PianistSelection::new(&names(&["A", "B", "C"]));
        model.handle_key(press(KeyCode::Char(' ')));
        model.handle_key(press(KeyCode::Down));
        model.handle_key(press(KeyCode::Char(' ')));
        assert_eq!(model.selected_pianists().unwrap(), vec!["C"]);
    }

    #[test]
    fn pianist_selection_rejects_empty_selection() {
        let mut model = PianistSelection::new(&names(&["A"]));
        model.handle_key(press(KeyCode::Char(' ')));
        assert!(model.selected_pianists().is_err());
        assert!(render(&model).contains("Select at least one pianist before confirming."));
    }

    #[test]
    fn pianist_selection_view_includes_controls() {
        let view = render(&PianistSelection::new(&names(&["A", "B"])));
        for want in ["space: toggle", "enter: confirm", "[x] A"] {
            assert!(view.contains(want), "view = {view:?}, want {want:?}");
        }
    }

    #[test]
    fn pianist_selection_visible_pianists_tracks_cursor_window() {
        let mut model = PianistSelection::new(&names(&["A", "B", "C", "D", "E", "F", "G", "H"]));
        model.height = 10;
        model.cursor = 6;
        let (visible, offset, hidden_above, hidden_below) = model.visible_pianists();
        assert_eq!(offset, 4);
        assert!(hidden_above);
        assert!(!hidden_below);
        assert_eq!(visible, names(&["E", "F", "G", "H"]));
    }

    #[test]
    fn pianist_selection_view_shows_overflow_hints() {
        let mut model = PianistSelection::new(&names(&["A", "B", "C", "D", "E", "F", "G", "H"]));
        model.height = 10;
        model.cursor = 3;
        let view = render(&model);
        for want in ["... 1 more above", "... 3 more below"] {
            assert!(view.contains(want), "view = {view:?}, want {want:?}");
        }
    }

    #[test]
    fn pianist_selection_keys_quit_and_cancel() {
        let mut model = PianistSelection::new(&names(&["A", "B"]));
        assert!(!model.handle_key(press(KeyCode::Char('j'))));
        assert!(!model.handle_key(press(KeyCode::Char('j'))), "cursor stops at the last row");
        assert_eq!(model.cursor, 1);
        assert!(!model.handle_key(press(KeyCode::Char('k'))));
        assert!(!model.handle_key(press(KeyCode::Up)));
        assert_eq!(model.cursor, 0);
        assert!(!model.handle_key(KeyEvent::new(KeyCode::Char('q'), KeyModifiers::ALT)), "alt+q is not q");
        assert!(model.handle_key(press(KeyCode::Enter)));
        assert!(!model.canceled);

        let mut model = PianistSelection::new(&names(&["A"]));
        assert!(model.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)));
        assert!(model.canceled);
    }

    #[test]
    fn single_choice_moves_within_bounds_and_renders() {
        let mut model = SingleChoice::new("Pick", "help text", &names(&["one", "two", "three"]), 7);
        assert_eq!(model.cursor, 0, "out-of-range initial falls back to the first option");
        model.handle_key(press(KeyCode::Up));
        assert_eq!(model.cursor, 0);
        model.handle_key(press(KeyCode::Down));
        model.handle_key(press(KeyCode::Char(' ')));
        assert_eq!(model.cursor, 1);
        let view = render(&model);
        assert_eq!(view, "Pick\nhelp text\nCurrent: 2 of 3\n\n  one\n> two\n  three\n");
        assert!(model.handle_key(press(KeyCode::Char('q'))));
        assert!(model.canceled);
    }

    #[test]
    fn single_choice_window_scrolls_with_cursor() {
        let options: Vec<String> = (1..=20).map(|n| format!("model-{n}")).collect();
        let mut model = SingleChoice::new("Pick", "help", &options, 19);
        model.height = 10;
        let (visible, offset, hidden_above, hidden_below) = model.visible_options();
        assert_eq!((visible.len(), offset, hidden_above, hidden_below), (5, 15, true, false));
        assert!(render(&model).contains("  ... 15 more above\n"));
    }

    #[test]
    fn visible_range_matches_go_window_math() {
        assert_eq!(visible_range(0, 0, 10, 6), (0, 0));
        assert_eq!(visible_range(8, 0, 10, 6), (0, 4));
        assert_eq!(visible_range(8, 3, 10, 6), (1, 5));
        assert_eq!(visible_range(8, 7, 10, 6), (4, 8));
        // Tiny terminals still show three rows; unknown height means 24.
        assert_eq!(visible_range(8, 0, 2, 6), (0, 3));
        assert_eq!(visible_range(30, 0, 0, 6), (0, 18));
        assert_eq!(visible_range(2, 1, 0, 6), (0, 2));
    }

    #[test]
    fn single_choice_selection_requires_options() {
        let err = run_single_choice_selection(&mut Vec::new(), "t", "h", &[], 0).unwrap_err();
        assert_eq!(err.to_string(), "single-choice selection requires at least one option");
    }
}
