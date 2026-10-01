/**
 * The slice of golang.org/x/oauth2 the Go build relied on: the authorize URL,
 * the token endpoint round trip (including its auth-style probe), refresh,
 * and expiry checks. Error wording mirrors oauth2's so failures read the
 * same as they did in Go.
 */
import { formatGoTime, type Token, tokenExpiryMs, ZERO_TIME } from '../core/config';
import { errorMessage, quote } from '../core/errors';
import { encodeValues, parseQuery, queryEscape, requestSignal, statusText, transportError } from './http';

/** Default production host for the authorize and token endpoints. */
export const ACCOUNTS_BASE_URL = 'https://accounts.spotify.com';

/**
 * oauth2 treats a token as expired this long before its actual expiry so a
 * request never races the deadline.
 */
const EXPIRY_DELTA_MS = 10_000;

/** oauth2 reads at most 1 MiB of a token response. */
const MAX_TOKEN_RESPONSE_BYTES = 1 << 20;

const MAX_INT32 = 2 ** 31 - 1;

/**
 * How client credentials are sent. oauth2 starts out unknown, tries the
 * Basic header first, falls back to form params if that fails, and then
 * remembers whichever worked for the lifetime of the config.
 */
type AuthStyle = 'unknown' | 'header' | 'params';

/** Client credentials plus the endpoints derived from the accounts host. */
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  redirectUrl: string;
  scopes: string[];
  timeoutMs: number;
  /** Mutable probe cache, like oauth2.Config's authStyleCache. */
  authStyle: AuthStyle;
}

export function newOAuthConfig(
  clientId: string,
  clientSecret: string,
  accountsBaseUrl: string,
  redirectUrl: string,
  scopes: string[],
  timeoutMs: number,
): OAuthConfig {
  const base = accountsBaseUrl.replace(/\/+$/, '');
  return {
    clientId,
    clientSecret,
    authUrl: `${base}/authorize`,
    tokenUrl: `${base}/api/token`,
    redirectUrl,
    scopes,
    timeoutMs,
    authStyle: 'unknown',
  };
}

/** oauth2's `AuthCodeURL`: parameters encoded in sorted key order. */
export function authCodeUrl(cfg: OAuthConfig, state: string): string {
  const params: Record<string, string> = { response_type: 'code', client_id: cfg.clientId };
  if (cfg.redirectUrl !== '') {
    params['redirect_uri'] = cfg.redirectUrl;
  }
  if (cfg.scopes.length > 0) {
    params['scope'] = cfg.scopes.join(' ');
  }
  if (state !== '') {
    params['state'] = state;
  }
  const separator = cfg.authUrl.includes('?') ? '&' : '?';
  return `${cfg.authUrl}${separator}${encodeValues(params)}`;
}

/** Exchanges an authorization code for a token. */
export function exchange(cfg: OAuthConfig, code: string, signal?: AbortSignal): Promise<Token> {
  const form: Record<string, string> = { grant_type: 'authorization_code', code };
  if (cfg.redirectUrl !== '') {
    form['redirect_uri'] = cfg.redirectUrl;
  }
  return retrieveToken(cfg, form, signal);
}

/** Obtains a new access token; a response without a refresh token keeps the one just used. */
export async function refresh(cfg: OAuthConfig, refreshToken: string, signal?: AbortSignal): Promise<Token> {
  if (refreshToken === '') {
    throw new Error('oauth2: token expired and refresh token is not set');
  }
  return retrieveToken(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken }, signal);
}

/** oauth2's `RetrieveToken`, including the header-then-params auth-style probe. */
async function retrieveToken(cfg: OAuthConfig, form: Record<string, string>, signal?: AbortSignal): Promise<Token> {
  const probe = cfg.authStyle === 'unknown';
  let style: AuthStyle = probe ? 'header' : cfg.authStyle;
  let token: Token;
  try {
    token = await tokenRoundTrip(cfg, form, style, signal);
  } catch (err) {
    if (!probe) {
      throw err;
    }
    // Assume the server wants the credentials the other way, as oauth2 does.
    style = 'params';
    token = await tokenRoundTrip(cfg, form, style, signal);
  }
  if (probe) {
    cfg.authStyle = style;
  }
  if (token.refreshToken === '') {
    token.refreshToken = form['refresh_token'] ?? '';
  }
  return token;
}

