/**
 * The CLI's orchestration of the spotify, recommend, llm, and tui modules,
 * checked against stand-ins for those modules: which arguments each call
 * receives, what is printed, and what is persisted. The modules' own
 * behavior is covered by their tests (and by the needs:* tests elsewhere).
 */
import { existsSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type Config, type Token, emptyConfig, formatGoTime, loadConfig, saveConfig } from '../core/config';
import { Db } from '../core/db';
import type { SyncStats } from '../core/model';
import type { PianistProfile, SuggestedPianist, TasteSummary, ValidatedPianist } from '../recommend';
import type { RecentTrack } from '../spotify';
import type { Deps } from '../tui';
import { run, tempPath } from './testutil';
import { newTuiDeps } from './tui_cmd';

const state = vi.hoisted(() => ({
  clients: [] as { spotify: unknown; persist: (token: Token) => void | Promise<void> }[],
  recent: [] as RecentTrack[],
  recentLimits: [] as number[],
  syncCalls: [] as { cfg: Config; limit: number; db: Db }[],
  refreshedToken: null as Token | null,
  loginToken: null as Token | null,
  profiles: [] as PianistProfile[],
  suggestCalls: [] as number[],
  validateCalls: [] as { searcher: unknown; known: string[]; suggestions: SuggestedPianist[]; limit: number }[],
  validated: [] as ValidatedPianist[],
  tuiDeps: null as Deps | null,
  tuiError: null as Error | null,
}));

vi.mock('../spotify', () => {
  class Client {
    constructor(spotify: unknown, persist: (token: Token) => void | Promise<void>) {
      state.clients.push({ spotify, persist });
    }

    async recentTracks(limit: number): Promise<RecentTrack[]> {
      state.recentLimits.push(limit);
      return state.recent;
    }

    async searchArtists(): Promise<never[]> {
      return [];
    }
  }
  return {
    DEFAULT_REDIRECT_URL: 'http://127.0.0.1:8000/api/auth/spotify/callback',
    Client,
    login: async (_spotify: unknown, presentUrl: (url: string) => void) => {
      presentUrl('https://accounts.spotify.com/authorize?x=1');
      return state.loginToken;
    },
    runSync: async (cfg: Config, client: unknown, db: Db, limit: number): Promise<SyncStats> => {
      expect(client).toBeInstanceOf(Client);
      state.syncCalls.push({ cfg, limit, db });
      if (state.refreshedToken !== null) {
        await state.clients.at(-1)?.persist(state.refreshedToken);
      }
      return { fetched: 7, alreadySynced: 1, blocked: 2, skipped: 1, accepted: 3, inserted: 2, updated: 1 };
    },
  };
});

const summary: TasteSummary = {
  totalTracks: 3,
  totalRatings: 3,
  commentCount: 0,
  favoritePianists: [],
  lovedTracks: [],
  dislikedTracks: [],
  commentedTracks: [],
  knownPianists: ['Martha Argerich'],
  discoveryGuidance: '',
};

vi.mock('../recommend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../recommend')>()),
  buildPianistProfiles: () => state.profiles,
  buildTasteSummary: () => summary,
  validateDiscoveryInput: () => {},
  validateSuggestedPianists: async (
    searcher: unknown,
    known: string[],
    suggestions: SuggestedPianist[],
    limit: number,
  ) => {
    state.validateCalls.push({ searcher, known, suggestions, limit });
    return state.validated;
  },
}));

vi.mock('../llm', () => ({
  Client: class {
    constructor(readonly provider: unknown) {
      expect(provider).toEqual({ fake: 'provider' });
    }

    async suggestNewPianists(_summary: TasteSummary, limit: number) {
      state.suggestCalls.push(limit);
      return {
        summary: 'Fire and poetry.',
        recommendations: [{ pianistName: 'Radu Lupu', whyFit: 'Poetry.', similarTo: [], confidence: 'high' }],
      };
    }

    async summarizeTaste() {
      return '  You   like\nclarity.  ';
    }
  },
}));

vi.mock('../llm/providers', () => ({
  fromConfig: () => ({ fake: 'provider' }),
  claudeCliModels: () => ['sonnet'],
}));

