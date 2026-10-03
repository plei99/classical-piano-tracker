import { type ClientRequest, request } from 'node:http';
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { Db } from '../../core/db';
import { emptySyncStats, type SyncStats } from '../../core/model';
import {
  API,
  type Artwork,
  type ArtworkResponse,
  type InitialData,
  PRESENCE_TOKEN_PARAM,
  TOKEN_HEADER,
  type ViewResponse,
} from '../api';
import { sortModeCycle } from '../../app/list';
import { newModel, tracksLoadedMsg, update, type Model } from '../../app/model';
import type { ArtworkLookup } from './artwork';
import { renderPage } from './page';
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
  '/assets/app.js': {
    contentType: 'text/javascript; charset=utf-8',
    body: 'console.log(1)',
    gzip: Buffer.from('gzip bytes').toString('base64'),
    br: Buffer.from('brotli bytes').toString('base64'),
  },
  '/assets/app.css': { contentType: 'text/css; charset=utf-8', body: 'body{}' },
};

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** The body as sent (still compressed if it was). */
  raw: Buffer;
  /** The body as text, decompressed. */
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

/** A server over an in-memory database; `seed` fills it before the server reads it. */
async function harness(overrides: Partial<WebServerOptions> = {}, seed?: (db: Db) => void): Promise<Harness> {
  const db = Db.openInMemory();
  seed?.(db);
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
    renderPage,
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
            const raw = Buffer.concat(chunks);
            const encoding = res.headers['content-encoding'];
            const text = () =>
              (encoding === 'gzip' ? gunzipSync(raw) : encoding === 'br' ? brotliDecompressSync(raw) : raw).toString(
                'utf8',
              );
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              raw,
              get body() {
                return text();
              },
              json: () => JSON.parse(text()),
            });
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

/** Adds `n` tracks, newest first by ID (track i was played at 1000 + i). */
function seedTracks(db: Db, n: number): number[] {
  return Array.from(
    { length: n },
    (_, i) =>
      db.upsertTrack({
        spotifyId: `sp-${i + 1}`,
        trackName: `Etude ${i + 1}`,
        albumName: i % 2 === 0 ? 'Chopin: Etudes' : 'Liszt: Etudes',
        artists: i % 2 === 0 ? '["Frédéric Chopin","Maurizio Pollini"]' : '["Franz Liszt","Yunchan Lim"]',
        lastPlayedAt: 1000 + i,
      }).id,
  );
}

const view = (reply: Reply) => reply.json() as ViewResponse;
const rowIds = (reply: Reply) => view(reply).rows.map((row) => row.track.id);

/** The data the page was rendered from. */
function initialData(html: string): InitialData {
  const match = /<script type="application\/json" id="tracker-initial">(.*?)<\/script>/s.exec(html);
  if (match === null) throw new Error(`no initial data in ${html}`);
  return JSON.parse(match[1] ?? '') as InitialData;
}

