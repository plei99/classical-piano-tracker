/**
 * The track browser's state machine, shared by the Ink TUI and the web UI: a
 * pure `update(model, msg) -> [model, cmd]` port of the Go Bubble Tea model,
 * so tests drive it without a terminal or a browser. Background work is
 * described by commands (`Cmd`) that the front end runs and whose results
 * come back as messages.
 */
import { errorMessage } from '../core/errors';
import { emptySyncStats } from '../core/model';
import type { Rating, SyncStats, Track, UpsertRatingParams } from '../core/model';
import {
  buildTrackText,
  type ListChunk,
  LocalTrackList,
  type ListRow,
  type SortMode,
  sortModeCycle,
  type TrackList,
  type TrackText,
} from './list';
import { dropLastRune } from './strings';

export { buildTrackText, type ListRow, type SortMode, sortModeCycle, type TrackList, type TrackText };

/**
 * I/O callbacks injected by the CLI, so the TUI never touches the network
 * or the database directly and never blocks a render on them.
 */
export interface Deps {
  /** Reads every track and rating; the model sorts and filters them in-process (the TUI). */
  load(): Promise<{ tracks: Track[]; ratings: Rating[] }>;
  sync(): Promise<SyncStats>;
  saveRating(params: UpsertRatingParams): Promise<Rating>;
  /**
   * Front ends whose library lives elsewhere (the web UI): asks for the
   * list in an order and filter, positioned at a track. When present it
   * replaces `load`, and re-sorting and searching become requests too.
   */
  view?(request: ViewRequest): Promise<ViewResult>;
}

export interface ViewRequest {
  readonly sort: SortMode;
  readonly query: string;
  /** The track to keep selected, or 0 for none. */
  readonly around: number;
  /** Re-read the library first (the r key); a sync re-reads it on its own. */
  readonly reload: boolean;
}

export interface ViewResult {
  readonly list: TrackList;
  /** Where `around` is in the list, or null when it is not there. */
  readonly index: number | null;
}

const sortModeLabels: Record<SortMode, string> = {
  recentDesc: 'recent',
  idAsc: 'id',
  topPlayed: 'top played',
  unratedFirst: 'unrated first',
};

/**
 * The root TUI state. Treated as immutable: `update` returns a new object
 * and never mutates arrays or maps it was given, so React can compare
 * models (and the pieces memoized from them) by identity.
 */
export interface Model {
  /** Missing callbacks make the matching action report "unavailable", as Go's nil funcs did. */
  deps: Partial<Deps>;
  width: number;
  height: number;
  loadingTracks: boolean;
  syncing: boolean;
  savingRating: boolean;
  searching: boolean;
  searchQuery: string;
  /**
   * The tracks on screen, sorted by `sortMode` and filtered by
   * `searchQuery`, with their ratings (so moving the selection is a lookup
   * rather than a DB round trip per keypress). A remote list catches up
   * with the sort and query when the server answers.
   */
  list: TrackList;
  sortMode: SortMode;
  /** The latest list request to the server; answers to older ones are dropped. */
  listRequest: number;
  /** Whether that request is still unanswered. */
  listPending: boolean;
  selectedIndex: number;
  editingRating: boolean;
  /**
   * Moves focus from the stars field to the opinion, where digits are
   * ordinary text instead of star ratings.
   */
  editingOpinion: boolean;
  draftStars: number;
  draftOpinion: string;
  statusMessage: string;
  statusIsError: boolean;
  err: Error | null;
  /** Time zone for timestamps; tests pin UTC so frames match the Go goldens. */
  timeZone: 'local' | 'utc';
}

/** A key press, named the way Bubble Tea v2's `KeyPressMsg.String()` names it. */
export interface KeyMsg {
  readonly type: 'key';
  /** e.g. "j", "G", "enter", "esc", "shift+tab", "ctrl+u", "space", or typed text. */
  readonly key: string;
  /** Text the key types, empty for special keys. */
  readonly text: string;
}

