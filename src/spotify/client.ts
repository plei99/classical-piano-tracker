/**
 * Authenticated Spotify Web API client over fetch, standing in for
 * zmb3/spotify plus oauth2's refreshing transport.
 */
import { mergeToken, type SpotifyConfig, type Token, validateStoredToken } from '../core/config';
import { quote, wrap } from '../core/errors';
import type { ArtistSearcher, CatalogArtist } from '../core/model';
import { DEFAULT_REDIRECT_URL, authenticator } from './auth';
import { encodeValues, HTTP_TIMEOUT_MS, requestSignal, sleep, statusText, transportError } from './http';
import { ACCOUNTS_BASE_URL, authorizationType, type OAuthConfig, refresh, tokenValid } from './oauth';
import { dateFromNs, parseRfc3339Ns } from './time';

/** Default production base for Web API requests. */
export const API_BASE_URL = 'https://api.spotify.com/v1/';

/** zmb3/spotify's wait when a 429 carries no usable Retry-After header. */
const DEFAULT_RETRY_DURATION_MS = 5_000;

const MAX_INT32 = 2 ** 31 - 1;
const MIN_INT32 = -(2 ** 31);

/** Spotify's limit on IDs per `GET /tracks` request. */
export const MAX_TRACK_BATCH = 50;

/**
 * A track's album art in Spotify's three usual sizes (~64, ~300, ~640 px).
 * Every size is null when the album has no images.
 */
export interface AlbumArt {
  small: string | null;
  medium: string | null;
  large: string | null;
}

/** Called with the merged token whenever the client refreshes it. */
export type TokenPersister = (token: Token) => void | Promise<void>;

export interface Artist {
  id: string;
  name: string;
}

/** One play from the recently-played endpoint. */
export interface RecentTrack {
  spotifyId: string;
  name: string;
  albumName: string;
  artists: Artist[];
  durationMs: number;
  playedAt: Date;
  /** Exact play time in Unix nanoseconds (Go's UnixNano), for the sync checkpoint. */
  playedAtNs: bigint;
}

export function artistNames(track: RecentTrack): string[] {
  return track.artists.map((artist) => artist.name);
}

export interface ClientOptions {
  accountsBaseUrl?: string;
  apiBaseUrl?: string;
  /** Per-request timeout; defaults to 30 seconds. */
  timeoutMs?: number;
  /** Cancels in-flight requests and rate-limit waits (Go's context). */
  signal?: AbortSignal;
}

/**
 * A non-success Web API response. The status is kept alongside Spotify's
 * message so callers can tell auth failures from rate limits.
 */
export class SpotifyApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SpotifyApiError';
  }
}

/** Authenticated Spotify Web API client that refreshes its token as needed. */
export class Client implements ArtistSearcher {
  private readonly oauth: OAuthConfig;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | undefined;
  /** What requests use; replaced by refreshes. */
  private current: Token;
  /** The raw token last seen by persistCurrentToken (Go's lastKnownToken). */
  private lastKnown: Token;
  /**
   * The token as last saved: the "previous" for mergeToken, the role
   * cfg.Spotify.Token played in the Go CLI's persist callback.
   */
  private lastSaved: Token;
  /** Serializes refreshes so concurrent calls spend the refresh token once. */
  private refreshing: Promise<Token> | null = null;

