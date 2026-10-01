/**
 * The track browser's state machine, shared by the Ink TUI and the web UI: a
 * pure `update(model, msg) -> [model, cmd]` port of the Go Bubble Tea model,
 * so tests drive it without a terminal or a browser. Background work is
 * described by commands (`Cmd`) that the front end runs and whose results
 * come back as messages.
 */
import { formatArtists } from '../core/artists';
import { errorMessage } from '../core/errors';
import { emptySyncStats } from '../core/model';
import type { Rating, SyncStats, Track, UpsertRatingParams } from '../core/model';
import { dropLastRune } from './strings';

/**
 * I/O callbacks injected by the CLI, so the TUI never touches the network
 * or the database directly and never blocks a render on them.
 */
export interface Deps {
  load(): Promise<{ tracks: Track[]; ratings: Rating[] }>;
  sync(): Promise<SyncStats>;
  saveRating(params: UpsertRatingParams): Promise<Rating>;
}

export type SortMode = 'recentDesc' | 'idAsc' | 'topPlayed' | 'unratedFirst';

export const sortModeCycle: readonly SortMode[] = ['recentDesc', 'idAsc', 'topPlayed', 'unratedFirst'];

const sortModeLabels: Record<SortMode, string> = {
  recentDesc: 'recent',
  idAsc: 'id',
  topPlayed: 'top played',
  unratedFirst: 'unrated first',
};

/** Strings derived from a track's artists JSON, computed once per load. */
export interface TrackText {
  /** Display label, e.g. "Frédéric Chopin, Krystian Zimerman". */
  readonly artists: string;
  /** Lowercased name, artists, and album for substring search. */
  readonly search: string;
}

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
  allTracks: readonly Track[];
  tracks: readonly Track[];
  /**
   * Loaded alongside the tracks so moving the selection is a map lookup
   * rather than a DB round trip per keypress.
   */
  ratings: ReadonlyMap<number, Rating>;
  /**
   * Caches strings derived from each track's artists JSON so rendering and
   * search never re-decode it per frame or per keystroke.
   */
  trackText: ReadonlyMap<number, TrackText>;
  sortMode: SortMode;
  /**
   * allTracks is already ordered by sortedBy when sorted is true, letting
   * search keystrokes skip a full re-sort.
   */
  sortedBy: SortMode;
  sorted: boolean;
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

export type Msg =
  | { readonly type: 'resize'; readonly width: number; readonly height: number }
  | TracksLoadedMsg
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
    allTracks: [],
    tracks: [],
    ratings: emptyRatings,
    trackText: emptyTrackText,
    sortMode: 'recentDesc',
    sortedBy: 'recentDesc',
    sorted: false,
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

