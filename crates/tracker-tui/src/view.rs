//! Rendering. `Draw::view` builds a frame description from the shared model
//! (pure, so tests can inspect it), and `View::render` draws it into a
//! ratatui buffer. The words come from [`presenter`], shared with the web
//! UI; the geometry follows the Go Lip Gloss layout cell for cell.

use std::borrow::Cow;

use ratatui::Frame;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Padding, Widget};

use tracker_app::presenter::{self, RatingView, Screen};
use tracker_app::{Model, TrackList};

use crate::text::{expand_tabs, hard_wrap, line_width, pack_hints, truncate, wrap_line, wrap_text, write_line};

const MIN_PANE_CONTENT_HEIGHT: isize = 8;
const VERTICAL_LAYOUT_WIDTH_CUT: isize = 90;
/// The blank margin around the whole frame, in cells.
const APP_PADDING: usize = 1;
/// Rows above the body: title, subtitle, a blank line, and the blank line
/// between the body and the footer.
const HEADER_HEIGHT: isize = 4;
/// Border plus padding on each side of a pane.
const PANE_FRAME: isize = 4;
/// Border only; Lip Gloss v2 counts it inside Width/Height.
const PANE_BORDER: usize = 2;
/// Padding rows above and below a pane's content.
const PANE_PADDING: usize = 2;

const TITLE: Style = Style::new().add_modifier(Modifier::BOLD);
const MUTED: Style = Style::new().add_modifier(Modifier::DIM);
const HIGHLIGHT: Style = Style::new().add_modifier(Modifier::BOLD);
const SELECTED_ROW: Style = Style::new().add_modifier(Modifier::REVERSED);
const STATUS_BAR: Style = Style::new().add_modifier(Modifier::DIM);
const ERROR: Style = Style::new().add_modifier(Modifier::BOLD);

/// Pane geometry, as in the Go `layout()`. Widths are the inner box (padding
/// included, border excluded); heights are content lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Layout {
    pub(crate) vertical: bool,
    pub(crate) list_width: usize,
    pub(crate) detail_width: usize,
    pub(crate) list_height: usize,
    pub(crate) detail_height: usize,
    /// The box the panes must fit. Borders, padding, and minimum widths can
    /// need more room than a small window has, so the body is clipped to
    /// this box and the header and footer always stay on screen.
    pub(crate) body_width: usize,
    pub(crate) body_height: usize,
}

/// The slice of the filtered list shown in the list pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) hidden_above: bool,
    pub(crate) hidden_below: bool,
}

/// A whole frame, top to bottom, before the outer margin is applied.
pub struct View<'a> {
    rows: Vec<Row<'a>>,
}

enum Row<'a> {
    Text(Line<'a>),
    Body(Body<'a>),
}

/// The list and detail panes, side by side or stacked, clipped to
/// `max_width` x `max_height`.
struct Body<'a> {
    vertical: bool,
    list: Pane<'a>,
    detail: Pane<'a>,
    max_width: usize,
    max_height: usize,
}

/// A bordered, padded pane. Like Lip Gloss, the height is a minimum: content
/// taller than the pane grows it rather than being cut.
struct Pane<'a> {
    width: usize,
    height: usize,
    lines: Vec<Line<'a>>,
}

impl<'a> Pane<'a> {
    fn new(width: usize, min_height: usize, lines: Vec<Line<'a>>) -> Pane<'a> {
        let text_width = width.saturating_sub(2);
        let lines = if lines.iter().any(|line| line_width(line) > text_width) {
            lines
                .into_iter()
                .flat_map(|line| if line_width(&line) > text_width { wrap_line(&line, text_width) } else { vec![line] })
                .collect()
        } else {
            lines
        };
        let height = min_height.max(lines.len() + 2);
        Pane { width, height, lines }
    }

    fn outer_width(&self) -> usize {
        self.width + PANE_BORDER
    }

    fn outer_height(&self) -> usize {
        self.height + PANE_BORDER
    }

    fn render(self, x: usize, y: usize, buf: &mut Buffer) {
        let (Ok(x), Ok(y)) = (u16::try_from(x), u16::try_from(y)) else { return };
        let width = u16::try_from(self.outer_width()).unwrap_or(u16::MAX);
        let height = u16::try_from(self.outer_height()).unwrap_or(u16::MAX);
        render_clipped(PaneWidget { lines: self.lines }, Rect::new(x, y, width, height), buf);
    }
}

/// A rounded, padded block with left-aligned, unwrapped lines: a minimal
/// `Paragraph` that writes text through the fast [`write_line`] path.
struct PaneWidget<'a> {
    lines: Vec<Line<'a>>,
}