/** oauth2's `doTokenRoundTrip`: POSTs the form and parses JSON or form-encoded replies. */
async function tokenRoundTrip(
  cfg: OAuthConfig,
  form: Record<string, string>,
  style: AuthStyle,
  signal?: AbortSignal,
): Promise<Token> {
  const values = { ...form };
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (style === 'params') {
    if (cfg.clientId !== '') values['client_id'] = cfg.clientId;
    if (cfg.clientSecret !== '') values['client_secret'] = cfg.clientSecret;
  } else {
    const credentials = `${queryEscape(cfg.clientId)}:${queryEscape(cfg.clientSecret)}`;
    headers['Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
  }

  const requestAbort = requestSignal(cfg.timeoutMs, signal);
  let response: Response;
  try {
    response = await fetch(cfg.tokenUrl, { method: 'POST', headers, body: encodeValues(values), signal: requestAbort });
  } catch (err) {
    throw transportError('Post', cfg.tokenUrl, err);
  }
  let body: string;
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    body = Buffer.from(bytes.subarray(0, MAX_TOKEN_RESPONSE_BYTES)).toString('utf8');
  } catch (err) {
    throw new Error(`oauth2: cannot fetch token: ${errorMessage(err)}`, { cause: err });
  }

  const failure = response.status < 200 || response.status > 299;
  const retrieveError = new RetrieveError(response.status, body);
  const contentType = mediaType(response.headers.get('Content-Type') ?? '');
  let parsed: TokenFields;
  if (contentType === 'application/x-www-form-urlencoded' || contentType === 'text/plain') {
    const query = parseQuery(body);
    if (query.error !== null) {
      if (failure) throw retrieveError;
      throw new Error(`oauth2: cannot parse response: ${query.error.message}`);
    }
    retrieveError.setDetail(query.get('error'), query.get('error_description'), query.get('error_uri'));
    parsed = {
      accessToken: query.get('access_token'),
      tokenType: query.get('token_type'),
      refreshToken: query.get('refresh_token'),
      expiresIn: atoi(query.get('expires_in')),
    };
  } else {
    let json: TokenJSON;
    try {
      json = parseTokenJSON(body);
    } catch (err) {
      if (failure) throw retrieveError;
      throw new Error(`oauth2: cannot parse json: ${errorMessage(err)}`, { cause: err });
    }
    retrieveError.setDetail(json.error, json.error_description, json.error_uri);
    parsed = {
      accessToken: json.access_token,
      tokenType: json.token_type,
      refreshToken: json.refresh_token,
      expiresIn: json.expires_in,
    };
  }

  // Some servers report errors with a 200, so a populated error code is a
  // failure regardless of status.
  if (failure || retrieveError.code !== '') {
    throw retrieveError;
  }
  if (parsed.accessToken === '') {
    throw new Error('oauth2: server response missing access_token');
  }
  return {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    tokenType: parsed.tokenType,
    expiry: parsed.expiresIn === 0 ? ZERO_TIME : formatGoTime(Date.now() + parsed.expiresIn * 1000),
  };
}

/** Whether the token can be used as-is (oauth2's `Token.Valid`); a zero expiry never expires. */
export function tokenValid(token: Token, nowMs: number): boolean {
  if (token.accessToken === '') {
    return false;
  }
  const expiryMs = tokenExpiryMs(token);
  return expiryMs === null || !(expiryMs - EXPIRY_DELTA_MS < nowMs);
}

/** The Authorization scheme for a token, normalized like oauth2's `Token.Type`. */
export function authorizationType(tokenType: string): string {
  switch (tokenType.toLowerCase()) {
    case '':
    case 'bearer':
      return 'Bearer';
    case 'mac':
      return 'MAC';
    case 'basic':
      return 'Basic';
    default:
      return tokenType;
  }
}

/** Token endpoint failure, formatted like oauth2's `RetrieveError`. */
export class RetrieveError extends Error {
  code = '';
  description = '';
  uri = '';

  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super('');
    this.name = 'RetrieveError';
    this.message = this.format();
  }

  setDetail(code: string, description: string, uri: string): void {
    this.code = code;
    this.description = description;
    this.uri = uri;
    this.message = this.format();
  }

  private format(): string {
    if (this.code === '') {
      return `oauth2: cannot fetch token: ${this.status} ${statusText(this.status)}\nResponse: ${this.body}`;
    }
    let text = `oauth2: ${quote(this.code)}`;
    if (this.description !== '') text += ` ${quote(this.description)}`;
    if (this.uri !== '') text += ` ${quote(this.uri)}`;
    return text;
  }
}

interface TokenFields {
  accessToken: string;
  tokenType: string;
  refreshToken: string;
  expiresIn: number;
}

interface TokenJSON {
  access_token: string;
  token_type: string;
  refresh_token: string;
  expires_in: number;
  error: string;
  error_description: string;
  error_uri: string;
}

/** Decodes oauth2's `tokenJSON` with Go's type strictness; null fields stay zero. */
export function parseTokenJSON(body: string): TokenJSON {
  const value: unknown = JSON.parse(body);
  const result: TokenJSON = {
    access_token: '',
    token_type: '',
    refresh_token: '',
    expires_in: 0,
    error: '',
    error_description: '',
    error_uri: '',
  };
  if (value === null) {
    return result;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('json: cannot unmarshal non-object into Go value of type internal.tokenJSON');
  }
  const record = value as Record<string, unknown>;
  for (const key of [
    'access_token',
    'token_type',
    'refresh_token',
    'error',
    'error_description',
    'error_uri',
  ] as const) {
    const field = record[key];
    if (field === undefined || field === null) continue;
    if (typeof field !== 'string') {
      throw new Error(`json: cannot unmarshal ${typeof field} into Go struct field tokenJSON.${key} of type string`);
    }
    result[key] = field;
  }
  result.expires_in = expirationTime(record['expires_in']);
  return result;
}

/** oauth2's `expirationTime`: an integer (or numeric string) clamped to int32. */
function expirationTime(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }
  const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(raw) || (typeof value === 'string' && !/^-?\d+$/.test(value))) {
    throw new Error(`strconv.ParseInt: parsing ${quote(String(value))}: invalid syntax`);
  }
  return Math.min(raw, MAX_INT32);
}

/** Go's `strconv.Atoi`, with failures treated as 0 as oauth2 does. */
function atoi(text: string): number {
  return /^[+-]?\d+$/.test(text) ? Number.parseInt(text, 10) : 0;
}

/** The media type of a Content-Type header, lowercased and without params. */
function mediaType(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}
