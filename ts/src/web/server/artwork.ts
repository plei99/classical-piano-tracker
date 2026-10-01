/**
 * Album art lookups for the web UI. The local database stores no artwork,
 * so the server asks Spotify on demand and remembers the answers on disk:
 * a library re-renders the same few hundred covers on every launch.
 *
 * Sources, in order: the Web API batch endpoint, the per-track endpoint
 * (Spotify restricts the batch one for some development-mode apps), then
 * the public oEmbed endpoint, which needs no token at all.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { loadConfig, mergeToken, saveConfig, validateClientCredentials, validateStoredToken } from '../../core/config';
import type { AlbumArt, ClientOptions } from '../../spotify';
import type { Artwork, ArtworkResponse } from '../api';

export const ARTWORK_CACHE_FILE = 'artwork-cache.json';

/** Production oEmbed origin. */
export const OEMBED_BASE_URL = 'https://open.spotify.com';

/** Spotify IDs are 22 base62 characters; anything else cannot be a track. */
const SPOTIFY_ID = /^[0-9A-Za-z]{22}$/;

const CACHE_VERSION = 1;
const DEFAULT_FAILURE_TTL_MS = 10 * 60_000;
const DEFAULT_PERSIST_DELAY_MS = 2_000;
const DEFAULT_CONCURRENCY = 4;
const OEMBED_TIMEOUT_MS = 10_000;

export function isSpotifyId(id: string): boolean {
  return SPOTIFY_ID.test(id);
}

/** The slice of the Spotify client the service uses, so tests can stub it. */
export interface ArtworkApi {
  albumArt(ids: readonly string[]): Promise<Map<string, AlbumArt>>;
  trackAlbumArt(id: string): Promise<AlbumArt>;
}

export interface ArtworkServiceOptions {
  /** Where answers persist; null keeps them in memory only. */
  cachePath: string | null;
  /**
   * An authenticated API client, or null when there is no usable token.
   * Called once per lookup so a `tracker spotify login` made while the
   * server runs takes effect without a restart.
   */
  spotify: () => ArtworkApi | null | Promise<ArtworkApi | null>;
  oembedBaseUrl?: string;
  fetch?: typeof fetch;
  /** Clock for the failure memo. */
  now?: () => number;
  failureTtlMs?: number;
  persistDelayMs?: number;
  /** Maximum simultaneous per-track requests to each source. */
  concurrency?: number;
}

/** What the HTTP layer needs; ArtworkService implements it. */
export interface ArtworkLookup {
  lookup(ids: readonly string[]): Promise<ArtworkResponse>;
}

