/** Ports of the Go `internal/tui/app_test.go` suite. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';

import { formatArtists } from '../core/artists';
import { Db } from '../core/db';
import type { Rating, SyncStats, Track } from '../core/model';
import { inkOptions } from './app';
import {
  buildTrackText,
  makeModel,
  newModel,
  refreshTrackList,
  selectedRating,
  selectedTrack,
  startRatingEditor,
  tracksLoadedMsg,
  update,
  type Model,
  type Msg,
} from './model';
import { renderText, specialKey, textKey, typeKeys, typeText } from './testkit';
import { truncate } from './text';
import { footerView, layout, view, visibleTracks } from './view';

function track(fields: Partial<Track> & { id: number }): Track {
  return {
    spotifyId: '',
    trackName: '',
    albumName: '',
    artists: '',
    playCount: 0,
    lastPlayedAt: 0,
    createdAt: 0,
    ...fields,
  };
}

function rating(fields: Partial<Rating> & { trackId: number }): Rating {
  return { stars: 0, opinion: '', updatedAt: 0, ...fields };
}

function ratingsMap(...ratings: Rating[]): Map<number, Rating> {
  return new Map(ratings.map((r) => [r.trackId, r]));
}

function loaded(tracks: Track[], ratings: Map<number, Rating> = new Map()): Msg {
  return { type: 'tracksLoaded', tracks, ratings, trackText: new Map() };
}

const ids = (tracks: readonly Track[]) => tracks.map((t) => t.id);

function footerHasNotificationLine(rendered: string, want: string): boolean {
  const lines = rendered.split('\n');
  return lines.some((line, index) => line.includes(want) && (lines[index + 1] ?? '').includes('j/k or arrows: move'));
}

const stats: SyncStats = {
  fetched: 5,
  blocked: 0,
  skipped: 0,
  accepted: 2,
  inserted: 1,
  updated: 1,
  alreadySynced: 0,
};

describe('update', () => {
  it('selects the first track with its cached rating once tracks load', () => {
    const [got, cmd] = update(
      newModel({}),
      loaded(
        [
          track({ id: 3, trackName: 'Track Three', artists: '["Artist Three"]', lastPlayedAt: 100 }),
          track({ id: 1, trackName: 'Track One', artists: '["Artist One"]', lastPlayedAt: 200 }),
          track({ id: 2, trackName: 'Track Two', artists: '["Artist Two"]', lastPlayedAt: 100 }),
        ],
        ratingsMap(rating({ trackId: 1, stars: 4 })),
      ),
    );
    expect(got.loadingTracks).toBe(false);
    expect(ids(got.tracks)).toEqual([1, 3, 2]);
    expect(selectedRating(got)?.stars).toBe(4);
    expect(cmd).toBeNull();
  });

  it('preserves the selected track across a reload', () => {
    const m = makeModel({ tracks: [track({ id: 7 }), track({ id: 9 })], selectedIndex: 1 });
    const [got, cmd] = update(
      m,
      loaded([
        track({ id: 5, trackName: 'Five', artists: '["Artist Five"]', lastPlayedAt: 300 }),
        track({ id: 9, trackName: 'Nine', artists: '["Artist Nine"]', lastPlayedAt: 200 }),
        track({ id: 7, trackName: 'Seven', artists: '["Artist Seven"]', lastPlayedAt: 100 }),
      ]),
    );
    expect(selectedTrack(got)?.id).toBe(9);
    expect(cmd).toBeNull();
  });

  it('reads the rating from the cache when moving the selection', () => {
    const m = makeModel({
      width: 120,
      height: 28,
      tracks: [
        track({ id: 1, trackName: 'One', artists: '["A"]' }),
        track({ id: 2, trackName: 'Two', artists: '["B"]' }),
      ],
      ratings: ratingsMap(rating({ trackId: 2, stars: 5, updatedAt: 10 })),
    });
    let [got, cmd] = update(m, textKey('j'));
    expect(cmd).toBeNull();
    expect(renderText(got)).toContain('Rating: 5/5');

    [got] = update(got, textKey('k'));
    expect(renderText(got)).toContain('Rating: none');
  });

  it('starts an asynchronous sync on s', async () => {
    const m = { ...newModel({ sync: () => Promise.resolve(stats) }), tracks: [track({ id: 1 })] };
    const [got, cmd] = update(m, textKey('s'));
    expect(got.syncing).toBe(true);
    expect(cmd).not.toBeNull();

    const msg = await cmd!();
    expect(msg.type).toBe('syncFinished');
    if (msg.type === 'syncFinished') {
      expect(msg.stats.fetched).toBe(5);
      expect(msg.err).toBeUndefined();
    }
  });

  it('reloads tracks after a sync finishes', () => {
    const m = makeModel({
      deps: { load: () => Promise.resolve({ tracks: [], ratings: [] }) },
      tracks: [track({ id: 1 })],
      syncing: true,
    });
    const [got, cmd] = update(m, { type: 'syncFinished', stats });
    expect(got.syncing).toBe(false);
    expect(got.loadingTracks).toBe(true);
    expect(footerHasNotificationLine(footerView(got), 'Sync complete.')).toBe(true);
    expect(cmd).not.toBeNull();
  });

  it('reports a failed sync in the status line', () => {
    const m = makeModel({ tracks: [track({ id: 1 })], syncing: true });
    const [got] = update(m, { type: 'syncFinished', stats, err: new Error('bad token') });
    expect(got.syncing).toBe(false);
    expect(got.statusIsError).toBe(true);
    expect(footerHasNotificationLine(footerView(got), 'Error: Sync failed: bad token')).toBe(true);
  });

  it('cycles the sort order with o and keeps the selected track', () => {
    const m = makeModel({
      tracks: [
        track({ id: 10, lastPlayedAt: 300, playCount: 2 }),
        track({ id: 7, lastPlayedAt: 200, playCount: 8 }),
        track({ id: 4, lastPlayedAt: 100, playCount: 1 }),
      ],
      sortMode: 'recentDesc',
      selectedIndex: 1,
    });
    const [got] = update(m, textKey('o'));
    expect(got.sortMode).toBe('idAsc');
    expect(selectedTrack(got)?.id).toBe(7);
    expect(ids(got.tracks)).toEqual([4, 7, 10]);
  });

  it('moves to the top and bottom with g and G', () => {
    const m = makeModel({ tracks: [track({ id: 11 }), track({ id: 22 }), track({ id: 33 })], selectedIndex: 1 });
    let [got, cmd] = update(m, textKey('g'));
    expect(got.selectedIndex).toBe(0);
    expect(selectedTrack(got)?.id).toBe(11);
    expect(cmd).toBeNull();

    [got, cmd] = update(got, textKey('G'));
    expect(got.selectedIndex).toBe(2);
    expect(selectedTrack(got)?.id).toBe(33);
    expect(cmd).toBeNull();
  });
});

const searchTracks = [
  track({
    id: 3,
    trackName: 'Ballade No. 1',
    albumName: 'Chopin',
    artists: '["Martha Argerich"]',
    lastPlayedAt: 300,
  }),
  track({ id: 2, trackName: 'Images', albumName: 'Debussy', artists: '["Seong-Jin Cho"]', lastPlayedAt: 200 }),
  track({ id: 1, trackName: 'Etudes', albumName: 'Ligeti', artists: '["Yuja Wang"]', lastPlayedAt: 100 }),
];

describe('search', () => {
  it('filters tracks, and enter leaves search mode', () => {
    const m = makeModel({ allTracks: searchTracks, tracks: searchTracks });
    let [got] = update(m, textKey('/'));
    expect(got.searching).toBe(true);

    let cmd;
    [got, cmd] = update(got, textKey('yuja'));
    expect(got.searchQuery).toBe('yuja');
    expect(ids(got.tracks)).toEqual([1]);
    expect(selectedTrack(got)?.id).toBe(1);
    expect(cmd).toBeNull();

    [got] = update(got, specialKey('enter'));
    expect(got.searching).toBe(false);
    expect(footerHasNotificationLine(footerView(got), 'Filter /yuja (1/3)')).toBe(true);
  });

  it('esc clears the filter and restores the tracks', () => {
    const m = makeModel({
      searching: true,
      searchQuery: 'yuja',
      allTracks: searchTracks.slice(1),
      tracks: searchTracks.slice(2),
    });
    const [got, cmd] = update(m, specialKey('esc'));
    expect(got.searching).toBe(false);
    expect(got.searchQuery).toBe('');
    expect(got.tracks).toHaveLength(2);
    expect(cmd).toBeNull();
  });

  it('shows a no-match message', () => {
    const m = makeModel({ width: 100, height: 28, searchQuery: 'zzz', allTracks: searchTracks.slice(2) });
    const frame = renderText(m);
    expect(frame).toContain('No tracks match /zzz');
    expect(footerHasNotificationLine(frame, 'Filter /zzz (0/1)')).toBe(true);
  });

  it('matches artists and album, but not across fields', () => {
    const allTracks = [
      track({ id: 1, trackName: 'Etudes', albumName: 'Ligeti', artists: '["Yuja Wang"]', lastPlayedAt: 100 }),
      track({
        id: 2,
        trackName: 'Nocturne',
        albumName: 'Chopin: Nocturnes',
        artists: '["Frédéric Chopin","Víkingur Ólafsson"]',
        lastPlayedAt: 200,
      }),
    ];
    const m = makeModel({ allTracks, trackText: buildTrackText(allTracks) });
    for (const query of ['ólafsson', 'NOCTURNES', 'ligeti']) {
      m.searchQuery = query;
      refreshTrackList(m, 0);
      expect(m.tracks, query).toHaveLength(1);
    }

    m.searchQuery = 'wang ligeti';
    refreshTrackList(m, 0);
    expect(m.tracks).toHaveLength(0);
  });

  it('appends pasted text to the search and the opinion', () => {
    const m = makeModel({ searching: true, allTracks: searchTracks.slice(1).reverse() });
    let [got] = update(m, { type: 'paste', text: 'yuja' });
    expect(got.searchQuery).toBe('yuja');
    expect(ids(got.tracks)).toEqual([1]);

    [got] = update({ ...got, searching: false, editingRating: true }, { type: 'paste', text: 'Op. 111' });
    expect(got.draftOpinion).toBe('Op. 111');
    expect(got.draftStars).toBe(0);
    expect(got.editingOpinion).toBe(true);
  });
});

describe('ratings', () => {
  it('re-sorts unrated-first after a save without touching the previous model', () => {
    const m = makeModel({
      tracks: [track({ id: 4, lastPlayedAt: 300 }), track({ id: 9, lastPlayedAt: 200 })],
      ratings: ratingsMap(rating({ trackId: 9, stars: 2 })),
      sortMode: 'unratedFirst',
      selectedIndex: 0,
    });
    const [got] = update(m, {
      type: 'ratingSaved',
      trackId: 4,
      rating: rating({ trackId: 4, stars: 5, updatedAt: 10 }),
    });
    expect(got.ratings.has(4)).toBe(true);
    expect(selectedTrack(got)?.id).toBe(4);
    expect(ids(got.tracks)).toEqual([4, 9]);
    expect(m.ratings.has(4)).toBe(false);
  });

  it('enter opens the editor with the existing rating', () => {
    const m = makeModel({
      tracks: [track({ id: 1, trackName: 'One', artists: '["A"]' })],
      ratings: ratingsMap(rating({ trackId: 1, stars: 4, opinion: 'Warm' })),
    });
    const [got] = update(m, specialKey('enter'));
    expect(got.editingRating).toBe(true);
    expect(got.draftStars).toBe(4);
    expect(got.draftOpinion).toBe('Warm');
  });

  it('handles editor input and saves asynchronously', async () => {
    const m = {
      ...newModel({ saveRating: (arg) => Promise.resolve({ ...arg }) }),
      tracks: [track({ id: 7, trackName: 'One', artists: '["A"]' })],
    };
    let [got] = update(m, specialKey('enter'));
    expect(got.editingRating).toBe(true);

    [got] = update(got, textKey('5'));
    [got] = update(got, textKey('Great'));
    const [saving, cmd] = update(got, specialKey('enter'));
    expect(saving.editingRating).toBe(false);
    expect(saving.savingRating).toBe(true);
    expect(cmd).not.toBeNull();

    const msg = await cmd!();
    expect(msg).toMatchObject({ type: 'ratingSaved', trackId: 7, rating: { stars: 5, opinion: 'Great' } });
  });

  it('a saved rating updates the selection', () => {
    const m = makeModel({ tracks: [track({ id: 9 })], savingRating: true });
    const [got] = update(m, {
      type: 'ratingSaved',
      trackId: 9,
      rating: rating({ trackId: 9, stars: 3, opinion: 'Good', updatedAt: 10 }),
    });
    expect(got.savingRating).toBe(false);
    expect(selectedRating(got)?.stars).toBe(3);
  });
});

describe('formatArtists', () => {
  it('joins artist names', () => {
    expect(formatArtists('["Martha Argerich","Daniil Trifonov"]')).toBe('Martha Argerich, Daniil Trifonov');
  });

  it('matches JSON decoding', () => {
    const cases = [
      '["Frédéric Chopin","Víkingur Ólafsson"]',
      '["Solo"]',
      '["A",""]',
      '[""]',
      '["Quote \\"Nickname\\" Pianist","B"]',
      String.raw`["Tom \u0026 Jerry"]`,
      '["Spaced", "Out"]',
      '[]',
      'not json',
    ];
    for (const raw of cases) {
      let want = raw;
      try {
        const artists: unknown = JSON.parse(raw);
        if (Array.isArray(artists) && artists.length > 0) {
          want = artists.join(', ');
        }
      } catch {
        // Not JSON: the raw text is shown.
      }
      expect(formatArtists(raw), raw).toBe(want);
    }
  });
});

describe('view', () => {
  it('renders the error state', () => {
    expect(renderText(makeModel({ err: new Error('boom') }))).toContain('Error: boom');
  });

  it('uses the vertical layout for narrow windows', () => {
    const geometry = layout(makeModel({ width: 70, height: 24 }));
    expect(geometry.vertical).toBe(true);
    expect(geometry.listWidth).toBe(geometry.detailWidth);
  });

  it('uses the horizontal layout for wide windows', () => {
    const geometry = layout(makeModel({ width: 140, height: 30 }));
    expect(geometry.vertical).toBe(false);
    expect(geometry.listHeight).toBe(geometry.detailHeight);
  });

  it('centers the selection when scrolling', () => {
    const m = makeModel({ tracks: Array.from({ length: 12 }, () => track({ id: 0 })), selectedIndex: 6 });
    const visible = visibleTracks(m, 11);
    expect(visible.tracks.length).toBeGreaterThan(0);
    expect(visible.offset).not.toBe(0);
    expect(visible.hiddenAbove).toBe(true);
    expect(visible.hiddenBelow).toBe(true);
  });

  it('includes the header and sort indicator', () => {
    const tracks = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((trackName, i) =>
      track({ id: i + 1, trackName, artists: `["${String.fromCharCode(65 + i)}"]`, lastPlayedAt: 100 }),
    );
    const frame = renderText(makeModel({ width: 80, height: 16, allTracks: tracks, tracks }));
    expect(frame).toContain('Local track history');
    expect(frame).toContain('sort: recent');
  });

  it('shows the rating editor', () => {
    const m = makeModel({
      width: 120,
      height: 28,
      tracks: [track({ id: 1, trackName: 'One', artists: '["A"]' })],
      editingRating: true,
      draftStars: 5,
      draftOpinion: 'Very good',
    });
    const frame = renderText(m);
    expect(frame).toContain('Rating Editor');
    expect(frame).toContain('Stars: 5/5');
  });

  it('shows which editor field has focus', () => {
    let m = startRatingEditor(
      makeModel({ width: 120, height: 28, tracks: [track({ id: 1, trackName: 'One', artists: '["A"]' })] }),
    );
    m = { ...m, draftOpinion: 'Op. 10' };
    let frame = renderText(m);
    expect(frame).toContain('> Stars: not set');
    expect(frame).not.toContain('Op. 10_');

    m = typeText(m, '4');
    frame = renderText(m);
    expect(frame).toContain('> Opinion:');
    expect(frame).toContain('Stars: 4/5');
    expect(frame).toContain('Op. 10_');
  });

  it('fits a small window with a status footer', () => {
    const m = makeModel({
      width: 92,
      height: 30,
      tracks: [
        track({
          id: 49,
          spotifyId: '4WlRUx1NuFSR1Oc7ksBBIm',
          trackName: 'Transcendental Etudes, S. 139: No. 4, Mazeppa - Live',
          artists: '["Franz Liszt","Yunchan Lim"]',
          albumName: 'Live from The Cliburn - Liszt: Transcendental Etudes',
          playCount: 1,
          lastPlayedAt: 1780000000000000000,
        }),
      ],
      statusMessage: 'Sync complete. fetched=10 accepted=10 inserted=0 updated=10',
    });
    expect(view(m).height).toBeLessThanOrEqual(m.height);
    expect(renderText(m).split('\n').length).toBeLessThanOrEqual(m.height);
  });

  it('requests the alternate screen', () => {
    expect(inkOptions().alternateScreen).toBe(true);
  });
});

describe('rating editor focus', () => {
  /** A model with the editor open on a fresh track. */
  function openRatingEditor(): Model {
    const [got] = update(
      makeModel({ tracks: [track({ id: 1, trackName: 'One', artists: '["A"]' })] }),
      specialKey('enter'),
    );
    expect(got.editingRating).toBe(true);
    expect(got.editingOpinion).toBe(false);
    return got;
  }

  it('treats digits as opinion text once stars are set', () => {
    let got = typeText(openRatingEditor(), '5');
    expect(got.draftStars).toBe(5);
    expect(got.editingOpinion).toBe(true);

    got = typeText(got, 'Op. 25 No. 1');
    expect(got.draftOpinion).toBe('Op. 25 No. 1');
    expect(got.draftStars).toBe(5);
  });

  it('starts the opinion when text is typed on the stars field', () => {
    const got = typeText(openRatingEditor(), '7th');
    expect(got.draftStars).toBe(0);
    expect(got.draftOpinion).toBe('7th');
    expect(got.editingOpinion).toBe(true);
  });

  it('switches fields with tab and shift+tab', () => {
    let got = typeText(openRatingEditor(), '4Lovely');
    got = typeKeys(got, specialKey('shift+tab'));
    expect(got.editingOpinion).toBe(false);

    got = typeText(got, '2');
    expect(got.draftStars).toBe(2);
    expect(got.draftOpinion).toBe('Lovely');
    expect(got.editingOpinion).toBe(true);

    got = typeKeys(got, specialKey('tab'));
    expect(got.editingOpinion).toBe(false);
  });

  it('backspace edits the focused field', () => {
    let got = typeText(openRatingEditor(), '3ab');
    got = typeKeys(got, specialKey('backspace'));
    expect(got.draftOpinion).toBe('a');
    expect(got.draftStars).toBe(3);

    got = typeKeys(got, specialKey('tab'), specialKey('backspace'));
    expect(got.draftStars).toBe(0);
    expect(got.draftOpinion).toBe('a');
  });
});

