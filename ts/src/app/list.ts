/**
 * The track list the browser shows, behind one small interface (a count, a
 * row lookup, and an index-of-track) with two implementations:
 *
 * - `LocalTrackList` (here) holds the whole library in memory and sorts and
 *   filters it on the spot. The TUI browses one directly, and `tracker web`'s
 *   server answers the browser's queries from one, so both use exactly this
 *   sort and search.
 * - The web client's `RemoteTrackList` (web/client/remoteList.ts) holds a
 *   sparse window of a list the server sorted and filtered, filled in as
 *   the selection and scroll position approach unloaded rows.
 *
 * Lists are immutable: every change returns a new list, so models (and the
 * React trees drawn from them) compare by identity.
 */
import { formatArtists } from '../core/artists';
import type { Rating, Track } from '../core/model';

export type SortMode = 'recentDesc' | 'idAsc' | 'topPlayed' | 'unratedFirst';

export const sortModeCycle: readonly SortMode[] = ['recentDesc', 'idAsc', 'topPlayed', 'unratedFirst'];

export function isSortMode(value: string): value is SortMode {
  return (sortModeCycle as readonly string[]).includes(value);
}

/** One track as the list and detail panes show it. */
export interface ListRow {
  readonly track: Track;
  readonly rating: Rating | null;
  /** Display label, e.g. "Frédéric Chopin, Krystian Zimerman". */
  readonly artists: string;
}

/** Rows fetched for a remote list: one window of the list the server holds for `sort` and `query`. */
export interface ListChunk {
  readonly sort: SortMode;
  readonly query: string;
  /** The server's library version the rows come from. */
  readonly version: number;
  readonly total: number;
  readonly matched: number;
  readonly offset: number;
  readonly rows: readonly ListRow[];
}

export interface TrackList {
  /**
   * The order and filter these rows are in. Equal to the model's sort mode
   * and query, except while a remote list's re-query is in flight: the
   * presenter describes the rows on screen, not the request.
   */
  readonly sort: SortMode;
  readonly query: string;
  /** Every track in the library. */
  readonly total: number;
  /** The tracks matching `query`. */
  readonly count: number;
  /** The row at `index` (0 <= index < count), or null while a remote row is not loaded yet. */
  row(index: number): ListRow | null;
  /** The track's position, or -1 when it is not in the list (or, for a remote list, not loaded). */
  indexOf(trackId: number): number;
  /**
   * The same library in another order or filter. In-memory lists answer on
   * the spot; remote lists return null and the model asks the server.
   */
  requery(sort: SortMode, query: string): TrackList | null;
  /** The list with one track's rating replaced (shown at once; `unratedFirst` also needs a requery). */
  withRating(trackId: number, rating: Rating): TrackList;
  /**
   * Remote lists only: the list with fetched rows added. Returns this list
   * when the rows belong to another list (an older query or version), and
   * null when they come from a newer version of the library, so the model
   * refetches around the selection instead of mixing versions.
   */
  withRows?(chunk: ListChunk): TrackList | null;
}

/** Strings derived from a track's artists JSON, computed once per load. */
export interface TrackText {
  /** Display label, e.g. "Frédéric Chopin, Krystian Zimerman". */
  readonly artists: string;
  /** Lowercased name, artists, and album for substring search. */
  readonly search: string;
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

const emptyRatings: ReadonlyMap<number, Rating> = new Map();
const emptyText: ReadonlyMap<number, TrackText> = new Map();

/** The whole library in memory, sorted and filtered in-process. */
export class LocalTrackList implements TrackList {
  private constructor(
    private readonly ratings: ReadonlyMap<number, Rating>,
    /**
     * Caches strings derived from each track's artists JSON so rendering and
     * search never re-decode it per frame or per keystroke.
     */
    private readonly text: ReadonlyMap<number, TrackText>,
    /** Every track, ordered by `sortedBy` (null: as loaded, not sorted yet). */
    private readonly all: readonly Track[],
    private readonly sortedBy: SortMode | null,
    /** The tracks shown: `all` filtered by `query`. */
    readonly tracks: readonly Track[],
    readonly sort: SortMode,
    readonly query: string,
  ) {}

  static readonly empty = new LocalTrackList(emptyRatings, emptyText, [], null, [], 'recentDesc', '');

  /** A freshly loaded library, not sorted yet: `requery` it before showing it. */
  static load(
    tracks: readonly Track[],
    ratings: ReadonlyMap<number, Rating>,
    text: ReadonlyMap<number, TrackText> = buildTrackText(tracks),
  ): LocalTrackList {
    return new LocalTrackList(ratings, text, tracks, null, tracks, 'recentDesc', '');
  }

