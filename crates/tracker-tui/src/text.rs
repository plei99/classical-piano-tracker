//! Cell-width-aware string helpers: measuring, truncating, and wrapping text
//! the way Lip Gloss did in the Go build, so pane layouts line up the same.

use std::borrow::Cow;

use ratatui::buffer::{Buffer, CellWidth};
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use unicode_segmentation::UnicodeSegmentation;

/// Lip Gloss expands each tab to four spaces before rendering. ratatui drops
/// control characters instead, so tabs are expanded up front to keep spacing.
const TAB: &str = "    ";

/// Display width of one grapheme cluster, matching what the ratatui buffer
/// will occupy. Control characters are filtered by the buffer, so they are
/// zero-width here too.
fn grapheme_width(grapheme: &str) -> usize {
    if grapheme.contains(char::is_control) { 0 } else { usize::from(grapheme.cell_width()) }
}

/// Characters that are always exactly one cell wide and never join a
/// neighbor into a larger grapheme cluster: printable ASCII, Latin-1 through
/// Latin Extended-B (minus the soft hyphen), and General Punctuation dashes,
/// quotes, and ellipses. That covers nearly every classical track title
/// ("Scherzo – Più lento"), and strings made only of these can be measured
/// and cut per `char` instead of by the much slower grapheme segmentation.
fn is_simple(c: char) -> bool {
    matches!(c, ' '..='~' | '\u{a0}'..='\u{ac}' | '\u{ae}'..='\u{2ff}' | '\u{2010}'..='\u{2027}' | '\u{2030}'..='\u{205e}')
}

/// The width of `value` if it consists only of [`is_simple`] characters.
fn simple_width(value: &str) -> Option<usize> {
    if value.is_ascii() {
        return value.bytes().all(|byte| !byte.is_ascii_control()).then_some(value.len());
    }
    value.chars().try_fold(0, |cells, c| is_simple(c).then_some(cells + 1))
}

/// Terminal cell width of `value`.
pub(crate) fn width(value: &str) -> usize {
    simple_width(value).unwrap_or_else(|| value.graphemes(true).map(grapheme_width).sum())
}

/// Writes a styled line at (`x`, `y`), clipped to `max_width` cells and the
/// buffer. Equivalent to `Buffer::set_line`, but spans of simple characters
/// skip grapheme segmentation, which dominated frame time.
pub(crate) fn write_line(buf: &mut Buffer, x: u16, y: u16, line: &Line<'_>, max_width: u16) {
    if y < buf.area.top() || y >= buf.area.bottom() {
        return;
    }
    let end = x.saturating_add(max_width).min(buf.area.right());
    let mut x = x;
    for span in &line.spans {
        if x >= end {
            return;
        }
        let style = line.style.patch(span.style);
        if simple_width(&span.content).is_some() {
            for c in span.content.chars() {
                if x >= end {
                    return;
                }
                buf[(x, y)].set_char(c).set_style(style);
                x += 1;
            }
        } else {
            x = buf.set_stringn(x, y, &span.content, usize::from(end - x), style).0;
        }
    }
}

/// Replaces tabs with spaces, borrowing when there are none.
pub(crate) fn expand_tabs(value: &str) -> Cow<'_, str> {
    if value.contains('\t') { Cow::Owned(value.replace('\t', TAB)) } else { Cow::Borrowed(value) }
}

/// Cuts `value` to at most `max_width` cells, ending in "..." when there is
/// room for it. Cutting by grapheme clusters keeps accented names valid and
/// never splits a wide character.
pub(crate) fn truncate(value: &str, max_width: usize) -> Cow<'_, str> {
    if max_width == 0 {
        return Cow::Borrowed("");
    }
    let tail = if max_width <= 3 { "" } else { "..." };
    let limit = max_width.saturating_sub(tail.len());
    if let Some(cells) = simple_width(value) {
        if cells <= max_width {
            return Cow::Borrowed(value);
        }
        let end = value.char_indices().nth(limit).map_or(value.len(), |(offset, _)| offset);
        return Cow::Owned(format!("{}{tail}", &value[..end]));
    }
    if width(value) <= max_width {
        return Cow::Borrowed(value);
    }
    let mut used = 0;
    let mut end = 0;
    for (offset, grapheme) in value.grapheme_indices(true) {
        let cells = grapheme_width(grapheme);
        if used + cells > limit {
            break;
        }
        used += cells;
        end = offset + grapheme.len();
    }
    let mut out = String::with_capacity(end + tail.len());
    out.push_str(&value[..end]);
    out.push_str(tail);
    Cow::Owned(out)
}

