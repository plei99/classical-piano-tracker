import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { type Config, emptyConfig, emptyProfile, formatGoTime, saveConfig } from '../core/config';
import { Db } from '../core/db';
import type { Track } from '../core/model';
import { discoveryRequestLimit, discoverySearchLimit } from './recommend_cmd';
import { run, saveTestConfig, tempPath } from './testutil';

function testRecommendationConfig(openAiKey: string): Config {
  const cfg = emptyConfig();
  cfg.spotify = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    token: {
      accessToken: 'access-token',
      refreshToken: '',
      tokenType: 'Bearer',
      expiry: formatGoTime(Date.now() + 3_600_000),
    },
  };
  cfg.llm = {
    activeProfile: 'openai',
    profiles: { openai: emptyProfile({ provider: 'openai', model: 'gpt-5.4', apiKey: openAiKey }) },
  };
  cfg.pianistsAllowlist = ['Martha Argerich'];
  return cfg;
}

function saveTrackWithRating(
  db: Db,
  spotifyId: string,
  trackName: string,
  albumName: string,
  artists: string,
  stars: number,
  opinion: string,
): Track {
  const now = Math.floor(Date.now() / 1000);
  const track = db.upsertTrack({ spotifyId, trackName, albumName, artists, lastPlayedAt: now });
  db.upsertRating({ trackId: track.id, stars, opinion, updatedAt: now });
  return track;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('recommend', () => {
  // Go: TestRecommendFavoritesPrintsEmptyState
  it('favorites prints the empty state', async () => {
    const configPath = tempPath('config.json');
    saveTestConfig(configPath, ['Martha Argerich']);
    const dbPath = tempPath('tracker.db');

    const { code, stdout } = await run(['--config', configPath, '--db', dbPath, 'recommend', 'favorites']);
    expect(code).toBe(0);
    expect(stdout).toContain('no favorite pianists could be derived');
  });

  // Go: TestRecommendPianistsRejectsSparseRatingsWithActionableMessage
  it('pianists rejects sparse ratings with an actionable message', async () => {
    const configPath = tempPath('config.json');
    saveConfig(configPath, testRecommendationConfig(''));
    const dbPath = tempPath('tracker.db');
    const db = Db.open(dbPath);
    saveTrackWithRating(db, 'track-1', 'Track One', 'Album One', '["Martha Argerich"]', 5, 'Excellent');
    db.close();

    const { code, stderr } = await run(['--config', configPath, '--db', dbPath, 'recommend', 'pianists']);
    expect(code).toBe(1);
    expect(stderr).toContain('not enough local rating data for pianist recommendations yet');
  });

  // Go: TestRecommendPianistsRequiresOpenAIKeyAfterDataCheck
  it('pianists requires an OpenAI key after the data check', async () => {
    const configPath = tempPath('config.json');
    saveConfig(configPath, testRecommendationConfig(''));
    const dbPath = tempPath('tracker.db');
    const db = Db.open(dbPath);
    for (const spotifyId of ['track-1', 'track-2', 'track-3']) {
      saveTrackWithRating(db, spotifyId, 'Track', 'Album', '["Martha Argerich"]', 5, 'Excellent');
    }
    db.close();
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('LLM_PROFILE', '');
    vi.stubEnv('LLM_PROVIDER', '');
    vi.stubEnv('LLM_MODEL', '');

    const { code, stderr } = await run(['--config', configPath, '--db', dbPath, 'recommend', 'pianists']);
    expect(code).toBe(1);
    expect(stderr).toContain('API key is required');
  });

  // Go: TestRecommendProfilePrintsLocalTasteSummary
  it('profile prints the local taste summary', async () => {
    const configPath = tempPath('config.json');
    saveTestConfig(configPath, ['Martha Argerich']);
    const dbPath = tempPath('tracker.db');
    const db = Db.open(dbPath);
    const track = saveTrackWithRating(db, 'track-1', 'Scarbo', 'Ravel', '["Martha Argerich"]', 5, 'Electrifying.');
    db.close();

    const { code, stdout } = await run(['--config', configPath, '--db', dbPath, 'recommend', 'profile']);
    expect(code).toBe(0);
    for (const want of [
      'Tracks: 1',
      'Ratings: 1',
      'Comments: 1',
      'Favorite Pianists',
      'Martha Argerich',
      'Loved Tracks',
      '[1] Scarbo',
      'Matched: Martha Argerich',
      'Opinion: Electrifying.',
      'Known Pianists: Martha Argerich',
    ]) {
      expect(stdout).toContain(want);
    }
    expect(stdout).not.toContain('Discovery Guidance:');
    expect(track.id).toBe(1);
  });

  // Go: TestRecommendSummaryUsesLLMProviderWithoutSpotifyValidation
  it('summary uses the LLM provider without Spotify validation', async () => {
    const server: Server = createServer((req, res) => {
      expect(req.url).toBe('/v1/chat/completions');
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: 'You like high-voltage clarity and sharply voiced modern repertoire.',
                }),
              },
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const configPath = tempPath('config.json');
      const cfg = emptyConfig();
      cfg.spotify.clientId = 'client-id';
      cfg.spotify.clientSecret = 'client-secret';
      cfg.llm = {
        activeProfile: 'test',
        profiles: {
          test: emptyProfile({
            provider: 'openai_compat',
            model: 'test-model',
            baseUrl: `http://127.0.0.1:${port}/v1`,
          }),
        },
      };
      cfg.pianistsAllowlist = ['Martha Argerich'];
      saveConfig(configPath, cfg);

      const dbPath = tempPath('tracker.db');
      const db = Db.open(dbPath);
      saveTrackWithRating(db, 'track-1', 'Track One', 'Album One', '["Martha Argerich"]', 5, 'Brilliant.');
      saveTrackWithRating(db, 'track-2', 'Track Two', 'Album Two', '["Martha Argerich"]', 4, 'Clear.');
      saveTrackWithRating(db, 'track-3', 'Track Three', 'Album Three', '["Martha Argerich"]', 5, 'Incisive.');
      db.close();

      const { code, stdout, stderr } = await run(['--config', configPath, '--db', dbPath, 'recommend', 'summary']);
      expect(stderr).toBe('');
      expect(code).toBe(0);
      expect(stdout).toContain('Summary: You like high-voltage clarity and sharply voiced modern repertoire.');
    } finally {
      server.close();
    }
  });

  // Go: TestDiscoveryRequestLimitOverRequestsForValidationHeadroom
  it('over-requests discovery suggestions for validation headroom', () => {
    for (const [limit, want] of [
      [1, 10],
      [5, 10],
      [7, 14],
      [10, 20],
    ] as const) {
      expect(discoveryRequestLimit(limit), String(limit)).toBe(want);
    }
    expect([1, 4, 5, 9].map(discoverySearchLimit)).toEqual([5, 5, 5, 9]);
  });

  it('validates limits and the allowlist before loading data', async () => {
    const configPath = tempPath('config.json');
    saveTestConfig(configPath, []);
    const dbPath = tempPath('tracker.db');
    const quoted = JSON.stringify(configPath);
    const cases: [string[], string][] = [
      [['recommend', 'favorites', '--limit', '0'], 'limit must be at least 1, got 0'],
      [['recommend', 'pianists', '--limit', '-2'], 'limit must be at least 1, got -2'],
      [['recommend', 'favorites'], 'config has an empty pianists_allowlist'],
      [['recommend', 'profile'], 'config has an empty pianists_allowlist'],
      [['recommend', 'summary'], 'config has an empty pianists_allowlist'],
      [['recommend', 'pianists'], `config ${quoted} has an empty pianists_allowlist`],
    ];
    for (const [args, message] of cases) {
      const result = await run(['--config', configPath, '--db', dbPath, ...args]);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.stderr, args.join(' ')).toBe(`${message}\n`);
    }
  });

  it('pianists explains first-run setup and requires a login', async () => {
    const configPath = tempPath('config.json');
    const dbPath = tempPath('tracker.db');
    const quoted = JSON.stringify(configPath);
    const args = ['--config', configPath, '--db', dbPath, 'recommend', 'pianists'];

    expect((await run(args)).stderr).toBe(
      `created default config at ${quoted}; set spotify.client_id and spotify.client_secret, ` +
        `run \`tracker --config ${quoted} spotify login\`, then rerun this command\n`,
    );
    saveTestConfig(configPath, ['Martha Argerich']);
    expect((await run(args)).stderr).toBe(`spotify login required for ${quoted}: spotify.token is required\n`);
  });
});
