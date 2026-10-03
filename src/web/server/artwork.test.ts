import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { emptyConfig, formatGoTime, loadConfig, saveConfig, type Token } from '../../core/config';
import { jsonReply, type MockServer, type Recorded, type Reply, startMockServer } from '../../spotify/test-support';
import {
  ARTWORK_CACHE_FILE,
  artworkCachePath,
  ArtworkService,
  type ArtworkServiceOptions,
  configArtworkApi,
} from './artwork';

const servers: MockServer[] = [];
async function mock(handler: (request: Recorded) => Reply): Promise<MockServer> {
  const server = await startMockServer(handler);
  servers.push(server);
  return server;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** A valid 22-character Spotify ID. */
function sid(n: number): string {
  return `track${n}`.padEnd(22, 'x');
}

const IMAGES = [
  { url: 'https://i.scdn.co/640', width: 640 },
  { url: 'https://i.scdn.co/300', width: 300 },
  { url: 'https://i.scdn.co/64', width: 64 },
];
const API_ART = { small: 'https://i.scdn.co/64', medium: 'https://i.scdn.co/300', large: 'https://i.scdn.co/640' };

function thumbArt(id: string) {
  const url = `https://thumb/${id}`;
  return { small: url, medium: url, large: url };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tracker-artwork-'));
}

/** Writes a config with credentials and, optionally, a stored token. */
function writeConfig(token: Token | null): string {
  const path = join(tempDir(), 'config.json');
  const cfg = emptyConfig();
  cfg.spotify.clientId = 'client-id';
  cfg.spotify.clientSecret = 'client-secret';
  cfg.spotify.token = token;
  saveConfig(path, cfg);
  return path;
}

function tokenExpiringIn(seconds: number): Token {
  return {
    accessToken: 'old-access',
    refreshToken: 'refresh',
    tokenType: 'Bearer',
    expiry: formatGoTime(Date.now() + seconds * 1000),
  };
}

/** The track ID an oEmbed request asks about. */
function oembedId(request: Recorded): string {
  const trackUrl = new URL(request.target, 'http://x').searchParams.get('url') ?? '';
  return trackUrl.replace('https://open.spotify.com/track/', '');
}

/** oEmbed that knows every ID except `unknown`. */
function oembedHandler(unknown: readonly string[] = []): (request: Recorded) => Reply {
  return (request) => {
    const id = oembedId(request);
    if (unknown.includes(id)) {
      return jsonReply(404, '{"error":"not found"}');
    }
    return jsonReply(200, JSON.stringify({ type: 'rich', thumbnail_url: `https://thumb/${id}` }));
  };
}

/** A Spotify API mock answering batch and single lookups from IMAGES. */
function apiHandler(batchStatus = 200): (request: Recorded) => Reply {
  return (request) => {
    const url = new URL(request.target, 'http://x');
    if (url.pathname === '/tracks') {
      if (batchStatus !== 200) {
        return jsonReply(batchStatus, `{"error":{"status":${batchStatus},"message":"refused"}}`);
      }
      const ids = (url.searchParams.get('ids') ?? '').split(',');
      return jsonReply(200, JSON.stringify({ tracks: ids.map((id) => ({ id, album: { images: IMAGES } })) }));
    }
    return jsonReply(200, JSON.stringify({ id: url.pathname.slice('/tracks/'.length), album: { images: IMAGES } }));
  };
}

async function service(
  overrides: Partial<ArtworkServiceOptions> & { api?: MockServer; oembed?: MockServer; token?: Token | null } = {},
): Promise<{ svc: ArtworkService; configPath: string; accounts: MockServer }> {
  const accounts = await mock(() =>
    jsonReply(200, '{"access_token":"new-access","token_type":"Bearer","expires_in":3600}'),
  );
  const configPath = writeConfig(overrides.token === undefined ? tokenExpiringIn(3600) : overrides.token);
  const api = overrides.api;
  const svc = new ArtworkService({
    cachePath: null,
    spotify: () =>
      api === undefined
        ? null
        : configArtworkApi(configPath, { apiBaseUrl: api.baseUrl, accountsBaseUrl: accounts.baseUrl }),
    oembedBaseUrl: overrides.oembed?.baseUrl ?? 'http://127.0.0.1:1',
    ...overrides,
  });
  return { svc, configPath, accounts };
}

describe('ArtworkService', () => {
  it('uses the batch endpoint, dropping invalid and duplicate IDs', async () => {
    const api = await mock(apiHandler());
    const oembed = await mock(oembedHandler());
    const { svc } = await service({ api, oembed });

    const result = await svc.lookup([sid(1), 'not-an-id', sid(2), sid(1), `${sid(3)}!`]);
    expect(result).toEqual({ [sid(1)]: API_ART, [sid(2)]: API_ART });
    expect(api.requests.map((r) => r.target)).toEqual([`/tracks?ids=${sid(1)}%2C${sid(2)}`]);
    expect(oembed.requests).toHaveLength(0);
  });

  it('persists a refreshed token to the config, like the CLI', async () => {
    const api = await mock(apiHandler());
    const { svc, configPath, accounts } = await service({ api, token: tokenExpiringIn(-60) });

    await svc.lookup([sid(1)]);
    expect(accounts.requests).toHaveLength(1);
    expect(api.requests[0]!.headers['authorization']).toBe('Bearer new-access');
    expect(loadConfig(configPath).spotify.token).toMatchObject({ accessToken: 'new-access', refreshToken: 'refresh' });
  });

  it('falls back to per-track lookups when the batch endpoint is refused, and remembers that', async () => {
    const api = await mock(apiHandler(403));
    const { svc } = await service({ api });

    expect(await svc.lookup([sid(1), sid(2)])).toEqual({ [sid(1)]: API_ART, [sid(2)]: API_ART });
    expect(await svc.lookup([sid(3)])).toEqual({ [sid(3)]: API_ART });
    expect(api.requests.map((r) => r.target)).toEqual([
      `/tracks?ids=${sid(1)}%2C${sid(2)}`,
      `/tracks/${sid(1)}`,
      `/tracks/${sid(2)}`,
      `/tracks/${sid(3)}`,
    ]);
  });

  it('falls back to per-track lookups on a 404 batch too', async () => {
    const api = await mock(apiHandler(404));
    const { svc } = await service({ api });
    expect(await svc.lookup([sid(1)])).toEqual({ [sid(1)]: API_ART });
    expect(api.requests.map((r) => r.target)).toEqual([`/tracks?ids=${sid(1)}`, `/tracks/${sid(1)}`]);
  });

  it('uses oEmbed when there is no stored token', async () => {
    const api = await mock(apiHandler());
    const oembed = await mock(oembedHandler([sid(2)]));
    const { svc } = await service({ api, oembed, token: null });

    expect(await svc.lookup([sid(1), sid(2)])).toEqual({ [sid(1)]: thumbArt(sid(1)), [sid(2)]: null });
    expect(api.requests).toHaveLength(0);
    expect(oembed.requests.map(oembedId).sort()).toEqual([sid(1), sid(2)]);
  });

  it('uses oEmbed when the API fails or refuses every path', async () => {
    const failing = await mock(() => jsonReply(500, ''));
    const oembed = await mock(oembedHandler());
    const first = await service({ api: failing, oembed });
    expect(await first.svc.lookup([sid(1)])).toEqual({ [sid(1)]: thumbArt(sid(1)) });

    const refusing = await mock(() => jsonReply(403, ''));
    const second = await service({ api: refusing, oembed });
    expect(await second.svc.lookup([sid(2)])).toEqual({ [sid(2)]: thumbArt(sid(2)) });
    // Both endpoints refused: later lookups skip the API entirely.
    expect(await second.svc.lookup([sid(3)])).toEqual({ [sid(3)]: thumbArt(sid(3)) });
    expect(refusing.requests).toHaveLength(2);
  });

  it('asks oEmbed about IDs the batch did not know', async () => {
    const api = await mock(() => jsonReply(200, JSON.stringify({ tracks: [null, { album: { images: [] } }] })));
    const oembed = await mock(oembedHandler([sid(1)]));
    const { svc } = await service({ api, oembed });
    expect(await svc.lookup([sid(1), sid(2)])).toEqual({ [sid(1)]: null, [sid(2)]: null });
    // sid(2) was found without images: a definitive "no art" with no second opinion.
    expect(oembed.requests.map(oembedId)).toEqual([sid(1)]);
  });

  it('persists answers atomically with owner-only permissions and reloads them', async () => {
    const oembed = await mock(oembedHandler([sid(2)]));
    const dir = tempDir();
    const cachePath = artworkCachePath(join(dir, 'tracker.db'))!;
    expect(cachePath).toBe(join(dir, ARTWORK_CACHE_FILE));

    const { svc } = await service({ oembed, cachePath, persistDelayMs: 60_000 });
    await svc.lookup([sid(1), sid(2)]);
    svc.close();
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toEqual({
      version: 1,
      artwork: { [sid(1)]: thumbArt(sid(1)), [sid(2)]: null },
    });

    const reloaded = new ArtworkService({
      cachePath,
      spotify: () => {
        throw new Error('unexpected Spotify lookup');
      },
      fetch: () => Promise.reject(new Error('unexpected fetch')),
    });
    expect(await reloaded.lookup([sid(2), sid(1)])).toEqual({ [sid(1)]: thumbArt(sid(1)), [sid(2)]: null });
  });

  it('writes on the debounce timer', async () => {
    const oembed = await mock(oembedHandler());
    const cachePath = join(tempDir(), ARTWORK_CACHE_FILE);
    const { svc } = await service({ oembed, cachePath, persistDelayMs: 1 });
    await svc.lookup([sid(1)]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).artwork).toHaveProperty(sid(1));
  });

  it('ignores a corrupt cache file', async () => {
    const cachePath = join(tempDir(), ARTWORK_CACHE_FILE);
    writeFileSync(cachePath, '{"version":1,"artwork":{"bad":{"small":1}}');
    const oembed = await mock(oembedHandler());
    const { svc } = await service({ oembed, cachePath });
    expect(await svc.lookup([sid(1)])).toEqual({ [sid(1)]: thumbArt(sid(1)) });
  });

  it('remembers transient failures in memory for the TTL only', async () => {
    let healthy = false;
    const oembed = await mock((request) => (healthy ? oembedHandler()(request) : jsonReply(503, '{"error":"busy"}')));
    let now = 1_000;
    const cachePath = join(tempDir(), ARTWORK_CACHE_FILE);
    const { svc } = await service({ oembed, cachePath, now: () => now, failureTtlMs: 600_000 });

    expect(await svc.lookup([sid(1)])).toEqual({ [sid(1)]: null });
    healthy = true;
    expect(await svc.lookup([sid(1)])).toEqual({ [sid(1)]: null });
    expect(oembed.requests).toHaveLength(1);
    svc.flush();
    expect(() => statSync(cachePath)).toThrow();

    now += 600_001;
    expect(await svc.lookup([sid(1)])).toEqual({ [sid(1)]: thumbArt(sid(1)) });
    expect(oembed.requests).toHaveLength(2);
  });

  it('coalesces concurrent lookups of the same IDs', async () => {
    const api = await mock(apiHandler());
    const { svc } = await service({ api });
    const [first, second] = await Promise.all([svc.lookup([sid(1), sid(2)]), svc.lookup([sid(2), sid(1)])]);
    expect(first).toEqual(second);
    expect(api.requests).toHaveLength(1);

    // Only the IDs not already in flight are fetched.
    await Promise.all([svc.lookup([sid(3)]), svc.lookup([sid(3), sid(4)])]);
    expect(
      api.requests
        .map((r) => r.target)
        .slice(1)
        .sort(),
    ).toEqual([`/tracks?ids=${sid(3)}`, `/tracks?ids=${sid(4)}`]);
  });

  it('limits concurrent oEmbed requests', async () => {
    let active = 0;
    let peak = 0;
    const fakeFetch = (async (input: string | URL | Request) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      const id = new URL(String(input)).searchParams.get('url')!.split('/').pop()!;
      return new Response(JSON.stringify({ thumbnail_url: `https://thumb/${id}` }), { status: 200 });
    }) as typeof fetch;
    const svc = new ArtworkService({ cachePath: null, spotify: () => null, fetch: fakeFetch, concurrency: 4 });
    const ids = Array.from({ length: 12 }, (_, i) => sid(i));
    const result = await svc.lookup(ids);
    expect(Object.values(result).every((art) => art !== null)).toBe(true);
    expect(peak).toBe(4);
  });
});
