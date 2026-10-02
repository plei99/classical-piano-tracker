/**
 * The HTTP contract between `tracker web`'s local server and the browser UI.
 * Both sides import these types, so a shape change breaks the build rather
 * than the page.
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
import type { Rating, SyncStats, Track, UpsertRatingParams } from '../core/model';

export const TOKEN_HEADER = 'X-Tracker-Token';
export const TOKEN_META = 'tracker-token';

export const API = {
  /** GET -> LibraryResponse */
  library: '/api/library',
  /** POST (no body) -> SyncStats */
  sync: '/api/sync',
  /** POST SaveRatingRequest -> Rating */
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

export interface LibraryResponse {
  tracks: Track[];
  ratings: Rating[];
}

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
