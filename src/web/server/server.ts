/**
 * The local HTTP server behind `tracker web`: the server-rendered page,
 * static assets, and the JSON API from ../api.ts, answered from its copy of
 * the library (library.ts). It only ever serves the browser on this
 * machine, so the defenses target other web pages the user has open (DNS
 * rebinding, cross-site POSTs), not remote clients; see the security notes
 * in api.ts.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';

import { isSortMode } from '../../app/list';
import type { Db } from '../../core/db';
import { errorMessage } from '../../core/errors';
import type { Rating, SyncStats } from '../../core/model';
import {
  API,
  ARTWORK_BATCH,
  type ErrorResponse,
  type InitialData,
  PRESENCE_TOKEN_PARAM,
  type ReloadResponse,
  type SaveRatingRequest,
  TOKEN_HEADER,
  VIEW_CHUNK,
  VIEW_LIMIT_MAX,
  type ViewResponse,
  type ViewRow,
} from '../api';
import { themeFromCookies } from '../client/theme';
import type { ArtworkLookup } from './artwork';
import { compress, COMPRESS_MIN_BYTES, type Encoding, pickEncoding } from './compress';
import { Library, type LibraryView, type ViewQuery } from './library';
import type { PageRenderer } from './page';

/**
 * Static files keyed by URL path (`/assets/app.js`, ...). The build embeds
 * only their gzip and brotli encodings (base64), which keeps the binary
 * (and every command's startup) smaller; the plain body is then unzipped
 * on the rare request that accepts neither. Tests give plain bodies.
 */
export type WebAsset = { contentType: string } & (
  { body: string; gzip?: string; br?: string } | { body?: undefined; gzip: string; br?: string }
);
export type WebAssets = Record<string, WebAsset>;

// Spotify's iFrame API loader (open.spotify.com) pulls its code from embed-cdn.spotifycdn.com, and that
// code evaluates strings, so 'unsafe-eval' is required for in-page playback. It does not allow inline
// scripts: only this app's bundle and Spotify's scripts can run, and the app never passes strings to eval.
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-eval' https://open.spotify.com https://embed-cdn.spotifycdn.com; frame-src https://open.spotify.com; " +
  "img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; " +
  "form-action 'none'";

/** Generous for a rating with a long opinion, small enough that no request can exhaust memory. */
export const MAX_BODY_BYTES = 64 * 1024;

/** Assets are rebuilt with the binary, so a short cache only saves reloads within one session. */
const ASSET_CACHE_CONTROL = 'private, max-age=300';

/** How long no page may hold a presence stream before the server stops: enough for a reload to reconnect. */
export const PRESENCE_GRACE_MS = 3000;

/** Keeps presence streams from looking idle to anything between the page and the server. */
const PRESENCE_PING_MS = 15_000;

export interface WebServerOptions {
  db: Db;
  assets: WebAssets;
  /**
   * Renders GET / (page.tsx's renderPage). Passed in rather than imported:
   * the binary carries it as a separate chunk, evaluated only by
   * `tracker web`, so React's server renderer adds nothing to every other
   * command's startup.
   */
  renderPage: PageRenderer;
  /** Runs one Spotify sync into `db`. */
  sync: () => Promise<SyncStats>;
  artwork: ArtworkLookup;
  /** 0 (the default) picks a free port. */
  port?: number;
  /** Fixed token for tests; normally random per launch. */
  token?: string;
  /** Shorter in tests; PRESENCE_GRACE_MS otherwise. */
  presenceGraceMs?: number;
}

export interface WebServer {
  /** `http://127.0.0.1:<port>/` */
  url: string;
  port: number;
  token: string;
  /**
   * Resolves once a page has connected and then no page has held a presence
   * stream for the grace period, with no sync or rating save running.
   */
  allTabsClosed: Promise<void>;
  close(): Promise<void>;
}

/** A failure with a status and a message safe to show the user. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/**
 * Counts the pages holding a presence stream open and decides when the last
 * one has gone for good: none for the grace period, so a reload does not
 * count, and then no work running, so a sync or save is never cut short.
 */
class TabPresence {
  private tabs = 0;
  private busy = 0;
  private graceOver = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private resolve!: () => void;
  readonly allClosed = new Promise<void>((resolve) => (this.resolve = resolve));