export class ArtworkService implements ArtworkLookup {
  /** Settled answers: art, or null for "Spotify has none". Persisted. */
  private readonly cache: Map<string, Artwork | null>;
  /** Transient failures, by expiry time. Memory only, so a restart retries. */
  private readonly failures = new Map<string, number>();
  /** Lookups in progress, so overlapping requests share one fetch per ID. */
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly oembedBaseUrl: string;
  private readonly failureTtlMs: number;
  private readonly persistDelayMs: number;
  private readonly apiLimit: Limiter;
  private readonly oembedLimit: Limiter;
  /** Set once Spotify refuses the batch endpoint, so later lookups skip straight to per-track calls. */
  private batchRefused = false;
  /** Set once Spotify refuses per-track calls too; later lookups go to oEmbed. */
  private apiRefused = false;
  private dirty = false;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: ArtworkServiceOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.oembedBaseUrl = (options.oembedBaseUrl ?? OEMBED_BASE_URL).replace(/\/+$/, '');
    this.failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
    this.persistDelayMs = options.persistDelayMs ?? DEFAULT_PERSIST_DELAY_MS;
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.apiLimit = new Limiter(concurrency);
    this.oembedLimit = new Limiter(concurrency);
    this.cache = options.cachePath === null ? new Map() : readCache(options.cachePath);
  }

  /**
   * Art for each valid ID (invalid ones are dropped). Never rejects: an ID
   * that could not be looked up maps to null and is retried after the
   * failure TTL.
   */
  async lookup(ids: readonly string[]): Promise<ArtworkResponse> {
    const wanted = [...new Set(ids.filter(isSpotifyId))];
    const waits: Promise<void>[] = [];
    const missing: string[] = [];
    const now = this.now();
    for (const id of wanted) {
      if (this.cache.has(id)) continue;
      const retryAt = this.failures.get(id);
      if (retryAt !== undefined) {
        if (retryAt > now) continue;
        this.failures.delete(id);
      }
      const running = this.inflight.get(id);
      if (running !== undefined) {
        waits.push(running);
      } else {
        missing.push(id);
      }
    }
    if (missing.length > 0) {
      const batch = this.resolve(missing).finally(() => {
        for (const id of missing) this.inflight.delete(id);
      });
      for (const id of missing) this.inflight.set(id, batch);
      waits.push(batch);
    }
    await Promise.all(waits);

    const response: ArtworkResponse = {};
    for (const id of wanted) {
      response[id] = this.cache.get(id) ?? null;
    }
    return response;
  }

  /** Writes pending cache changes now. */
  flush(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.dirty || this.options.cachePath === null) {
      return;
    }
    try {
      writeCache(this.options.cachePath, this.cache);
      this.dirty = false;
    } catch {
      // The cache is an optimization; a failed write only costs refetches.
    }
  }

  /** Stops the debounce timer and saves what is pending. */
  close(): void {
    this.flush();
  }

  /** Records an outcome for every ID; never rejects. */
  private async resolve(ids: string[]): Promise<void> {
    let remaining = ids;
    let api: ArtworkApi | null = null;
    if (!this.apiRefused) {
      try {
        api = await this.options.spotify();
      } catch {
        api = null;
      }
    }
    if (api !== null) {
      remaining = await this.fromApi(api, remaining);
    }
    if (remaining.length > 0) {
      await this.fromOembed(remaining);
    }
  }

  /** Returns the IDs the API could not answer, for the oEmbed fallback. */
  private async fromApi(api: ArtworkApi, ids: string[]): Promise<string[]> {
    if (!this.batchRefused) {
      try {
        const found = await api.albumArt(ids);
        const unknown: string[] = [];
        for (const id of ids) {
          const art = found.get(id);
          // An ID the batch did not know gets a second opinion from oEmbed.
          if (art === undefined) unknown.push(id);
          else this.settle(id, art);
        }
        return unknown;
      } catch (err) {
        if (!isRefusal(err)) {
          return ids;
        }
        this.batchRefused = true;
      }
    }

    const leftover: string[] = [];
    await Promise.all(
      ids.map((id) =>
        this.apiLimit.run(async () => {
          if (this.apiRefused) {
            leftover.push(id);
            return;
          }
          try {
            this.settle(id, await api.trackAlbumArt(id));
          } catch (err) {
            // A 404 here could be the restriction rather than the track, so
            // only oEmbed's answer is trusted as "no such track".
            if (statusOf(err) === 403) this.apiRefused = true;
            leftover.push(id);
          }
        }),
      ),
    );
    return leftover;
  }

  private async fromOembed(ids: string[]): Promise<void> {
    await Promise.all(
      ids.map((id) =>
        this.oembedLimit.run(async () => {
          try {
            const thumbnail = await this.oembedThumbnail(id);
            this.settle(id, { small: thumbnail, medium: thumbnail, large: thumbnail });
          } catch {
            this.failures.set(id, this.now() + this.failureTtlMs);
          }
        }),
      ),
    );
  }

  /** oEmbed has one ~300 px thumbnail; null when the track does not exist. Throws on transient failure. */
  private async oembedThumbnail(id: string): Promise<string | null> {
    const trackUrl = `https://open.spotify.com/track/${id}`;
    const response = await this.fetch(`${this.oembedBaseUrl}/oembed?url=${encodeURIComponent(trackUrl)}`, {
      signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`oEmbed HTTP ${response.status}`);
    }
    const body = (await response.json()) as unknown;
    const thumbnail =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['thumbnail_url'] : undefined;
    return typeof thumbnail === 'string' && thumbnail !== '' ? thumbnail : null;
  }

  private settle(id: string, art: AlbumArt): void {
    const hasArt = art.small !== null || art.medium !== null || art.large !== null;
    this.cache.set(id, hasArt ? { small: art.small, medium: art.medium, large: art.large } : null);
    this.failures.delete(id);
    this.dirty = true;
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null || this.options.cachePath === null) {
      return;
    }
    this.persistTimer = setTimeout(() => this.flush(), this.persistDelayMs);
    // Pending writes are flushed by close(); they must not hold the process open.
    this.persistTimer.unref();
  }
}

