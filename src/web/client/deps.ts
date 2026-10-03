/**
 * The shared model's I/O, over the local server's JSON API. The web UI runs
 * the same state machine as the TUI, but its list lives on the server:
 * re-sorting, searching, and reloading are `view` requests, and the list
 * pane fetches more rows with `rows` as the selection or scroll position
 * nears the end of what has arrived.
 */
import type { ListChunk, SortMode } from '../../app/list';
import type { Deps, ViewRequest, ViewResult } from '../../app/model';
import type { Rating, SyncStats } from '../../core/model';
import {
  API,
  TOKEN_HEADER,
  TOKEN_META,
  type ErrorResponse,
  type ReloadResponse,
  VIEW_CHUNK,
  type ViewResponse,
} from '../api';
import { artworkStore, type ArtworkStore } from './artwork';
import { RemoteTrackList } from './remoteList';

export { VIEW_CHUNK };

/** What the web UI needs from the server. */
export interface WebDeps extends Pick<Deps, 'sync' | 'saveRating'> {
  view(request: ViewRequest): Promise<ViewResult>;
  /** One window of the list for `sort` and `query`, as the server holds it now. */
  rows(sort: SortMode, query: string, offset: number, limit: number): Promise<ListChunk>;
}

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

export function viewUrl(sort: SortMode, query: string, offset: number, limit: number, around = 0): string {
  const params = new URLSearchParams({ sort, q: query, offset: String(offset), limit: String(limit) });
  if (around > 0) {
    params.set('around', String(around));
  }
  return `${API.view}?${params.toString()}`;
}

/** A view response as rows of one list: the request's sort and query are not echoed back. */
export function chunkOf(view: ViewResponse, sort: SortMode, query: string): ListChunk {
  return {
    sort,
    query,
    version: view.version,
    total: view.total,
    matched: view.matched,
    offset: view.offset,
    rows: view.rows,
  };
}

export function httpDeps(
  token: string,
  {
    fetcher = (...args) => fetch(...args),
    store = artworkStore,
  }: { fetcher?: typeof fetch; store?: ArtworkStore } = {},
): WebDeps {
  const post = (body?: unknown): RequestInit => ({
    method: 'POST',
    headers: { [TOKEN_HEADER]: token, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const get = async (url: string): Promise<ViewResponse> => {
    const view = await call<ViewResponse>(url, {}, fetcher);
    store.seed(view.rows);
    return view;
  };
  return {
    view: async ({ sort, query, around, reload }) => {
      if (reload) {
        await call<ReloadResponse>(API.reload, post(), fetcher);
      }
      const view = await get(viewUrl(sort, query, 0, VIEW_CHUNK, around));
      return { list: RemoteTrackList.fromChunk(chunkOf(view, sort, query)), index: view.index };
    },
    rows: async (sort, query, offset, limit) => chunkOf(await get(viewUrl(sort, query, offset, limit)), sort, query),
    sync: () => call<SyncStats>(API.sync, post(), fetcher),
    saveRating: (params) => call<Rating>(API.ratings, post(params), fetcher),
  };
}