  /** Requires `spotify.token` (see `validateStoredToken`). */
  constructor(
    spotify: SpotifyConfig,
    private readonly persist: TokenPersister,
    options: ClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? HTTP_TIMEOUT_MS;
    this.oauth = authenticator(
      spotify,
      options.accountsBaseUrl ?? ACCOUNTS_BASE_URL,
      DEFAULT_REDIRECT_URL,
      this.timeoutMs,
    );
    try {
      validateStoredToken(spotify);
    } catch (err) {
      throw wrap('missing stored Spotify token', err);
    }
    const token = spotify.token!;
    this.current = { ...token };
    this.lastKnown = { ...token };
    this.lastSaved = { ...token };
    const apiBaseUrl = options.apiBaseUrl ?? API_BASE_URL;
    this.apiBaseUrl = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`;
    this.signal = options.signal;
  }

  /** Recently played tracks; `limit` must be 1..50 (0 means 50). */
  async recentTracks(limit: number): Promise<RecentTrack[]> {
    const normalizedLimit = normalizeRecentTrackLimit(limit);
    const url = `${this.apiBaseUrl}me/player/recently-played?${encodeValues({ limit: String(normalizedLimit) })}`;
    let tracks: RecentTrack[];
    try {
      // Go decoded played_at while reading the response, so a bad timestamp
      // fails the fetch rather than surfacing later.
      tracks = normalizeRecentlyPlayed(decodeRecentlyPlayed(await this.get(url)));
    } catch (err) {
      throw wrap('fetch recently played tracks from Spotify', err);
    }
    await this.persistCurrentToken();
    return tracks;
  }

  /** Searches the catalog for artists; a limit below 1 means 5. */
  async searchArtists(query: string, limit: number): Promise<CatalogArtist[]> {
    const pageSize = limit < 1 ? 5 : limit;
    const url = `${this.apiBaseUrl}search?${encodeValues({ limit: String(pageSize), q: query, type: 'artist' })}`;
    let artists: CatalogArtist[];
    try {
      artists = decodeArtistSearch(await this.get(url));
    } catch (err) {
      throw wrap(`search Spotify artists for ${quote(query)}`, err);
    }
    await this.persistCurrentToken();
    return artists;
  }

  /**
   * Album art for up to MAX_TRACK_BATCH tracks via `GET /tracks?ids=`.
   * Tracks Spotify does not know are absent from the result. Spotify
   * restricts this endpoint for some development-mode apps (403/404); the
   * SpotifyApiError status lets callers fall back to `trackAlbumArt`.
   */
  async albumArt(ids: readonly string[]): Promise<Map<string, AlbumArt>> {
    if (ids.length === 0 || ids.length > MAX_TRACK_BATCH) {
      throw new Error(`track batch must hold 1 to ${MAX_TRACK_BATCH} IDs, got ${ids.length}`);
    }
    const url = `${this.apiBaseUrl}tracks?${encodeValues({ ids: ids.join(',') })}`;
    let art: Map<string, AlbumArt>;
    try {
      art = decodeTracksAlbumArt(await this.get(url), ids);
    } catch (err) {
      throw wrap('fetch Spotify tracks', err);
    }
    await this.persistCurrentToken();
    return art;
  }

  /** Album art for one track via `GET /tracks/{id}`; an unknown track is a 404 SpotifyApiError. */
  async trackAlbumArt(id: string): Promise<AlbumArt> {
    const url = `${this.apiBaseUrl}tracks/${encodeURIComponent(id)}`;
    let art: AlbumArt;
    try {
      art = albumArtOf(asObject(await this.get(url), 'spotify.FullTrack'));
    } catch (err) {
      throw wrap(`fetch Spotify track ${quote(id)}`, err);
    }
    await this.persistCurrentToken();
    return art;
  }

  /** Returns a usable token, refreshing it first when expired or about to expire. */
  private currentToken(): Promise<Token> {
    if (tokenValid(this.current, Date.now())) {
      return Promise.resolve(this.current);
    }
    this.refreshing ??= refresh(this.oauth, this.current.refreshToken, this.signal)
      .then((token) => {
        this.current = token;
        return token;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  /**
   * Writes the token back after a successful call, but only when a refresh
   * actually changed it, so a refresh is persisted exactly once.
   */
  private async persistCurrentToken(): Promise<void> {
    let current: Token;
    try {
      current = await this.currentToken();
    } catch (err) {
      throw wrap('read current Spotify token', err);
    }
    if (tokensEqual(current, this.lastKnown)) {
      return;
    }
    const merged = mergeToken(current, this.lastSaved);
    try {
      await this.persist(merged);
    } catch (err) {
      throw wrap('persist refreshed Spotify token', err);
    }
    this.lastKnown = { ...current };
    this.lastSaved = merged;
  }

  /**
   * GETs a JSON resource. Like zmb3/spotify with retries enabled, a 429
   * waits for Retry-After and tries again, and a 204 yields null.
   */
  private async get(url: string): Promise<unknown> {
    for (;;) {
      let token: Token;
      try {
        token = await this.currentToken();
      } catch (err) {
        // oauth2's transport fails the request itself, so Go saw a *url.Error.
        throw wrap(`Get ${quote(url)}`, err);
      }
      let response: Response;
      let body: string;
      try {
        response = await fetch(url, {
          headers: { Authorization: `${authorizationType(token.tokenType)} ${token.accessToken}` },
          signal: requestSignal(this.timeoutMs, this.signal),
        });
        body = await response.text();
      } catch (err) {
        throw transportError('Get', url, err);
      }

      if (response.status === 429) {
        const waited = await sleep(retryDurationMs(response.headers.get('Retry-After')), this.signal);
        if (waited) {
          continue;
        }
        // Canceled while waiting: Go falls through and reports the 429.
      }
      if (response.status === 204) {
        return null;
      }
      if (response.status !== 200) {
        throw decodeError(response.status, body);
      }
      return JSON.parse(body) as unknown;
    }
  }
}

/** 0 means "the API maximum", matching the CLI's default. */
export function normalizeRecentTrackLimit(limit: number): number {
  if (limit === 0) {
    return 50;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error(`recent track limit must be between 1 and 50, got ${limit}`);
  }
  return limit;
}

/** Field-wise token comparison; expiries compare as instants, like Go's Time.Equal. */
export function tokensEqual(left: Token, right: Token): boolean {
  return (
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.tokenType === right.tokenType &&
    sameInstant(left.expiry, right.expiry)
  );
}

function sameInstant(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  try {
    return parseRfc3339Ns(left) === parseRfc3339Ns(right);
  } catch {
    return false;
  }
}

/**
 * Retry-After in whole seconds (Go's ParseInt(raw, 10, 32)); anything
 * unparseable falls back to the default wait, and negative values retry
 * immediately.
 */
export function retryDurationMs(header: string | null): number {
  if (header === null || !/^[+-]?\d+$/.test(header)) {
    return DEFAULT_RETRY_DURATION_MS;
  }
  const seconds = Number.parseInt(header, 10);
  if (seconds > MAX_INT32 || seconds < MIN_INT32) {
    return DEFAULT_RETRY_DURATION_MS;
  }
  return Math.max(seconds, 0) * 1000;
}

/**
 * Turns a failed response into an error the way zmb3/spotify's
 * `decodeError` does, keeping its fallbacks for empty or non-JSON bodies.
 * Unlike Go, Spotify's own message is prefixed with the HTTP status.
 */
export function decodeError(status: number, body: string): SpotifyApiError {
  if (body === '') {
    return new SpotifyApiError(status, `spotify: HTTP ${status}: ${statusText(status)} (body empty)`);
  }
  let message: string;
  try {
    message = errorEnvelopeMessage(JSON.parse(body));
  } catch {
    return new SpotifyApiError(status, `spotify: couldn't decode error: (${Buffer.byteLength(body)}) [${body}]`);
  }
  if (message === '') {
    return new SpotifyApiError(status, `spotify: unexpected HTTP ${status}: ${statusText(status)} (empty error)`);
  }
  return new SpotifyApiError(status, `spotify: HTTP ${status}: ${message}`);
}

