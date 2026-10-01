/**
 * The CLI's OAuth authorization-code flow: a one-shot local HTTP server
 * receives Spotify's browser redirect, then the code is exchanged for a token.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { type SpotifyConfig, type Token, validateClientCredentials } from '../core/config';
import { quote, wrap } from '../core/errors';
import { HTTP_TIMEOUT_MS, parseQuery } from './http';
import { ACCOUNTS_BASE_URL, authCodeUrl, exchange, newOAuthConfig, type OAuthConfig } from './oauth';

/** The local callback used during the CLI OAuth flow; it must be registered on the Spotify app. */
export const DEFAULT_REDIRECT_URL = 'http://127.0.0.1:8000/api/auth/spotify/callback';

/** The app only reads listening history. */
export const SCOPES: readonly string[] = ['user-read-recently-played'];

/** Bounds shutdown so a lingering browser connection cannot hang login. */
const CALLBACK_SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Centralizes the OAuth settings so login and authenticated client creation
 * stay aligned on redirect URL and scopes.
 */
export function authenticator(
  spotify: SpotifyConfig,
  accountsBaseUrl: string,
  redirectUrl: string,
  timeoutMs: number,
): OAuthConfig {
  try {
    validateClientCredentials(spotify);
  } catch (err) {
    throw wrap('invalid Spotify credentials', err);
  }
  return newOAuthConfig(spotify.clientId, spotify.clientSecret, accountsBaseUrl, redirectUrl, [...SCOPES], timeoutMs);
}

export interface LoginOptions {
  /** Abandons the wait for the browser (Go's context cancellation). */
  signal?: AbortSignal;
  accountsBaseUrl?: string;
  /**
   * Overrides DEFAULT_REDIRECT_URL. Port 0 binds an ephemeral port and the
   * authorize URL then names the real one; tests rely on this.
   */
  redirectUrl?: string;
  timeoutMs?: number;
}

/**
 * Runs the authorization-code flow: hands the authorize URL to `presentUrl`,
 * waits for the browser callback on DEFAULT_REDIRECT_URL, and exchanges the
 * code for a token (expiry formatted with `formatGoTime`).
 *
 * Like the Go build there is no timeout on the wait itself; it ends when the
 * browser calls back (successfully or not) or `options.signal` aborts.
 */
export async function login(
  spotify: SpotifyConfig,
  presentUrl: (url: string) => void | Promise<void>,
  options: LoginOptions = {},
): Promise<Token> {
  const redirectUrl = options.redirectUrl ?? DEFAULT_REDIRECT_URL;
  const oauth = authenticator(
    spotify,
    options.accountsBaseUrl ?? ACCOUNTS_BASE_URL,
    redirectUrl,
    options.timeoutMs ?? HTTP_TIMEOUT_MS,
  );
  const { listenAddr, callbackPath } = callbackServerConfig(redirectUrl);
  const state = randomState();

  const callback = await CallbackServer.listen(listenAddr, callbackPath, state);
  if (callback.port !== null) {
    oauth.redirectUrl = redirectUrlWithPort(redirectUrl, callback.port);
  }

  try {
    await presentUrl(authCodeUrl(oauth, state));
    const code = await waitOrCancel(callback.outcome, options.signal);
    try {
      return await exchange(oauth, code, options.signal);
    } catch (err) {
      throw wrap('exchange Spotify authorization code', err);
    }
  } finally {
    await callback.shutdown();
  }
}