export interface TracksLoadedMsg {
  readonly type: 'tracksLoaded';
  readonly tracks: readonly Track[];
  readonly ratings: ReadonlyMap<number, Rating>;
  readonly trackText: ReadonlyMap<number, TrackText>;
  readonly err?: Error;
}

/** The server's answer to a list request (`Deps.view`). */
export interface ListLoadedMsg {
  readonly type: 'listLoaded';
  /** The request's `listRequest` number. */
  readonly seq: number;
  readonly reload: boolean;
  readonly result?: ViewResult;
  readonly err?: Error;
}

export type Msg =
  | { readonly type: 'resize'; readonly width: number; readonly height: number }
  | TracksLoadedMsg
  | ListLoadedMsg
  /** More rows of a remote list, fetched ahead of the selection and scroll position. */
  | { readonly type: 'listRows'; readonly chunk: ListChunk }
  | { readonly type: 'syncFinished'; readonly stats: SyncStats; readonly err?: Error }
  | { readonly type: 'ratingSaved'; readonly trackId: number; readonly rating?: Rating; readonly err?: Error }
  | KeyMsg
  | { readonly type: 'paste'; readonly text: string }
  | { readonly type: 'quit' }
  | PointerMsg;

/**
 * Intents from front ends with a pointer and form fields (the web UI). The
 * keyboard flow stays the source of truth; these are the clicks and text
 * fields that stand in for it, with the same guards as the keys.
 */
export type PointerMsg =
  /** Clicking a row selects that track. */
  | { readonly type: 'select'; readonly trackId: number }
  /** Typing in the search field replaces the whole query. */
  | { readonly type: 'setSearch'; readonly query: string }
  /** Clicking a star in the rating editor. */
  | { readonly type: 'setDraftStars'; readonly stars: number }
  /** Editing the opinion text field. */
  | { readonly type: 'setDraftOpinion'; readonly text: string }
  /** Focusing an editor field. */
  | { readonly type: 'focusField'; readonly field: 'stars' | 'opinion' };

/** Background work. Commands never reject: failures come back as messages. */
export type Cmd = () => Promise<Msg>;

/** Ends the program, like `tea.Quit`. */
export const quit: Cmd = () => Promise.resolve({ type: 'quit' });

const emptyRatings: ReadonlyMap<number, Rating> = new Map();
const emptyTrackText: ReadonlyMap<number, TrackText> = new Map();

/** A model with Go zero values, overridden by `fields` (like a Go struct literal). */
export function makeModel(fields: Partial<Model> = {}): Model {
  return {
    deps: {},
    width: 0,
    height: 0,
    loadingTracks: false,
    syncing: false,
    savingRating: false,
    searching: false,
    searchQuery: '',
    list: LocalTrackList.empty,
    sortMode: 'recentDesc',
    listRequest: 0,
    listPending: false,
    selectedIndex: 0,
    editingRating: false,
    editingOpinion: false,
    draftStars: 0,
    draftOpinion: '',
    statusMessage: '',
    statusIsError: false,
    err: null,
    timeZone: 'local',
    ...fields,
  };
}

/** The root model at startup: loading until `init`'s command reports back. */
export function newModel(deps: Partial<Deps>, fields: Partial<Model> = {}): Model {
  return makeModel({ deps, loadingTracks: true, ...fields });
}

/**
 * Starts the program: an asynchronous read of the library, unless the
 * model already has one (the web UI starts from the server's first render).
 */
export function init(m: Model): [Model, Cmd | null] {
  if (!m.loadingTracks) {
    return [m, null];
  }
  if (m.deps.view === undefined) {
    return [m, loadTracksCmd(m)];
  }
  const next = { ...m };
  return [next, loadTracksCmd(next)];
}