impl Widget for PaneWidget<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let block = Block::bordered().border_type(BorderType::Rounded).padding(Padding::uniform(1));
        let inner = block.inner(area);
        block.render(area, buf);
        for (line, y) in self.lines.iter().zip(inner.top()..inner.bottom()) {
            write_line(buf, inner.x, y, line, inner.width);
        }
    }
}

impl Body<'_> {
    /// Size of the panes before clipping.
    fn natural_size(&self) -> (usize, usize) {
        if self.vertical {
            (
                self.list.outer_width().max(self.detail.outer_width()),
                self.list.outer_height() + self.detail.outer_height(),
            )
        } else {
            (
                self.list.outer_width() + self.detail.outer_width(),
                self.list.outer_height().max(self.detail.outer_height()),
            )
        }
    }

    fn height(&self) -> usize {
        self.natural_size().1.min(self.max_height)
    }

    fn render(self, x: usize, y: usize, buf: &mut Buffer) {
        let (width, height) = self.natural_size();
        if width <= self.max_width && height <= self.max_height {
            self.render_unclipped(x, y, buf);
            return;
        }
        // Only very small windows get here: draw in full off screen and copy
        // the part inside the clip box, like Go's clipBlock.
        let (Ok(scratch_width), Ok(scratch_height)) = (u16::try_from(width), u16::try_from(height)) else { return };
        let mut scratch = Buffer::empty(Rect::new(0, 0, scratch_width, scratch_height));
        let (max_width, max_height) = (self.max_width, self.max_height);
        self.render_unclipped(0, 0, &mut scratch);
        for dy in 0..height.min(max_height) {
            for dx in 0..width.min(max_width) {
                let (Ok(bx), Ok(by)) = (u16::try_from(x + dx), u16::try_from(y + dy)) else { continue };
                if buf.area.contains((bx, by).into()) {
                    buf[(bx, by)] = scratch[(dx as u16, dy as u16)].clone();
                }
            }
        }
    }

    fn render_unclipped(self, x: usize, y: usize, buf: &mut Buffer) {
        let (detail_x, detail_y) =
            if self.vertical { (x, y + self.list.outer_height()) } else { (x + self.list.outer_width(), y) };
        self.list.render(x, y, buf);
        self.detail.render(detail_x, detail_y, buf);
    }
}

/// Renders a widget whose rect may extend past the buffer. A terminal shows
/// the top-left of an oversized frame, so the widget is drawn in full off
/// screen and only the visible part is copied, keeping borders where they
/// belong instead of squeezing the widget into the visible area.
fn render_clipped(widget: impl Widget, rect: Rect, buf: &mut Buffer) {
    let visible = rect.intersection(buf.area);
    if visible.is_empty() {
        return;
    }
    if visible == rect {
        widget.render(rect, buf);
        return;
    }
    let mut scratch = Buffer::empty(Rect::new(0, 0, rect.width, rect.height));
    widget.render(scratch.area, &mut scratch);
    for y in visible.top()..visible.bottom() {
        for x in visible.left()..visible.right() {
            buf[(x, y)] = scratch[(x - rect.x, y - rect.y)].clone();
        }
    }
}

