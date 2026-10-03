/**
 * Explicit opt-in only: these tests use CLI account quota, but never read the
 * user's tracker database/config or contact Spotify. A normal test run is
 * offline. Set TRACKER_TEST_LIVE_CLI=codex or claude_cli to exercise an
 * authenticated CLI (and optionally TRACKER_TEST_CLI_MODEL).
 */
import { describe, expect, it } from 'vitest';
import type { TasteSummary } from '../../recommend';
import { Client, type Provider } from '..';
import { ClaudeCLIProvider } from './claudecli';
import { CodexProvider } from './codex';

const live = process.env['TRACKER_TEST_LIVE_CLI'] ?? '';
const model = process.env['TRACKER_TEST_CLI_MODEL'] ?? '';

function liveProvider(): Provider {
  switch (live) {
    case 'codex':
      return new CodexProvider(model, '');
    case 'claude_cli':
      return new ClaudeCLIProvider(model, '');
    default:
      throw new Error('unknown TRACKER_TEST_LIVE_CLI');
  }
}

const summary: TasteSummary = {
  totalTracks: 3,
  totalRatings: 3,
  commentCount: 1,
  favoritePianists: [{ name: 'Murray Perahia', trackCount: 3, ratedTrackCount: 3, averageStars: 5, totalPlayCount: 3 }],
  lovedTracks: [],
  dislikedTracks: [],
  commentedTracks: [
    {
      trackId: 0,
      trackName: 'Goldberg Variations',
      albumName: '',
      artists: ['Murray Perahia'],
      playCount: 0,
      lastPlayedAt: 0,
      stars: 5,
      opinion: 'Clear counterpoint and warm tone.',
      matchedArtist: '',
    },
  ],
  knownPianists: ['Murray Perahia'],
  discoveryGuidance: '',
};

describe.skipIf(live === '')('live CLI', () => {
  it('summarizes taste', { timeout: 2 * 60_000 }, async () => {
    const text = await new Client(liveProvider()).summarizeTaste(summary, AbortSignal.timeout(2 * 60_000));
    expect(text.trim()).not.toBe('');
  });

  it('suggests pianists', { timeout: 3 * 60_000 }, async () => {
    const result = await new Client(liveProvider()).suggestNewPianists(summary, 5, AbortSignal.timeout(3 * 60_000));
    expect(result.recommendations).toHaveLength(5);
  });
});
