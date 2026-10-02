import { type ClientRequest, request } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { Db } from '../../core/db';
import { emptySyncStats, type SyncStats } from '../../core/model';
import { API, type ArtworkResponse, PRESENCE_TOKEN_PARAM, TOKEN_HEADER } from '../api';
import type { ArtworkLookup } from './artwork';
import {
  CONTENT_SECURITY_POLICY,
  MAX_BODY_BYTES,
  PRESENCE_GRACE_MS,
  startWebServer,
  type WebAssets,
  type WebServer,
  type WebServerOptions,
} from './server';

const ASSETS: WebAssets = {
  '/': {
    contentType: 'text/html; charset=utf-8',
    body: '<meta name="tracker-token" content="%TRACKER_TOKEN%"><script src="/assets/app.js"></script>',
  },
  '/assets/app.js': { contentType: 'text/javascript; charset=utf-8', body: 'console.log(1)' },
  '/assets/app.css': { contentType: 'text/css; charset=utf-8', body: 'body{}' },
};

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json(): unknown;
}

interface Harness {
  server: WebServer;
  db: Db;
  syncCalls: number;
  artworkCalls: string[][];
  call(method: string, path: string, init?: { body?: string; headers?: Record<string, string> }): Promise<Reply>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function harness(overrides: Partial<WebServerOptions> = {}): Promise<Harness> {
  const db = Db.openInMemory();
  const h: Partial<Harness> & { syncCalls: number; artworkCalls: string[][] } = { syncCalls: 0, artworkCalls: [] };
  const artwork: ArtworkLookup = {
    lookup: (ids) => {
      h.artworkCalls.push([...ids]);
      return Promise.resolve(Object.fromEntries(ids.map((id) => [id, null])) as ArtworkResponse);
    },
  };
  const server = await startWebServer({
    db,
    assets: ASSETS,
    artwork,
    sync: () => {
      h.syncCalls++;
      return Promise.resolve({ ...emptySyncStats(), fetched: 3 });
    },
    ...overrides,
  });
  cleanups.push(async () => {
    await server.close();
    db.close();
  });
  const call: Harness['call'] = (method, path, init = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: server.port,
          method,
          path,
          headers: { Host: `127.0.0.1:${server.port}`, ...init.headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
          });
        },
      );
      req.on('error', reject);
      req.end(init.body);
    });
  return Object.assign(h, { server, db, call });
}

function post(h: Harness, path: string, body: unknown): Promise<Reply> {
  return h.call('POST', path, {
    body: JSON.stringify(body),
    headers: { [TOKEN_HEADER]: h.server.token, 'Content-Type': 'application/json' },
  });
}

function seedTrack(db: Db): number {
  return db.upsertTrack({
    spotifyId: 'sp-1',
    trackName: 'Scarbo',
    albumName: 'Gaspard',
    artists: '["Martha Argerich"]',
    lastPlayedAt: 100,
  }).id;
}

