import { afterEach, describe, expect, it } from 'vitest';

import { type Token, tokenExpiryMs, ZERO_TIME } from '../core/config';
import { encodeValues, parseQuery, queryEscape } from './http';
import {
  authCodeUrl,
  authorizationType,
  exchange,
  newOAuthConfig,
  type OAuthConfig,
  parseTokenJSON,
  refresh,
  tokenValid,
} from './oauth';
import { jsonReply, type MockServer, type Reply, startMockServer, textReply } from './test-support';

const servers: MockServer[] = [];

async function mock(handler: () => Reply): Promise<MockServer> {
  const server = await startMockServer(handler);
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function config(base: string): OAuthConfig {
  return newOAuthConfig('client id', 'secret&', base, 'http://127.0.0.1:8000/cb', [], 5_000);
}

describe('query encoding', () => {
  it('escapes like Go url.QueryEscape', () => {
    expect(queryEscape('a b+c/d~e*f')).toBe('a+b%2Bc%2Fd~e%2Af');
    expect(queryEscape('Frédéric')).toBe('Fr%C3%A9d%C3%A9ric');
  });

  it('encodes values in sorted key order', () => {
    expect(encodeValues({ type: 'artist', q: 'a&b', limit: '5' })).toBe('limit=5&q=a%26b&type=artist');
  });

  it('parses queries like Go url.ParseQuery', () => {
    const query = parseQuery('code=the+code&state=s1&state=s2&bad=%zz&x');
    expect(query.get('code')).toBe('the code');
    expect(query.get('state')).toBe('s1');
    expect(query.get('x')).toBe('');
    expect(query.get('bad')).toBe('');
    expect(query.error?.message).toBe('invalid URL escape "%zz"');
    expect(parseQuery('a=1;b=2').error?.message).toBe('invalid semicolon separator in query');
  });
});

describe('authCodeUrl', () => {
  it('sorts and encodes params', () => {
    const cfg = config('https://accounts.example');
    cfg.scopes = ['user-read-recently-played'];
    expect(authCodeUrl(cfg, 'abc')).toBe(
      'https://accounts.example/authorize?client_id=client+id&redirect_uri=http%3A%2F%2F127.0.0.1%3A8000%2Fcb' +
        '&response_type=code&scope=user-read-recently-played&state=abc',
    );
  });
});

describe('tokens', () => {
  it('treat a token as expired ten seconds early', () => {
    const now = Date.parse('2026-03-31T12:00:00Z');
    const token = (offsetSeconds: number): Token => ({
      accessToken: 'a',
      refreshToken: '',
      tokenType: '',
      expiry: new Date(now + offsetSeconds * 1000).toISOString(),
    });
    expect(tokenValid(token(10), now)).toBe(true);
    expect(tokenValid(token(9), now)).toBe(false);
    expect(tokenValid(token(5), now)).toBe(false);
    expect(tokenValid(token(-5), now)).toBe(false);
    expect(tokenValid({ ...token(0), expiry: ZERO_TIME }, now)).toBe(true);
    expect(tokenValid({ ...token(3600), accessToken: '' }, now)).toBe(false);
  });

  it('normalize the authorization type like oauth2', () => {
    expect(authorizationType('')).toBe('Bearer');
    expect(authorizationType('bearer')).toBe('Bearer');
    expect(authorizationType('mac')).toBe('MAC');
    expect(authorizationType('basic')).toBe('Basic');
    expect(authorizationType('Custom')).toBe('Custom');
  });
});

describe('token endpoint', () => {
  it('exchanges a code with HTTP Basic credentials', async () => {
    const server = await mock(() =>
      jsonReply(200, '{"access_token":"access","token_type":"Bearer","refresh_token":"refresh","expires_in":3600}'),
    );
    const before = Date.now();
    const token = await exchange(config(server.baseUrl), 'the code');
    expect(token).toMatchObject({ accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer' });
    const lifetime = tokenExpiryMs(token)! - before;
    expect(lifetime).toBeGreaterThanOrEqual(3_600_000 - 1);
    expect(lifetime).toBeLessThan(3_660_000);

    expect(server.requests).toHaveLength(1);
    const request = server.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.target).toBe('/api/token');
    expect(request.headers['authorization']).toBe(`Basic ${Buffer.from('client+id:secret%26').toString('base64')}`);
    expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(request.body).toBe(
      'code=the+code&grant_type=authorization_code&redirect_uri=http%3A%2F%2F127.0.0.1%3A8000%2Fcb',
    );
  });

  it('refresh keeps the previous refresh token and a zero expiry', async () => {
    const server = await mock(() => jsonReply(200, '{"access_token":"new"}'));
    const token = await refresh(config(server.baseUrl), 'old-refresh');
    expect(token).toEqual({ accessToken: 'new', refreshToken: 'old-refresh', tokenType: '', expiry: ZERO_TIME });
    expect(server.requests[0]!.form('grant_type')).toBe('refresh_token');
    expect(server.requests[0]!.form('refresh_token')).toBe('old-refresh');
  });

  it('refresh without a refresh token fails before the network', async () => {
    await expect(refresh(config('http://127.0.0.1:1'), '')).rejects.toThrow(
      /^oauth2: token expired and refresh token is not set$/,
    );
  });

  it('formats errors like oauth2', async () => {
    const cases: [Reply, string][] = [
      [
        jsonReply(400, '{"error":"invalid_grant","error_description":"Refresh token revoked"}'),
        'oauth2: "invalid_grant" "Refresh token revoked"',
      ],
      [textReply(502, 'upstream down'), 'oauth2: cannot fetch token: 502 Bad Gateway\nResponse: upstream down'],
      [jsonReply(200, '{"error":"server_error"}'), 'oauth2: "server_error"'],
      [jsonReply(200, '{"token_type":"Bearer"}'), 'oauth2: server response missing access_token'],
      [jsonReply(200, 'not json'), 'oauth2: cannot parse json: '],
    ];
    for (const [reply, want] of cases) {
      const server = await mock(() => reply);
      const err = await refresh(config(server.baseUrl), 'r').then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message.startsWith(want), `${err?.message} should start with ${want}`).toBe(true);
    }
  });

  it('probes header then params credentials and remembers what worked', async () => {
    let calls = 0;
    const server = await mock(() =>
      calls++ === 0
        ? jsonReply(401, '{"error":"invalid_client"}')
        : jsonReply(200, '{"access_token":"a","expires_in":60}'),
    );
    const cfg = config(server.baseUrl);
    await refresh(cfg, 'r');
    const [header, params] = server.requests;
    expect(header!.headers['authorization']).toMatch(/^Basic /);
    expect(params!.headers['authorization']).toBeUndefined();
    expect(params!.form('client_id')).toBe('client id');
    expect(params!.form('client_secret')).toBe('secret&');

    await refresh(cfg, 'r');
    expect(server.requests).toHaveLength(3);
    expect(server.requests[2]!.headers['authorization']).toBeUndefined();
  });

  it('reports the second attempt when both credential styles fail', async () => {
    const server = await mock(() => jsonReply(400, '{"error":"invalid_grant"}'));
    await expect(exchange(config(server.baseUrl), 'c')).rejects.toThrow('oauth2: "invalid_grant"');
    expect(server.requests).toHaveLength(2);
  });

  it('accepts form-encoded responses', async () => {
    const server = await mock(() =>
      textReply(200, 'access_token=a&token_type=bearer&expires_in=60', {
        'Content-Type': 'application/x-www-form-urlencoded',
      }),
    );
    const token = await exchange(config(server.baseUrl), 'c');
    expect(token.accessToken).toBe('a');
    expect(token.tokenType).toBe('bearer');
    expect(token.expiry).not.toBe(ZERO_TIME);
  });

  it('wraps transport failures like Go url.Error', async () => {
    const cfg = config('http://127.0.0.1:1');
    cfg.authStyle = 'header';
    await expect(refresh(cfg, 'r')).rejects.toThrow(/^Post "http:\/\/127\.0\.0\.1:1\/api\/token": /);
  });

  it('parses expires_in like oauth2 expirationTime', () => {
    expect(parseTokenJSON('{"expires_in":"120"}').expires_in).toBe(120);
    expect(parseTokenJSON('{"expires_in":99999999999}').expires_in).toBe(2 ** 31 - 1);
    expect(() => parseTokenJSON('{"expires_in":1.5}')).toThrow();
    expect(() => parseTokenJSON('{"access_token":5}')).toThrow();
    expect(parseTokenJSON('null').access_token).toBe('');
  });
});