/// Greedy word wrap used for opinions: paragraphs split on newlines, words
/// on whitespace, and a word longer than `max_width` stays on its own line.
pub(crate) fn wrap_text(value: &str, max_width: usize) -> Vec<String> {
    if max_width == 0 || value.is_empty() {
        return vec![String::new()];
    }

    let mut lines = Vec::new();
    for paragraph in value.split('\n') {
        let mut words = paragraph.split_whitespace();
        let Some(first) = words.next() else {
            lines.push(String::new());
            continue;
        };

        let mut line = first.to_string();
        let mut line_width = width(first);
        for word in words {
            let word_width = width(word);
            if line_width + 1 + word_width <= max_width {
                line.push(' ');
                line.push_str(word);
                line_width += 1 + word_width;
                continue;
            }
            lines.push(std::mem::replace(&mut line, word.to_string()));
            line_width = word_width;
        }
        lines.push(line);
    }
    lines
}

/// Total cell width of a styled line.
pub(crate) fn line_width(line: &Line<'_>) -> usize {
    line.spans.iter().map(|span| width(&span.content)).sum()
}

/// One styled grapheme, the unit [`wrap_line`] works on.
#[derive(Clone, Copy)]
struct Cell<'s> {
    grapheme: &'s str,
    style: Style,
    width: usize,
}

/// Re-wraps a styled line that is wider than `limit`, reproducing the
/// word-wrap Lip Gloss applied to every line of a fixed-width pane
/// (`ansi.Wrap`): break at spaces, also after ASCII hyphens, hard-break
/// words longer than the limit, and drop spaces that land on a break.
///
/// The Go layout only overflows in rare cases (e.g. a selected row with a
/// three-digit track ID, where the trailing highlight space is dropped), so
/// this is never on the hot path.
pub(crate) fn wrap_line(line: &Line<'_>, limit: usize) -> Vec<Line<'static>> {
    let cells: Vec<Cell<'_>> = line
        .spans
        .iter()
        .flat_map(|span| {
            let style = line.style.patch(span.style);
            span.content.graphemes(true).map(move |grapheme| Cell { grapheme, style, width: grapheme_width(grapheme) })
        })
        .collect();
    if limit == 0 {
        return vec![styled_line(&cells)];
    }

    let mut wrapper =
        Wrapper { limit, lines: vec![Vec::new()], word: Vec::new(), space: Vec::new(), ..Wrapper::default() };
    for cell in cells {
        wrapper.push(cell);
    }
    wrapper.finish().iter().map(|cells| styled_line(cells)).collect()
}

/// State machine ported from `ansi.Wrap` in charmbracelet/x.
#[derive(Default)]
struct Wrapper<'s> {
    limit: usize,
    lines: Vec<Vec<Cell<'s>>>,
    word: Vec<Cell<'s>>,
    space: Vec<Cell<'s>>,
    space_width: usize,
    /// Width already written to the current line.
    line_width: usize,
    word_width: usize,
}

