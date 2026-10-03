import { createServer } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { SpotifyConfig, Token } from '../core/config';
import { callbackServerConfig, DEFAULT_REDIRECT_URL, login, randomState } from './auth';
import { jsonReply, type MockServer, type Reply, startMockServer } from './test-support';

const CALLBACK_PATH = '/api/auth/spotify/callback';
const EPHEMERAL_REDIRECT = `http://127.0.0.1:0${CALLBACK_PATH}`;
const credentials: SpotifyConfig = { clientId: 'id', clientSecret: 'secret', token: null };

const servers: MockServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('callbackServerConfig', () => {
  it('extracts the listen address and path', () => {
    expect(callbackServerConfig(DEFAULT_REDIRECT_URL)).toEqual({
      listenAddr: '127.0.0.1:8000',
      callbackPath: CALLBACK_PATH,
    });
    expect(callbackServerConfig('HTTP://localhost/cb')).toEqual({ listenAddr: 'localhost:80', callbackPath: '/cb' });
  });

  it.each([
    ['https://127.0.0.1/cb', 'redirect URL "https://127.0.0.1/cb" must use http for local callback handling'],
    ['http:///cb', 'redirect URL "http:///cb" must include a host'],
    ['http://127.0.0.1:8000', 'redirect URL "http://127.0.0.1:8000" must include a callback path'],
    ['http://127.0.0.1/cb?x=1', 'redirect URL "http://127.0.0.1/cb?x=1" must not include query or fragment components'],
    [
      'http://127.0.0.1/cb#frag',
      'redirect URL "http://127.0.0.1/cb#frag" must not include query or fragment components',
    ],
  ])('rejects %s', (raw, message) => {
    expect(() => callbackServerConfig(raw)).toThrow(message);
  });
});

describe('randomState', () => {
  it('is 32 lowercase hex characters and unique', () => {
    const first = randomState();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(randomState()).not.toBe(first);
  });
});

interface BrowserResponse {
  status: number;
  contentType: string | null;
  nosniff: string | null;
  body: string;
}

async function browserGet(origin: string, target: string): Promise<BrowserResponse> {
  const response = await fetch(`${origin}${target}`);
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    nosniff: response.headers.get('x-content-type-options'),
    body: await response.text(),
  };
}

/**
 * Runs login against a mock token endpoint on an ephemeral callback port.
 * `browse` plays the browser, given the callback origin and OAuth state.
 */
async function runLogin(
  tokenReply: () => Reply,
  browse: (origin: string, state: string) => Promise<BrowserResponse[]>,
): Promise<{ result: Promise<Token>; responses: BrowserResponse[]; accounts: MockServer; presented: string }> {
  const accounts = await startMockServer(tokenReply);
  servers.push(accounts);
  let presented = '';
  let browsing: Promise<BrowserResponse[]> = Promise.resolve([]);
  const result = login(
    credentials,
    (url) => {
      presented = url;
      const authorize = new URL(url);
      const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
      // A real browser runs independently of the waiting CLI.
      browsing = browse(redirect.origin, authorize.searchParams.get('state')!);
    },
    { accountsBaseUrl: accounts.baseUrl, redirectUrl: EPHEMERAL_REDIRECT },
  );
  await result.catch(() => undefined);
  return { result, responses: await browsing, accounts, presented };
}

const tokenOk = (): Reply =>
  jsonReply(200, '{"access_token":"access","token_type":"Bearer","refresh_token":"refresh","expires_in":3600}');

