/**
 * The subset of Go's `net/url` the model catalog relies on.
 *
 * WHATWG `URL` normalizes differently from Go (it adds a trailing slash to
 * bare hosts, rejects relative references, and escapes query values with a
 * different safe set), so endpoint derivation uses this small port instead.
 * Paths are decoded and re-escaped as Go does; queries and fragments are
 * kept in their escaped form.
 */
import { goQuote } from '../../recommend/gojson';

export interface GoURL {
  scheme: string;
  /** Text after "//" up to the path, or null when there is no authority. */
  host: string | null;
  opaque: string;
  /** Decoded path, like Go's `URL.Path`. */
  path: string;
  /** The original escaped path when it differs from the canonical escaping. */
  rawPath: string;
  rawQuery: string;
  forceQuery: boolean;
  fragment: string;
}

/** Go's `url.Parse`. Throws Go's `parse "...": ...` errors. */
export function parseURL(raw: string): GoURL {
  const fail = (reason: string): never => {
    throw new Error(`parse ${goQuote(raw)}: ${reason}`);
  };
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      fail('net/url: invalid control character in URL');
    }
  }

  let rest = raw;
  let fragment = '';
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    fragment = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }

  let scheme = '';
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(rest);
  if (schemeMatch !== null) {
    scheme = (schemeMatch[1] as string).toLowerCase();
    rest = rest.slice(schemeMatch[0].length);
  } else if (rest.startsWith(':')) {
    fail('missing protocol scheme');
  }

  let rawQuery = '';
  let forceQuery = false;
  const question = rest.indexOf('?');
  if (question >= 0) {
    rawQuery = rest.slice(question + 1);
    forceQuery = rawQuery === '';
    rest = rest.slice(0, question);
  }

  if (scheme !== '' && !rest.startsWith('/')) {
    return { scheme, host: null, opaque: rest, path: '', rawPath: '', rawQuery, forceQuery, fragment };
  }
  if (scheme === '') {
    const colon = rest.indexOf(':');
    const slash = rest.indexOf('/');
    if (colon >= 0 && (slash < 0 || colon < slash)) {
      fail('first path segment in URL cannot contain colon');
    }
  }

  let host: string | null = null;
  if ((scheme !== '' || !rest.startsWith('///')) && rest.startsWith('//')) {
    const authority = rest.slice(2);
    const end = authority.indexOf('/');
    host = end >= 0 ? authority.slice(0, end) : authority;
    rest = end >= 0 ? authority.slice(end) : '';
  }
  const path = unescapePath(rest);
  if (path === null) {
    const bad = rest.slice(rest.search(/%(?![0-9a-fA-F]{2})/)).slice(0, 3);
    return fail(`invalid URL escape ${goQuote(bad)}`);
  }
  return {
    scheme,
    host,
    opaque: '',
    path,
    rawPath: escapePath(path) === rest ? '' : rest,
    rawQuery,
    forceQuery,
    fragment,
  };
}

/** Go's `shouldEscape(c, encodePath)`. */
function shouldEscapeInPath(c: number): boolean {
  if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39)) {
    return false;
  }
  return !'-_.~$&+,/:;=@'.includes(String.fromCharCode(c));
}

/** Go's `escape(s, encodePath)`. */
function escapePath(path: string): string {
  let out = '';
  for (const byte of Buffer.from(path, 'utf8')) {
    out += shouldEscapeInPath(byte)
      ? `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
      : String.fromCharCode(byte);
  }
  return out;
}

/** Go's `unescape(s, encodePath)`; null for a malformed escape. */
function unescapePath(raw: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '%') {
      const pair = raw.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(pair)) {
        return null;
      }
      bytes.push(parseInt(pair, 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(raw[i] as string, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Go's `validEncoded(s, encodePath)`. */
function validEncodedPath(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if ("!$&'()*+,;=:@[]%".includes(raw[i] as string)) {
      continue;
    }
    if (c >= 0x80 || shouldEscapeInPath(c)) {
      return false;
    }
  }
  return true;
}

/** Go's `(*url.URL).EscapedPath`. */
function escapedPath(u: GoURL): string {
  if (u.rawPath !== '' && validEncodedPath(u.rawPath) && unescapePath(u.rawPath) === u.path) {
    return u.rawPath;
  }
  return u.path === '*' ? '*' : escapePath(u.path);
}

/** Go's `(*url.URL).String`. */
export function formatURL(u: GoURL): string {
  let out = '';
  if (u.scheme !== '') {
    out += `${u.scheme}:`;
  }
  if (u.opaque !== '') {
    out += u.opaque;
  } else {
    const host = u.host ?? '';
    // A null host is Go's OmitHost ("scheme:/path"): no "//" is written.
    if (u.host !== null && (u.scheme !== '' || host !== '') && (host !== '' || u.path !== '')) {
      out += `//${host}`;
    }
    let path = escapedPath(u);
    if (path !== '' && !path.startsWith('/') && host !== '') {
      path = `/${path}`;
    }
    if (out === '' && (path.split('/')[0] ?? '').includes(':')) {
      out += './';
    }
    out += path;
  }
  if (u.forceQuery || u.rawQuery !== '') {
    out += `?${u.rawQuery}`;
  }
  if (u.fragment !== '') {
    out += `#${u.fragment}`;
  }
  return out;
}

/** Go's `url.QueryEscape`. */
export function queryEscape(text: string): string {
  let out = '';
  for (const byte of Buffer.from(text, 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(c)) {
      out += c;
    } else if (c === ' ') {
      out += '+';
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/** Go's `url.QueryUnescape`; returns null for malformed escapes. */
function queryUnescape(text: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === '%') {
      const pair = text.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(pair)) {
        return null;
      }
      bytes.push(parseInt(pair, 16));
      i += 2;
    } else if (c === '+') {
      bytes.push(0x20);
    } else {
      bytes.push(...Buffer.from(c, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Go's `u.Query()` + `Set(key, value)` + `Encode()`: parses the existing
 * query (dropping malformed pairs), replaces `key`, and re-encodes with keys
 * sorted.
 */
export function setQueryParam(rawQuery: string, key: string, value: string): string {
  const values = new Map<string, string[]>();
  for (const part of rawQuery.split('&')) {
    if (part === '' || part.includes(';')) {
      continue;
    }
    const eq = part.indexOf('=');
    const k = queryUnescape(eq >= 0 ? part.slice(0, eq) : part);
    const v = queryUnescape(eq >= 0 ? part.slice(eq + 1) : '');
    if (k === null || v === null) {
      continue;
    }
    values.set(k, [...(values.get(k) ?? []), v]);
  }
  values.set(key, [value]);
  const keys = [...values.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return keys.flatMap((k) => (values.get(k) ?? []).map((v) => `${queryEscape(k)}=${queryEscape(v)}`)).join('&');
}