  constructor(private readonly graceMs: number) {}

  opened(): void {
    this.tabs++;
    this.graceOver = false;
    clearTimeout(this.timer);
  }

  closed(): void {
    this.tabs--;
    if (this.tabs === 0 && !this.disposed) {
      this.timer = setTimeout(() => {
        this.graceOver = true;
        this.check();
      }, this.graceMs);
    }
  }

  /** Runs work the server must not stop in the middle of. */
  async work<T>(run: () => Promise<T>): Promise<T> {
    this.busy++;
    try {
      return await run();
    } finally {
      this.busy--;
      this.check();
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }

  private check(): void {
    if (this.graceOver && this.tabs === 0 && this.busy === 0) {
      this.resolve();
    }
  }
}

type Route =
  | { method: 'GET' | 'POST'; handle: (req: IncomingMessage, url: URL) => unknown }
  /** Answers with HTML instead of JSON. */
  | { method: 'GET'; page: (req: IncomingMessage) => string }
  /** Answers with its own stream instead of a JSON body. */
  | { method: 'GET'; stream: (url: URL, res: ServerResponse) => void };

/**
 * Binds 127.0.0.1 and serves until `close()`. Rejects with the listen error
 * (e.g. code EADDRINUSE) when the port cannot be bound.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const assets = prepareAssets(options.assets);
  const token = options.token ?? randomBytes(16).toString('hex');
  let port = 0;
  const presence = new TabPresence(options.presenceGraceMs ?? PRESENCE_GRACE_MS);
  const library = new Library(options.db);
  /** One sync at a time: overlapping runs would both count plays before either saves the checkpoint. */
  let syncing: Promise<SyncStats> | null = null;
  const sync = (): Promise<SyncStats> => {
    syncing ??= presence
      .work(async () => {
        const stats = await options.sync();
        try {
          library.reload();
          setImmediate(() => library.warm());
        } catch {
          // The next request reads the library again and reports the error.
          library.forget();
        }
        return stats;
      })
      .finally(() => {
        syncing = null;
      });
    return syncing;
  };

  /** Adds the art the artwork cache already knows, so the page can skip asking for it. */
  const viewResponse = (view: LibraryView): ViewResponse => ({
    ...view,
    rows: view.rows.map((row): ViewRow => {
      const art = options.artwork.known?.(row.track.spotifyId);
      return art === undefined ? { ...row } : { ...row, art };
    }),
  });

  // Read the library right after startup, so the first page does not wait
  // for it. The read is synchronous: a request that arrives first reads it
  // itself (Library.view), and never sees a "Loading" screen.
  setImmediate(() => {
    try {
      library.ensureLoaded();
      setImmediate(() => library.warm());
    } catch {
      // Reported to the page that asks for the library.
    }
  });

  const routes: Record<string, Route> = {
    '/': {
      method: 'GET',
      page: (req) => {
        let initial: InitialData;
        try {
          initial = {
            view: viewResponse(library.view({ sort: 'recentDesc', query: '', offset: 0, limit: VIEW_CHUNK })),
          };
        } catch (err) {
          initial = { error: errorMessage(err) };
        }
        return options.renderPage({ token, theme: themeFromCookies(req.headers.cookie), initial });
      },
    },
    [API.view]: {
      method: 'GET',
      handle: (_req, url): ViewResponse => viewResponse(library.view(parseViewQuery(url.searchParams))),
    },
    [API.reload]: {
      method: 'POST',
      handle: async (req): Promise<ReloadResponse> => {
        await readBody(req);
        const reloaded = library.reload();
        setImmediate(() => library.warm());
        return reloaded;
      },
    },
    [API.sync]: {
      method: 'POST',
      handle: async (req) => {
        await readBody(req);
        return sync();
      },
    },
    [API.ratings]: {
      method: 'POST',
      handle: (req): Promise<Rating> =>
        presence.work(async () => {
          const params = parseRating(await readBody(req));
          if (options.db.trackById(params.trackId) === null) {
            throw new HttpError(404, `track ${params.trackId} not found`);
          }
          const rating = options.db.upsertRating(params);
          library.setRating(rating);
          return rating;
        }),
    },
    [API.artwork]: {
      method: 'GET',
      handle: (_req, url) => {
        const raw = url.searchParams.get('ids') ?? '';
        const ids = raw === '' ? [] : raw.split(',');
        if (ids.length > ARTWORK_BATCH) {
          throw new HttpError(400, `at most ${ARTWORK_BATCH} ids per request, got ${ids.length}`);
        }
        return options.artwork.lookup(ids.map((id) => id.trim()));
      },
    },
    [API.presence]: {
      method: 'GET',
      stream: (url, res) => {
        if (!tokenMatches(url.searchParams.get(PRESENCE_TOKEN_PARAM) ?? undefined, token)) {
          throw new HttpError(403, 'missing or invalid token');
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        res.write(': ok\n\n');
        const ping = setInterval(() => res.write(': ping\n\n'), PRESENCE_PING_MS);
        presence.opened();
        res.on('close', () => {
          clearInterval(ping);
          presence.closed();
        });
      },
    },
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    const encoding = pickEncoding(req.headers['accept-encoding']);
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);

      // A rebinding attack reaches us under the attacker's host name.
      const host = (req.headers.host ?? '').toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        throw new HttpError(403, 'forbidden host');
      }
      const method = req.method ?? '';
      if (method !== 'GET' && method !== 'POST') {
        throw new HttpError(405, 'method not allowed', { Allow: 'GET, POST' });
      }
      if (method !== 'GET' && !tokenMatches(req.headers[TOKEN_HEADER.toLowerCase()], token)) {
        throw new HttpError(403, 'missing or invalid token');
      }

