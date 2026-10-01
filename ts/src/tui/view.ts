/**
 * Rendering, part one: `view(model)` builds a frame description (rows of
 * styled spans plus the bordered panes) that the Ink components in
 * `frame.tsx` draw. Keeping it pure lets tests inspect layout without a
 * terminal. The geometry follows the Go Lip Gloss layout cell for cell.
 */
import type { Track } from '../core/model';
import { selectedRating, selectedTrack, sortModeLabel, textFor, totalTrackCount, type Model } from './model';
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

const browsingHints = [
  'j/k or arrows: move',
  'g/G: top/bottom',
  'o: sort',
  's: sync',
  'enter/e: rate',
  'r: reload',
  'q: quit',
];
const editingHints = ['1-5: stars', 'tab: switch field', 'ctrl+u: clear opinion', 'enter: save', 'esc: cancel'];
const searchHints = ['type: search', 'backspace: delete', 'enter: apply', 'esc: clear'];

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

  text('Classical Piano Tracker', TITLE);
  if (m.loadingTracks) {
    blank();
    text('Loading local tracks...', PLAIN);
  } else if (m.err !== null) {
    blank();
    text(`Error: ${expandTabs(m.err.message)}`, ERROR);
    blank();
    text('Press r to retry or q to quit.', STATUS_BAR);
  } else if (m.allTracks.length === 0 && m.tracks.length === 0) {
    blank();
    text('No local tracks found. Run `tracker sync` first.', MUTED);
    blank();
    text(footerView(m), STATUS_BAR);
  } else {
    text('Local track history', MUTED);
    blank();
    const footer = footerView(m);
    if (m.tracks.length === 0) {
      text(`No tracks match /${expandTabs(m.searchQuery.trim())}`, MUTED);
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
  readonly tracks: readonly Track[];
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
  const count = m.tracks.length;
  if (count <= Math.floor(availableLines / 2)) {
    return { tracks: m.tracks, offset: 0, hiddenAbove: false, hiddenBelow: false };
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
  return { tracks: m.tracks.slice(start, end), offset: start, hiddenAbove: start > 0, hiddenBelow: end < count };
}

function renderList(m: Model, width: number, height: number): Line[] {
  const lines: Line[] = [styled('Tracks', TITLE), styled(trackListSummary(m), MUTED), BLANK];

  const { tracks, offset, hiddenAbove, hiddenBelow } = visibleTracks(m, height);
  if (hiddenAbove) {
    lines.push(styled(`... ${offset} earlier`, MUTED));
  }

  const titleWidth = Math.max(10, width - 8);
  const artistWidth = Math.max(10, width - 6);
  for (const [index, track] of tracks.entries()) {
    const line = `${String(track.id).padStart(2)}  ${fit(track.trackName, titleWidth)}`;
    const subtitle = `    ${fit(textFor(m, track).artists, artistWidth)}`;
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
    lines.push(styled(`... ${m.tracks.length - (offset + tracks.length)} more`, MUTED));
  }
  return lines;
}

function renderDetails(m: Model, width: number, height: number): Line[] {
  const track = selectedTrack(m);
  if (track === null) {
    return [styled('Track Details', TITLE), BLANK, styled('No track selected.', MUTED)];
  }
  const textWidth = Math.max(16, width - 2);
  const artists = textFor(m, track).artists;

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
    lines.push(
      BLANK,
      styled('1-5 sets stars, then type your opinion.', MUTED),
      styled('Tab switches field. Enter saves. Esc cancels.', MUTED),
    );
    return trimLines(lines, height, ELLIPSIS);
  }

  const lines: Line[] = [
    styled('Track Details', TITLE),
    BLANK,
    styled(fit(track.trackName, textWidth), HIGHLIGHT),
    styled(fit(artists, textWidth), MUTED),
    BLANK,
    styled(`ID: ${track.id}`, PLAIN),
    styled(fit(`Spotify ID: ${track.spotifyId}`, textWidth), PLAIN),
    styled(fit(`Album: ${track.albumName}`, textWidth), PLAIN),
    styled(`Play Count: ${track.playCount}`, PLAIN),
    styled(fit(`Last Played: ${formatTime(track.lastPlayedAt, m.timeZone)}`, textWidth), PLAIN),
  ];

  const rating = selectedRating(m);
  if (m.savingRating) {
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

function ratingDraftStarsLabel(m: Model): string {
  return m.draftStars < 1 || m.draftStars > 5 ? 'not set' : `${m.draftStars}/5`;
}

/** Shows the text cursor only while the opinion has focus. */
function draftOpinionLine(m: Model): string {
  return m.editingOpinion ? `${m.draftOpinion}_` : m.draftOpinion;
}

function trackListSummary(m: Model): string {
  const label = sortModeLabel(m.sortMode);
  if (m.searchQuery.trim() === '') {
    return `${m.tracks.length} loaded · sort: ${label}`;
  }
  return `${m.tracks.length}/${totalTrackCount(m)} shown · sort: ${label}`;
}

/**
 * The status line (if any) above the key help, wrapped to the frame width.
 * Plain text; the frame draws it faint.
 */
export function footerView(m: Model): string {
  const width = frameWidth(m);
  let hints: readonly string[] = m.editingRating ? editingHints : browsingHints;
  if (m.searching) {
    hints = searchHints;
  }
  const base = packHints(hints, width);

  let status: string | null = null;
  if (m.syncing) {
    status = 'Syncing with Spotify...';
  } else if (m.savingRating) {
    status = 'Saving rating...';
  } else if (m.statusMessage !== '') {
    status = m.statusIsError ? `Error: ${m.statusMessage}` : m.statusMessage;
  } else if (m.searching) {
    status = `Search /${m.searchQuery}_ (${m.tracks.length}/${totalTrackCount(m)})`;
  } else if (m.searchQuery.trim() !== '') {
    status = `Filter /${m.searchQuery.trim()} (${m.tracks.length}/${totalTrackCount(m)})`;
  }

  // Status text can be arbitrarily long (e.g. API errors), so it wraps; key
  // hints are packed whole.
  return status === null ? base : `${hardWrap(expandTabs(status), width)}\n${base}`;
}

const pad2 = (value: number) => String(value).padStart(2, '0');

/**
 * Formats Unix seconds like Go's `time.Unix(s, 0).Format(time.RFC3339)`:
 * local time with a numeric offset, or "Z" when the offset is zero.
 */
export function formatTime(seconds: number, timeZone: 'local' | 'utc'): string {
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) {
    // Outside the range a Date can represent.
    return String(seconds);
  }
  const offset = timeZone === 'utc' ? 0 : -date.getTimezoneOffset();
  const local = new Date(date.getTime() + offset * 60_000);
  const year = local.getUTCFullYear();
  const yearText = year < 0 ? `-${String(-year).padStart(4, '0')}` : String(year).padStart(4, '0');
  const stamp =
    `${yearText}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}` +
    `T${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())}`;
  if (offset === 0) {
    return `${stamp}Z`;
  }
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${stamp}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}
