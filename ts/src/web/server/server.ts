/**
 * The local HTTP server behind `tracker web`: static assets plus the JSON
 * API from ../api.ts. It only ever serves the browser on this machine, so
 * the defenses target other web pages the user has open (DNS rebinding,
 * cross-site POSTs), not remote clients; see the security notes in api.ts.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Db } from '../../core/db';
import { errorMessage } from '../../core/errors';
import type { Rating, SyncStats } from '../../core/model';
import {
  API,
  ARTWORK_BATCH,
  type ErrorResponse,
  type LibraryResponse,
  type SaveRatingRequest,
  TOKEN_HEADER,
} from '../api';
import type { ArtworkLookup } from './artwork';

/** Static files keyed by URL path (`/`, `/assets/app.js`, ...). */
export type WebAssets = Record<string, { contentType: string; body: string }>;

/** Where the page receives its per-launch token; replaced on every `/` response. */
export const TOKEN_PLACEHOLDER = '%TRACKER_TOKEN%';

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

export interface WebServerOptions {
  db: Db;
  assets: WebAssets;
  /** Runs one Spotify sync into `db`. */
  sync: () => Promise<SyncStats>;
  artwork: ArtworkLookup;
  /** 0 (the default) picks a free port. */
  port?: number;
  /** Fixed token for tests; normally random per launch. */
  token?: string;
}

export interface WebServer {
  /** `http://127.0.0.1:<port>/` */
  url: string;
  port: number;
  token: string;
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
 * Binds 127.0.0.1 and serves until `close()`. Rejects with the listen error
 * (e.g. code EADDRINUSE) when the port cannot be bound.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const token = options.token ?? randomBytes(16).toString('hex');
  let port = 0;
  /** One sync at a time: overlapping runs would both count plays before either saves the checkpoint. */
  let syncing: Promise<SyncStats> | null = null;
  const sync = (): Promise<SyncStats> => {
    syncing ??= options.sync().finally(() => {
      syncing = null;
    });
    return syncing;
  };

  const routes: Record<string, { method: 'GET' | 'POST'; handle: (req: IncomingMessage, url: URL) => unknown }> = {
    [API.library]: {
      method: 'GET',
      handle: (): LibraryResponse => ({ tracks: options.db.listAllTracks(), ratings: options.db.listAllRatings() }),
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
      handle: async (req): Promise<Rating> => {
        const params = parseRating(await readBody(req));
        if (options.db.trackById(params.trackId) === null) {
          throw new HttpError(404, `track ${params.trackId} not found`);
        }
        return options.db.upsertRating(params);
      },
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
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
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

      if (isApi) {
        const route = routes[url.pathname];
        if (route === undefined) {
          throw new HttpError(404, `no API route ${url.pathname}`);
        }
        if (route.method !== method) {
          throw new HttpError(405, 'method not allowed', { Allow: route.method });
        }
        const body = await route.handle(req, url);
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify(body), 'no-store');
        return;
      }

      const asset = Object.hasOwn(options.assets, url.pathname) ? options.assets[url.pathname] : undefined;
      if (asset === undefined) {
        throw new HttpError(404, '404 page not found');
      }
      if (method !== 'GET') {
        throw new HttpError(405, 'method not allowed', { Allow: 'GET' });
      }
      if (url.pathname === '/') {
        send(res, 200, asset.contentType, asset.body.replaceAll(TOKEN_PLACEHOLDER, token), 'no-store');
      } else {
        send(res, 200, asset.contentType, asset.body, ASSET_CACHE_CONTROL);
      }
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
        send(res, failure.status, 'application/json; charset=utf-8', JSON.stringify(body), 'no-store');
      } else {
        send(res, failure.status, 'text/plain; charset=utf-8', `${failure.message}\n`, 'no-store');
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
    close: () =>
      new Promise((resolve) => {
        // Browsers hold keep-alive connections open indefinitely.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function send(res: ServerResponse, status: number, contentType: string, body: string, cacheControl: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
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