/** `{"error":{"message":…}}` with Go's strictness: wrong types fail, nulls are empty. */
function errorEnvelopeMessage(value: unknown): string {
  if (value === null) {
    return '';
  }
  const envelope = asObject(value, 'error envelope');
  const error = envelope['error'];
  if (error === undefined || error === null) {
    return '';
  }
  const detail = asObject(error, 'spotify.Error');
  return optionalString(detail, 'message', 'Error');
}

// ---- Wire decoding ----
// Go's encoding/json leaves a field at its zero value for null or missing
// JSON, and fails on a type mismatch; these helpers do the same.

type JSONObject = Record<string, unknown>;

function kind(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value;
}

function asObject(value: unknown, where: string): JSONObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`json: cannot unmarshal ${kind(value)} into Go value of type ${where}`);
  }
  return value as JSONObject;
}

function optionalObject(obj: JSONObject, key: string, where: string): JSONObject {
  const value = obj[key];
  return value === undefined || value === null ? {} : asObject(value, `${where}.${key}`);
}

function optionalString(obj: JSONObject, key: string, where: string): string {
  const value = obj[key];
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`json: cannot unmarshal ${kind(value)} into Go struct field ${where}.${key} of type string`);
  }
  return value;
}

function optionalArray(obj: JSONObject, key: string, where: string): unknown[] {
  const value = obj[key];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`json: cannot unmarshal ${kind(value)} into Go struct field ${where}.${key} of type slice`);
  }
  return value;
}

/** zmb3's `Numeric`: Spotify sometimes sends integers as floats; Go truncates. */
function numeric(obj: JSONObject, key: string, where: string): number {
  const value = obj[key];
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value !== 'number') {
    throw new Error(`json: cannot unmarshal ${kind(value)} into Go struct field ${where}.${key} of type float64`);
  }
  return Math.trunc(value);
}

/** The recently-played item shape the client keeps from the wire. */
export interface RecentlyPlayedItem {
  track: {
    id: string;
    name: string;
    albumName: string;
    artists: Artist[];
    durationMs: number;
  };
  /** RFC 3339 text exactly as Spotify sent it. */
  playedAt: string;
}