impl<'s> Wrapper<'s> {
    fn current(&mut self) -> &mut Vec<Cell<'s>> {
        self.lines.last_mut().expect("wrapper always has a line")
    }

    fn add_space(&mut self) {
        if self.space_width == 0 && self.space.is_empty() {
            return;
        }
        self.line_width += self.space_width;
        let space = std::mem::take(&mut self.space);
        self.current().extend(space);
        self.space_width = 0;
    }

    fn add_word(&mut self) {
        if self.word.is_empty() {
            return;
        }
        self.add_space();
        self.line_width += self.word_width;
        let word = std::mem::take(&mut self.word);
        self.current().extend(word);
        self.word_width = 0;
    }

    fn add_newline(&mut self) {
        self.lines.push(Vec::new());
        self.line_width = 0;
        self.space.clear();
        self.space_width = 0;
    }

    fn push(&mut self, cell: Cell<'s>) {
        let limit = self.limit;
        let ascii = cell.grapheme.len() == 1;
        let first = cell.grapheme.chars().next().unwrap_or(' ');

        if !ascii {
            // Non-ASCII clusters: no-break space is part of a word.
            if first.is_whitespace() && first != '\u{a0}' {
                self.add_word();
                self.space_width += cell.width;
                self.space.push(cell);
                return;
            }
            if self.word_width + cell.width > limit {
                self.add_word();
            }
            self.word_width += cell.width;
            self.word.push(cell);
            if self.line_width + self.word_width + self.space_width > limit {
                self.add_newline();
            }
            if self.word_width == limit {
                self.add_word();
            }
            return;
        }

        if first.is_whitespace() {
            self.add_word();
            self.space_width += 1;
            self.space.push(cell);
        } else if first == '-' {
            self.add_space();
            if self.line_width + self.word_width >= limit {
                self.word_width += 1;
                self.word.push(cell);
            } else {
                self.add_word();
                self.line_width += 1;
                self.current().push(cell);
            }
        } else {
            if self.line_width == limit {
                self.add_newline();
            }
            self.word_width += 1;
            self.word.push(cell);
            if self.word_width == limit {
                self.add_word();
            }
            if self.line_width + self.word_width + self.space_width > limit {
                self.add_newline();
            }
        }
    }

    fn finish(mut self) -> Vec<Vec<Cell<'s>>> {
        if self.word_width == 0 {
            if self.line_width + self.space_width <= self.limit {
                // Trailing spaces that still fit are preserved.
                let space = std::mem::take(&mut self.space);
                self.current().extend(space);
            }
            self.space.clear();
            self.space_width = 0;
        }
        self.add_word();
        self.lines
    }
}