impl<'a> View<'a> {
    fn new() -> View<'a> {
        View { rows: Vec::with_capacity(16) }
    }

    /// Adds `text` as one row per line, all in `style`.
    fn text(&mut self, text: impl Into<Cow<'a, str>>, style: Style) {
        match text.into() {
            Cow::Borrowed(text) => {
                for line in text.split('\n') {
                    self.rows.push(Row::Text(Line::from(Span::styled(line, style))));
                }
            }
            Cow::Owned(text) if !text.contains('\n') => {
                self.rows.push(Row::Text(Line::from(Span::styled(text, style))))
            }
            Cow::Owned(text) => {
                for line in text.split('\n') {
                    self.rows.push(Row::Text(Line::from(Span::styled(line.to_string(), style))));
                }
            }
        }
    }

    fn blank(&mut self) {
        self.rows.push(Row::Text(Line::default()));
    }

    /// Rows the frame occupies, including the outer margin.
    #[cfg(test)]
    pub(crate) fn height(&self) -> usize {
        let rows: usize = self
            .rows
            .iter()
            .map(|row| match row {
                Row::Text(_) => 1,
                Row::Body(body) => body.height(),
            })
            .sum();
        rows + 2 * APP_PADDING
    }

    /// Draws the frame into `area`, offset by the outer margin.
    pub(crate) fn render(self, area: Rect, buf: &mut Buffer) {
        let area = area.intersection(buf.area);
        let (right, bottom) = (usize::from(area.right()), usize::from(area.bottom()));
        let x = usize::from(area.x) + APP_PADDING;
        let mut y = usize::from(area.y) + APP_PADDING;
        for row in self.rows {
            if y >= bottom {
                break;
            }
            match row {
                Row::Text(line) => {
                    if x < right {
                        // Both fit in u16: they are inside the buffer area.
                        write_line(buf, x as u16, y as u16, &line, (right - x) as u16);
                    }
                    y += 1;
                }
                Row::Body(body) => {
                    let height = body.height();
                    body.render(x, y, buf);
                    y += height;
                }
            }
        }
    }
}

/// Truncates user text to `max_width` cells after expanding tabs.
fn fit(value: &str, max_width: usize) -> Cow<'_, str> {
    match expand_tabs(value) {
        Cow::Borrowed(value) => truncate(value, max_width),
        Cow::Owned(value) => Cow::Owned(truncate(&value, max_width).into_owned()),
    }
}

fn styled<'a>(text: impl Into<Cow<'a, str>>, style: Style) -> Line<'a> {
    Line::from(Span::styled(text, style))
}

/// Caps `lines` at `height`, replacing the last kept line with a muted
/// ellipsis. Zero means no limit, as in Go.
fn trim_lines(mut lines: Vec<Line<'_>>, height: isize) -> Vec<Line<'_>> {
    if height <= 0 || lines.len() <= height as usize {
        return lines;
    }
    if height <= 1 {
        lines.truncate(1);
        return lines;
    }
    lines.truncate(height as usize - 1);
    lines.push(styled("...", MUTED));
    lines
}

fn editor_field_label(label: String, focused: bool) -> Line<'static> {
    if focused { styled(format!("> {label}"), HIGHLIGHT) } else { Line::from(format!("  {label}")) }
}

/// Drawing the shared model on a character grid.
pub trait Draw {
    /// Draws the model into a ratatui frame.
    fn render(&self, frame: &mut Frame<'_>);
    /// Draws the model into any buffer (used by tests and benches).
    fn render_to(&self, area: Rect, buf: &mut Buffer);
    /// Builds the track browser: header, list and detail panes, footer.
    fn view(&self) -> View<'_>;
    /// The width inside the outer margin.
    fn frame_width(&self) -> usize;
    fn layout(&self) -> Layout;
    /// Picks the rows to show so the selection stays centered while
    /// scrolling.
    fn visible_tracks(&self, height: usize) -> Window;
    fn list_lines(&self, width: usize, height: usize) -> Vec<Line<'_>>;
    fn detail_lines(&self, width: usize, height: usize) -> Vec<Line<'_>>;
    /// The status line (if any) above the key help, joined with newlines
    /// and wrapped to the frame width.
    fn footer(&self) -> String;
}

impl Draw for Model {
    fn render(&self, frame: &mut Frame<'_>) {
        let area = frame.area();
        self.render_to(area, frame.buffer_mut());
    }

    fn render_to(&self, area: Rect, buf: &mut Buffer) {
        self.view().render(area, buf);
    }

    fn view(&self) -> View<'_> {
        let mut view = View::new();
        view.text(presenter::TITLE, TITLE);

        match presenter::screen(self) {
            Screen::Loading => {
                view.blank();
                view.text(presenter::LOADING_TEXT, Style::new());
                return view;
            }
            Screen::Error => {
                view.blank();
                view.text(expand_tabs(&presenter::error_text(self)).into_owned(), ERROR);
                view.blank();
                view.text(presenter::RETRY_TEXT, STATUS_BAR);
                return view;
            }
            Screen::Empty => {
                view.blank();
                view.text(presenter::NO_TRACKS_TEXT, MUTED);
                view.blank();
                view.text(self.footer(), STATUS_BAR);
                return view;
            }
            Screen::NoMatch | Screen::Browse => {}
        }