      const route = Object.hasOwn(routes, url.pathname) ? routes[url.pathname] : undefined;
      if (isApi || route !== undefined) {
        if (route === undefined) {
          throw new HttpError(404, `no API route ${url.pathname}`);
        }
        if (route.method !== method) {
          throw new HttpError(405, 'method not allowed', { Allow: route.method });
        }
        if ('stream' in route) {
          route.stream(url, res);
          return;
        }
        if ('page' in route) {
          const html = route.page(req);
          send(res, 200, 'text/html; charset=utf-8', compressed(Buffer.from(html), encoding), 'no-store');
          return;
        }
        const body = await route.handle(req, url);
        const json = Buffer.from(JSON.stringify(body));
        send(res, 200, 'application/json; charset=utf-8', compressed(json, encoding), 'no-store');
        return;
      }

      const asset = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : undefined;
      if (asset === undefined) {
        throw new HttpError(404, '404 page not found');
      }
      if (method !== 'GET') {
        throw new HttpError(405, 'method not allowed', { Allow: 'GET' });
      }
      send(res, 200, asset.contentType, asset.encoded(encoding), ASSET_CACHE_CONTROL);
    } catch (err) {
      const failure = err instanceof HttpError ? err : new HttpError(500, errorMessage(err));
      for (const [name, value] of Object.entries(failure.headers)) {
        res.setHeader(name, value);
      }
      if (failure.status === 413) {
        // The unread rest of the body would otherwise be parsed as the next request.
        res.setHeader('Connection', 'close');
      }
      if (isApi) {
        const body: ErrorResponse = { error: failure.message };
        send(res, failure.status, 'application/json; charset=utf-8', { body: JSON.stringify(body) }, 'no-store');
      } else {
        send(res, failure.status, 'text/plain; charset=utf-8', { body: `${failure.message}\n` }, 'no-store');
      }
    }
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    token,
    allTabsClosed: presence.allClosed,
    close: () =>
      new Promise((resolve) => {
        presence.dispose();
        // Browsers hold keep-alive connections (and presence streams) open indefinitely.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A response body, possibly compressed. `vary` marks bodies whose encoding depends on Accept-Encoding. */
interface Body {
  body: string | Buffer;
  encoding?: Encoding;
  vary?: boolean;
}

/** Compresses JSON and HTML worth compressing, when the request allows it. */
function compressed(body: Buffer, encoding: Encoding | null): Body {
  if (encoding === null || body.length < COMPRESS_MIN_BYTES) {
    return { body, vary: true };
  }
  return { body: compress(body, encoding), encoding, vary: true };
}

interface PreparedAsset {
  contentType: string;
  /** The body in the best encoding the request accepts. */
  encoded(encoding: Encoding | null): Body;
}

/** Decodes each asset's build-time encodings once, on first use. */
function prepareAssets(assets: WebAssets): Record<string, PreparedAsset> {
  const prepared: Record<string, PreparedAsset> = {};
  for (const [path, asset] of Object.entries(assets)) {
    const cache = new Map<string, Buffer>();
    const decode = (encoding: Encoding): Buffer | undefined => {
      const text = asset[encoding];
      if (text === undefined) return undefined;
      let buffer = cache.get(encoding);
      if (buffer === undefined) {
        buffer = Buffer.from(text, 'base64');
        cache.set(encoding, buffer);
      }
      return buffer;
    };
    let plain: Buffer | undefined;
    const identity = (): Buffer => (plain ??= Buffer.from(asset.body ?? gunzipSync(decode('gzip') ?? Buffer.alloc(0))));
    prepared[path] = {
      contentType: asset.contentType,
      encoded: (encoding) => {
        const vary = asset.gzip !== undefined || asset.br !== undefined;
        // Brotli when allowed; a gzip-only client still gets gzip.
        for (const candidate of encoding === 'br'
          ? (['br', 'gzip'] as const)
          : encoding === 'gzip'
            ? ['gzip' as const]
            : []) {
          const buffer = decode(candidate);
          if (buffer !== undefined) {
            return { body: buffer, encoding: candidate, vary };
          }
        }
        return { body: identity(), vary };
      },
    };
  }
  return prepared;
}

function send(res: ServerResponse, status: number, contentType: string, body: Body, cacheControl: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', cacheControl);
  if (body.vary === true) {
    res.setHeader('Vary', 'Accept-Encoding');
  }
  if (body.encoding !== undefined) {
    res.setHeader('Content-Encoding', body.encoding);
  }
  res.setHeader('Content-Length', Buffer.byteLength(body.body));
  res.end(body.body);
}

function tokenMatches(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== 'string') {
    return false;
  }
  const given = Buffer.from(header);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Reads the body as UTF-8, refusing anything over MAX_BODY_BYTES before buffering it. */
async function readBody(req: IncomingMessage): Promise<string> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) {
    throw new HttpError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A decimal integer parameter, or undefined when absent; anything else is a 400. */
function intParam(params: URLSearchParams, name: string, message: string): number | undefined {
  const raw = params.get(name);
  if (raw === null) {
    return undefined;
  }
  if (!/^\d{1,15}$/.test(raw)) {
    throw new HttpError(400, message);
  }
  return Number(raw);
}

/** Validates API.view's parameters. */
function parseViewQuery(params: URLSearchParams): ViewQuery {
  const sort = params.get('sort') ?? '';
  if (!isSortMode(sort)) {
    throw new HttpError(400, 'sort must be one of recentDesc, idAsc, topPlayed, unratedFirst');
  }
  const limitMessage = `limit must be an integer from 1 to ${VIEW_LIMIT_MAX}`;
  const limit = intParam(params, 'limit', limitMessage);
  if (limit === undefined || limit < 1 || limit > VIEW_LIMIT_MAX) {
    throw new HttpError(400, limitMessage);
  }
  const offset = intParam(params, 'offset', 'offset must be a non-negative integer') ?? 0;
  const around = intParam(params, 'around', 'around must be a positive track ID');
  if (around === 0) {
    throw new HttpError(400, 'around must be a positive track ID');
  }
  return { sort, query: params.get('q') ?? '', offset, limit, ...(around !== undefined && { around }) };
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Validates a SaveRatingRequest with the same limits the CLI's `rate` enforces. */
function parseRating(text: string): SaveRatingRequest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body must be JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'request body must be a JSON object');
  }
  const { trackId, stars, opinion, updatedAt } = value as Record<string, unknown>;
  if (!isPositiveInt(trackId)) {
    throw new HttpError(400, 'trackId must be a positive integer');
  }
  if (typeof stars !== 'number' || !Number.isInteger(stars) || stars < 1 || stars > 5) {
    throw new HttpError(400, `stars must be between 1 and 5, got ${JSON.stringify(stars) ?? 'nothing'}`);
  }
  if (typeof opinion !== 'string') {
    throw new HttpError(400, 'opinion must be a string');
  }
  if (!isPositiveInt(updatedAt)) {
    throw new HttpError(400, 'updatedAt must be a positive integer');
  }
  return { trackId, stars, opinion, updatedAt };
}