/// Rebuilds spans from cells, merging runs that share a style.
fn styled_line(cells: &[Cell<'_>]) -> Line<'static> {
    let mut spans: Vec<Span<'static>> = Vec::new();
    for cell in cells {
        match spans.last_mut() {
            Some(span) if span.style == cell.style => span.content.to_mut().push_str(cell.grapheme),
            _ => spans.push(Span::styled(cell.grapheme.to_string(), cell.style)),
        }
    }
    Line::from(spans)
}

/// Joins key hints with a 3-space gap, starting a new line rather than
/// splitting a hint when the next one would overflow `max_width`.
pub(crate) fn pack_hints(hints: &[impl AsRef<str>], max_width: usize) -> String {
    let mut packed = String::new();
    let mut line_width = 0;
    for hint in hints {
        let hint = hint.as_ref();
        let hint_width = width(hint);
        if line_width == 0 {
            line_width = hint_width;
        } else if line_width + 3 + hint_width <= max_width {
            packed.push_str("   ");
            line_width += 3 + hint_width;
        } else {
            packed.push('\n');
            line_width = hint_width;
        }
        packed.push_str(hint);
    }
    packed
}

/// Port of x/ansi `Wrap(s, limit, "")` (what the Go footer uses for status
/// messages) on plain text: a word wrap that also cuts words longer than the
/// limit, and treats `-` as a breakpoint. Kept step-for-step identical,
/// including Go's slightly different rules for ASCII and other characters,
/// so long errors break on the same columns in both builds.
pub(crate) fn hard_wrap(value: &str, limit: usize) -> String {
    if limit < 1 {
        return value.to_string();
    }
    let mut wrap = HardWrap { limit, ..HardWrap::default() };
    let mut rest = value;
    while let Some(c) = rest.chars().next() {
        if c.is_ascii() {
            rest = &rest[1..];
            wrap.ascii(c);
        } else {
            let cluster = rest.graphemes(true).next().unwrap_or(rest);
            rest = &rest[cluster.len()..];
            wrap.cluster(cluster);
        }
    }
    wrap.finish()
}

#[derive(Default)]
struct HardWrap {
    limit: usize,
    buf: String,
    word: String,
    space: String,
    space_width: usize,
    cur_width: usize,
    word_len: usize,
}

impl HardWrap {
    fn add_space(&mut self) {
        self.cur_width += self.space_width;
        self.buf.push_str(&self.space);
        self.space.clear();
        self.space_width = 0;
    }

    fn add_word(&mut self) {
        if self.word.is_empty() {
            return;
        }
        self.add_space();
        self.cur_width += self.word_len;
        self.buf.push_str(&self.word);
        self.word.clear();
        self.word_len = 0;
    }

    fn add_newline(&mut self) {
        self.buf.push('\n');
        self.cur_width = 0;
        self.space.clear();
        self.space_width = 0;
    }

    /// Keeps trailing spaces that still fit; drops them otherwise.
    fn flush_spaces(&mut self) {
        if self.word_len == 0 {
            if self.cur_width + self.space_width > self.limit {
                self.cur_width = 0;
            } else {
                self.buf.push_str(&self.space);
            }
            self.space.clear();
            self.space_width = 0;
        }
    }

    fn ascii(&mut self, c: char) {
        match c {
            '\n' => {
                self.flush_spaces();
                self.add_word();
                self.add_newline();
            }
            ' ' | '\t' | '\r' | '\x0b' | '\x0c' => {
                self.add_word();
                self.space.push(c);
                self.space_width += 1;
            }
            '-' => {
                self.add_space();
                if self.cur_width + self.word_len >= self.limit {
                    self.word.push(c);
                    self.word_len += 1;
                } else {
                    self.add_word();
                    self.buf.push(c);
                    self.cur_width += 1;
                }
            }
            _ => {
                if self.cur_width == self.limit {
                    self.add_newline();
                }
                self.word.push(c);
                self.word_len += 1;
                if self.word_len == self.limit {
                    self.add_word();
                }
                if self.cur_width + self.word_len + self.space_width > self.limit {
                    self.add_newline();
                }
            }
        }
    }

    fn cluster(&mut self, cluster: &str) {
        let cells = grapheme_width(cluster);
        let is_space = cluster.chars().next().is_some_and(|c| c.is_whitespace() && c != '\u{a0}');
        if is_space {
            self.add_word();
            self.space.push_str(cluster);
            self.space_width += cells;
            return;
        }
        if self.word_len + cells > self.limit {
            self.add_word();
        }
        self.word.push_str(cluster);
        self.word_len += cells;
        if self.cur_width + self.word_len + self.space_width > self.limit {
            self.add_newline();
        }
        if self.word_len == self.limit {
            self.add_word();
        }
    }

    fn finish(mut self) -> String {
        self.flush_spaces();
        self.add_word();
        self.buf
    }
}

#[cfg(test)]
mod tests {
    use ratatui::style::{Modifier, Stylize};

    use super::*;

    #[test]
    fn truncate_keeps_utf8_intact() {
        let got = truncate("Víkingur Ólafsson, Frédéric Chopin", 12);
        assert_eq!(width(&got), 12, "truncate() = {got:?}");
        assert!(got.ends_with("..."), "truncate() = {got:?}, want ellipsis");
        assert_eq!(got, "Víkingur ...");
    }

    #[test]
    fn truncate_edge_widths() {
        assert_eq!(truncate("anything", 0), "");
        assert_eq!(truncate("fits", 4), "fits");
        assert_eq!(truncate("abcdef", 3), "abc");
        assert_eq!(truncate("abcdef", 5), "ab...");
        // A wide character that would straddle the cut is dropped, not split.
        assert_eq!(truncate("ab漢字漢字", 6), "ab...");
        assert_eq!(truncate("ab漢字漢字", 7), "ab漢...");
        assert_eq!(truncate("ab漢字漢字", 8), "ab漢...");
    }

    #[test]
    fn simple_characters_are_single_width_standalone_graphemes() {
        for c in (0..=0x2fff_u32).filter_map(char::from_u32).filter(|c| is_simple(*c)) {
            let alone = c.to_string();
            assert_eq!(alone.as_str().cell_width(), 1, "{c:?} (U+{:04X}) must be one cell", c as u32);
            for neighbor in ['a', '\u{e9}', '\u{2013}', c] {
                let pair = format!("{neighbor}{c}");
                assert_eq!(pair.graphemes(true).count(), 2, "{c:?} must not join {neighbor:?}");
            }
        }
        assert!(!is_simple('\u{301}') && !is_simple('\u{ad}') && !is_simple('\u{200d}') && !is_simple('\t'));
    }

    #[test]
    fn write_line_matches_set_line() {
        let line = Line::from(vec!["Scherzo – Più lento ".bold(), "e\u{301}漢字".dim(), " end".reversed()]);
        for max_width in [0, 5, 20, 24, 40] {
            let area = ratatui::layout::Rect::new(0, 0, 30, 1);
            let (mut fast, mut reference) = (Buffer::empty(area), Buffer::empty(area));
            write_line(&mut fast, 2, 0, &line, max_width);
            reference.set_line(2, 0, &line, max_width);
            assert_eq!(fast, reference, "max_width={max_width}");
        }
    }

    #[test]
    fn width_counts_cells() {
        assert_eq!(width("Chopin"), 6);
        assert_eq!(width("Frédéric"), 8);
        assert_eq!(width("e\u{301}"), 1);
        assert_eq!(width("漢字"), 4);
        assert_eq!(width("a\tb"), 2);
        assert_eq!(width("Scherzo – Più lento"), 19);
        assert_eq!(truncate("Scherzo – Più lento", 12), "Scherzo –...");
    }

    #[test]
    fn wrap_text_breaks_on_words() {
        assert_eq!(wrap_text("", 10), vec![""]);
        assert_eq!(wrap_text("one two three four", 9), vec!["one two", "three", "four"]);
        assert_eq!(wrap_text("first\n\nsecond", 20), vec!["first", "", "second"]);
        assert_eq!(wrap_text("supercalifragilistic word", 5), vec!["supercalifragilistic", "word"]);
    }

    fn plain(lines: &[Line<'_>]) -> Vec<String> {
        lines.iter().map(|line| line.spans.iter().map(|span| span.content.as_ref()).collect()).collect()
    }

    #[test]
    fn wrap_line_drops_overflowing_trailing_space() {
        // The Go selected row with a three-digit ID: one cell too wide, and
        // the extra cell is the trailing highlight space.
        let line = Line::from(vec![" ".reversed(), "150  Title...".reversed(), " ".reversed()]);
        let wrapped = wrap_line(&line, 14);
        assert_eq!(plain(&wrapped), vec![" 150  Title..."]);
        assert!(wrapped[0].spans.iter().all(|span| span.style.add_modifier.contains(Modifier::REVERSED)));
    }

    #[test]
    fn wrap_line_moves_last_word_and_hard_breaks() {
        let line = Line::from("1234  Sonata in B-flat...");
        assert_eq!(plain(&wrap_line(&line, 20)), vec!["1234  Sonata in B-", "flat..."]);
        assert_eq!(plain(&wrap_line(&Line::from("abcdefghij"), 4)), vec!["abcd", "efgh", "ij"]);
        assert_eq!(plain(&wrap_line(&Line::from("short"), 10)), vec!["short"]);
        // Reference outputs captured from Go's ansi.Wrap.
        assert_eq!(
            plain(&wrap_line(&Line::from("Opinion: https://example.com/a/very/long/url/that/never/ends ok"), 16)),
            vec!["Opinion:", "https://example.", "com/a/very/long/", "url/that/never/e", "nds ok"]
        );
        assert_eq!(plain(&wrap_line(&Line::from("  leading and   gaps  "), 8)), vec!["", "leading", "and", "gaps  "]);
    }

    #[test]
    fn expand_tabs_matches_lipgloss() {
        assert_eq!(expand_tabs("a\tb"), "a    b");
        assert!(matches!(expand_tabs("plain"), Cow::Borrowed(_)));
    }
}