describe('web server', () => {
  it('binds 127.0.0.1 with a random 32-hex token', async () => {
    const h = await harness();
    expect(h.server.url).toBe(`http://127.0.0.1:${h.server.port}/`);
    expect(h.server.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('serves the page with the token substituted, the CSP, and no caching', async () => {
    const h = await harness();
    const page = await h.call('GET', '/');
    expect(page.status).toBe(200);
    expect(page.body).toBe(
      `<meta name="tracker-token" content="${h.server.token}"><script src="/assets/app.js"></script>`,
    );
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-eval' https://open.spotify.com https://embed-cdn.spotifycdn.com; frame-src https://open.spotify.com; " +
        "img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; " +
        "form-action 'none'",
    );
    expect(page.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves assets as-is with a short cache', async () => {
    const h = await harness();
    const js = await h.call('GET', '/assets/app.js?v=1');
    expect(js.status).toBe(200);
    expect(js.body).toBe('console.log(1)');
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('private, max-age=300');
  });

  it('accepts localhost and rejects any other Host', async () => {
    const h = await harness();
    expect((await h.call('GET', '/', { headers: { Host: `localhost:${h.server.port}` } })).status).toBe(200);
    for (const host of [
      'evil.example',
      `evil.example:${h.server.port}`,
      '127.0.0.1',
      `127.0.0.1:${h.server.port + 1}`,
    ]) {
      const reply = await h.call('GET', API.library, { headers: { Host: host } });
      expect(reply.status).toBe(403);
      expect(reply.json()).toEqual({ error: 'forbidden host' });
    }
    expect((await h.call('GET', '/', { headers: { Host: 'evil.example' } })).body).toBe('forbidden host\n');
  });

  it('requires the token on POST', async () => {
    const h = await harness();
    for (const headers of [{}, { [TOKEN_HEADER]: 'f'.repeat(32) }, { [TOKEN_HEADER]: 'short' }] as Record<
      string,
      string
    >[]) {
      const reply = await h.call('POST', API.sync, { headers });
      expect(reply.status).toBe(403);
      expect(reply.json()).toEqual({ error: 'missing or invalid token' });
    }
    expect(h.syncCalls).toBe(0);
  });

  it('rejects other methods with 405, and wrong methods per route', async () => {
    const h = await harness();
    for (const method of ['PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
      const reply = await h.call(method, API.ratings, { headers: { [TOKEN_HEADER]: h.server.token } });
      expect(reply.status).toBe(405);
      expect(reply.headers['allow']).toBe('GET, POST');
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    }
    const getSync = await h.call('GET', API.sync);
    expect(getSync.status).toBe(405);
    expect(getSync.headers['allow']).toBe('POST');
    expect((await post(h, API.library, {})).status).toBe(405);
    expect((await post(h, '/assets/app.js', {})).status).toBe(405);
  });

  it('answers unknown paths with 404: JSON under /api, text elsewhere', async () => {
    const h = await harness();
    const api = await h.call('GET', '/api/nope');
    expect(api.status).toBe(404);
    expect(api.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(api.json()).toEqual({ error: 'no API route /api/nope' });
    const page = await h.call('GET', '/nope');
    expect(page.status).toBe(404);
    expect(page.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(page.body).toBe('404 page not found\n');
    // Inherited object keys are not assets.
    expect((await h.call('GET', '/constructor')).status).toBe(404);
  });

  it('returns the library', async () => {
    const h = await harness();
    const trackId = seedTrack(h.db);
    h.db.upsertRating({ trackId, stars: 4, opinion: 'Glittering', updatedAt: 200 });
    const reply = await h.call('GET', API.library);
    expect(reply.status).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.json()).toEqual({ tracks: h.db.listAllTracks(), ratings: h.db.listAllRatings() });
  });

  it('runs sync, sharing one run between overlapping requests', async () => {
    let release!: (stats: SyncStats) => void;
    let calls = 0;
    const h = await harness({
      sync: () => {
        calls++;
        return calls === 1 ? new Promise((resolve) => (release = resolve)) : Promise.resolve(emptySyncStats());
      },
    });
    const first = post(h, API.sync, {});
    const second = post(h, API.sync, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    release({ ...emptySyncStats(), inserted: 2 });
    const replies = await Promise.all([first, second]);
    expect(replies.map((r) => r.json())).toEqual([
      { ...emptySyncStats(), inserted: 2 },
      { ...emptySyncStats(), inserted: 2 },
    ]);
    expect(calls).toBe(1);

    // A finished run does not stick: the next request syncs again.
    expect((await post(h, API.sync, {})).status).toBe(200);
    expect(calls).toBe(2);
  });

  it('reports sync failures as JSON 500s', async () => {
    const h = await harness({ sync: () => Promise.reject(new Error('spotify login required')) });
    const reply = await post(h, API.sync, {});
    expect(reply.status).toBe(500);
    expect(reply.json()).toEqual({ error: 'spotify login required' });
  });

  it('saves a valid rating and returns it', async () => {
    const h = await harness();
    const trackId = seedTrack(h.db);
    const rating = { trackId, stars: 5, opinion: 'Electric', updatedAt: 300 };
    const reply = await post(h, API.ratings, rating);
    expect(reply.status).toBe(200);
    expect(reply.json()).toEqual(rating);
    expect(h.db.ratingByTrackId(trackId)).toEqual(rating);
  });

  it('validates ratings', async () => {
    const h = await harness();
    const trackId = seedTrack(h.db);
    const valid = { trackId, stars: 3, opinion: '', updatedAt: 1 };
    const cases: [unknown, string][] = [
      ['not json', 'request body must be JSON'],
      [[], 'request body must be a JSON object'],
      [{ ...valid, trackId: 0 }, 'trackId must be a positive integer'],
      [{ ...valid, trackId: '1' }, 'trackId must be a positive integer'],
      [{ ...valid, trackId: 1.5 }, 'trackId must be a positive integer'],
      [{ ...valid, stars: 0 }, 'stars must be between 1 and 5, got 0'],
      [{ ...valid, stars: 6 }, 'stars must be between 1 and 5, got 6'],
      [{ ...valid, stars: 2.5 }, 'stars must be between 1 and 5, got 2.5'],
      [{ ...valid, stars: undefined }, 'stars must be between 1 and 5, got nothing'],
      [{ ...valid, opinion: null }, 'opinion must be a string'],
      [{ ...valid, updatedAt: -1 }, 'updatedAt must be a positive integer'],
    ];
    for (const [body, error] of cases) {
      const reply = await h.call('POST', API.ratings, {
        body: typeof body === 'string' ? body : JSON.stringify(body),
        headers: { [TOKEN_HEADER]: h.server.token },
      });
      expect([reply.status, reply.json()]).toEqual([400, { error }]);
    }
    const missing = await post(h, API.ratings, { ...valid, trackId: trackId + 1 });
    expect([missing.status, missing.json()]).toEqual([404, { error: `track ${trackId + 1} not found` }]);
    expect(h.db.listAllRatings()).toEqual([]);
  });

  it('limits request bodies to 64 KB', async () => {
    const h = await harness();
    const trackId = seedTrack(h.db);
    const atLimit = JSON.stringify({ trackId, stars: 1, opinion: '', updatedAt: 1 });
    const padded = atLimit.replace('"opinion":""', `"opinion":"${'x'.repeat(MAX_BODY_BYTES - atLimit.length)}"`);
    expect(Buffer.byteLength(padded)).toBe(MAX_BODY_BYTES);
    expect(
      (await h.call('POST', API.ratings, { body: padded, headers: { [TOKEN_HEADER]: h.server.token } })).status,
    ).toBe(200);

    const tooBig = await h.call('POST', API.ratings, {
      body: `${padded} `,
      headers: { [TOKEN_HEADER]: h.server.token },
    });
    expect([tooBig.status, tooBig.json()]).toEqual([413, { error: 'request body exceeds 65536 bytes' }]);
  });

  it('limits chunked bodies without a Content-Length', async () => {
    const h = await harness();
    const reply = await h.call('POST', API.sync, {
      body: 'x'.repeat(MAX_BODY_BYTES + 1),
      headers: { [TOKEN_HEADER]: h.server.token, 'Transfer-Encoding': 'chunked' },
    });
    expect(reply.status).toBe(413);
    expect(h.syncCalls).toBe(0);
  });

  it('looks up artwork, refusing oversized batches', async () => {
    const h = await harness();
    const reply = await h.call('GET', `${API.artwork}?ids=a,%20b`);
    expect([reply.status, reply.json()]).toEqual([200, { a: null, b: null }]);
    expect(h.artworkCalls).toEqual([['a', 'b']]);

    expect((await h.call('GET', API.artwork)).json()).toEqual({});
    const ids = Array.from({ length: 51 }, (_, i) => `id${i}`).join(',');
    const tooMany = await h.call('GET', `${API.artwork}?ids=${ids}`);
    expect([tooMany.status, tooMany.json()]).toEqual([400, { error: 'at most 50 ids per request, got 51' }]);
  });

  it('fails to start on a busy port with the listen error code', async () => {
    const h = await harness();
    const err = await startWebServer({
      db: h.db,
      assets: ASSETS,
      artwork: { lookup: () => Promise.resolve({}) },
      sync: () => Promise.resolve(emptySyncStats()),
      port: h.server.port,
    }).then(
      () => new Error('expected a rejection') as NodeJS.ErrnoException,
      (e: unknown) => e as NodeJS.ErrnoException,
    );
    expect(err.code).toBe('EADDRINUSE');
  });
});

/** An open presence stream, as a page holds one. */
interface Tab {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** What the server has sent so far. */
  received: () => string;
  close(): void;
}

/** Opens a presence stream and resolves once the server answers (with the stream's first bytes, if it is one). */
function openTab(h: Harness, query = `?${PRESENCE_TOKEN_PARAM}=${h.server.token}`, host?: string): Promise<Tab> {
  return new Promise((resolve, reject) => {
    let req: ClientRequest | undefined = undefined;
    req = request(
      {
        host: '127.0.0.1',
        port: h.server.port,
        path: `${API.presence}${query}`,
        headers: { Host: host ?? `127.0.0.1:${h.server.port}` },
      },
      (res) => {
        let text = '';
        const tab: Tab = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          received: () => text,
          close: () => req?.destroy(),
        };
        res.on('data', (chunk: Buffer) => {
          const first = text === '';
          text += chunk.toString('utf8');
          if (first) resolve(tab);
        });
        res.on('end', () => resolve(tab));
        res.on('error', () => {});
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves to whether `allTabsClosed` settled within `ms`. */
async function closedWithin(h: Harness, ms: number): Promise<boolean> {
  return Promise.race([h.server.allTabsClosed.then(() => true), sleep(ms).then(() => false)]);
}

describe('presence', () => {
  const GRACE = 60;

  it('waits 3 s by default', () => {
    expect(PRESENCE_GRACE_MS).toBe(3000);
  });

  it('streams comments to a page with the token', async () => {
    const h = await harness();
    const tab = await openTab(h);
    expect(tab.status).toBe(200);
    expect(tab.headers['content-type']).toBe('text/event-stream');
    expect(tab.headers['cache-control']).toBe('no-store');
    expect(tab.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(tab.received()).toBe(': ok\n\n');
    tab.close();
  });

  it('rejects a missing or wrong token and a foreign Host, without counting them', async () => {
    const h = await harness({ presenceGraceMs: GRACE });
    for (const query of ['', `?${PRESENCE_TOKEN_PARAM}=`, `?${PRESENCE_TOKEN_PARAM}=${'f'.repeat(32)}`]) {
      const tab = await openTab(h, query);
      expect([tab.status, JSON.parse(tab.received())]).toEqual([403, { error: 'missing or invalid token' }]);
    }
    // The token in the header (as POSTs send it) does not count either.
    const header = await h.call('GET', API.presence, { headers: { [TOKEN_HEADER]: h.server.token } });
    expect(header.status).toBe(403);
    const foreign = await openTab(h, undefined, 'evil.example');
    expect([foreign.status, JSON.parse(foreign.received())]).toEqual([403, { error: 'forbidden host' }]);
    const posted = await post(h, `${API.presence}?${PRESENCE_TOKEN_PARAM}=${h.server.token}`, {});
    expect([posted.status, posted.headers['allow']]).toEqual([405, 'GET']);
    expect(await closedWithin(h, GRACE * 3)).toBe(false);
  });

  it('never stops before a page has connected', async () => {
    const h = await harness({ presenceGraceMs: GRACE });
    expect((await h.call('GET', '/')).status).toBe(200);
    expect(await closedWithin(h, GRACE * 3)).toBe(false);
  });

  it('stops once the last stream has been closed for the grace period', async () => {
    const h = await harness({ presenceGraceMs: GRACE });
    const tab = await openTab(h);
    expect(await closedWithin(h, GRACE * 2)).toBe(false);
    const closedAt = Date.now();
    tab.close();
    await h.server.allTabsClosed;
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(GRACE - 5);
  });

  it('keeps running through a reload', async () => {
    const h = await harness({ presenceGraceMs: GRACE });
    const before = await openTab(h);
    before.close();
    await sleep(GRACE / 3);
    const after = await openTab(h);
    expect(await closedWithin(h, GRACE * 3)).toBe(false);
    after.close();
    expect(await closedWithin(h, GRACE * 3)).toBe(true);
  });

  it('stops only after the last of several tabs closes', async () => {
    const h = await harness({ presenceGraceMs: GRACE });
    const [first, second] = await Promise.all([openTab(h), openTab(h)]);
    first.close();
    expect(await closedWithin(h, GRACE * 3)).toBe(false);
    second!.close();
    expect(await closedWithin(h, GRACE * 3)).toBe(true);
  });

  it('waits for a running sync before stopping', async () => {
    let release!: (stats: SyncStats) => void;
    const h = await harness({
      presenceGraceMs: GRACE,
      sync: () => new Promise((resolve) => (release = resolve)),
    });
    const tab = await openTab(h);
    const syncing = post(h, API.sync, {});
    await sleep(20);
    tab.close();
    expect(await closedWithin(h, GRACE * 3)).toBe(false);
    release(emptySyncStats());
    expect((await syncing).status).toBe(200);
    expect(await closedWithin(h, GRACE)).toBe(true);
  });

  it('waits for a rating save, and keeps running if a tab returns meanwhile', async () => {
    const h = await harness({ presenceGraceMs: GRACE });
    const trackId = seedTrack(h.db);
    const tab = await openTab(h);
    // A save whose body is still arriving when the grace period ends.
    let req: ClientRequest | undefined = undefined;
    const saved = new Promise<number>((resolve, reject) => {
      req = request(
        {
          host: '127.0.0.1',
          port: h.server.port,
          method: 'POST',
          path: API.ratings,
          headers: {
            Host: `127.0.0.1:${h.server.port}`,
            [TOKEN_HEADER]: h.server.token,
            'Transfer-Encoding': 'chunked',
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.write(`{"trackId":${trackId},"stars":4,`);
    });
    await sleep(20);
    tab.close();
    expect(await closedWithin(h, GRACE * 3)).toBe(false);
    const back = await openTab(h);
    req!.end('"opinion":"","updatedAt":1}');
    expect(await saved).toBe(200);
    expect(await closedWithin(h, GRACE * 3)).toBe(false);
    back.close();
    expect(await closedWithin(h, GRACE * 3)).toBe(true);
  });
});