export function update(m: Model, msg: Msg): [Model, Cmd | null] {
  switch (msg.type) {
    case 'resize':
      return [{ ...m, width: msg.width, height: msg.height }, null];
    case 'tracksLoaded': {
      const next = { ...m, loadingTracks: false };
      if (msg.err !== undefined) {
        next.err = msg.err;
        return [next, null];
      }
      const selectedTrackId = selectedTrackID(m);
      next.err = null;
      next.list = LocalTrackList.load(msg.tracks, msg.ratings, msg.trackText);
      return [next, refreshTrackList(next, selectedTrackId)];
    }
    case 'listLoaded': {
      if (msg.seq !== m.listRequest) {
        // Superseded: a later sort, search, or reload decides what is shown.
        return [m, null];
      }
      const next = { ...m, listPending: false, loadingTracks: false };
      if (msg.err !== undefined || msg.result === undefined) {
        const err = msg.err ?? new Error('no list in the response');
        if (msg.reload) {
          next.err = err;
        } else {
          setStatus(next, err.message, true);
        }
        return [next, null];
      }
      const { list, index } = msg.result;
      next.err = null;
      next.list = list;
      // Keep the selection if it moved while the request was in flight and
      // its track is still here; otherwise take the server's position for
      // the track selected when the request was made.
      const current = selectedTrack(m);
      const found = current === null ? -1 : list.indexOf(current.id);
      selectIndex(next, found >= 0 ? found : index);
      return [next, null];
    }
    case 'listRows': {
      const merged = m.list.withRows?.(msg.chunk);
      if (merged === undefined || merged === m.list) {
        return [m, null];
      }
      if (merged === null) {
        // The library changed under the cached rows: refetch the list
        // around the selection, showing the old rows until it arrives.
        if (m.listPending) {
          return [m, null];
        }
        const next = { ...m };
        return [next, listCmd(next, selectedTrackID(m), false)];
      }
      return [{ ...m, list: merged }, null];
    }
    case 'syncFinished': {
      const next = { ...m, syncing: false };
      if (msg.err !== undefined) {
        setStatus(next, `Sync failed: ${msg.err.message}`, true);
        return [next, null];
      }
      const { fetched, accepted, inserted, updated } = msg.stats;
      setStatus(
        next,
        `Sync complete. fetched=${fetched} accepted=${accepted} inserted=${inserted} updated=${updated}`,
        false,
      );
      next.loadingTracks = true;
      return [next, loadTracksCmd(next, false)];
    }
    case 'ratingSaved': {
      const next = { ...m, savingRating: false };
      if (msg.err !== undefined) {
        setStatus(next, `Save failed: ${msg.err.message}`, true);
        return [next, null];
      }
      let cmd: Cmd | null = null;
      if (msg.rating !== undefined) {
        next.list = m.list.withRating(msg.trackId, msg.rating);
        if (next.sortMode === 'unratedFirst') {
          cmd = refreshTrackList(next, msg.trackId);
        }
        setStatus(next, `Saved ${msg.rating.stars}/5 rating for track ${msg.trackId}`, false);
      }
      return [next, cmd];
    }
    case 'key':
      if (m.editingRating) {
        return handleRatingEditorKey(m, msg);
      }
      if (m.searching) {
        return handleSearchKey(m, msg);
      }
      return handleBrowsingKey(m, msg);
    case 'paste':
      // Bracketed paste arrives separately from key presses.
      if (m.editingRating) {
        return [{ ...m, draftOpinion: m.draftOpinion + msg.text, editingOpinion: true }, null];
      }
      if (m.searching) {
        const next = { ...m, searchQuery: m.searchQuery + msg.text };
        clearStatus(next);
        return [next, refreshTrackList(next, selectedTrackID(m))];
      }
      return [m, null];
    case 'quit':
      return [m, null];
    case 'select': {
      if (m.syncing || m.savingRating || m.editingRating) {
        return [m, null];
      }
      const index = m.list.indexOf(msg.trackId);
      return [index < 0 ? m : moveSelectionTo(m, index), null];
    }
    case 'setSearch': {
      if (m.syncing || m.savingRating || m.editingRating || msg.query === m.searchQuery) {
        return [m, null];
      }
      const next = { ...m, searchQuery: msg.query };
      clearStatus(next);
      return [next, refreshTrackList(next, selectedTrackID(m))];
    }
    case 'setDraftStars':
      if (!m.editingRating || !Number.isInteger(msg.stars) || msg.stars < 0 || msg.stars > 5) {
        return [m, null];
      }
      return [{ ...m, draftStars: msg.stars }, null];
    case 'setDraftOpinion':
      return m.editingRating ? [{ ...m, draftOpinion: msg.text, editingOpinion: true }, null] : [m, null];
    case 'focusField':
      return m.editingRating ? [{ ...m, editingOpinion: msg.field === 'opinion' }, null] : [m, null];
  }
}

