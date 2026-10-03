/**
 * The HTTP contract between `tracker web`'s local server and the browser UI.
 * Both sides import these types, so a shape change breaks the build rather
 * than the page.
 *
 * The server owns the library: it reads tracks and ratings once (and again
 * on reload, sync, and rating saves), keeps the four sort orders, and
 * answers windowed queries (API.view) with the TUI's own sort and search
 * (app/list.ts). The browser keeps the UI state (the TUI's model) and a
 * sparse cache of rows, so moving between loaded rows never touches the
 * network; it never downloads the whole library.
 *
 * GET / is rendered on the server: the first screen for the default state
 * (sort recentDesc, no query, the first track selected), with the data it
 * was rendered from in `<script type="application/json" id="tracker-initial">`
 * as `InitialData`, which the client hydrates from. `<html data-theme>`
 * comes from the THEME_COOKIE cookie.
 *
 * Responses are gzip- or brotli-compressed when the request allows it
 * (static assets are compressed at build time, JSON and HTML over 1 KiB on
 * the fly), never the presence stream.
 *
 * Security model: the server binds 127.0.0.1 only and rejects requests whose
 * Host header is not the address it serves (blocks DNS rebinding). Every
 * request that changes state must carry the per-launch token from the page's
 * `<meta name="tracker-token">` in the TOKEN_HEADER header; other sites can
 * neither read the token nor send that header without a CORS preflight, which
 * the server never approves.
 *
 * The presence stream is a GET, because EventSource cannot send headers, so
 * it takes the token as a query parameter instead. A wrong or missing token
 * gets the usual 403, so another site cannot hold the server open.
 */
import type { SortMode } from '../app/list';
import type { Rating, SyncStats, Track, UpsertRatingParams } from '../core/model';

export const TOKEN_HEADER = 'X-Tracker-Token';
export const TOKEN_META = 'tracker-token';

export const API = {
  /**
   * GET ?sort=<SortMode>&q=<query>&offset=<n>&limit=<n>[&around=<track id>] -> ViewResponse.
   * `q` (default empty) filters exactly as the TUI's search does: trimmed,
   * lowercased substring over track name, artists, and album. `offset`
   * defaults to 0; `limit` must be 1..VIEW_LIMIT_MAX. With `around`, if
   * that track matches, the window is centered on it (clamped to the list;
   * `offset` is ignored) and `index` is its position; otherwise `index` is
   * null and `offset` applies. A bad parameter is a 400.
   */
  view: '/api/view',
  /** POST (no body) -> ReloadResponse: re-reads the database. */
  reload: '/api/reload',
  /** POST (no body) -> SyncStats; the server then reloads its library (a new version). */
  sync: '/api/sync',
  /** POST SaveRatingRequest -> Rating; the server's copy of the rating changes too (a new version). */
  ratings: '/api/ratings',
  /** GET ?ids=<spotify id>,<spotify id>... (at most ARTWORK_BATCH) -> ArtworkResponse */
  artwork: '/api/artwork',
  /**
   * GET ?token=<page token> -> text/event-stream that sends only comments
   * (one at once, then one every 15 s) and never ends on its own. Each open
   * page holds one; the server stops a few seconds after the last closes.
   */
  presence: '/api/presence',
} as const;

/** The query parameter that carries the page token on API.presence. */
export const PRESENCE_TOKEN_PARAM = 'token';

/** Spotify's track lookup accepts at most 50 IDs per request. */
export const ARTWORK_BATCH = 50;

/** The most rows one API.view request may ask for. */
export const VIEW_LIMIT_MAX = 500;

/** Rows per window the page asks for, and that GET / sends: about six screens of the list pane. */
export const VIEW_CHUNK = 100;

/** The theme choice the server renders into `<html data-theme>`: auto, light, or dark. */
export const THEME_COOKIE = 'tracker-theme';

/** The element holding InitialData on the server-rendered page. */
export const INITIAL_DATA_ID = 'tracker-initial';

/** One track in a view, with what the list and detail panes show for it. */
export interface ViewRow {
  track: Track;
  rating: Rating | null;
  /** The display label for the artists, formatted as the TUI formats it. */
  artists: string;
  /**
   * Present only when the server's artwork cache already knows the track
   * (null: known to have no art); otherwise ask API.artwork.
   */
  art?: Artwork | null;
}

export interface ViewResponse {
  /** Increases whenever the library or a rating changes; rows from different versions never mix. */
  version: number;
  /** Every track in the library. */
  total: number;
  /** Tracks matching the query. */
  matched: number;
  /** The position of rows[0] in the matched list. */
  offset: number;
  rows: ViewRow[];
  /** The `around` track's position in the matched list, or null. */
  index: number | null;
}

export interface ReloadResponse {
  version: number;
  total: number;
}

/** What GET / was rendered from: the first window of the default view, or why the library could not load. */
export type InitialData = { view: ViewResponse } | { error: string };

export type SaveRatingRequest = UpsertRatingParams;
export type SyncResponse = SyncStats;

/** Album art in Spotify's three sizes; any can be null when Spotify lacks it. */
export interface Artwork {
  /** ~64 px, for list rows. */
  small: string | null;
  /** ~300 px. */
  medium: string | null;
  /** ~640 px, for the detail pane. */
  large: string | null;
}

/** Keyed by Spotify track ID; null when the track has no art or could not be looked up. */
export type ArtworkResponse = Record<string, Artwork | null>;

/** Every non-2xx response has this body. */
export interface ErrorResponse {
  error: string;
}
