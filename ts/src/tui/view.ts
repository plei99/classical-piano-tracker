/**
 * Rendering, part one: `view(model)` builds a frame description (rows of
 * styled spans plus the bordered panes) that the Ink components in
 * `frame.tsx` draw. Keeping it pure lets tests inspect layout without a
 * terminal. The geometry follows the Go Lip Gloss layout cell for cell.
 */
import type { ListRow, Model } from '../app/model';
import {
  EDITOR_HELP,
  formatTime,
  LOADING_TEXT,
  NO_TRACKS_TEXT,
  RETRY_TEXT,
  SUBTITLE,
  TITLE as TITLE_TEXT,
  details,
  draftOpinionLine,
  errorText,
  hintText,
  hints,
  noMatchText,
  ratingDraftStarsLabel,
  screen,
  status,
  trackListSummary,
} from '../app/presenter';
import {
  clipLine,
  expandTabs,
  fit,
  hardWrap,
  type Line,
  lineWidth,
  packHints,
  type Style,
  trimLines,
  wrapLine,
  wrapText,
} from './text';

const MIN_PANE_CONTENT_HEIGHT = 8;
const VERTICAL_LAYOUT_WIDTH_CUT = 90;
/** The blank margin around the whole frame, in cells. */
export const APP_PADDING = 1;
/**
 * Rows above the body: title, subtitle, a blank line, and the blank line
 * between the body and the footer.
 */
const HEADER_HEIGHT = 4;
/** Border plus padding on both sides of a pane. */
const PANE_FRAME = 4;
/** Border only; Lip Gloss v2 counts it inside Width/Height. */
const PANE_BORDER = 2;

const PLAIN: Style = {};
const TITLE: Style = { bold: true };
const MUTED: Style = { dim: true };
const HIGHLIGHT: Style = { bold: true };
const SELECTED_ROW: Style = { inverse: true };
/** A muted subtitle inside the reversed selection. */
const SELECTED_MUTED: Style = { inverse: true, dim: true };
const STATUS_BAR: Style = { dim: true };
const ERROR: Style = { bold: true };

const BLANK: Line = [];
const ELLIPSIS: Line = [{ text: '...', style: MUTED }];

/**
 * Pane geometry, as in the Go `layout()`. Widths are the box inside the
 * border (padding included); heights are content lines.
 */
export interface Layout {
  readonly vertical: boolean;
  readonly listWidth: number;
  readonly detailWidth: number;
  readonly listHeight: number;
  readonly detailHeight: number;
  /**
   * The box the panes must fit. Borders, padding, and minimum widths can
   * need more room than a small window has, so the body is clipped to this
   * box and the header and footer always stay on screen.
   */
  readonly bodyWidth: number;
  readonly bodyHeight: number;
}

/** A bordered, padded pane. Like Lip Gloss, `height` is a minimum: taller content grows the pane. */
export interface Pane {
  /** Width inside the border, padding included (Go's pane width). */
  readonly width: number;
  /** Minimum content lines (Go's pane height). */
  readonly height: number;
  /** Content lines, already wrapped to fit inside the padding. */
  readonly lines: readonly Line[];
}

/** The list and detail panes, side by side or stacked, clipped to `width` x `height`. */
export interface Body {
  readonly vertical: boolean;
  readonly list: Pane;
  readonly detail: Pane;
  readonly width: number;
  readonly height: number;
  /**
   * Whether the panes overflow the box. Only very small windows need
   * clipping, and skipping it spares Ink a slice of every line.
   */
  readonly clipped: boolean;
}

export type Row = { readonly kind: 'line'; readonly line: Line } | { readonly kind: 'body'; readonly body: Body };

/** A whole frame, top to bottom, before the outer margin is applied. */
export interface Frame {
  readonly rows: readonly Row[];
  /** Rows the frame occupies, including the outer margin. */
  readonly height: number;
  /**
   * Set when the frame is taller than the window: the terminal shows only
   * its top rows, as Bubble Tea did.
   */
  readonly clipHeight: number | null;
}

