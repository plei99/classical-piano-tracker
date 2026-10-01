import { afterEach, describe, expect, it } from 'vitest';

import { formatGoTime, type SpotifyConfig, type Token, tokenExpiryMs } from '../core/config';
import {
  Client,
  decodeArtistSearch,
  decodeError,
  decodeRecentlyPlayed,
  normalizeRecentlyPlayed,
  normalizeRecentTrackLimit,
  type RecentlyPlayedItem,
  retryDurationMs,
  SpotifyApiError,
  tokensEqual,
} from './client';
import { artistNames } from './index';
import { jsonReply, type MockServer, type Recorded, type Reply, startMockServer, textReply } from './test-support';

const RECENT_JSON = JSON.stringify({
  items: [
    {
      track: {
        id: 'track-id',
        name: 'Piano Sonata No. 14',
        album: { name: 'Beethoven Favorites' },
        artists: [{ id: 'artist-id', name: 'Martha Argerich' }],
        duration_ms: 1234,
      },
      played_at: '2026-03-31T12:00:00Z',
    },
  ],
});

const servers: MockServer[] = [];
async function mock(handler: (request: Recorded) => Reply): Promise<MockServer> {
  const server = await startMockServer(handler);
  servers.push(server);
  return server;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('normalizeRecentTrackLimit', () => {
  it('defaults 0 to 50 and rejects out-of-range limits', () => {
    expect(normalizeRecentTrackLimit(0)).toBe(50);
    expect(normalizeRecentTrackLimit(1)).toBe(1);
    expect(normalizeRecentTrackLimit(50)).toBe(50);
    expect(() => normalizeRecentTrackLimit(51)).toThrow(/^recent track limit must be between 1 and 50, got 51$/);
    expect(() => normalizeRecentTrackLimit(-1)).toThrow('got -1');
  });
});

describe('normalizeRecentlyPlayed', () => {
  it('maps fields', () => {
    const items: RecentlyPlayedItem[] = [
      {
        track: {
          id: 'track-id',
          name: 'Piano Sonata No. 14',
          albumName: 'Beethoven Favorites',
          artists: [{ id: 'artist-id', name: 'Martha Argerich' }],
          durationMs: 1234,
        },
        playedAt: '2026-03-31T12:00:00Z',
      },
    ];
    const tracks = normalizeRecentlyPlayed(items);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toEqual({
      spotifyId: 'track-id',
      name: 'Piano Sonata No. 14',
      albumName: 'Beethoven Favorites',
      artists: [{ id: 'artist-id', name: 'Martha Argerich' }],
      durationMs: 1234,
      playedAt: new Date('2026-03-31T12:00:00Z'),
      playedAtNs: BigInt(Date.parse('2026-03-31T12:00:00Z')) * 1_000_000n,
    });
    expect(artistNames(tracks[0]!)).toEqual(['Martha Argerich']);
  });

  it('decodes the wire format, tolerating nulls and float numbers', () => {
    expect(normalizeRecentlyPlayed(decodeRecentlyPlayed(JSON.parse(RECENT_JSON)))[0]!.spotifyId).toBe('track-id');

    const tracks = normalizeRecentlyPlayed(
      decodeRecentlyPlayed({
        items: [
          {
            track: { id: null, name: 'N', album: null, artists: null, duration_ms: 1234.9 },
            played_at: '2026-03-31T12:00:00.123456789Z',
          },
        ],
      }),
    );
    expect(tracks[0]).toMatchObject({ spotifyId: '', albumName: '', artists: [], durationMs: 1234 });
    expect(tracks[0]!.playedAtNs % 1_000_000_000n).toBe(123_456_789n);
    expect(decodeRecentlyPlayed({ items: null })).toEqual([]);
    expect(decodeRecentlyPlayed(null)).toEqual([]);
    expect(() => decodeRecentlyPlayed({ items: [{ track: { name: 5 } }] })).toThrow(/cannot unmarshal number/);
  });
});

describe('tokensEqual', () => {
  it('compares every field', () => {
    const left: Token = {
      accessToken: 'access',
      refreshToken: 'refresh',
      tokenType: 'Bearer',
      expiry: '2026-03-31T12:00:00Z',
    };
    const right = { ...left };
    expect(tokensEqual(left, right)).toBe(true);
    right.accessToken = 'different';
    expect(tokensEqual(left, right)).toBe(false);
  });

  it('compares expiries as instants', () => {
    const left: Token = { accessToken: 'a', refreshToken: '', tokenType: '', expiry: '2026-03-31T12:00:00Z' };
    expect(tokensEqual(left, { ...left, expiry: '2026-03-31T14:00:00+02:00' })).toBe(true);
    expect(tokensEqual(left, { ...left, expiry: '2026-03-31T12:00:00.000000001Z' })).toBe(false);
  });
});

describe('decodeError', () => {
  it('mirrors zmb3 fallbacks', () => {
    const err = decodeError(401, '{"error":{"status":401,"message":"The access token expired"}}');
    expect(err).toBeInstanceOf(SpotifyApiError);
    expect(err.status).toBe(401);
    expect(err.message).toBe('spotify: HTTP 401: The access token expired');
    expect(decodeError(503, '').message).toBe('spotify: HTTP 503: Service Unavailable (body empty)');
    expect(decodeError(500, '{}').message).toBe('spotify: unexpected HTTP 500: Internal Server Error (empty error)');
    expect(decodeError(502, '<html>').message).toBe("spotify: couldn't decode error: (6) [<html>]");
    expect(decodeError(400, '{"error":"invalid_token"}').message).toBe(
      `spotify: couldn't decode error: (25) [{"error":"invalid_token"}]`,
    );
  });
});

describe('retryDurationMs', () => {
  it('parses whole seconds', () => {
    expect(retryDurationMs(null)).toBe(5000);
    expect(retryDurationMs('')).toBe(5000);
    expect(retryDurationMs('soon')).toBe(5000);
    expect(retryDurationMs('3')).toBe(3000);
    expect(retryDurationMs('-1')).toBe(0);
  });
});

describe('decodeArtistSearch', () => {
  it('treats a missing page as no artists', () => {
    expect(decodeArtistSearch({})).toEqual([]);
    expect(decodeArtistSearch({ artists: null })).toEqual([]);
  });
});

function tokenExpiringIn(seconds: number): Token {
  return {
    accessToken: 'old-access',
    refreshToken: 'refresh',
    tokenType: 'Bearer',
    expiry: formatGoTime(Date.now() + seconds * 1000),
  };
}

function spotifyConfig(token: Token | null): SpotifyConfig {
  return { clientId: 'id', clientSecret: 'secret', token };
}

interface Harness {
  accounts: MockServer;
  api: MockServer;
  persisted: Token[];
  client: Client;
}

async function harness(
  token: Token,
  api: (request: Recorded) => Reply,
  accountsReply: Reply = jsonReply(200, '{"access_token":"new-access","token_type":"Bearer","expires_in":3600}'),
  persist?: (token: Token) => void,
): Promise<Harness> {
  const accounts = await mock(() => accountsReply);
  const apiServer = await mock(api);
  const persisted: Token[] = [];
  const client = new Client(spotifyConfig(token), persist ?? ((t) => void persisted.push(t)), {
    accountsBaseUrl: accounts.baseUrl,
    apiBaseUrl: apiServer.baseUrl,
  });
  return { accounts, api: apiServer, persisted, client };
}

describe('Client', () => {
  it('validates credentials, then the stored token', () => {
    const persist = (): void => undefined;
    expect(() => new Client({ clientId: '', clientSecret: '', token: null }, persist)).toThrow(
      /^invalid Spotify credentials: spotify\.client_id is required; spotify\.client_secret is required$/,
    );
    expect(() => new Client(spotifyConfig(null), persist)).toThrow(
      /^missing stored Spotify token: spotify\.token is required$/,
    );
  });

  it('uses a valid token without refreshing', async () => {
    const h = await harness(tokenExpiringIn(3600), () => jsonReply(200, RECENT_JSON));
    const tracks = await h.client.recentTracks(10);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.spotifyId).toBe('track-id');

    expect(h.api.requests).toHaveLength(1);
    expect(h.api.requests[0]).toMatchObject({ method: 'GET', target: '/me/player/recently-played?limit=10' });
    expect(h.api.requests[0]!.headers['authorization']).toBe('Bearer old-access');
    expect(h.accounts.requests).toHaveLength(0);
    expect(h.persisted).toHaveLength(0);
  });

  it('refreshes an expired token and persists it once', async () => {
    const h = await harness(tokenExpiringIn(-60), () => jsonReply(200, RECENT_JSON));
    await h.client.recentTracks(0);
    await h.client.recentTracks(0);

    expect(h.accounts.requests).toHaveLength(1);
    expect(h.accounts.requests[0]!.form('refresh_token')).toBe('refresh');
    expect(h.api.requests[0]!.target).toBe('/me/player/recently-played?limit=50');
    expect(h.api.requests.every((request) => request.headers['authorization'] === 'Bearer new-access')).toBe(true);

    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]).toMatchObject({ accessToken: 'new-access', refreshToken: 'refresh', tokenType: 'Bearer' });
    expect(tokenExpiryMs(h.persisted[0]!)!).toBeGreaterThan(Date.now());
  });

  it('shares one refresh between concurrent calls', async () => {
    const h = await harness(tokenExpiringIn(-60), () => jsonReply(200, RECENT_JSON));
    await Promise.all([h.client.recentTracks(1), h.client.searchArtists('x', 1)]);
    expect(h.accounts.requests).toHaveLength(1);
    expect(h.persisted).toHaveLength(1);
  });

  it('merges a refreshed token that omits fields with the stored one', async () => {
    const stored = tokenExpiringIn(-60);
    const h = await harness(stored, () => jsonReply(200, RECENT_JSON), jsonReply(200, '{"access_token":"n"}'));
    await h.client.recentTracks(1);
    expect(h.persisted).toEqual([
      { accessToken: 'n', refreshToken: 'refresh', tokenType: 'Bearer', expiry: expect.any(String) },
    ]);
    // A zero expiry keeps the stored one, as Go's TokenFromOAuth did.
    expect(h.persisted[0]!.expiry).toBe(stored.expiry);
  });

  it('refreshes a token inside the expiry delta', async () => {
    const h = await harness(tokenExpiringIn(5), () => jsonReply(200, RECENT_JSON));
    await h.client.recentTracks(1);
    expect(h.accounts.requests).toHaveLength(1);
    expect(h.persisted).toHaveLength(1);
  });

  it('does not persist a refreshed token when the call fails', async () => {
    const h = await harness(tokenExpiringIn(-60), () =>
      jsonReply(401, '{"error":{"status":401,"message":"The access token expired"}}'),
    );
    const err = await h.client.recentTracks(5).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toBe('fetch recently played tracks from Spotify: spotify: HTTP 401: The access token expired');
    expect(err?.cause).toBeInstanceOf(SpotifyApiError);
    expect((err?.cause as SpotifyApiError).status).toBe(401);
    expect(h.persisted).toHaveLength(0);
  });

  it('reports refresh failures like a transport error', async () => {
    const h = await harness(
      tokenExpiringIn(-60),
      () => jsonReply(200, RECENT_JSON),
      jsonReply(400, '{"error":"invalid_grant","error_description":"Refresh token revoked"}'),
    );
    await expect(h.client.recentTracks(50)).rejects.toThrow(
      `fetch recently played tracks from Spotify: Get "${h.api.baseUrl}/me/player/recently-played?limit=50": ` +
        'oauth2: "invalid_grant" "Refresh token revoked"',
    );
    expect(h.api.requests).toHaveLength(0);
  });

  it('wraps persist failures', async () => {
    const h = await harness(
      tokenExpiringIn(-60),
      () => jsonReply(200, RECENT_JSON),
      jsonReply(200, '{"access_token":"new"}'),
      () => {
        throw new Error('disk full');
      },
    );
    await expect(h.client.recentTracks(50)).rejects.toThrow(/^persist refreshed Spotify token: disk full$/);
  });

  it('validates the limit before any request', async () => {
    const h = await harness(tokenExpiringIn(-60), () => jsonReply(200, RECENT_JSON));
    await expect(h.client.recentTracks(51)).rejects.toThrow(/^recent track limit must be between 1 and 50, got 51$/);
    expect(h.accounts.requests).toHaveLength(0);
    expect(h.api.requests).toHaveLength(0);
  });

  it('retries rate-limited requests', async () => {
    let calls = 0;
    const h = await harness(tokenExpiringIn(3600), () =>
      calls++ === 0 ? textReply(429, '', { 'Retry-After': '0' }) : jsonReply(200, RECENT_JSON),
    );
    expect(await h.client.recentTracks(50)).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('reports the 429 when canceled during the rate-limit wait', async () => {
    const accounts = await mock(() => jsonReply(500, ''));
    const api = await mock(() => textReply(429, '', { 'Retry-After': '30' }));
    const controller = new AbortController();
    const client = new Client(spotifyConfig(tokenExpiringIn(3600)), () => undefined, {
      accountsBaseUrl: accounts.baseUrl,
      apiBaseUrl: api.baseUrl,
      signal: controller.signal,
    });
    const result = client.recentTracks(50);
    setTimeout(() => controller.abort(), 50);
    await expect(result).rejects.toThrow('spotify: HTTP 429: Too Many Requests (body empty)');
  });

  it('treats 204 No Content as no tracks', async () => {
    const h = await harness(tokenExpiringIn(3600), () => textReply(204, ''));
    expect(await h.client.recentTracks(50)).toEqual([]);
  });

  it('wraps a malformed played_at as a fetch error', async () => {
    const h = await harness(tokenExpiringIn(3600), () =>
      jsonReply(200, '{"items":[{"track":{"id":"t"},"played_at":"yesterday"}]}'),
    );
    await expect(h.client.recentTracks(50)).rejects.toThrow(
      'fetch recently played tracks from Spotify: parsing time "yesterday"',
    );
  });

  it('searches artists, mapping results and defaulting the limit', async () => {
    const h = await harness(tokenExpiringIn(3600), () =>
      jsonReply(
        200,
        JSON.stringify({
          artists: {
            items: [
              { id: 'a1', name: 'Martha Argerich', popularity: 61, genres: ['classical', 'classical piano'] },
              { id: null, name: 'No Id', popularity: null, genres: null },
            ],
          },
        }),
      ),
    );
    expect(await h.client.searchArtists('Martha Argerich & co', 0)).toEqual([
      { name: 'Martha Argerich', id: 'a1', popularity: 61, genres: ['classical', 'classical piano'] },
      { name: 'No Id', id: '', popularity: 0, genres: [] },
    ]);
    expect(h.api.requests).toHaveLength(1);
    expect(h.api.requests[0]!.target).toBe('/search?limit=5&q=Martha+Argerich+%26+co&type=artist');
  });

  it('handles missing search results and still persists a refresh', async () => {
    const h = await harness(tokenExpiringIn(-60), () => jsonReply(200, '{}'));
    expect(await h.client.searchArtists('nobody', 3)).toEqual([]);
    expect(h.api.requests[0]!.target.startsWith('/search?limit=3&')).toBe(true);
    expect(h.persisted).toHaveLength(1);
  });

  it('wraps search errors with the query', async () => {
    const h = await harness(tokenExpiringIn(3600), () => jsonReply(400, '{"error":{"message":"Bad limit"}}'));
    await expect(h.client.searchArtists('Gould', 99)).rejects.toThrow(
      /^search Spotify artists for "Gould": spotify: HTTP 400: Bad limit$/,
    );
  });
});
