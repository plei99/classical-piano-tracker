/**
 * The client against the real server: starts the Rust `tracker web` on a
 * seeded database and drives it with the client's own HTTP layer
 * (`httpDeps`) and page reading (`readInitialData`), so the wire format,
 * routes, token handling, and the server's first render are checked at
 * run time, as the generated types check them at compile time.
 *
 * Needs the binary: `make check` builds it and sets TRACKER_BIN. Without
 * TRACKER_BIN, target/debug/tracker is used when it exists.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API, INITIAL_DATA_ID, type ArtworkResponse, type InitialData, type ViewRow } from '../api';
import { selectedTrack } from '../app/model';
import { ArtworkStore } from './artwork';
import { httpDeps } from './deps';
import { initialModel, readInitialData } from './initial';
import { renderApp } from './page';

/**
 * The shapes the server is seen to send below, as typed values: if the
 * generated types ever narrow (say, art that cannot be null), this file
 * stops compiling, since the parsed JSON itself is only cast to them.
 */
export const SENT_SHAPES: { art: ViewRow['art'][]; initial: InitialData[] } = {
  art: [null, undefined, { small: 's', medium: null, large: null }],
  initial: [{ view: null }, { view: null, error: 'database is locked' }],
};

const bin = process.env['TRACKER_BIN'] ?? join(process.cwd(), '../target/debug/tracker');
const required = process.env['TRACKER_BIN'] !== undefined;

/** Spotify IDs are 22 alphanumerics. */
const sid = (n: number) => `track${String(n).padStart(17, '0')}`;

const TRACKS = [
  {
    id: 1,
    name: 'Ballade No. 1 in G Minor',
    artists: ['Frédéric Chopin', 'Krystian Zimerman'],
    plays: 3,
    at: 1_787_000_300,
  },
  {
    id: 2,
    name: 'Gaspard de la nuit: Scarbo <live>',
    artists: ['Maurice Ravel', 'Martha Argerich'],
    plays: 9,
    at: 1_787_000_200,
  },
  {
    id: 3,
    name: 'Partita No. 2 & Sinfonia',
    artists: ['Johann Sebastian Bach', 'Martha Argerich'],
    plays: 5,
    at: 1_787_000_100,
  },
];