/**
 * An ArtworkApi backed by the config's stored Spotify token, or null when
 * there is none. Token refreshes are merged and saved back to `configPath`
 * exactly as the CLI's client does, so the web server never strands a
 * refreshed token.
 */
export async function configArtworkApi(configPath: string, options: ClientOptions = {}): Promise<ArtworkApi | null> {
  let cfg;
  try {
    cfg = loadConfig(configPath);
    validateClientCredentials(cfg.spotify);
    validateStoredToken(cfg.spotify);
  } catch {
    return null;
  }
  const { Client } = await import('../../spotify');
  return new Client(
    { ...cfg.spotify },
    (token) => {
      cfg.spotify.token = mergeToken(token, cfg.spotify.token);
      saveConfig(configPath, cfg);
    },
    options,
  );
}

/** The cache file sits next to the database, which is per-user state like it. */
export function artworkCachePath(databasePath: string): string | null {
  if (databasePath === '' || databasePath === ':memory:' || databasePath.startsWith('file:')) {
    return null;
  }
  return join(dirname(databasePath), ARTWORK_CACHE_FILE);
}

/** 403 and 404 are how Spotify refuses restricted endpoints to development-mode apps. */
function isRefusal(err: unknown): boolean {
  const status = statusOf(err);
  return status === 403 || status === 404;
}

/** The HTTP status of a SpotifyApiError, which the client may wrap. */
function statusOf(err: unknown): number | null {
  for (let current = err; current instanceof Error; current = current.cause) {
    if ('status' in current && typeof current.status === 'number') {
      return current.status;
    }
  }
  return null;
}

/** A minimal semaphore: at most `limit` tasks run at once, the rest wait in order. */
class Limiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

// ---- Disk cache ----

function isArtwork(value: unknown): value is Artwork {
  if (typeof value !== 'object' || value === null) return false;
  const art = value as Record<string, unknown>;
  return (['small', 'medium', 'large'] as const).every((key) => art[key] === null || typeof art[key] === 'string');
}

/** A missing, unreadable, or foreign cache file starts empty rather than failing the server. */
function readCache(path: string): Map<string, Artwork | null> {
  const cache = new Map<string, Artwork | null>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return cache;
  }
  if (typeof parsed !== 'object' || parsed === null) return cache;
  const file = parsed as Record<string, unknown>;
  const entries = file['artwork'];
  if (file['version'] !== CACHE_VERSION || typeof entries !== 'object' || entries === null) return cache;
  for (const [id, art] of Object.entries(entries)) {
    if (isSpotifyId(id) && (art === null || isArtwork(art))) {
      cache.set(id, art === null ? null : { small: art.small, medium: art.medium, large: art.large });
    }
  }
  return cache;
}

/** Atomic replace with owner-only permissions, like the config file. */
function writeCache(path: string, cache: Map<string, Artwork | null>): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const data = JSON.stringify({ version: CACHE_VERSION, artwork: Object.fromEntries(cache) });
  const tempPath = join(dir, `.artwork-cache-${randomBytes(6).toString('hex')}.json`);
  try {
    writeFileSync(tempPath, data, { mode: 0o600, flag: 'wx' });
    renameSync(tempPath, path);
  } catch (err) {
    rmSync(tempPath, { force: true });
    throw err;
  }
}