/** Outer size of a pane, border included. */
function paneSize(pane: Pane): { width: number; height: number } {
  return { width: pane.width + PANE_BORDER, height: Math.max(pane.height, pane.lines.length) + PANE_FRAME };
}

/** Size of the stacked or side-by-side panes before clipping. */
function bodyNaturalSize(vertical: boolean, list: Pane, detail: Pane): { width: number; height: number } {
  const a = paneSize(list);
  const b = paneSize(detail);
  return vertical
    ? { width: Math.max(a.width, b.width), height: a.height + b.height }
    : { width: a.width + b.width, height: Math.max(a.height, b.height) };
}

/** Builds a pane, re-wrapping any line wider than the padded box as Lip Gloss does. */
function makePane(width: number, height: number, lines: Line[]): Pane {
  const textWidth = Math.max(0, width - 2);
  if (lines.some((line) => lineWidth(line) > textWidth)) {
    lines = lines.flatMap((line) => (lineWidth(line) > textWidth ? wrapLine(line, textWidth) : [line]));
  }
  return { width, height, lines };
}

function styled(text: string, style: Style): Line {
  return [{ text, style }];
}

/** Builds the track browser: header, list and detail panes, footer. */
export function view(m: Model): Frame {
  const rows: Row[] = [];
  const text = (value: string, style: Style) => {
    for (const line of value.split('\n')) {
      rows.push({ kind: 'line', line: styled(line, style) });
    }
  };
  const blank = () => rows.push({ kind: 'line', line: BLANK });

  text(TITLE_TEXT, TITLE);
  const current = screen(m);
  if (current === 'loading') {
    blank();
    text(LOADING_TEXT, PLAIN);
  } else if (current === 'error') {
    blank();
    text(expandTabs(errorText(m)), ERROR);
    blank();
    text(RETRY_TEXT, STATUS_BAR);
  } else if (current === 'empty') {
    blank();
    text(NO_TRACKS_TEXT, MUTED);
    blank();
    text(footerView(m), STATUS_BAR);
  } else {
    text(SUBTITLE, MUTED);
    blank();
    const footer = footerView(m);
    if (current === 'noMatch') {
      text(expandTabs(noMatchText(m)), MUTED);
      blank();
    } else {
      const geometry = layout(m, footer.split('\n').length);
      const list = makePane(
        geometry.listWidth,
        geometry.listHeight,
        renderList(m, geometry.listWidth, geometry.listHeight),
      );
      const detail = makePane(
        geometry.detailWidth,
        geometry.detailHeight,
        renderDetails(m, geometry.detailWidth, geometry.detailHeight),
      );
      const natural = bodyNaturalSize(geometry.vertical, list, detail);
      const height = Math.min(natural.height, geometry.bodyHeight);
      // A body clipped to nothing is dropped with its separator, as in Go.
      if (height > 0) {
        const clipped = natural.height > geometry.bodyHeight || natural.width > geometry.bodyWidth;
        rows.push({
          kind: 'body',
          body: { vertical: geometry.vertical, list, detail, width: geometry.bodyWidth, height, clipped },
        });
        blank();
      }
    }
    text(footer, STATUS_BAR);
  }

  // The terminal cuts lines at the window edge; do the same so the frame
  // never wraps.
  if (m.width > 0) {
    const maxWidth = Math.max(0, m.width - APP_PADDING);
    for (const [index, row] of rows.entries()) {
      if (row.kind === 'line') {
        const clipped = clipLine(row.line, maxWidth);
        if (clipped !== row.line) {
          rows[index] = { kind: 'line', line: clipped };
        }
      }
    }
  }

  let height = 2 * APP_PADDING;
  for (const row of rows) {
    height += row.kind === 'line' ? 1 : row.body.height;
  }
  return { rows, height, clipHeight: m.height > 0 && height > m.height ? m.height : null };
}

/** The width inside the outer margin. Before the first resize it assumes a 100-column terminal. */
export function frameWidth(m: Model): number {
  const width = m.width > 0 ? m.width : 100;
  return Math.max(1, width - 2 * APP_PADDING);
}

