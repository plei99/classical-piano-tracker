/**
 * What the track browser shows, independent of how it is drawn. The Ink TUI
 * lays these strings out on a character grid (tui/view.ts, matched cell for
 * cell against the Go build); the web UI lays the same content out with CSS.
 * Keeping every user-visible decision here means both front ends always say
 * the same thing.
 *
 * Counts, the sort label, and the filter describe the list on screen
 * (`m.list`), which for a remote list lags the keys by a round trip; the
 * TUI's list always matches the model's sort and query.
 */
import type { Rating, Track } from '../core/model';
import { selectedRow, sortModeLabel, type Model } from './model';

export const TITLE = 'Classical Piano Tracker';
export const SUBTITLE = 'Local track history';
export const LOADING_TEXT = 'Loading local tracks...';
export const RETRY_TEXT = 'Press r to retry or q to quit.';
export const NO_TRACKS_TEXT = 'No local tracks found. Run `tracker sync` first.';
export const EDITOR_HELP = ['1-5 sets stars, then type your opinion.', 'Tab switches field. Enter saves. Esc cancels.'];

/** One entry in the key help. */
export interface Hint {
  /** The keys as the TUI prints them, e.g. "j/k or arrows". */
  readonly keys: string;
  readonly label: string;
  /**
   * The key a click on this hint sends, for front ends with a pointer.
   * Hints that describe typing or a family of keys have none.
   */
  readonly key?: string;
  /** Only meaningful in a terminal (quitting a browser tab is the browser's job). */
  readonly terminalOnly?: boolean;
}

const browsingHints: readonly Hint[] = [
  { keys: 'j/k or arrows', label: 'move' },
  { keys: 'g/G', label: 'top/bottom' },
  { keys: 'o', label: 'sort', key: 'o' },
  { keys: 's', label: 'sync', key: 's' },
  { keys: 'enter/e', label: 'rate', key: 'e' },
  { keys: 'r', label: 'reload', key: 'r' },
  { keys: 'q', label: 'quit', key: 'q', terminalOnly: true },
];

const editingHints: readonly Hint[] = [
  { keys: '1-5', label: 'stars' },
  { keys: 'tab', label: 'switch field', key: 'tab' },
  { keys: 'ctrl+u', label: 'clear opinion', key: 'ctrl+u' },
  { keys: 'enter', label: 'save', key: 'enter' },
  { keys: 'esc', label: 'cancel', key: 'esc' },
];

const searchHints: readonly Hint[] = [
  { keys: 'type', label: 'search' },
  { keys: 'backspace', label: 'delete' },
  { keys: 'enter', label: 'apply', key: 'enter' },
  { keys: 'esc', label: 'clear', key: 'esc' },
];

/** The key help for the current mode. */
export function hints(m: Model): readonly Hint[] {
  if (m.searching) {
    return searchHints;
  }
  return m.editingRating ? editingHints : browsingHints;
}

/** A hint as the TUI prints it, e.g. "o: sort". */
export function hintText(hint: Hint): string {
  return `${hint.keys}: ${hint.label}`;
}

/** Which screen to show. */
export type Screen = 'loading' | 'error' | 'empty' | 'noMatch' | 'browse';

export function screen(m: Model): Screen {
  if (m.loadingTracks) return 'loading';
  if (m.err !== null) return 'error';
  if (m.list.total === 0 && m.list.count === 0) return 'empty';
  if (m.list.count === 0) return 'noMatch';
  return 'browse';
}

export function errorText(m: Model): string {
  return `Error: ${m.err?.message ?? ''}`;
}

export function noMatchText(m: Model): string {
  return `No tracks match /${m.list.query.trim()}`;
}

/** The status line above the key help, or null when there is nothing to report. */
export interface Status {
  readonly text: string;
  readonly isError: boolean;
}

export function status(m: Model): Status | null {
  if (m.syncing) {
    return { text: 'Syncing with Spotify...', isError: false };
  }
  if (m.savingRating) {
    return { text: 'Saving rating...', isError: false };
  }
  if (m.statusMessage !== '') {
    return { text: m.statusIsError ? `Error: ${m.statusMessage}` : m.statusMessage, isError: m.statusIsError };
  }
  const { query, count, total } = m.list;
  if (m.searching) {
    return { text: `Search /${query}_ (${count}/${total})`, isError: false };
  }
  if (query.trim() !== '') {
    return { text: `Filter /${query.trim()} (${count}/${total})`, isError: false };
  }
  return null;
}

/** e.g. "543 loaded · sort: recent", or "12/543 shown · sort: recent" while filtered. */
export function trackListSummary(m: Model): string {
  const { sort, query, count, total } = m.list;
  const label = sortModeLabel(sort);
  if (query.trim() === '') {
    return `${count} loaded · sort: ${label}`;
  }
  return `${count}/${total} shown · sort: ${label}`;
}

export function ratingDraftStarsLabel(m: Model): string {
  return m.draftStars < 1 || m.draftStars > 5 ? 'not set' : `${m.draftStars}/5`;
}

/** Shows the text cursor only while the opinion has focus. */
export function draftOpinionLine(m: Model): string {
  return m.editingOpinion ? `${m.draftOpinion}_` : m.draftOpinion;
}

/** The selected track with everything the detail pane shows about it. */
export interface Details {
  readonly track: Track;
  readonly artists: string;
  /** Label/value pairs in display order. */
  readonly fields: readonly { readonly label: string; readonly value: string }[];
  /** 'saving' while a save is in flight, null when unrated. */
  readonly rating: Rating | 'saving' | null;
}

export function details(m: Model): Details | null {
  const row = selectedRow(m);
  if (row === null) {
    return null;
  }
  const { track } = row;
  return {
    track,
    artists: row.artists,
    fields: [
      { label: 'ID', value: String(track.id) },
      { label: 'Spotify ID', value: track.spotifyId },
      { label: 'Album', value: track.albumName },
      { label: 'Play Count', value: String(track.playCount) },
      { label: 'Last Played', value: formatTime(track.lastPlayedAt, m.timeZone) },
    ],
    rating: m.savingRating ? 'saving' : row.rating,
  };
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