function handleBrowsingKey(m: Model, msg: KeyMsg): [Model, Cmd | null] {
  const busy = m.syncing || m.savingRating;
  const count = m.list.count;
  const last = count - 1;
  switch (msg.key) {
    case 'q':
    case 'ctrl+c':
      return [m, quit];
    case 'r': {
      const next = { ...m, loadingTracks: true, err: null };
      clearStatus(next);
      return [next, loadTracksCmd(next)];
    }
    case 's': {
      if (m.syncing) {
        return [m, null];
      }
      const next = { ...m };
      if (m.deps.sync === undefined) {
        setStatus(next, 'Sync is unavailable in this view.', true);
        return [next, null];
      }
      next.syncing = true;
      clearStatus(next);
      return [next, syncCmd(next)];
    }
    case 'o': {
      if (count === 0 || busy) {
        return [m, null];
      }
      const next = { ...m };
      clearStatus(next);
      return [next, cycleSortMode(next)];
    }
    case '/': {
      if (busy) {
        return [m, null];
      }
      const next = { ...m, searching: true };
      clearStatus(next);
      return [next, null];
    }
    case 'esc': {
      if (m.searchQuery.trim() === '' || busy) {
        return [m, null];
      }
      const next = { ...m, searchQuery: '' };
      clearStatus(next);
      return [next, refreshTrackList(next, selectedTrackID(m))];
    }
    case 'e':
    case 'enter': {
      if (selectedTrack(m) === null || m.savingRating) {
        return [m, null];
      }
      return [startRatingEditor(m), null];
    }
    case 'up':
    case 'k':
      if (count === 0 || m.selectedIndex === 0 || busy) {
        return [m, null];
      }
      return [moveSelectionTo(m, m.selectedIndex - 1), null];
    case 'down':
    case 'j':
      if (count === 0 || m.selectedIndex >= last || busy) {
        return [m, null];
      }
      return [moveSelectionTo(m, m.selectedIndex + 1), null];
    case 'g':
    case 'home':
      if (count === 0 || m.selectedIndex === 0 || busy) {
        return [m, null];
      }
      return [moveSelectionTo(m, 0), null];
    case 'G':
    case 'end':
      if (count === 0 || m.selectedIndex >= last || busy) {
        return [m, null];
      }
      return [moveSelectionTo(m, last), null];
  }
  return [m, null];
}

function handleSearchKey(m: Model, msg: KeyMsg): [Model, Cmd | null] {
  let query: string;
  switch (msg.key) {
    case 'ctrl+c':
      return [m, quit];
    case 'enter': {
      const next = { ...m, searching: false };
      clearStatus(next);
      return [next, null];
    }
    case 'esc': {
      const next = { ...m, searching: false, searchQuery: '' };
      clearStatus(next);
      return [next, refreshTrackList(next, selectedTrackID(m))];
    }
    case 'backspace':
      query = dropLastRune(m.searchQuery);
      break;
    case 'ctrl+u':
      query = '';
      break;
    case 'space':
      query = m.searchQuery + ' ';
      break;
    default:
      if (msg.text === '') {
        return [m, null];
      }
      query = m.searchQuery + msg.text;
  }
  const next = { ...m, searchQuery: query };
  clearStatus(next);
  return [next, refreshTrackList(next, selectedTrackID(m))];
}