describe.runIf(required || existsSync(bin))('the Rust server', () => {
  let dir = '';
  let server: ChildProcess | undefined;
  let base = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tracker-contract-'));
    const db = new DatabaseSync(join(dir, 'tracker.db'));
    db.exec(readFileSync(join(process.cwd(), '../crates/tracker-core/sql/schema.sql'), 'utf8'));
    const insert = db.prepare(
      'INSERT INTO tracks (id, spotify_id, track_name, album_name, artists, play_count, last_played_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
    );
    for (const t of TRACKS)
      insert.run(t.id, sid(t.id), t.name, `Album ${t.id}`, JSON.stringify(t.artists), t.plays, t.at);
    db.prepare('INSERT INTO ratings (track_id, stars, opinion, updated_at) VALUES (?, ?, ?, ?)').run(
      3,
      5,
      'Lucid',
      1_787_000_400,
    );
    db.close();
    // Art the server already knows, so nothing is looked up on Spotify.
    writeFileSync(
      join(dir, 'artwork-cache.json'),
      JSON.stringify({
        version: 1,
        artwork: {
          [sid(1)]: { small: 'https://i.scdn.co/image/s1', medium: null, large: 'https://i.scdn.co/image/l1' },
          [sid(2)]: null,
        },
      }),
    );
    server = spawn(
      bin,
      [
        '--config',
        join(dir, 'config.json'),
        '--db',
        join(dir, 'tracker.db'),
        'web',
        '--no-open',
        '--keep-running',
        '--port',
        '0',
      ],
      {
        env: { ...process.env, TZ: 'UTC' },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    base = await new Promise<string>((resolve, reject) => {
      let out = '';
      server!.stdout!.on('data', (chunk: Buffer) => {
        out += String(chunk);
        const url = /Serving the tracker web UI at (\S+)/.exec(out)?.[1];
        if (url !== undefined) resolve(url);
      });
      server!.once('exit', (code) => reject(new Error(`tracker web exited (${code}): ${out}`)));
    });
  });

  afterAll(() => {
    server?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The client's fetch, against the server's address. */
  const fetcher: typeof fetch = (input, init) => fetch(new URL(String(input), base), init);

  async function page(): Promise<{ html: string; token: string; initial: InitialData }> {
    const response = await fetch(base, { headers: { Cookie: 'tracker-theme=dark' } });
    expect(response.status).toBe(200);
    const html = await response.text();
    const token = /<meta name="tracker-token" content="([0-9a-f]+)"/.exec(html)?.[1] ?? '';
    const json = new RegExp(`<script type="application/json" id="${INITIAL_DATA_ID}">(.*?)</script>`).exec(html)?.[1];
    const doc = { getElementById: (id: string) => (id === INITIAL_DATA_ID ? { textContent: json ?? null } : null) };
    return { html, token, initial: readInitialData(doc as unknown as Document) };
  }

  it('renders the first screen the client would, from data the client reads', async () => {
    const { html, token, initial } = await page();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(initial.view?.rows.map((row) => row.track.id)).toEqual([1, 2, 3]);
    expect(initial.view?.rows[0]?.art).toEqual({
      small: 'https://i.scdn.co/image/s1',
      medium: null,
      large: 'https://i.scdn.co/image/l1',
    });
    expect(initial.view?.rows[1]?.art).toBeNull();
    expect(initial.view?.rows[2]).not.toHaveProperty('art');
    expect(initial.view?.rows[2]?.rating).toEqual({ trackId: 3, stars: 5, opinion: 'Lucid', updatedAt: 1_787_000_400 });
    expect(selectedTrack(initialModel(initial, {}))?.trackName).toBe('Ballade No. 1 in G Minor');
    // The client adopts this markup as it is: it must be exactly its own render.
    const root = /<div id="root">([\s\S]*)<\/div>\s*<script type="application\/json"/.exec(html)?.[1];
    expect(root).toBe(renderApp(initial, 'dark'));
    expect(html).toContain('<html lang="en" data-theme="dark">');
  });

  it('answers the client’s list, rating, reload, and artwork requests', async () => {
    const { token } = await page();
    const deps = httpDeps(token, { fetcher, store: new ArtworkStore(fetcher, 0) });

    const top = await deps.view!({ sort: 'topPlayed', query: '', around: 3, reload: false });
    expect([top.list.count, top.index]).toEqual([3, 1]);
    expect([0, 1, 2].map((i) => top.list.row(i)?.track.id)).toEqual([2, 3, 1]);

    const search = await deps.view!({ sort: 'recentDesc', query: 'ARGERICH', around: 0, reload: false });
    expect(search.list.count).toBe(2);
    expect(search.list.total).toBe(3);

    const saved = await deps.saveRating({ trackId: 1, stars: 4, opinion: 'Poised', updatedAt: 1_787_000_500 });
    expect(saved).toEqual({ trackId: 1, stars: 4, opinion: 'Poised', updatedAt: 1_787_000_500 });
    const reloaded = await deps.view!({ sort: 'unratedFirst', query: '', around: 1, reload: true });
    expect(reloaded.list.row(0)?.track.id).toBe(2);
    expect(reloaded.list.row(reloaded.index ?? -1)?.rating?.stars).toBe(4);

    const art = (await (await fetcher(`${API.artwork}?ids=${sid(1)},${sid(2)}`)).json()) as ArtworkResponse;
    expect(art).toEqual({
      [sid(1)]: { small: 'https://i.scdn.co/image/s1', medium: null, large: 'https://i.scdn.co/image/l1' },
      [sid(2)]: null,
    });
  });

  it('rejects writes without the page’s token, with the error body the client reports', async () => {
    const deps = httpDeps('0'.repeat(32), { fetcher, store: new ArtworkStore(fetcher, 0) });
    await expect(deps.saveRating({ trackId: 1, stars: 3, opinion: '', updatedAt: 1 })).rejects.toThrow(
      'missing or invalid token',
    );
  });
});
