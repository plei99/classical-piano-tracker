import { describe, expect, it } from 'vitest';

import { emptyConfig, type Config } from '../core/config';
import { Db } from '../core/db';
import { emptySyncStats } from '../core/model';
import type { RecentTrack } from './client';
import { decide, normalizeName, runSync, type TrackSource } from './syncer';
import { dateFromNs, parseRfc3339Ns } from './time';

const BASE_NS = parseRfc3339Ns('2026-04-01T10:00:00Z');
const MINUTE_NS = 60_000_000_000n;

function config(allow: string[], block: string[]): Config {
  return { ...emptyConfig(), pianistsAllowlist: allow, artistsBlocklist: block };
}

function track(spotifyId: string, artists: string[], playedAtNs = BASE_NS): RecentTrack {
  return {
    spotifyId,
    name: `Track ${spotifyId}`,
    albumName: `Album ${spotifyId}`,
    artists: artists.map((name) => ({ id: '', name })),
    durationMs: 0,
    playedAt: dateFromNs(playedAtNs),
    playedAtNs,
  };
}

function source(tracks: RecentTrack[]): TrackSource {
  return { recentTracks: () => Promise.resolve(tracks) };
}

describe('decide', () => {
  const cfg = config(['Martha Argerich'], ['Yiruma']);
  it.each([
    ['accepts allowlisted artist', ['Martha Argerich'], 'accept'],
    ['blocks blocklisted artist', ['Yiruma', 'Martha Argerich'], 'block'],
    ['skips unknown artist', ['Unknown Pianist'], 'skip'],
    ['matches case-insensitively', ['martha argerich'], 'accept'],
    ['trims stray spaces', ['  Martha Argerich '], 'accept'],
    ['ignores blank names', ['', '  '], 'skip'],
  ] as const)('%s', (_name, artists, want) => {
    expect(decide(cfg, track('t', [...artists]))).toBe(want);
  });

  it('normalizes like Go strings.ToLower(strings.TrimSpace(...))', () => {
    expect(normalizeName('\u0085 ΣΑΣ \t')).toBe('σασ');
    expect(normalizeName('İstanbul')).toBe('istanbul');
    // Go's TrimSpace does not treat a BOM as space.
    expect(normalizeName('﻿A')).toBe('﻿a');
  });
});

describe('runSync', () => {
  it('filters, counts, and stores accepted tracks', async () => {
    const cfg = config(['Martha Argerich', 'Daniil Trifonov'], ['Yiruma']);
    const db = Db.openInMemory();
    // An earlier play makes the second accepted track an update.
    db.upsertTrack({
      spotifyId: 'accepted-update',
      trackName: 'Track accepted-update',
      albumName: 'Album accepted-update',
      artists: '["Daniil Trifonov"]',
      lastPlayedAt: 1_775_037_600 - 3600,
    });

    const stats = await runSync(
      cfg,
      source([
        track('accepted-new', ['Martha Argerich']),
        track('blocked', ['Yiruma']),
        track('skipped', ['Unknown Artist']),
        track('accepted-update', ['Daniil Trifonov']),
      ]),
      db,
      50,
    );
    expect(stats).toEqual({
      fetched: 4,
      alreadySynced: 0,
      blocked: 1,
      skipped: 1,
      accepted: 2,
      inserted: 1,
      updated: 1,
    });

    expect(db.listAllTracks()).toHaveLength(2);
    expect(db.trackBySpotifyId('accepted-new')).toMatchObject({
      artists: '["Martha Argerich"]',
      trackName: 'Track accepted-new',
      albumName: 'Album accepted-new',
      lastPlayedAt: 1_775_037_600,
      playCount: 1,
    });
    expect(db.trackBySpotifyId('accepted-update')?.playCount).toBe(2);
    expect(db.recentPlayCheckpoint()).toBe(BASE_NS);
  });

  it('skips already-synced recent plays', async () => {
    const cfg = config(['Martha Argerich'], []);
    const newer = BASE_NS + 2n * MINUTE_NS;
    const db = Db.openInMemory();
    db.upsertRecentPlayCheckpoint(BASE_NS + MINUTE_NS);
    for (let i = 0; i < 2; i++) {
      db.upsertTrack({
        spotifyId: 'newer',
        trackName: '',
        albumName: '',
        artists: '["Martha Argerich"]',
        lastPlayedAt: 1_775_037_600,
      });
    }

    const stats = await runSync(
      cfg,
      source([track('older', ['Martha Argerich'], BASE_NS), track('newer', ['Martha Argerich'], newer)]),
      db,
      50,
    );
    expect(stats).toEqual({ ...emptySyncStats(), fetched: 2, alreadySynced: 1, accepted: 1, updated: 1 });
    expect(db.trackBySpotifyId('older')).toBeNull();
    expect(db.trackBySpotifyId('newer')?.playCount).toBe(3);
    expect(db.recentPlayCheckpoint()).toBe(newer);
  });

  it('keeps nanosecond precision and never moves the checkpoint backwards', async () => {
    const cfg = config(['Martha Argerich'], []);
    const db = Db.openInMemory();
    db.upsertRecentPlayCheckpoint(BASE_NS);

    let stats = await runSync(cfg, source([track('same', ['Martha Argerich'], BASE_NS)]), db, 50);
    expect(stats.alreadySynced).toBe(1);

    stats = await runSync(cfg, source([track('next', ['Martha Argerich'], BASE_NS + 1n)]), db, 50);
    expect(stats.inserted).toBe(1);
    expect(db.recentPlayCheckpoint()).toBe(BASE_NS + 1n);

    await runSync(cfg, source([track('old', ['Martha Argerich'], BASE_NS - 60n * MINUTE_NS)]), db, 50);
    expect(db.recentPlayCheckpoint()).toBe(BASE_NS + 1n);
  });

  it('advances the checkpoint past filtered plays', async () => {
    const db = Db.openInMemory();
    const stats = await runSync(config(['Martha Argerich'], ['Yiruma']), source([track('b', ['Yiruma'])]), db, 50);
    expect(stats).toEqual({ ...emptySyncStats(), fetched: 1, blocked: 1 });
    expect(db.recentPlayCheckpoint()).toBe(BASE_NS);
  });

  it('returns fetch errors unwrapped and leaves the database untouched', async () => {
    const db = Db.openInMemory();
    const failing: TrackSource = { recentTracks: () => Promise.reject(new Error('spotify is down')) };
    await expect(runSync(config([], []), failing, db, 50)).rejects.toThrow(/^spotify is down$/);
    expect(db.recentPlayCheckpoint()).toBeNull();
  });

  it('passes the limit through to the source', async () => {
    let seen: number | undefined;
    const probe: TrackSource = {
      recentTracks: (limit) => {
        seen = limit;
        return Promise.resolve([]);
      },
    };
    expect(await runSync(config([], []), probe, Db.openInMemory(), 17)).toEqual(emptySyncStats());
    expect(seen).toBe(17);
  });

  it('wraps checkpoint load failures', async () => {
    const db = Db.openInMemory();
    db.close();
    await expect(runSync(config(['A'], []), source([track('x', ['A'])]), db, 50)).rejects.toThrow(
      /^load recent play checkpoint: /,
    );
  });
});