vi.mock('../tui', () => ({
  runTui: async (deps: Deps) => {
    state.tuiDeps = deps;
    if (state.tuiError !== null) {
      throw state.tuiError;
    }
    await deps.load();
  },
}));

function token(overrides: Partial<Token> = {}): Token {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    tokenType: 'Bearer',
    expiry: formatGoTime(Date.now() + 3_600_000),
    ...overrides,
  };
}

function loggedInConfig(path: string): Config {
  const cfg = emptyConfig();
  cfg.spotify = { clientId: 'client-id', clientSecret: 'client-secret', token: token() };
  cfg.pianistsAllowlist = ['Martha Argerich'];
  saveConfig(path, cfg);
  return cfg;
}

function validated(name: string): ValidatedPianist {
  return {
    pianistName: name,
    whyFit: `Because ${name}.`,
    similarTo: [],
    confidence: '',
    spotifyName: name,
    spotifyId: `id-${name}`,
    popularity: 0,
    genres: [],
  };
}

beforeEach(() => {
  state.clients = [];
  state.recent = [];
  state.recentLimits = [];
  state.syncCalls = [];
  state.refreshedToken = null;
  state.loginToken = null;
  state.profiles = [];
  state.suggestCalls = [];
  state.validateCalls = [];
  state.validated = [];
  state.tuiDeps = null;
  state.tuiError = null;
  vi.stubEnv('COLUMNS', '');
});

describe('sync and spotify wiring', () => {
  it('sync prints stats and persists refreshed tokens merged into the config', async () => {
    const configPath = tempPath('config.json');
    const dbPath = tempPath('tracker.db');
    const original = loggedInConfig(configPath);
    state.refreshedToken = token({ accessToken: 'new-access', refreshToken: '' });

    const { code, stdout, stderr } = await run(['--config', configPath, '--db', dbPath, 'sync', '--limit', '25']);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toBe(
      `database: ${dbPath}\nfetched: 7\nalready_synced: 1\nblocked: 2\nskipped: 1\naccepted: 3\ninserted: 2\nupdated: 1\n`,
    );
    expect(state.syncCalls).toHaveLength(1);
    expect(state.syncCalls[0]?.limit).toBe(25);
    expect(state.clients[0]?.spotify).toEqual(original.spotify);

    const saved = loadConfig(configPath).spotify.token;
    expect(saved?.accessToken).toBe('new-access');
    expect(saved?.refreshToken).toBe('refresh-token');
  });

  it('spotify recent prints plays in UTC, or the empty state', async () => {
    const configPath = tempPath('config.json');
    loggedInConfig(configPath);

    expect((await run(['--config', configPath, 'spotify', 'recent'])).stdout).toBe(
      'no recent Spotify plays returned\n',
    );
    expect(state.recentLimits).toEqual([50]);

    state.recent = [
      {
        spotifyId: 'sp',
        name: 'Scarbo',
        albumName: 'Ravel',
        artists: [
          { id: 'a', name: 'Martha Argerich' },
          { id: 'b', name: 'Friend' },
        ],
        durationMs: 1,
        playedAt: new Date(Date.UTC(2026, 3, 1, 23, 59, 58)),
        playedAtNs: 0n,
      },
    ];
    const { stdout } = await run(['--config', configPath, 'spotify', 'recent', '--limit', '3']);
    expect(stdout).toBe(
      '1. Scarbo\n   Artists: Martha Argerich, Friend\n   Album:   Ravel\n   Played:  2026-04-01 23:59:58\n',
    );
    expect(state.recentLimits).toEqual([50, 3]);
  });

  it('spotify login presents the URL and saves the merged token', async () => {
    const configPath = tempPath('config.json');
    const quoted = JSON.stringify(configPath);
    expect((await run(['--config', configPath, 'spotify', 'login'])).stderr).toBe(
      `created default config at ${quoted}; set spotify.client_id and spotify.client_secret, ` +
        `then rerun \`tracker --config ${quoted} spotify login\`\n`,
    );

    loggedInConfig(configPath);
    state.loginToken = token({ accessToken: 'fresh', refreshToken: '' });
    const { code, stdout } = await run(['--config', configPath, 'spotify', 'login']);
    expect(code).toBe(0);
    expect(stdout).toBe(
      'Open this URL in your browser:\nhttps://accounts.spotify.com/authorize?x=1\n\n' +
        'Waiting for the Spotify callback at http://127.0.0.1:8000/api/auth/spotify/callback\n' +
        `spotify login succeeded: token saved to ${configPath}\n`,
    );
    const saved = loadConfig(configPath).spotify.token;
    expect(saved?.accessToken).toBe('fresh');
    expect(saved?.refreshToken).toBe('refresh-token');
  });
});