        view.text(presenter::SUBTITLE, MUTED);
        view.blank();
        if self.list.is_empty() {
            view.text(expand_tabs(&presenter::no_match_text(self)).into_owned(), MUTED);
            view.blank();
        } else {
            let layout = self.layout();
            // A pane's box is its content lines plus padding, as in Go's
            // renderPane, so both panes exactly fill the body.
            let list = Pane::new(
                layout.list_width,
                layout.list_height + PANE_PADDING,
                self.list_lines(layout.list_width, layout.list_height),
            );
            let detail = Pane::new(
                layout.detail_width,
                layout.detail_height + PANE_PADDING,
                self.detail_lines(layout.detail_width, layout.detail_height),
            );
            let body = Body {
                vertical: layout.vertical,
                list,
                detail,
                max_width: layout.body_width,
                max_height: layout.body_height,
            };
            // A body clipped to nothing is dropped with its separator, as in Go.
            if body.height() > 0 {
                view.rows.push(Row::Body(body));
                view.blank();
            }
        }
        view.text(self.footer(), STATUS_BAR);
        view
    }

    /// Before the first resize this assumes a 100-column terminal.
    fn frame_width(&self) -> usize {
        let width = if self.width > 0 { usize::from(self.width) } else { 100 };
        width.saturating_sub(2 * APP_PADDING).max(1)
    }

    fn layout(&self) -> Layout {
        let width = if self.width > 0 { self.width as isize } else { 100 };
        let height = if self.height > 0 { self.height as isize } else { 28 };
        let padding = APP_PADDING as isize;

        let available_width = (width - 2 * padding).max(40);
        let footer_height = self.footer().split('\n').count() as isize;
        let body_height = (height - 2 * padding - HEADER_HEIGHT - footer_height).max(0);

        if available_width < VERTICAL_LAYOUT_WIDTH_CUT {
            let pane_width = (available_width - PANE_FRAME).max(30);
            let list_height = (body_height / 2 - PANE_FRAME).max(0);
            let detail_height = (body_height - body_height / 2 - PANE_FRAME).max(0);
            return Layout {
                vertical: true,
                list_width: pane_width as usize,
                detail_width: pane_width as usize,
                list_height: clamp_pane_height(list_height, list_height),
                detail_height: clamp_pane_height(detail_height, detail_height),
                body_width: self.frame_width(),
                body_height: body_height as usize,
            };
        }

        let list_width = (available_width / 2).min(44);
        let detail_width = (available_width - list_width - 1 - PANE_FRAME).max(34);
        let list_width = (list_width - PANE_FRAME).max(28);
        let pane_height = body_height - PANE_FRAME;
        Layout {
            vertical: false,
            list_width: list_width as usize,
            detail_width: detail_width as usize,
            list_height: clamp_pane_height(pane_height, pane_height),
            detail_height: clamp_pane_height(pane_height, pane_height),
            body_width: self.frame_width(),
            body_height: body_height as usize,
        }
    }

    /// Only these rows are ever formatted.
    fn visible_tracks(&self, height: usize) -> Window {
        // Below the 3 heading lines, each track takes 2 lines.
        let available = (height as isize - 3).max(2) as usize;
        let len = self.list.len();
        if len <= available / 2 {
            return Window { start: 0, end: len, hidden_above: false, hidden_below: false };
        }
        // Scrolling adds an "... N earlier" and/or "... N more" line. Reserve
        // both so the window keeps one size while scrolling and never grows
        // the pane past its height.
        let max_visible = (available.saturating_sub(2) / 2).max(1);
        let start = self.selected_index.saturating_sub(max_visible / 2).min(len - max_visible);
        let end = start + max_visible;
        Window { start, end, hidden_above: start > 0, hidden_below: end < len }
    }

    fn list_lines(&self, width: usize, height: usize) -> Vec<Line<'_>> {
        let window = self.visible_tracks(height);
        let mut lines = Vec::with_capacity(5 + 2 * (window.end - window.start));
        lines.push(styled(presenter::TRACKS_HEADING, TITLE));
        lines.push(styled(presenter::track_list_summary(self), MUTED));
        lines.push(Line::default());
        if window.hidden_above {
            lines.push(styled(format!("... {} earlier", window.start), MUTED));
        }