function handleRatingEditorKey(m: Model, msg: KeyMsg): [Model, Cmd | null] {
  switch (msg.key) {
    case 'esc': {
      const next = { ...m, editingRating: false };
      setStatus(next, 'Rating edit canceled.', false);
      return [next, null];
    }
    case 'enter': {
      const track = selectedTrack(m);
      if (track === null || m.savingRating) {
        return [m, null];
      }
      const next = { ...m };
      if (m.draftStars < 1 || m.draftStars > 5) {
        setStatus(next, 'Choose a star rating from 1 to 5 before saving.', true);
        return [next, null];
      }
      if (m.deps.saveRating === undefined) {
        setStatus(next, 'Saving ratings is unavailable in this view.', true);
        return [next, null];
      }
      next.editingRating = false;
      next.savingRating = true;
      clearStatus(next);
      return [next, saveRatingCmd(next, track.id, m.draftStars, m.draftOpinion.trim())];
    }
    case 'tab':
    case 'shift+tab':
      return [{ ...m, editingOpinion: !m.editingOpinion }, null];
    case 'backspace':
      if (!m.editingOpinion) {
        return [{ ...m, draftStars: 0 }, null];
      }
      return [{ ...m, draftOpinion: dropLastRune(m.draftOpinion) }, null];
    case 'ctrl+u':
      return [{ ...m, draftOpinion: '' }, null];
  }

  if (!m.editingOpinion && /^[1-5]$/.test(msg.key)) {
    // The stars field takes a single digit and then hands focus to the
    // opinion, so the usual "5, then type" flow needs no extra key.
    return [{ ...m, draftStars: Number(msg.key), editingOpinion: true }, null];
  }

  // Any other text starts (or continues) the opinion.
  if (msg.key === 'space') {
    return [{ ...m, draftOpinion: m.draftOpinion + ' ', editingOpinion: true }, null];
  }
  if (msg.text !== '') {
    return [{ ...m, draftOpinion: m.draftOpinion + msg.text, editingOpinion: true }, null];
  }
  return [m, null];
}

/** The selected row, or null when nothing is selected or (remote lists) its row is still loading. */
export function selectedRow(m: Model): ListRow | null {
  return m.list.row(m.selectedIndex);
}

export function selectedTrack(m: Model): Track | null {
  return selectedRow(m)?.track ?? null;
}

/** The saved rating for the selected track, if any. */
export function selectedRating(m: Model): Rating | null {
  return selectedRow(m)?.rating ?? null;
}

/** The selected track's ID, or 0 (never a real ID) when nothing is selected. */
export function selectedTrackID(m: Model): number {
  return selectedTrack(m)?.id ?? 0;
}

function moveSelectionTo(m: Model, index: number): Model {
  const { count } = m.list;
  if (count === 0) {
    return m;
  }
  const clamped = Math.min(Math.max(index, 0), count - 1);
  if (clamped === m.selectedIndex) {
    return m;
  }
  const next = { ...m, selectedIndex: clamped };
  clearStatus(next);
  return next;
}

/**
 * Loads tracks and ratings, and precomputes display and search text off the
 * update path; or, for a remote list, asks the server (`reload` re-reads its
 * library first). Takes a model the caller has just copied, as a remote
 * request is numbered in it.
 */
export function loadTracksCmd(m: Model, reload = true): Cmd {
  if (m.deps.view !== undefined) {
    return listCmd(m, selectedTrackID(m), reload);
  }
  const { load } = m.deps;
  return async () => {
    try {
      if (load === undefined) {
        throw new Error('Loading tracks is unavailable in this view.');
      }
      const { tracks, ratings } = await load();
      return tracksLoadedMsg(tracks, ratings);
    } catch (err) {
      return { type: 'tracksLoaded', tracks: [], ratings: emptyRatings, trackText: emptyTrackText, err: asError(err) };
    }
  };
}

/** Builds the message `loadTracksCmd` produces from the DB rows. */
export function tracksLoadedMsg(tracks: readonly Track[], ratings: readonly Rating[]): TracksLoadedMsg {
  const byTrackId = new Map<number, Rating>();
  for (const rating of ratings) {
    byTrackId.set(rating.trackId, rating);
  }
  return { type: 'tracksLoaded', tracks, ratings: byTrackId, trackText: buildTrackText(tracks) };
}

