/**
 * Shared HTTP plumbing for the API-backed providers and the model catalog.
 *
 * Errors are phrased like Go's net/http so wrapped messages read the same:
 * a failed exchange renders as `Post "<url>": <reason>` (Go's *url.Error),
 * and a client timeout as "context deadline exceeded (Client.Timeout
 * exceeded while awaiting headers)". Transport-level reasons (connection
 * refused, DNS failures) use Node's wording.
 */
import { STATUS_CODES } from 'node:http';
import { goQuote } from '../../recommend/gojson';
import { goTrimSpace } from '../../recommend/gostrings';
import { contextError } from '../context';

/** Model calls can take well over the 30s many clients default to. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 90_000;

/** Injectable transport settings, mirroring Go's `*http.Client` parameter. */
export interface HttpOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  /** The status the way Go's `resp.Status` renders it, e.g. "404 Not Found". */
  statusLine: string;
  body: Buffer;
}

/** Which stage of the exchange failed; Go words each one differently. */
export class HttpError extends Error {
  constructor(
    readonly stage: 'build' | 'send' | 'read',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HttpError';
  }
}

/** The response body as text with surrounding whitespace removed. */
export function bodyText(response: HttpResponse): string {
  return goTrimSpace(response.body.toString('utf8'));
}

function abortReason(err: unknown, timeout: AbortSignal, signal: AbortSignal | undefined, phase: string): string {
  if (signal?.aborted) {
    return contextError(signal).message;
  }
  if (timeout.aborted) {
    return `context deadline exceeded (Client.Timeout ${phase})`;
  }
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  return cause instanceof Error ? cause.message : String(cause);
}

/** Performs one request with a whole-exchange timeout, like `http.Client.Timeout`. */
export async function httpRequest(
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string>,
  body: string | undefined,
  options: { fetch: typeof fetch; timeoutMs: number },
  signal?: AbortSignal,
): Promise<HttpResponse> {
  try {
    new URL(url);
  } catch {
    throw new HttpError('build', `parse ${goQuote(url)}: invalid URL`);
  }
  const op = method === 'GET' ? 'Get' : 'Post';
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  let response: Response;
  try {
    response = await options.fetch(url, { method, headers, body, signal: combined });
  } catch (err) {
    const reason = abortReason(err, timeout, signal, 'exceeded while awaiting headers');
    throw new HttpError('send', `${op} ${goQuote(url)}: ${reason}`, { cause: err });
  }

  let data: Buffer;
  try {
    data = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    throw new HttpError('read', abortReason(err, timeout, signal, 'or context cancellation while reading body'), {
      cause: err,
    });
  }
  const reason = response.statusText || STATUS_CODES[response.status] || '';
  return { status: response.status, statusLine: `${response.status} ${reason}`.trim(), body: data };
}

/**
 * Posts a JSON body and maps transport failures onto the provider's Go
 * error contexts (`build ...`, `call ...`, `read ...`).
 */
export async function postJSON(
  url: string,
  headers: Record<string, string>,
  payload: string,
  options: { fetch: typeof fetch; timeoutMs: number },
  contexts: { build: string; call: string; read: string },
  signal?: AbortSignal,
): Promise<HttpResponse> {
  try {
    return await httpRequest('POST', url, headers, payload, options, signal);
  } catch (err) {
    if (err instanceof HttpError) {
      const context = err.stage === 'build' ? contexts.build : err.stage === 'send' ? contexts.call : contexts.read;
      throw new Error(`${context}: ${err.message}`, { cause: err.cause ?? err });
    }
    throw err;
  }
}

/** Resolves the injectable transport settings with a provider's default timeout. */
export function resolveHttpOptions(
  options: HttpOptions | undefined,
  defaultTimeoutMs: number,
): { fetch: typeof fetch; timeoutMs: number } {
  return {
    fetch: options?.fetch ?? globalThis.fetch.bind(globalThis),
    timeoutMs: options?.timeoutMs ?? defaultTimeoutMs,
  };
}