/** Decodes a recently-played page (null, as for a 204, means no items). */
export function decodeRecentlyPlayed(value: unknown): RecentlyPlayedItem[] {
  if (value === null) {
    return [];
  }
  const page = asObject(value, 'spotify.RecentlyPlayedResult');
  return optionalArray(page, 'items', 'RecentlyPlayedResult').map((raw) => {
    const item = asObject(raw, 'spotify.RecentlyPlayedItem');
    const track = optionalObject(item, 'track', 'RecentlyPlayedItem');
    const album = optionalObject(track, 'album', 'SimpleTrack');
    const playedAt = item['played_at'];
    if (playedAt !== undefined && playedAt !== null && typeof playedAt !== 'string') {
      throw new Error(`json: cannot unmarshal ${kind(playedAt)} into Go struct field RecentlyPlayedItem.played_at`);
    }
    return {
      track: {
        id: optionalString(track, 'id', 'SimpleTrack'),
        name: optionalString(track, 'name', 'SimpleTrack'),
        albumName: optionalString(album, 'name', 'SimpleAlbum'),
        artists: optionalArray(track, 'artists', 'SimpleTrack').map((rawArtist) => {
          const artist = asObject(rawArtist, 'spotify.SimpleArtist');
          return {
            id: optionalString(artist, 'id', 'SimpleArtist'),
            name: optionalString(artist, 'name', 'SimpleArtist'),
          };
        }),
        durationMs: numeric(track, 'duration_ms', 'SimpleTrack'),
      },
      // A null time leaves Go's zero time.
      playedAt: playedAt ?? '0001-01-01T00:00:00Z',
    };
  });
}

/**
 * Converts wire items into the app's smaller normalized shape so
 * downstream modules do not depend on the API's JSON layout. `played_at`
 * is parsed exactly so the checkpoint keeps Go's nanosecond precision.
 */
export function normalizeRecentlyPlayed(items: RecentlyPlayedItem[]): RecentTrack[] {
  return items.map((item) => {
    const playedAtNs = parseRfc3339Ns(item.playedAt);
    return {
      spotifyId: item.track.id,
      name: item.track.name,
      albumName: item.track.albumName,
      artists: item.track.artists.map((artist) => ({ id: artist.id, name: artist.name })),
      durationMs: item.track.durationMs,
      playedAt: dateFromNs(playedAtNs),
      playedAtNs,
    };
  });
}

/** The size the "medium" slot aims for; Spotify's middle image is 300 px. */
const MEDIUM_IMAGE_PX = 300;

/**
 * Picks small/medium/large from an album's images by width rather than by
 * position: Spotify usually lists them largest first, but does not promise
 * it, and some albums carry only one or two sizes.
 */
export function pickAlbumArt(images: readonly { url: string; width: number }[]): AlbumArt {
  const usable = images.filter((image) => image.url !== '').sort((a, b) => a.width - b.width);
  const smallest = usable[0];
  const largest = usable[usable.length - 1];
  if (smallest === undefined || largest === undefined) {
    return { small: null, medium: null, large: null };
  }
  let medium = smallest;
  for (const image of usable) {
    if (Math.abs(image.width - MEDIUM_IMAGE_PX) < Math.abs(medium.width - MEDIUM_IMAGE_PX)) {
      medium = image;
    }
  }
  return { small: smallest.url, medium: medium.url, large: largest.url };
}

function albumArtOf(track: JSONObject): AlbumArt {
  const album = optionalObject(track, 'album', 'FullTrack');
  return pickAlbumArt(
    optionalArray(album, 'images', 'SimpleAlbum').map((raw) => {
      const image = asObject(raw, 'spotify.Image');
      return { url: optionalString(image, 'url', 'Image'), width: numeric(image, 'width', 'Image') };
    }),
  );
}

/**
 * Decodes a `GET /tracks` page. Spotify answers in request order with null
 * for unknown IDs, so results are keyed by the requested ID: a relinked
 * track can come back under a different `id`.
 */
export function decodeTracksAlbumArt(value: unknown, ids: readonly string[]): Map<string, AlbumArt> {
  const art = new Map<string, AlbumArt>();
  if (value === null) {
    return art;
  }
  const page = asObject(value, 'spotify.FullTrackPage');
  optionalArray(page, 'tracks', 'FullTrackPage').forEach((raw, index) => {
    const id = ids[index];
    if (raw !== null && id !== undefined) {
      art.set(id, albumArtOf(asObject(raw, 'spotify.FullTrack')));
    }
  });
  return art;
}

/** Maps an artist search page to catalog artists; a missing page means none. */
export function decodeArtistSearch(value: unknown): CatalogArtist[] {
  if (value === null) {
    return [];
  }
  const result = asObject(value, 'spotify.SearchResult');
  const page = optionalObject(result, 'artists', 'SearchResult');
  return optionalArray(page, 'items', 'FullArtistPage').map((raw) => {
    const artist = asObject(raw, 'spotify.FullArtist');
    return {
      name: optionalString(artist, 'name', 'FullArtist'),
      id: optionalString(artist, 'id', 'FullArtist'),
      popularity: numeric(artist, 'popularity', 'FullArtist'),
      genres: optionalArray(artist, 'genres', 'FullArtist').map((genre) => {
        if (typeof genre !== 'string') {
          throw new Error(
            `json: cannot unmarshal ${kind(genre)} into Go struct field FullArtist.genres of type string`,
          );
        }
        return genre;
      }),
    };
  });
}