function syncCmd(m: Model): Cmd {
  const { sync } = m.deps;
  return async () => {
    try {
      if (sync === undefined) {
        throw new Error('Sync is unavailable in this view.');
      }
      return { type: 'syncFinished', stats: await sync() };
    } catch (err) {
      return {
        type: 'syncFinished',
        stats: emptySyncStats(),
        err: asError(err),
      };
    }
  };
}

function saveRatingCmd(m: Model, trackId: number, stars: number, opinion: string): Cmd {
  const { saveRating } = m.deps;
  return async () => {
    try {
      if (saveRating === undefined) {
        throw new Error('Saving ratings is unavailable in this view.');
      }
      const rating = await saveRating({ trackId, stars, opinion, updatedAt: Math.floor(Date.now() / 1000) });
      return { type: 'ratingSaved', trackId, rating };
    } catch (err) {
      return { type: 'ratingSaved', trackId, err: asError(err) };
    }
  };
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(errorMessage(err));
}

/** Opens the rating editor on the stars field, prefilled from the saved rating. */
export function startRatingEditor(m: Model): Model {
  const rating = selectedRating(m);
  const next = {
    ...m,
    editingRating: true,
    editingOpinion: false,
    draftStars: rating?.stars ?? 0,
    draftOpinion: rating?.opinion ?? '',
  };
  clearStatus(next);
  return next;
}

// The helpers below mutate a model the caller has just copied, mirroring
// Go's pointer-receiver methods on the Update loop's value copy.

function setStatus(m: Model, message: string, isError: boolean): void {
  m.statusMessage = message;
  m.statusIsError = isError;
}

function clearStatus(m: Model): void {
  m.statusMessage = '';
  m.statusIsError = false;
}

function cycleSortMode(m: Model): Cmd | null {
  const selectedTrackId = selectedTrackID(m);
  const index = sortModeCycle.indexOf(m.sortMode);
  m.sortMode = sortModeCycle[(index + 1) % sortModeCycle.length] ?? 'recentDesc';
  return refreshTrackList(m, selectedTrackId);
}

/**
 * Re-sorts (only when needed) and re-filters, keeping `selectedTrackId`
 * selected if it is still shown. In-memory lists change on the spot; a
 * remote list returns the request that will.
 */
export function refreshTrackList(m: Model, selectedTrackId: number): Cmd | null {
  const list = m.list.requery(m.sortMode, m.searchQuery);
  if (list === null) {
    return listCmd(m, selectedTrackId, false);
  }
  m.list = list;
  selectIndex(m, list.indexOf(selectedTrackId));
  return null;
}

/** Selects `index` in a new list, or falls back to the top (closing the editor) when the track is gone. */
function selectIndex(m: Model, index: number | null): void {
  if (m.list.count === 0) {
    m.selectedIndex = 0;
    m.editingRating = false;
    return;
  }
  if (index !== null && index >= 0 && index < m.list.count) {
    m.selectedIndex = index;
    return;
  }
  m.selectedIndex = 0;
  m.editingRating = false;
}

/** Asks the server for the list in the model's order and filter, around a track. */
function listCmd(m: Model, around: number, reload: boolean): Cmd {
  const seq = m.listRequest + 1;
  m.listRequest = seq;
  m.listPending = true;
  const { view } = m.deps;
  const request: ViewRequest = { sort: m.sortMode, query: m.searchQuery, around, reload };
  return async () => {
    try {
      if (view === undefined) {
        throw new Error('Loading tracks is unavailable in this view.');
      }
      return { type: 'listLoaded', seq, reload, result: await view(request) };
    } catch (err) {
      return { type: 'listLoaded', seq, reload, err: asError(err) };
    }
  };
}

export function sortModeLabel(mode: SortMode): string {
  return sortModeLabels[mode];
}