export function layout(m: Model, footerHeight = footerView(m).split('\n').length): Layout {
  const width = m.width > 0 ? m.width : 100;
  const height = m.height > 0 ? m.height : 28;

  const availableWidth = Math.max(40, width - 2 * APP_PADDING);
  const bodyHeight = Math.max(0, height - 2 * APP_PADDING - HEADER_HEIGHT - footerHeight);

  if (availableWidth < VERTICAL_LAYOUT_WIDTH_CUT) {
    const paneWidth = Math.max(30, availableWidth - PANE_FRAME);
    const listHeight = Math.max(0, Math.floor(bodyHeight / 2) - PANE_FRAME);
    const detailHeight = Math.max(0, bodyHeight - Math.floor(bodyHeight / 2) - PANE_FRAME);
    return {
      vertical: true,
      listWidth: paneWidth,
      detailWidth: paneWidth,
      listHeight: clampPaneHeight(listHeight, listHeight),
      detailHeight: clampPaneHeight(detailHeight, detailHeight),
      bodyWidth: frameWidth(m),
      bodyHeight,
    };
  }

  const listWidth = Math.min(44, Math.floor(availableWidth / 2));
  const detailWidth = Math.max(34, availableWidth - listWidth - 1 - PANE_FRAME);
  const paneHeight = bodyHeight - PANE_FRAME;
  return {
    vertical: false,
    listWidth: Math.max(28, listWidth - PANE_FRAME),
    detailWidth,
    listHeight: clampPaneHeight(paneHeight, paneHeight),
    detailHeight: clampPaneHeight(paneHeight, paneHeight),
    bodyWidth: frameWidth(m),
    bodyHeight,
  };
}

function clampPaneHeight(height: number, availableHeight: number): number {
  if (availableHeight <= 0) {
    return 0;
  }
  if (availableHeight < MIN_PANE_CONTENT_HEIGHT) {
    return availableHeight;
  }
  return Math.max(MIN_PANE_CONTENT_HEIGHT, height);
}

/** The slice of the filtered list shown in the list pane. */
export interface VisibleTracks {
  readonly rows: readonly ListRow[];
  readonly offset: number;
  readonly hiddenAbove: boolean;
  readonly hiddenBelow: boolean;
}

/**
 * Picks the rows to show so the selection stays centered while scrolling.
 * Only these rows are ever formatted.
 */
export function visibleTracks(m: Model, height: number): VisibleTracks {
  // Below the 3 heading lines, each track takes 2 lines.
  const availableLines = Math.max(2, height - 3);
  const { count } = m.list;
  if (count <= Math.floor(availableLines / 2)) {
    return { rows: rowsBetween(m, 0, count), offset: 0, hiddenAbove: false, hiddenBelow: false };
  }

  // Scrolling adds an "... N earlier" and/or "... N more" line. Reserve both
  // so the window keeps one size while scrolling and never grows the pane
  // past its height.
  const maxVisible = Math.max(1, Math.floor((availableLines - 2) / 2));
  let start = Math.max(0, m.selectedIndex - Math.floor(maxVisible / 2));
  if (start + maxVisible > count) {
    start = count - maxVisible;
  }
  const end = start + maxVisible;
  return { rows: rowsBetween(m, start, end), offset: start, hiddenAbove: start > 0, hiddenBelow: end < count };
}

/** The TUI's list is in memory, so every row in range is loaded. */
function rowsBetween(m: Model, start: number, end: number): ListRow[] {
  const rows: ListRow[] = [];
  for (let index = start; index < end; index++) {
    const row = m.list.row(index);
    if (row !== null) {
      rows.push(row);
    }
  }
  return rows;
}