describe('recommend wiring', () => {
  it('favorites prints at most --limit rows', async () => {
    const configPath = tempPath('config.json');
    loggedInConfig(configPath);
    const profile = (name: string, score: number): PianistProfile => ({
      name,
      trackCount: 1,
      ratedTrackCount: 1,
      totalPlayCount: 3,
      averageStars: 4.5,
      favoriteScore: score,
    });
    state.profiles = [profile('Martha Argerich', 91.255), profile('Yuja Wang', 80), profile('Radu Lupu', 10)];

    const { stdout } = await run([
      '--config',
      configPath,
      '--db',
      tempPath('tracker.db'),
      'recommend',
      'favorites',
      '--limit',
      '2',
    ]);
    expect(stdout).toBe(
      '#  Pianist          Score  Avg Stars  Rated Tracks  Total Plays\n' +
        '1  Martha Argerich  91.25  4.50       1             3\n' +
        '2  Yuja Wang        80.00  4.50       1             3\n',
    );
  });

  it('pianists requests headroom, validates through Spotify, and truncates', async () => {
    const configPath = tempPath('config.json');
    loggedInConfig(configPath);
    const args = ['--config', configPath, '--db', tempPath('tracker.db'), 'recommend', 'pianists'];

    const empty = await run(args);
    expect(empty.stdout).toBe('Summary: Fire and poetry.\nNo validated pianist recommendations were found.\n');
    expect(state.suggestCalls).toEqual([10]);
    expect(state.validateCalls[0]?.limit).toBe(5);
    expect(state.validateCalls[0]?.known).toEqual(['Martha Argerich']);
    expect(state.validateCalls[0]?.suggestions.map((s) => s.pianistName)).toEqual(['Radu Lupu']);
    expect(state.clients).toHaveLength(1);

    state.validated = [validated('A'), validated('B'), validated('C')];
    const { stdout } = await run([...args, '--limit', '2']);
    expect(state.suggestCalls).toEqual([10, 10]);
    expect(stdout).toBe(
      'Summary: Fire and poetry.\n\n1. A\n   Spotify ID: id-A\n   Why:        Because A.\n\n' +
        '2. B\n   Spotify ID: id-B\n   Why:        Because B.\n',
    );
  });

  it('summary prints the wrapped LLM text', async () => {
    const configPath = tempPath('config.json');
    loggedInConfig(configPath);
    const { stdout } = await run(['--config', configPath, '--db', tempPath('tracker.db'), 'recommend', 'summary']);
    expect(stdout).toBe('Summary: You like clarity.\n');
    expect(state.clients).toHaveLength(0);
  });
});

describe('tui wiring', () => {
  it('opens the database and hands deferred callbacks to the TUI', async () => {
    const configPath = tempPath('config.json');
    const dbPath = tempPath('tracker.db');
    const { code } = await run(['--config', configPath, '--db', dbPath, 'tui']);
    expect(code).toBe(0);
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(configPath)).toBe(false);
    expect(Object.keys(state.tuiDeps ?? {}).sort()).toEqual(['load', 'saveRating', 'sync']);
  });

  it('syncs through the CLI path with a limit of 50', async () => {
    const configPath = tempPath('config.json');
    loggedInConfig(configPath);
    const db = Db.openInMemory();
    const stats = await newTuiDeps(configPath, db).sync();
    expect(stats.fetched).toBe(7);
    expect(state.syncCalls.at(-1)?.limit).toBe(50);
    expect(state.syncCalls.at(-1)?.db).toBe(db);
    db.close();
  });

  it('wraps TUI failures', async () => {
    state.tuiError = new Error('boom');
    const { code, stderr } = await run(['--db', tempPath('tracker.db'), '--config', tempPath('c.json'), 'tui']);
    expect(code).toBe(1);
    expect(stderr).toBe('run tracker TUI: boom\n');
  });
});