describe('loading', () => {
  it('returns ratings keyed by track ID from the DB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracker-tui-'));
    const db = Db.open(join(dir, 'tracker.db'));
    try {
      const saved = db.upsertTrack({
        spotifyId: 'sp-1',
        trackName: 'One',
        albumName: 'Album',
        artists: '["A"]',
        lastPlayedAt: 100,
      });
      db.upsertRating({ trackId: saved.id, stars: 4, opinion: 'Warm', updatedAt: 10 });

      const m = makeModel({
        deps: { load: () => Promise.resolve({ tracks: db.listAllTracks(), ratings: db.listAllRatings() }) },
      });
      const [, cmd] = update(m, textKey('r'));
      const msg = await cmd!();
      expect(msg.type).toBe('tracksLoaded');
      if (msg.type === 'tracksLoaded') {
        expect(msg.err).toBeUndefined();
        expect(msg.tracks).toHaveLength(1);
        expect(msg.ratings.get(saved.id)).toMatchObject({ stars: 4, opinion: 'Warm' });
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('text', () => {
  it('truncate keeps UTF-8 intact', () => {
    const got = truncate('Víkingur Ólafsson, Frédéric Chopin', 12);
    expect(got.isWellFormed()).toBe(true);
    expect(stringWidth(got)).toBe(12);
    expect(got.endsWith('...')).toBe(true);
  });
});

describe('frames fit the window', () => {
  const tracks = Array.from({ length: 40 }, (_, i) =>
    track({
      id: i + 1,
      trackName: `Piano Sonata No. ${i} in B-flat minor, Op. 35`,
      artists: '["Frédéric Chopin","Martha Argerich"]',
      lastPlayedAt: 1000 - i,
    }),
  );
  const base = update(newModel({}), tracksLoadedMsg(tracks, []))[0];

  const states: Record<string, (m: Model) => Model> = {
    browsing: (m) => m,
    editing: (m) => ({ ...startRatingEditor(m), draftOpinion: 'lyrical '.repeat(40) }),
    searching: (m) => ({ ...m, searching: true }),
    'long error': (m) => ({
      ...m,
      statusMessage: 'Sync failed: ' + 'spotify: HTTP 503 upstream unavailable '.repeat(6),
      statusIsError: true,
    }),
  };

  // Every frame must fit the window, at every scroll position, with the key
  // help on its last lines.
  for (const [name, setup] of Object.entries(states)) {
    it(name, () => {
      for (const width of [50, 60, 80, 89, 90, 100, 120, 160]) {
        for (const height of [16, 20, 24, 30, 48]) {
          for (const selectedIndex of [0, 1, 7, 20, 38, 39]) {
            const m = setup({ ...base, width, height, selectedIndex });
            const size = `${name} ${width}x${height} sel=${selectedIndex}`;
            const frame = renderText(m);
            const lines = frame.split('\n');
            expect(view(m).height, size).toBeLessThanOrEqual(height);
            expect(lines.length, size).toBeLessThanOrEqual(height);
            for (const line of lines) {
              expect(stringWidth(line), `${size}: ${line}`).toBeLessThanOrEqual(width);
            }
            const footerLines = stripVTControlCharacters(footerView(m)).split('\n');
            const lastHint = (footerLines[footerLines.length - 1] ?? '').trim();
            expect(frame, size).toContain(lastHint);
          }
        }
      }
    });
  }

  it('visible tracks leave room for scroll hints', () => {
    const m = makeModel({ tracks: Array.from({ length: 30 }, () => track({ id: 0 })) });
    for (let height = 5; height <= 40; height++) {
      for (let selectedIndex = 0; selectedIndex < m.tracks.length; selectedIndex++) {
        const visible = visibleTracks({ ...m, selectedIndex }, height);
        const lines = 3 + 2 * visible.tracks.length + Number(visible.hiddenAbove) + Number(visible.hiddenBelow);
        expect(lines, `height=${height} selected=${selectedIndex}`).toBeLessThanOrEqual(Math.max(height, 3 + 2 + 2));
      }
    }
  });

  it('drops the body when the window has no room for it', () => {
    const one = [track({ id: 1, trackName: 'One', artists: '["A"]', lastPlayedAt: 1 })];
    const m = { ...update(newModel({}), tracksLoadedMsg(one, []))[0], width: 30, height: 10 };
    const frame = renderText(m);
    expect(view(m).height).toBeLessThanOrEqual(m.height);
    expect(frame.split('\n').length).toBeLessThanOrEqual(m.height);
    expect(frame).toContain('q: quit');
  });

  it('wraps the footer hints to the width, keeping each hint whole', () => {
    const footer = footerView(makeModel({ width: 50 }));
    for (const line of footer.split('\n')) {
      expect(stringWidth(line), line).toBeLessThanOrEqual(48);
    }
    expect(footer).toContain('j/k or arrows: move');
    expect(footer).toContain('q: quit');
  });
});
