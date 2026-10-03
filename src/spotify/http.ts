/**
 * Small HTTP helpers that reproduce Go's net/url and net/http text, so URLs,
 * form bodies, and transport errors read the same as in the Go build.
 */
import { STATUS_CODES } from 'node:http';

import { errorMessage, quote } from '../core/errors';

/**
 * Go's http.Client has no default timeout; a hung Spotify endpoint should
 * not wedge the CLI or a TUI task forever, so every request gets one.
 */
export const HTTP_TIMEOUT_MS = 30_000;

/** Combines the per-request timeout with an optional caller cancellation. */
export function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** Maps abort reasons onto Go's context errors; otherwise the root cause. */
export function causeMessage(err: unknown): string {
  if (err instanceof Error || err instanceof DOMException) {
    if (err.name === 'TimeoutError') {
      return 'context deadline exceeded';
    }
    if (err.name === 'AbortError') {
      return 'context canceled';
    }
    // fetch reports "fetch failed" with the socket error as the cause.
    if (err.cause instanceof Error) {
      return err.cause.message;
    }
  }
  return errorMessage(err);
}

/** Go's `*url.Error` text, e.g. `Get "https://…": connection refused`. */
export function transportError(method: 'Get' | 'Post', url: string, err: unknown): Error {
  return new Error(`${method} ${quote(url)}: ${causeMessage(err)}`, { cause: err });
}

/** Where Go's `http.StatusText` differs from Node's table. */
const GO_STATUS_TEXT: Record<number, string> = {
  413: 'Request Entity Too Large',
  414: 'Request URI Too Long',
  416: 'Requested Range Not Satisfiable',
  418: "I'm a teapot",
  509: '',
};

/** Go's `http.StatusText`: the canonical reason phrase, or "" if unknown. */
export function statusText(status: number): string {
  return GO_STATUS_TEXT[status] ?? STATUS_CODES[status] ?? '';
}

/** Resolves after `ms`, or early (with false) when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---- net/url ----

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Go's `url.QueryEscape`: unreserved bytes pass through, spaces become `+`,
 * and everything else is percent-encoded. URLSearchParams differs (it keeps
 * `*` and escapes `~`), which would change the authorize URL and bodies.
 */
export function queryEscape(raw: string): string {
  let escaped = '';
  for (const byte of encoder.encode(raw)) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(char)) {
      escaped += char;
    } else if (char === ' ') {
      escaped += '+';
    } else {
      escaped += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return escaped;
}

/** Go's `url.Values.Encode`: keys sorted, each pair query-escaped. */
export function encodeValues(values: Record<string, string>): string {
  return Object.keys(values)
    .sort()
    .map((key) => `${queryEscape(key)}=${queryEscape(values[key] ?? '')}`)
    .join('&');
}

/** Go's `url.QueryUnescape`, including its error for malformed escapes. */
function queryUnescape(text: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '%') {
      const hex = text.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
        throw new Error(`invalid URL escape ${quote(text.slice(i, i + 3))}`);
      }
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else if (char === '+') {
      bytes.push(0x20);
    } else {
      bytes.push(...encoder.encode(char));
    }
  }
  return decoder.decode(new Uint8Array(bytes));
}

/** A parsed query: the first value per key (Go's `Values.Get`) plus the first error, if any. */
export interface ParsedQuery {
  get(key: string): string;
  error: Error | null;
}

/**
 * Go's `url.ParseQuery`: malformed pairs are skipped and the first error is
 * reported, while every well-formed pair is still kept.
 */
export function parseQuery(query: string): ParsedQuery {
  const values = new Map<string, string>();
  let error: Error | null = null;
  for (const pair of query.split('&')) {
    if (pair.includes(';')) {
      error ??= new Error('invalid semicolon separator in query');
      continue;
    }
    if (pair === '') {
      continue;
    }
    const eq = pair.indexOf('=');
    try {
      const key = queryUnescape(eq === -1 ? pair : pair.slice(0, eq));
      const value = queryUnescape(eq === -1 ? '' : pair.slice(eq + 1));
      if (!values.has(key)) {
        values.set(key, value);
      }
    } catch (err) {
      error ??= err as Error;
    }
  }
  return { get: (key) => values.get(key) ?? '', error };
}
