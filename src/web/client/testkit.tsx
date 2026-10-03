/**
 * Test helpers for the web client: a fake `tracker web` server built on the
 * real server's Library (so the client is tested against the server's sort,
 * search, and windowing), and the page the real server would render.
 */
import type { Rating, SyncStats, Track } from '../../core/model';
import { API, type InitialData, type ViewResponse } from '../api';
import { Library } from '../server/library';
import { renderPage } from '../server/page';
import type { ThemeChoice } from './theme';

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
    initial: () => ({ view: viewOf(new URLSearchParams('sort=recentDesc&limit=100')) }),
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

/** Splits the page the server renders into what goes in <head> and <body>. */
export function pageParts(
  initial: InitialData,
  theme: ThemeChoice = 'auto',
): { head: string; body: string; html: string } {
  const html = renderPage({ token: 'secret', theme, initial });
  return {
    html,
    head: /<head>([\s\S]*)<\/head>/.exec(html)?.[1] ?? '',
    body: /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '',
  };
}