describe('login', () => {
  it('requires client credentials', async () => {
    await expect(
      login({ clientId: '', clientSecret: '', token: null }, () => {
        throw new Error('must not present a URL');
      }),
    ).rejects.toThrow(
      /^invalid Spotify credentials: spotify\.client_id is required; spotify\.client_secret is required$/,
    );
  });

  it('exchanges the callback code', async () => {
    const { result, responses, accounts, presented } = await runLogin(tokenOk, async (origin, state) => [
      // Unrelated requests (like favicon fetches) do not end the login.
      await browserGet(origin, '/favicon.ico'),
      await browserGet(origin, `${CALLBACK_PATH}?code=the+code&state=${state}`),
    ]);

    const token = await result;
    expect(token).toMatchObject({ accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer' });
    expect(token.expiry).not.toBe('0001-01-01T00:00:00Z');

    expect(presented).toMatch(
      new RegExp(
        `^${accounts.baseUrl}/authorize\\?client_id=id&redirect_uri=http%3A%2F%2F127\\.0\\.0\\.1%3A\\d+%2Fapi%2Fauth%2Fspotify%2Fcallback` +
          '&response_type=code&scope=user-read-recently-played&state=[0-9a-f]{32}$',
      ),
    );

    expect(responses[0]).toEqual({
      status: 404,
      contentType: 'text/plain; charset=utf-8',
      nosniff: 'nosniff',
      body: '404 page not found\n',
    });
    expect(responses[1]).toMatchObject({
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      body: 'Spotify authentication complete. You can close this window.\n',
    });

    expect(accounts.requests).toHaveLength(1);
    const exchange = accounts.requests[0]!;
    expect(exchange.form('code')).toBe('the code');
    expect(exchange.form('grant_type')).toBe('authorization_code');
    // The exchange names the same redirect URI the browser was sent to.
    expect(exchange.form('redirect_uri')).toBe(new URL(presented).searchParams.get('redirect_uri'));
  });

  it.each([
    [
      'rejects a state mismatch',
      (_state: string) => `${CALLBACK_PATH}?code=c&state=evil`,
      'spotify login failed: callback state mismatch',
      'spotify login failed: state mismatch\n',
    ],
    [
      'reports an authorization error',
      (state: string) => `${CALLBACK_PATH}?error=access_denied&state=${state}`,
      'spotify login failed: access_denied',
      'spotify login failed\n',
    ],
    [
      'requires a code',
      (state: string) => `${CALLBACK_PATH}?state=${state}`,
      'spotify login failed: missing authorization code',
      'spotify login failed: missing code\n',
    ],
  ])('%s', async (_name, target, wantError, wantBody) => {
    const { result, responses, accounts } = await runLogin(tokenOk, async (origin, state) => [
      await browserGet(origin, target(state)),
    ]);
    await expect(result).rejects.toThrow(new RegExp(`^${wantError}$`));
    expect(responses[0]).toEqual({
      status: 400,
      contentType: 'text/plain; charset=utf-8',
      nosniff: 'nosniff',
      body: wantBody,
    });
    expect(accounts.requests).toHaveLength(0);
  });

  it('wraps exchange failures', async () => {
    const { result } = await runLogin(
      () => jsonReply(400, '{"error":"invalid_grant","error_description":"Invalid authorization code"}'),
      async (origin, state) => [await browserGet(origin, `${CALLBACK_PATH}?code=c&state=${state}`)],
    );
    await expect(result).rejects.toThrow(
      'exchange Spotify authorization code: oauth2: "invalid_grant" "Invalid authorization code"',
    );
  });

  it('aborts on a presentUrl error and releases the port', async () => {
    let port = 0;
    await expect(
      login(
        credentials,
        (url) => {
          port = Number(new URL(new URL(url).searchParams.get('redirect_uri')!).port);
          throw new Error('no browser');
        },
        { accountsBaseUrl: 'http://127.0.0.1:1', redirectUrl: EPHEMERAL_REDIRECT },
      ),
    ).rejects.toThrow(/^no browser$/);
    expect(port).toBeGreaterThan(0);
    await expectPortFree(port);
  });

  it('stops waiting when canceled and releases the port', async () => {
    const controller = new AbortController();
    let port = 0;
    const result = login(
      credentials,
      (url) => {
        port = Number(new URL(new URL(url).searchParams.get('redirect_uri')!).port);
        setTimeout(() => controller.abort(), 10);
      },
      { accountsBaseUrl: 'http://127.0.0.1:1', redirectUrl: EPHEMERAL_REDIRECT, signal: controller.signal },
    );
    await expect(result).rejects.toThrow(/^spotify login canceled: context canceled$/);
    await expectPortFree(port);
  });

  it('reports a busy callback port', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as { port: number };
    try {
      await expect(
        login(credentials, () => undefined, { redirectUrl: `http://127.0.0.1:${port}${CALLBACK_PATH}` }),
      ).rejects.toThrow(new RegExp(`^listen for Spotify callback on 127\\.0\\.0\\.1:${port}: `));
    } finally {
      blocker.close();
    }
  });
});

async function expectPortFree(port: number): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
}
