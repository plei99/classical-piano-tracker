/**
 * Test helpers for the web client: a fake `tracker web` server that sorts,
 * searches, and windows the library with the TUI's own list code (as the
 * Rust server does; the contract test checks the real one), and the page the
 * server renders.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LocalTrackList, type ListRow, type SortMode } from '../app/list';
import type { Rating, SyncStats, Track } from '../core/model';
import { API, INITIAL_DATA_ID, TOKEN_META, type InitialData, type ViewResponse } from '../api';
import { scriptJson } from './initial';
import { renderApp } from './page';
import type { ThemeChoice } from './theme';

/** The server's copy of the library: every track and its rating, in a new version after each change. */
class Library {
  private version = 0;
  private base = LocalTrackList.empty;

  constructor(private readonly source: { listAllTracks(): Track[]; listAllRatings(): Rating[] }) {}

  reload(): { version: number; total: number } {
    const ratings = new Map(this.source.listAllRatings().map((rating) => [rating.trackId, rating]));
    this.base = LocalTrackList.load(this.source.listAllTracks(), ratings);
    this.version++;
    return { version: this.version, total: this.base.total };
  }

  setRating(rating: Rating): void {
    this.base = this.base.withRating(rating.trackId, rating);
    this.version++;
  }

  view(query: { sort: SortMode; query: string; offset: number; limit: number; around?: number }): ViewResponse {
    const list = this.base.requery(query.sort, query.query);
    const matched = list.count;
    let start = query.offset;
    let index: number | null = null;
    if (query.around !== undefined) {
      const found = list.indexOf(query.around);
      if (found >= 0) {
        index = found;
        start = Math.max(0, Math.min(found - Math.floor(query.limit / 2), matched - query.limit));
      }
    }
    const rows: ListRow[] = [];
    for (let position = start; position < Math.min(matched, start + query.limit); position++) {
      const row = list.row(position);
      if (row !== null) rows.push(row);
    }
    return { version: this.version, total: list.total, matched, offset: start, rows, index };
  }
}

export function track(
  id: number,
  name: string,
  lastPlayedAt: number,
  artists = '["Frédéric Chopin","Martha Argerich"]',
): Track {
  return {
    id,
    spotifyId: `spotify${String(id).padStart(15, '0')}`,
    trackName: name,
    albumName: `Album ${id}`,
    artists,
    playCount: id,
    lastPlayedAt,
    createdAt: 1,
  };
}

/** `n` tracks, newest first by ID (track i was played at 10_000 + i). */
export function manyTracks(n: number): Track[] {
  return Array.from({ length: n }, (_, i) => track(i + 1, `Etude ${i + 1}`, 10_000 + i));
}

export interface FakeServer {
  fetch: typeof fetch;
  library: Library;
  tracks: Track[];
  ratings: Rating[];
  /** Every request, as "METHOD /path?query". */
  requests: string[];
  /** View requests only. */
  views(): URLSearchParams[];
  /** Holds the next responses to matching requests until `release` (to test ordering). */
  hold(match: (url: URL) => boolean): { release(): void; held(): number };
  /** Makes the next reload fail with this message. */
  failReload?: string;
  sync: () => Promise<SyncStats>;
  initial(): InitialData;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function fakeServer(tracks: Track[], ratings: Rating[] = []): FakeServer {
  const server: FakeServer = {
    tracks,
    ratings,
    requests: [],
    library: undefined as unknown as Library,
    views: () =>
      server.requests
        .filter((request) => request.startsWith(`GET ${API.view}?`))
        .map((request) => new URLSearchParams(request.slice(request.indexOf('?') + 1))),
    hold: (match) => {
      holds.push({ match, waiting: [] });
      const hold = holds[holds.length - 1]!;
      return {
        release: () => {
          holds.splice(holds.indexOf(hold), 1);
          for (const go of hold.waiting) go();
        },
        held: () => hold.waiting.length,
      };
    },
    sync: async () => ({
      fetched: 1,
      blocked: 0,
      skipped: 0,
      accepted: 1,
      inserted: 1,
      updated: 0,
      alreadySynced: 0,
    }),
    initial: () => ({ view: viewOf(new URLSearchParams('sort=recentDesc&limit=100')), error: null }),
    fetch: async (input, init) => {
      const url = new URL(String(input), 'http://127.0.0.1');
      const method = init?.method ?? 'GET';
      server.requests.push(`${method} ${url.pathname}${url.search}`);
      // Answer from the state at request time, deliver when released.
      const answer = respond(method, url, init);
      const hold = holds.find((candidate) => candidate.match(url));
      if (hold !== undefined) {
        await new Promise<void>((resolve) => hold.waiting.push(resolve));
      }
      return answer();
    },
  };
  const holds: { match: (url: URL) => boolean; waiting: (() => void)[] }[] = [];
  server.library = new Library({ listAllTracks: () => server.tracks, listAllRatings: () => server.ratings });
  server.library.reload();

  function viewOf(params: URLSearchParams): ViewResponse {
    const around = params.get('around');
    const result = server.library.view({
      sort: (params.get('sort') ?? 'recentDesc') as never,
      query: params.get('q') ?? '',
      offset: Number(params.get('offset') ?? 0),
      limit: Number(params.get('limit')),
      ...(around !== null && { around: Number(around) }),
    });
    return { ...result, rows: result.rows.map((row) => ({ ...row })) };
  }

  function respond(method: string, url: URL, init?: RequestInit): () => Response | Promise<Response> {
    switch (`${method} ${url.pathname}`) {
      case `GET ${API.view}`: {
        const body = viewOf(url.searchParams);
        return () => json(body);
      }
      case `POST ${API.reload}`: {
        if (server.failReload !== undefined) {
          const error = server.failReload;
          server.failReload = undefined;
          return () => json({ error }, 500);
        }
        return () => json(server.library.reload());
      }
      case `POST ${API.sync}`:
        return async () => {
          const stats = await server.sync();
          server.library.reload();
          return json(stats);
        };
      case `POST ${API.ratings}`: {
        const rating = JSON.parse(String(init?.body)) as Rating;
        server.ratings = [...server.ratings.filter((r) => r.trackId !== rating.trackId), rating];
        server.library.setRating(rating);
        return () => json(rating);
      }
      case `GET ${API.artwork}`:
        return () => json({});
    }
    return () => json({ error: 'not found' }, 404);
  }

  return server;
}

// The DOM test environment's import.meta.url is not a file URL; tests run in web/.
const TEMPLATE = readFileSync(join(process.cwd(), 'index.html'), 'utf8');

/** The page the server sends: the template filled in as the Rust server fills it. */
export function renderPage(initial: InitialData, theme: ThemeChoice = 'auto', token = 'secret'): string {
  const script = `<script type="application/json" id="${INITIAL_DATA_ID}">${scriptJson(initial)}</script>`;
  return TEMPLATE.replaceAll('%TRACKER_TOKEN%', token)
    .replaceAll('%TRACKER_THEME%', theme)
    .replace('<!--tracker-app-->', renderApp(initial, theme))
    .replace('<!--tracker-initial-->', script);
}

/** Splits the page the server renders into what goes in <head> and <body>. */
export function pageParts(
  initial: InitialData,
  theme: ThemeChoice = 'auto',
): { head: string; body: string; html: string } {
  const html = renderPage(initial, theme);
  return {
    html,
    head: /<head>([\s\S]*)<\/head>/.exec(html)?.[1] ?? '',
    body: /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '',
  };
}