/** Races the callback against cancellation, with Go's ctx error text. */
function waitOrCancel(outcome: Promise<string>, signal?: AbortSignal): Promise<string> {
  if (signal === undefined) {
    return outcome;
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      const reason: unknown = signal.reason;
      const timedOut = reason instanceof DOMException && reason.name === 'TimeoutError';
      reject(new Error(`spotify login canceled: ${timedOut ? 'context deadline exceeded' : 'context canceled'}`));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    outcome.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Validates the redirect URL and extracts the bind address and callback
 * path. Parsed by hand like Go's url.Parse: WHATWG URL parsing would
 * normalize away the cases Go rejects (e.g. `http:///cb` gains host "cb").
 */
export function callbackServerConfig(rawUrl: string): { listenAddr: string; callbackPath: string } {
  const schemeEnd = rawUrl.indexOf('://');
  const scheme = schemeEnd === -1 ? '' : rawUrl.slice(0, schemeEnd);
  let rest = schemeEnd === -1 ? rawUrl : rawUrl.slice(schemeEnd + 3);
  let fragment = '';
  let query = '';
  [rest, fragment] = splitOnce(rest, '#');
  [rest, query] = splitOnce(rest, '?');
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash);
  // Go keeps userinfo out of URL.Host.
  const host = authority.slice(authority.lastIndexOf('@') + 1);

  if (scheme.toLowerCase() !== 'http') {
    throw new Error(`redirect URL ${quote(rawUrl)} must use http for local callback handling`);
  }
  if (host === '') {
    throw new Error(`redirect URL ${quote(rawUrl)} must include a host`);
  }
  if (path === '') {
    throw new Error(`redirect URL ${quote(rawUrl)} must include a callback path`);
  }
  if (query !== '' || fragment !== '') {
    throw new Error(`redirect URL ${quote(rawUrl)} must not include query or fragment components`);
  }
  return { listenAddr: host.includes(':') ? host : `${host}:80`, callbackPath: path };
}

function splitOnce(text: string, separator: string): [string, string] {
  const index = text.indexOf(separator);
  return index === -1 ? [text, ''] : [text.slice(0, index), text.slice(index + 1)];
}

/** Rewrites the `:0` port of an ephemeral-port redirect URL. */
function redirectUrlWithPort(redirectUrl: string, port: number): string {
  return redirectUrl.replace(/:0(?=\/)/, `:${port}`);
}

/** Generates the anti-CSRF OAuth state token for one login attempt. */
export function randomState(): string {
  return randomBytes(16).toString('hex');
}

/** Splits Go's `host:port` listen address for node:http. */
function splitHostPort(addr: string): { host: string | undefined; port: number } {
  const colon = addr.lastIndexOf(':');
  const host = addr.slice(0, colon).replace(/^\[(.*)\]$/, '$1');
  const portText = addr.slice(colon + 1);
  const port = /^\d+$/.test(portText) ? Number(portText) : Number.NaN;
  if (!(port >= 0 && port <= 65_535)) {
    throw new Error(`listen tcp ${addr}: address ${portText}: invalid port`);
  }
  // Go treats an empty host as every interface.
  return { host: host === '' ? undefined : host, port };
}

/**
 * One-shot callback server. The first callback outcome (code or error)
 * settles `outcome`; later requests are still answered until shutdown, as
 * in Go, but no longer change the result.
 */
class CallbackServer {
  readonly outcome: Promise<string>;
  private settle!: (result: { code: string } | { error: Error }) => void;

  private constructor(
    private readonly server: Server,
    /** The bound port when the configured one was 0, else null. */
    readonly port: number | null,
  ) {
    let settled = false;
    this.outcome = new Promise<string>((resolve, reject) => {
      this.settle = (result) => {
        if (settled) return;
        settled = true;
        if ('code' in result) resolve(result.code);
        else reject(result.error);
      };
    });
    // The outcome may reject while presentUrl is still running.
    this.outcome.catch(() => undefined);
  }

  static async listen(listenAddr: string, callbackPath: string, state: string): Promise<CallbackServer> {
    let callback: CallbackServer | undefined;
    const server = createServer((req, res) => callback?.handle(req, res, callbackPath, state));
    try {
      const { host, port } = splitHostPort(listenAddr);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      const boundPort = port === 0 && address !== null && typeof address === 'object' ? address.port : null;
      callback = new CallbackServer(server, boundPort);
    } catch (err) {
      server.close();
      throw wrap(`listen for Spotify callback on ${listenAddr}`, err);
    }
    server.on('error', (err) => callback?.settle({ error: wrap('serve Spotify callback listener', err) }));
    return callback;
  }

  /** Checks state, then an `error` parameter, then the code, in Go's order. */
  private handle(req: IncomingMessage, res: ServerResponse, callbackPath: string, state: string): void {
    // Each response closes its connection so shutdown never waits on keep-alive.
    res.setHeader('Connection', 'close');
    const target = req.url ?? '';
    const [path, rawQuery] = splitOnce(target, '?');
    if (path !== callbackPath) {
      httpError(res, '404 page not found', 404);
      return;
    }

    const query = parseQuery(rawQuery);
    if (query.get('state') !== state) {
      httpError(res, 'spotify login failed: state mismatch', 400);
      this.settle({ error: new Error('spotify login failed: callback state mismatch') });
      return;
    }
    const authError = query.get('error');
    if (authError !== '') {
      httpError(res, 'spotify login failed', 400);
      this.settle({ error: new Error(`spotify login failed: ${authError}`) });
      return;
    }
    const code = query.get('code');
    if (code === '') {
      httpError(res, 'spotify login failed: missing code', 400);
      this.settle({ error: new Error('spotify login failed: missing authorization code') });
      return;
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Spotify authentication complete. You can close this window.\n');
    this.settle({ code });
  }

  /**
   * Stops accepting and releases the port, giving in-flight responses up to
   * CALLBACK_SHUTDOWN_TIMEOUT_MS before connections are dropped.
   */
  shutdown(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.server.closeAllConnections();
        resolve();
      }, CALLBACK_SHUTDOWN_TIMEOUT_MS);
      this.server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      this.server.closeIdleConnections();
    });
  }
}

/** Go's `http.Error`: a plain-text body with a trailing newline. */
function httpError(res: ServerResponse, message: string, status: number): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(`${message}\n`);
}