function renderList(m: Model, width: number, height: number): Line[] {
  const lines: Line[] = [styled('Tracks', TITLE), styled(trackListSummary(m), MUTED), BLANK];

  const { rows, offset, hiddenAbove, hiddenBelow } = visibleTracks(m, height);
  if (hiddenAbove) {
    lines.push(styled(`... ${offset} earlier`, MUTED));
  }

  const titleWidth = Math.max(10, width - 8);
  const artistWidth = Math.max(10, width - 6);
  for (const [index, { track, artists }] of rows.entries()) {
    const line = `${String(track.id).padStart(2)}  ${fit(track.trackName, titleWidth)}`;
    const subtitle = `    ${fit(artists, artistWidth)}`;
    if (offset + index === m.selectedIndex) {
      // Lip Gloss pads the highlight by one cell on each side.
      const pad = { text: ' ', style: SELECTED_ROW };
      lines.push([pad, { text: line, style: SELECTED_ROW }, pad]);
      lines.push([pad, { text: subtitle, style: SELECTED_MUTED }, pad]);
      continue;
    }
    lines.push(styled(line, PLAIN), styled(subtitle, MUTED));
  }

  if (hiddenBelow) {
    lines.push(styled(`... ${m.list.count - (offset + rows.length)} more`, MUTED));
  }
  return lines;
}

function renderDetails(m: Model, width: number, height: number): Line[] {
  const shown = details(m);
  if (shown === null) {
    return [styled('Track Details', TITLE), BLANK, styled('No track selected.', MUTED)];
  }
  const textWidth = Math.max(16, width - 2);
  const { track, artists } = shown;

  if (m.editingRating) {
    const lines: Line[] = [
      styled('Rating Editor', TITLE),
      BLANK,
      styled(fit(track.trackName, textWidth), HIGHLIGHT),
      styled(fit(artists, textWidth), MUTED),
      BLANK,
      editorFieldLabel(`Stars: ${ratingDraftStarsLabel(m)}`, !m.editingOpinion),
      editorFieldLabel('Opinion:', m.editingOpinion),
    ];
    const opinion = wrapText(expandTabs(draftOpinionLine(m)), textWidth).map((line) => styled(line, PLAIN));
    lines.push(...trimLines(opinion, Math.max(1, height - lines.length - 2), ELLIPSIS));
    lines.push(BLANK, ...EDITOR_HELP.map((line) => styled(line, MUTED)));
    return trimLines(lines, height, ELLIPSIS);
  }

  const lines: Line[] = [
    styled('Track Details', TITLE),
    BLANK,
    styled(fit(track.trackName, textWidth), HIGHLIGHT),
    styled(fit(artists, textWidth), MUTED),
    BLANK,
    ...shown.fields.map(({ label, value }) => styled(fit(`${label}: ${value}`, textWidth), PLAIN)),
  ];

  const rating = shown.rating;
  if (rating === 'saving') {
    lines.push(BLANK, styled('Rating: saving...', MUTED));
  } else if (rating === null) {
    lines.push(BLANK, styled('Rating: none', MUTED));
  } else {
    lines.push(BLANK, styled(`Rating: ${rating.stars}/5`, PLAIN));
    if (rating.opinion !== '') {
      const opinion = wrapText(expandTabs(`Opinion: ${rating.opinion}`), textWidth).map((line) => styled(line, PLAIN));
      lines.push(...trimLines(opinion, 3, ELLIPSIS));
    }
    lines.push(styled(`Updated: ${formatTime(rating.updatedAt, m.timeZone)}`, MUTED));
  }
  return trimLines(lines, height, ELLIPSIS);
}

function editorFieldLabel(label: string, focused: boolean): Line {
  return focused ? styled(`> ${label}`, HIGHLIGHT) : styled(`  ${label}`, PLAIN);
}

/**
 * The status line (if any) above the key help, wrapped to the frame width.
 * Plain text; the frame draws it faint.
 */
export function footerView(m: Model): string {
  const width = frameWidth(m);
  // Status text can be arbitrarily long (e.g. API errors), so it wraps; key
  // hints are packed whole.
  const base = packHints(hints(m).map(hintText), width);
  const line = status(m);
  return line === null ? base : `${hardWrap(expandTabs(line.text), width)}\n${base}`;
}

export { formatTime } from '../app/presenter';