/** The command that starts the program: an asynchronous DB read. */
export function init(m: Model): Cmd {
  return loadTracksCmd(m);
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
      next.allTracks = msg.tracks;
      next.ratings = msg.ratings;
      next.trackText = msg.trackText;
      next.sorted = false;
      refreshTrackList(next, selectedTrackId);
      return [next, null];
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
      return [next, loadTracksCmd(next)];
    }
    case 'ratingSaved': {
      const next = { ...m, savingRating: false };
      if (msg.err !== undefined) {
        setStatus(next, `Save failed: ${msg.err.message}`, true);
        return [next, null];
      }
      if (msg.rating !== undefined) {
        // Copy before writing: the previous model may still be rendered.
        const ratings = new Map(m.ratings);
        ratings.set(msg.trackId, msg.rating);
        next.ratings = ratings;
        if (next.sortMode === 'unratedFirst') {
          next.sorted = false;
          refreshTrackList(next, msg.trackId);
        }
        setStatus(next, `Saved ${msg.rating.stars}/5 rating for track ${msg.trackId}`, false);
      }
      return [next, null];
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
        refreshTrackList(next, selectedTrackID(m));
        return [next, null];
      }
      return [m, null];
    case 'quit':
      return [m, null];
    case 'select': {
      if (m.syncing || m.savingRating || m.editingRating) {
        return [m, null];
      }
      const index = m.tracks.findIndex((track) => track.id === msg.trackId);
      return [index < 0 ? m : moveSelectionTo(m, index), null];
    }
    case 'setSearch': {
      if (m.syncing || m.savingRating || m.editingRating || msg.query === m.searchQuery) {
        return [m, null];
      }
      const next = { ...m, searchQuery: msg.query };
      clearStatus(next);
      refreshTrackList(next, selectedTrackID(m));
      return [next, null];
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
  const last = m.tracks.length - 1;
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
      if (m.tracks.length === 0 || busy) {
        return [m, null];
      }
      const next = { ...m };
      clearStatus(next);
      cycleSortMode(next);
      return [next, null];
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
      refreshTrackList(next, selectedTrackID(m));
      return [next, null];
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
      if (m.tracks.length === 0 || m.selectedIndex === 0 || busy) {
        return [m, null];
      }
      return [moveSelectionTo(m, m.selectedIndex - 1), null];
    case 'down':
    case 'j':
      if (m.tracks.length === 0 || m.selectedIndex >= last || busy) {
        return [m, null];
      }
      return [moveSelectionTo(m, m.selectedIndex + 1), null];
    case 'g':
    case 'home':
      if (m.tracks.length === 0 || m.selectedIndex === 0 || busy) {
        return [m, null];
      }
      return [moveSelectionTo(m, 0), null];
    case 'G':
    case 'end':
      if (m.tracks.length === 0 || m.selectedIndex >= last || busy) {
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
      refreshTrackList(next, selectedTrackID(m));
      return [next, null];
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
  refreshTrackList(next, selectedTrackID(m));
  return [next, null];
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

export function selectedTrack(m: Model): Track | null {
  return m.tracks[m.selectedIndex] ?? null;
}

/** The saved rating for the selected track, if any. */
export function selectedRating(m: Model): Rating | null {
  const track = selectedTrack(m);
  return track === null ? null : (m.ratings.get(track.id) ?? null);
}

/** The selected track's ID, or 0 (never a real ID) when nothing is selected. */
export function selectedTrackID(m: Model): number {
  return selectedTrack(m)?.id ?? 0;
}

function moveSelectionTo(m: Model, index: number): Model {
  if (m.tracks.length === 0) {
    return m;
  }
  const clamped = Math.min(Math.max(index, 0), m.tracks.length - 1);
  if (clamped === m.selectedIndex) {
    return m;
  }
  const next = { ...m, selectedIndex: clamped };
  clearStatus(next);
  return next;
}

/** Loads tracks and ratings, and precomputes display and search text off the update path. */
export function loadTracksCmd(m: Model): Cmd {
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

function cycleSortMode(m: Model): void {
  const selectedTrackId = selectedTrackID(m);
  const index = sortModeCycle.indexOf(m.sortMode);
  m.sortMode = sortModeCycle[(index + 1) % sortModeCycle.length] ?? 'recentDesc';
  refreshTrackList(m, selectedTrackId);
}

const byRecentDesc = (left: Track, right: Track): number =>
  right.lastPlayedAt - left.lastPlayedAt || right.id - left.id;

const byIdAsc = (left: Track, right: Track): number => left.id - right.id;

const byTopPlayed = (left: Track, right: Track): number =>
  right.playCount - left.playCount || byRecentDesc(left, right);

function sortTracks(m: Model): void {
  // Sort a copy: the previous model (and anything memoized from it) keeps
  // its own order.
  const tracks = m.allTracks.slice();
  switch (m.sortMode) {
    case 'idAsc':
      tracks.sort(byIdAsc);
      break;
    case 'topPlayed':
      tracks.sort(byTopPlayed);
      break;
    case 'unratedFirst': {
      const { ratings } = m;
      tracks.sort((left, right) => {
        const leftRated = ratings.has(left.id);
        if (leftRated !== ratings.has(right.id)) {
          return leftRated ? 1 : -1;
        }
        return byRecentDesc(left, right);
      });
      break;
    }
    case 'recentDesc':
      tracks.sort(byRecentDesc);
      break;
  }
  m.allTracks = tracks;
  m.sortedBy = m.sortMode;
  m.sorted = true;
}

/** Re-sorts (only when needed) and re-filters, keeping `selectedTrackId` selected if it is still shown. */
export function refreshTrackList(m: Model, selectedTrackId: number): void {
  if (m.allTracks.length === 0 && m.tracks.length > 0) {
    m.allTracks = m.tracks;
    m.sorted = false;
  }
  if (!m.sorted || m.sortedBy !== m.sortMode) {
    sortTracks(m);
  }
  m.tracks = filterTracks(m, m.allTracks, m.searchQuery);
  if (m.tracks.length === 0) {
    m.selectedIndex = 0;
    m.editingRating = false;
    return;
  }
  const index = m.tracks.findIndex((track) => track.id === selectedTrackId);
  if (index >= 0) {
    m.selectedIndex = index;
    return;
  }
  m.selectedIndex = 0;
  m.editingRating = false;
}

/**
 * Search text aligned index for index with a sorted track array, built on
 * that array's first search. A per-keystroke scan of a plain string array
 * is several times faster than looking each track up in `trackText`.
 * Track arrays are never mutated once built, so their identity keys the
 * cache, and a re-sort (a new array) starts a fresh entry.
 */
const searchIndexes = new WeakMap<readonly Track[], readonly string[]>();

function searchIndex(m: Model, tracks: readonly Track[]): readonly string[] {
  let index = searchIndexes.get(tracks);
  if (index === undefined) {
    index = tracks.map((track) => textFor(m, track).search);
    searchIndexes.set(tracks, index);
  }
  return index;
}

function filterTracks(m: Model, tracks: readonly Track[], query: string): readonly Track[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    // Sharing is safe: arrays are never mutated after they are built.
    return tracks;
  }
  const index = searchIndex(m, tracks);
  const matches: Track[] = [];
  for (let position = 0; position < index.length; position++) {
    if (index[position]?.includes(needle) === true) {
      matches.push(tracks[position] as Track);
    }
  }
  return matches;
}

export function buildTrackText(tracks: readonly Track[]): Map<number, TrackText> {
  const texts = new Map<number, TrackText>();
  for (const track of tracks) {
    texts.set(track.id, newTrackText(track));
  }
  return texts;
}

function newTrackText(track: Track): TrackText {
  const artists = formatArtists(track.artists);
  return {
    artists,
    // NUL separators keep a pasted query from matching across fields.
    search: `${track.trackName}\x00${artists}\x00${track.albumName}`.toLowerCase(),
  };
}

/** Falls back to decoding on a cache miss so hand-built models (tests) behave like loaded ones. */
export function textFor(m: Model, track: Track): TrackText {
  return m.trackText.get(track.id) ?? newTrackText(track);
}

export function totalTrackCount(m: Model): number {
  return m.allTracks.length > 0 ? m.allTracks.length : m.tracks.length;
}

export function sortModeLabel(mode: SortMode): string {
  return sortModeLabels[mode];
}