describe('web server', () => {
  it('binds 127.0.0.1 with a random 32-hex token', async () => {
    const h = await harness();
    expect(h.server.url).toBe(`http://127.0.0.1:${h.server.port}/`);
    expect(h.server.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('renders the page with the token, the CSP, and no caching', async () => {
    const h = await harness();
    const page = await h.call('GET', '/');
    expect(page.status).toBe(200);
    expect(page.body).toContain(`<meta name="tracker-token" content="${h.server.token}" />`);
    expect(page.body).toContain('<script type="module" src="/assets/app.js"></script>');
    expect(page.body).toContain('<link rel="stylesheet" href="/assets/app.css" />');
    // CSP forbids inline scripts: the only inline script is data, never run.
    expect(page.body.match(/<script(?![^>]*\bsrc=)[^>]*>/g)).toEqual([
      '<script type="application/json" id="tracker-initial">',
    ]);
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

  it('serves assets with a short cache, in the build-time encoding the request accepts', async () => {
    const h = await harness();
    const js = await h.call('GET', '/assets/app.js?v=1');
    expect(js.status).toBe(200);
    expect(js.body).toBe('console.log(1)');
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('private, max-age=300');
    expect(js.headers['content-encoding']).toBeUndefined();
    expect(js.headers['vary']).toBe('Accept-Encoding');

    const accept = async (header: string) => {
      const reply = await h.call('GET', '/assets/app.js', { headers: { 'Accept-Encoding': header } });
      return [reply.headers['content-encoding'], reply.raw.toString('utf8'), reply.headers['content-length']];
    };
    expect(await accept('gzip, deflate, br')).toEqual(['br', 'brotli bytes', '12']);
    expect(await accept('gzip, deflate')).toEqual(['gzip', 'gzip bytes', '10']);
    expect(await accept('br;q=0, gzip')).toEqual(['gzip', 'gzip bytes', '10']);
    expect(await accept('*')).toEqual(['br', 'brotli bytes', '12']);
    expect(await accept('identity')).toEqual([undefined, 'console.log(1)', '14']);

    // An asset built without encodings is always sent as-is.
    const css = await h.call('GET', '/assets/app.css', { headers: { 'Accept-Encoding': 'gzip, br' } });
    expect([css.headers['content-encoding'], css.body, css.headers['vary']]).toEqual([undefined, 'body{}', undefined]);
  });

  it('unzips an asset embedded only compressed for a request that accepts neither encoding', async () => {
    const h = await harness({
      assets: {
        '/assets/app.js': {
          contentType: 'text/javascript; charset=utf-8',
          gzip: gzipSync('console.log(2)').toString('base64'),
        },
      },
    });
    const plain = await h.call('GET', '/assets/app.js');
    expect([plain.headers['content-encoding'], plain.raw.toString('utf8'), plain.headers['vary']]).toEqual([
      undefined,
      'console.log(2)',
      'Accept-Encoding',
    ]);
    const br = await h.call('GET', '/assets/app.js', { headers: { 'Accept-Encoding': 'br, gzip' } });
    expect([br.headers['content-encoding'], br.body]).toEqual(['gzip', 'console.log(2)']);
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
      const reply = await h.call('GET', `${API.view}?sort=recentDesc&limit=10`, { headers: { Host: host } });
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
    const postView = await post(h, API.view, {});
    expect([postView.status, postView.headers['allow']]).toEqual([405, 'GET']);
    const getReload = await h.call('GET', API.reload);
    expect([getReload.status, getReload.headers['allow']]).toEqual([405, 'POST']);
    expect((await post(h, '/assets/app.js', {})).status).toBe(405);
    const postPage = await post(h, '/', {});
    expect([postPage.status, postPage.headers['allow'], postPage.body]).toEqual([405, 'GET', 'method not allowed\n']);
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

  it('no longer serves the whole library', async () => {
    const h = await harness();
    const reply = await h.call('GET', '/api/library');
    expect([reply.status, reply.json()]).toEqual([404, { error: 'no API route /api/library' }]);
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
      renderPage,
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

describe('view API', () => {
  it('answers windows of the list with rows as the TUI shows them', async () => {
    let ids: number[] = [];
    const h = await harness({}, (db) => {
      ids = seedTracks(db, 5);
      db.upsertRating({ trackId: ids[3]!, stars: 4, opinion: 'Sparkling', updatedAt: 9 });
    });
    const first = await h.call('GET', `${API.view}?sort=recentDesc&q=&offset=0&limit=2`);
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.json()).toEqual({
      version: 1,
      total: 5,
      matched: 5,
      offset: 0,
      index: null,
      rows: [
        { track: h.db.trackById(ids[4]!), rating: null, artists: 'Frédéric Chopin, Maurizio Pollini' },
        {
          track: h.db.trackById(ids[3]!),
          rating: { trackId: ids[3], stars: 4, opinion: 'Sparkling', updatedAt: 9 },
          artists: 'Franz Liszt, Yunchan Lim',
        },
      ],
    });
    // q and offset are optional; a window past the end is empty.
    const rest = await h.call('GET', `${API.view}?sort=recentDesc&offset=3&limit=500`);
    expect([view(rest).offset, rowIds(rest)]).toEqual([3, [ids[1], ids[0]]]);
    const past = await h.call('GET', `${API.view}?sort=recentDesc&offset=9&limit=5`);
    expect([view(past).offset, view(past).matched, rowIds(past)]).toEqual([9, 5, []]);
  });

  it('sorts and searches exactly as the TUI does', async () => {
    const h = await harness({}, (db) => {
      const ids = seedTracks(db, 12);
      db.upsertTrack({
        spotifyId: 'sp-1',
        trackName: 'Etude 1',
        albumName: 'Chopin: Etudes',
        artists: '[]',
        lastPlayedAt: 1,
      });
      db.upsertRating({ trackId: ids[2]!, stars: 5, opinion: '', updatedAt: 1 });
      db.upsertRating({ trackId: ids[7]!, stars: 2, opinion: '', updatedAt: 1 });
    });
    let tui = update(newModel({}), tracksLoadedMsg(h.db.listAllTracks(), h.db.listAllRatings()))[0];
    const shown = (m: Model) => Array.from({ length: m.list.count }, (_, i) => m.list.row(i)?.track.id);
    for (const sort of sortModeCycle) {
      for (const query of ['', '  CHOPIN ', 'lim', 'etude 1', 'pollini\u0000chopin', 'zzz']) {
        const searched = update(tui, { type: 'setSearch', query })[0];
        const reply = await h.call('GET', `${API.view}?sort=${sort}&q=${encodeURIComponent(query)}&limit=500`);
        expect(rowIds(reply), `${sort} /${query}`).toEqual(shown(searched));
        expect(view(reply).matched).toBe(searched.list.count);
      }
      tui = update(update(tui, { type: 'setSearch', query: '' })[0], { type: 'key', key: 'o', text: 'o' })[0];
    }
  });

  it('centers the window on the around track, or falls back to the offset', async () => {
    let ids: number[] = [];
    const h = await harness({}, (db) => {
      ids = seedTracks(db, 20);
    });
    // Newest first: list position p holds ids[19 - p].
    const around = async (position: number, extra = '') => {
      const reply = await h.call(
        'GET',
        `${API.view}?sort=recentDesc&offset=3&limit=5&around=${ids[19 - position]}${extra}`,
      );
      return [view(reply).offset, view(reply).index, view(reply).rows.length];
    };
    expect(await around(10)).toEqual([8, 10, 5]);
    expect(await around(1)).toEqual([0, 1, 5]);
    expect(await around(19)).toEqual([15, 19, 5]);
    // Filtered out, or no such track: the offset applies.
    expect(await around(10, '&q=chopin')).toEqual([3, null, 5]);
    const missing = await h.call('GET', `${API.view}?sort=recentDesc&offset=3&limit=5&around=999`);
    expect([view(missing).offset, view(missing).index]).toEqual([3, null]);
  });

  it('rejects bad parameters with 400s', async () => {
    const h = await harness();
    const sortError = 'sort must be one of recentDesc, idAsc, topPlayed, unratedFirst';
    const limitError = 'limit must be an integer from 1 to 500';
    const cases: [string, string][] = [
      ['limit=10', sortError],
      ['sort=newest&limit=10', sortError],
      ['sort=recentDesc', limitError],
      ['sort=recentDesc&limit=0', limitError],
      ['sort=recentDesc&limit=501', limitError],
      ['sort=recentDesc&limit=1.5', limitError],
      ['sort=recentDesc&limit=ten', limitError],
      ['sort=recentDesc&limit=10&offset=-1', 'offset must be a non-negative integer'],
      ['sort=recentDesc&limit=10&offset=x', 'offset must be a non-negative integer'],
      ['sort=recentDesc&limit=10&around=0', 'around must be a positive track ID'],
      ['sort=recentDesc&limit=10&around=-3', 'around must be a positive track ID'],
      ['sort=recentDesc&limit=10&around=', 'around must be a positive track ID'],
    ];
    for (const [query, error] of cases) {
      const reply = await h.call('GET', `${API.view}?${query}`);
      expect([query, reply.status, reply.json()]).toEqual([query, 400, { error }]);
    }
  });

  it('starts a new version on reload, sync, and rating saves', async () => {
    let ids: number[] = [];
    const h = await harness(
      {
        sync: () => {
          h.db.upsertTrack({
            spotifyId: 'sp-new',
            trackName: 'Synced',
            albumName: 'A',
            artists: '["B"]',
            lastPlayedAt: 5000,
          });
          return Promise.resolve({ ...emptySyncStats(), inserted: 1 });
        },
      },
      (db) => {
        ids = seedTracks(db, 3);
      },
    );
    const get = async (sort = 'recentDesc') => view(await h.call('GET', `${API.view}?sort=${sort}&limit=10`));
    expect((await get()).version).toBe(1);

    // Changes made behind the server's back show up on reload.
    seedTracks(h.db, 4);
    expect((await get()).total).toBe(3);
    expect((await h.call('POST', API.reload)).status).toBe(403);
    const reloaded = await h.call('POST', API.reload, { headers: { [TOKEN_HEADER]: h.server.token } });
    expect(reloaded.json()).toEqual({ version: 2, total: 4 });
    expect((await get()).total).toBe(4);

    // A sync reloads by itself.
    expect((await post(h, API.sync, {})).json()).toMatchObject({ inserted: 1 });
    const synced = await get();
    expect([synced.version, synced.total, synced.rows[0]?.track.trackName]).toEqual([3, 5, 'Synced']);

    // A saved rating is in the next answer, and unrated-first moves it down.
    const unrated = await get('unratedFirst');
    expect(unrated.rows[0]?.rating).toBeNull();
    const firstId = unrated.rows[0]!.track.id;
    const saved = await post(h, API.ratings, { trackId: firstId, stars: 5, opinion: 'Yes', updatedAt: 7 });
    expect(saved.status).toBe(200);
    const after = await get('unratedFirst');
    expect(after.version).toBe(4);
    expect(after.rows.at(-1)?.track.id).toBe(firstId);
    expect(after.rows.at(-1)?.rating).toEqual({ trackId: firstId, stars: 5, opinion: 'Yes', updatedAt: 7 });
    expect((await get()).rows.find((row) => row.track.id === firstId)?.rating?.stars).toBe(5);
    expect(ids).toHaveLength(3);
  });

  it('includes art only for tracks the artwork cache already knows', async () => {
    const art: Artwork = { small: 'https://i.scdn.co/s', medium: null, large: 'https://i.scdn.co/l' };
    const known = new Map<string, Artwork | null>([
      ['sp-1', art],
      ['sp-2', null],
    ]);
    const h = await harness(
      { artwork: { lookup: () => Promise.resolve({}), known: (id) => known.get(id) } },
      (db) => void seedTracks(db, 3),
    );
    const rows = view(await h.call('GET', `${API.view}?sort=idAsc&limit=10`)).rows;
    expect(rows.map((row) => ('art' in row ? row.art : 'absent'))).toEqual([art, null, 'absent']);
  });

  it('reports a library that cannot be read, and reads it again on reload', async () => {
    let broken = true;
    const h = await harness({}, (db) => {
      seedTracks(db, 2);
      const list = db.listAllTracks.bind(db);
      db.listAllTracks = () => {
        if (broken) throw new Error('database is locked');
        return list();
      };
    });
    const failed = await h.call('GET', `${API.view}?sort=recentDesc&limit=10`);
    expect([failed.status, failed.json()]).toEqual([500, { error: 'database is locked' }]);
    const page = await h.call('GET', '/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('Error: database is locked');
    expect(page.body).toContain('>Retry</button>');
    expect(initialData(page.body)).toEqual({ error: 'database is locked' });

    broken = false;
    const reloaded = await h.call('POST', API.reload, { headers: { [TOKEN_HEADER]: h.server.token } });
    expect(reloaded.json()).toEqual({ version: 1, total: 2 });
  });
});

describe('page render', () => {
  it('renders the first screen and the data it came from', async () => {
    const h = await harness({}, (db) => void seedTracks(db, 3));
    const page = await h.call('GET', '/');
    const data = initialData(page.body);
    expect(data).toEqual({ view: view(await h.call('GET', `${API.view}?sort=recentDesc&limit=100`)) });
    expect(page.body).toContain('<html lang="en">');
    expect(page.body).toContain('<p class="muted">3 loaded · sort: recent</p>');
    expect(page.body).toMatch(/<li id="track-3" role="option" aria-selected="true" class="row row--selected"/);
    expect(page.body).toContain('<h2 class="hero__title">Etude 3</h2>');
  });

  it('shows the empty library', async () => {
    const h = await harness();
    const page = await h.call('GET', '/');
    expect(page.body).toContain('No local tracks found.');
    expect(initialData(page.body)).toMatchObject({ view: { total: 0, matched: 0, rows: [] } });
  });

  it('escapes the initial data so no track name can end its script element', async () => {
    const name = '</script><script>alert(1)</script><!-- & \u2028\u2029 -->';
    const h = await harness({}, (db) => {
      db.upsertTrack({ spotifyId: 'sp-x', trackName: name, albumName: '<b>', artists: '["A & B"]', lastPlayedAt: 1 });
    });
    const page = await h.call('GET', '/');
    const script = /<script type="application\/json" id="tracker-initial">(.*?)<\/script>/s.exec(page.body)?.[1] ?? '';
    expect(script).not.toMatch(/[<>&\u2028\u2029]/);
    expect(script).toContain('\\u003c/script\\u003e');
    const data = initialData(page.body);
    expect('view' in data && data.view.rows[0]?.track.trackName).toBe(name);
    // In the markup React escapes it.
    expect(page.body).not.toContain('<script>alert(1)');
  });

  it('renders the theme from the cookie', async () => {
    const h = await harness();
    const themed = async (cookie?: string) => {
      const page = await h.call('GET', '/', { headers: cookie === undefined ? {} : { Cookie: cookie } });
      const html = /<html[^>]*>/.exec(page.body)?.[0];
      const checked = /<input type="radio" name="theme" checked="" value="(\w+)"/.exec(page.body)?.[1];
      return [html, checked];
    };
    expect(await themed()).toEqual(['<html lang="en">', 'auto']);
    expect(await themed('a=1; tracker-theme=dark; b=2')).toEqual(['<html lang="en" data-theme="dark">', 'dark']);
    expect(await themed('tracker-theme=light')).toEqual(['<html lang="en" data-theme="light">', 'light']);
    expect(await themed('tracker-theme=auto')).toEqual(['<html lang="en">', 'auto']);
    expect(await themed('tracker-theme="><script>')).toEqual(['<html lang="en">', 'auto']);
    expect(await themed('xtracker-theme=dark')).toEqual(['<html lang="en">', 'auto']);
  });
});

describe('compression', () => {
  it('compresses JSON and HTML over 1 KiB as the request allows, and says it varies', async () => {
    const h = await harness({}, (db) => void seedTracks(db, 30));
    const url = `${API.view}?sort=recentDesc&limit=30`;
    const plain = await h.call('GET', url);
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.headers['vary']).toBe('Accept-Encoding');

    for (const [accept, encoding] of [
      ['gzip, deflate', 'gzip'],
      ['gzip, deflate, br, zstd', 'br'],
      ['br;q=0, gzip;q=0.5', 'gzip'],
      ['deflate', undefined],
    ] as const) {
      const reply = await h.call('GET', url, { headers: { 'Accept-Encoding': accept } });
      expect([accept, reply.headers['content-encoding']]).toEqual([accept, encoding]);
      expect(reply.headers['vary']).toBe('Accept-Encoding');
      expect(reply.json()).toEqual(plain.json());
      expect(Number(reply.headers['content-length'])).toBe(reply.raw.length);
      if (encoding !== undefined) expect(reply.raw.length).toBeLessThan(plain.raw.length / 3);
    }

    const page = await h.call('GET', '/', { headers: { 'Accept-Encoding': 'gzip' } });
    expect([page.headers['content-encoding'], page.headers['vary']]).toEqual(['gzip', 'Accept-Encoding']);
    expect(page.body).toContain('<!doctype html>');
  });

  it('leaves small responses, errors, and the presence stream uncompressed', async () => {
    const h = await harness();
    const small = await h.call('GET', `${API.view}?sort=recentDesc&limit=1`, {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    expect([small.headers['content-encoding'], small.headers['vary']]).toEqual([undefined, 'Accept-Encoding']);
    const error = await h.call('GET', `${API.view}?sort=x&limit=1`, { headers: { 'Accept-Encoding': 'gzip' } });
    expect([error.status, error.headers['content-encoding']]).toEqual([400, undefined]);

    const tab = await new Promise<Record<string, string | string[] | undefined>>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: h.server.port,
          path: `${API.presence}?${PRESENCE_TOKEN_PARAM}=${h.server.token}`,
          headers: { Host: `127.0.0.1:${h.server.port}`, 'Accept-Encoding': 'gzip, br' },
        },
        (res) => {
          resolve(res.headers);
          req.destroy();
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(tab['content-type']).toBe('text/event-stream');
    expect(tab['content-encoding']).toBeUndefined();
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
