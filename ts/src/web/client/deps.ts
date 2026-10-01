/**
 * The shared model's I/O, over the local server's JSON API. The web UI runs
 * the same state machine as the TUI; only these three calls differ.
 */
import type { Deps } from '../../app/model';
import type { Rating, SyncStats } from '../../core/model';
import { API, TOKEN_HEADER, TOKEN_META, type ErrorResponse, type LibraryResponse } from '../api';

/** The per-launch token the server put in the page, required on every POST. */
export function pageToken(doc: Document = document): string {
  return doc.querySelector<HTMLMetaElement>(`meta[name="${TOKEN_META}"]`)?.content ?? '';
}

async function call<T>(path: string, init: RequestInit, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(path, init);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (body as ErrorResponse | null)?.error;
    throw new Error(message ?? `${response.status} ${response.statusText}`);
  }
  return body as T;
}

export function httpDeps(token: string, fetcher: typeof fetch = fetch): Deps {
  const post = (body?: unknown): RequestInit => ({
    method: 'POST',
    headers: { [TOKEN_HEADER]: token, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return {
    load: () => call<LibraryResponse>(API.library, {}, fetcher),
    sync: () => call<SyncStats>(API.sync, post(), fetcher),
    saveRating: (params) => call<Rating>(API.ratings, post(params), fetcher),
  };
}