        let title_width = width.saturating_sub(8).max(10);
        let artist_width = width.saturating_sub(6).max(10);
        for (position, row) in
            self.list.tracks[window.start..window.end].iter().map(|&index| &self.list.all_tracks[index]).enumerate()
        {
            let line = format!("{:2}  {}", row.track.id, fit(&row.track.track_name, title_width));
            let subtitle = format!("    {}", fit(&row.artists, artist_width));
            if window.start + position == self.selected_index {
                // Lip Gloss pads the highlight by one cell on each side.
                lines.push(Line::from(vec![
                    Span::styled(" ", SELECTED_ROW),
                    Span::styled(line, SELECTED_ROW),
                    Span::styled(" ", SELECTED_ROW),
                ]));
                lines.push(Line::from(vec![
                    Span::styled(" ", SELECTED_ROW),
                    Span::styled(subtitle, SELECTED_ROW.patch(MUTED)),
                    Span::styled(" ", SELECTED_ROW),
                ]));
            } else {
                lines.push(Line::from(line));
                lines.push(styled(subtitle, MUTED));
            }
        }

        if window.hidden_below {
            lines.push(styled(format!("... {} more", self.list.len() - window.end), MUTED));
        }
        lines
    }

    fn detail_lines(&self, width: usize, height: usize) -> Vec<Line<'_>> {
        let Some(details) = presenter::details(self) else {
            return vec![
                styled(presenter::DETAILS_HEADING, TITLE),
                Line::default(),
                styled(presenter::NO_SELECTION_TEXT, MUTED),
            ];
        };
        let track = details.track;
        let text_width = width.saturating_sub(2).max(16);
        let height = height as isize;

        if self.editing_rating {
            let mut lines = vec![
                styled(presenter::EDITOR_HEADING, TITLE),
                Line::default(),
                styled(fit(&track.track_name, text_width), HIGHLIGHT),
                styled(fit(details.artists, text_width), MUTED),
                Line::default(),
                editor_field_label(presenter::stars_field_label(self), !self.editing_opinion),
                editor_field_label(presenter::OPINION_LABEL.to_string(), self.editing_opinion),
            ];
            let opinion: Vec<Line<'_>> = wrap_text(&expand_tabs(&presenter::draft_opinion_line(self)), text_width)
                .into_iter()
                .map(Line::from)
                .collect();
            let room = (height - lines.len() as isize - 2).max(1);
            lines.extend(trim_lines(opinion, room));
            lines.push(Line::default());
            lines.extend(presenter::EDITOR_HELP.map(|help| styled(help, MUTED)));
            return trim_lines(lines, height);
        }

        let mut lines = vec![
            styled(presenter::DETAILS_HEADING, TITLE),
            Line::default(),
            styled(fit(&track.track_name, text_width), HIGHLIGHT),
            styled(fit(details.artists, text_width), MUTED),
            Line::default(),
        ];
        lines.extend(
            details.fields.iter().map(|field| Line::from(fit(&presenter::field_text(field), text_width).into_owned())),
        );

        lines.push(Line::default());
        match details.rating {
            RatingView::Saving => lines.push(styled(presenter::RATING_SAVING_TEXT, MUTED)),
            RatingView::Unrated => lines.push(styled(presenter::RATING_NONE_TEXT, MUTED)),
            RatingView::Rated(rating) => {
                lines.push(Line::from(presenter::rating_text(rating)));
                if !rating.opinion.is_empty() {
                    let opinion = wrap_text(&expand_tabs(&presenter::opinion_text(rating)), text_width)
                        .into_iter()
                        .map(Line::from)
                        .collect();
                    lines.extend(trim_lines(opinion, 3));
                }
                lines.push(styled(presenter::updated_text(self, rating), MUTED));
            }
        }
        trim_lines(lines, height)
    }

    fn footer(&self) -> String {
        let width = self.frame_width();
        let help: Vec<String> = presenter::hints(self).iter().map(presenter::hint_text).collect();
        // Status text can be arbitrarily long (e.g. API errors), so it wraps;
        // key hints are packed whole.
        let help = pack_hints(&help, width);
        match presenter::status(self) {
            Some(status) => format!("{}\n{help}", hard_wrap(&expand_tabs(&status.text), width)),
            None => help,
        }
    }
}

fn clamp_pane_height(height: isize, available: isize) -> usize {
    if available <= 0 {
        return 0;
    }
    if available < MIN_PANE_CONTENT_HEIGHT {
        return available as usize;
    }
    height.max(MIN_PANE_CONTENT_HEIGHT) as usize
}