  /**
   * Shows `tracks` exactly as given, for hand-built models in tests. `all`
   * (the library, default `tracks`) is re-sorted on the next requery.
   */
  static of(
    tracks: readonly Track[],
    options: {
      ratings?: ReadonlyMap<number, Rating>;
      all?: readonly Track[];
      sort?: SortMode;
      query?: string;
      text?: ReadonlyMap<number, TrackText>;
    } = {},
  ): LocalTrackList {
    return new LocalTrackList(
      options.ratings ?? emptyRatings,
      options.text ?? emptyText,
      options.all ?? tracks,
      null,
      tracks,
      options.sort ?? 'recentDesc',
      options.query ?? '',
    );
  }

  get total(): number {
    return this.all.length;
  }

  get count(): number {
    return this.tracks.length;
  }

  row(index: number): ListRow | null {
    const track = this.tracks[index];
    if (track === undefined) {
      return null;
    }
    return { track, rating: this.ratings.get(track.id) ?? null, artists: this.textOf(track).artists };
  }

  indexOf(trackId: number): number {
    return this.tracks.findIndex((track) => track.id === trackId);
  }

  rating(trackId: number): Rating | null {
    return this.ratings.get(trackId) ?? null;
  }

  /** Re-sorts only when the order changed (a search keystroke just re-filters), then filters. */
  requery(sort: SortMode, query: string): LocalTrackList {
    let { all, sortedBy } = this;
    if (sortedBy !== sort) {
      all = sortTracks(all, sort, this.ratings);
      sortedBy = sort;
    }
    const tracks = this.filter(all, query);
    return new LocalTrackList(this.ratings, this.text, all, sortedBy, tracks, sort, query);
  }

  withRating(trackId: number, rating: Rating): LocalTrackList {
    // Copy before writing: the previous list may still be rendered.
    const ratings = new Map(this.ratings);
    ratings.set(trackId, rating);
    // Only the unrated-first order depends on ratings.
    const sortedBy = this.sortedBy === 'unratedFirst' ? null : this.sortedBy;
    return new LocalTrackList(ratings, this.text, this.all, sortedBy, this.tracks, this.sort, this.query);
  }

  /** Falls back to decoding on a cache miss so hand-built lists (tests) behave like loaded ones. */
  textOf(track: Track): TrackText {
    return this.text.get(track.id) ?? newTrackText(track);
  }

  private filter(tracks: readonly Track[], query: string): readonly Track[] {
    const needle = query.trim().toLowerCase();
    if (needle === '') {
      // Sharing is safe: arrays are never mutated after they are built.
      return tracks;
    }
    const index = this.searchIndex(tracks);
    const matches: Track[] = [];
    for (let position = 0; position < index.length; position++) {
      if (index[position]?.includes(needle) === true) {
        matches.push(tracks[position] as Track);
      }
    }
    return matches;
  }

  private searchIndex(tracks: readonly Track[]): readonly string[] {
    let index = searchIndexes.get(tracks);
    if (index === undefined) {
      index = tracks.map((track) => this.textOf(track).search);
      searchIndexes.set(tracks, index);
    }
    return index;
  }
}

/**
 * Search text aligned index for index with a sorted track array, built on
 * that array's first search. A per-keystroke scan of a plain string array
 * is several times faster than looking each track up in the text map.
 * Track arrays are never mutated once built, so their identity keys the
 * cache, and a re-sort (a new array) starts a fresh entry.
 */
const searchIndexes = new WeakMap<readonly Track[], readonly string[]>();

const byRecentDesc = (left: Track, right: Track): number =>
  right.lastPlayedAt - left.lastPlayedAt || right.id - left.id;

const byIdAsc = (left: Track, right: Track): number => left.id - right.id;

const byTopPlayed = (left: Track, right: Track): number =>
  right.playCount - left.playCount || byRecentDesc(left, right);

/** Sorts a copy: the previous list (and anything memoized from it) keeps its own order. */
function sortTracks(all: readonly Track[], sort: SortMode, ratings: ReadonlyMap<number, Rating>): readonly Track[] {
  const tracks = all.slice();
  switch (sort) {
    case 'idAsc':
      tracks.sort(byIdAsc);
      break;
    case 'topPlayed':
      tracks.sort(byTopPlayed);
      break;
    case 'unratedFirst':
      tracks.sort((left, right) => {
        const leftRated = ratings.has(left.id);
        if (leftRated !== ratings.has(right.id)) {
          return leftRated ? 1 : -1;
        }
        return byRecentDesc(left, right);
      });
      break;
    case 'recentDesc':
      tracks.sort(byRecentDesc);
      break;
  }
  return tracks;
}
