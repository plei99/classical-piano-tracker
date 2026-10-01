import { describe, expect, it } from 'vitest';

import type { Track } from '../core/model';
import { makeModel, startRatingEditor, tracksLoadedMsg, update, type Model, type Msg } from './model';
import { details, hintText, hints, screen, status, trackListSummary } from './presenter';

const tracks: Track[] = [1, 2, 3].map((id) => ({
  id,
  spotifyId: `sp${id}`,
  trackName: `Track ${id}`,
  albumName: `Album ${id}`,
  artists: `["Pianist ${id}"]`,
  playCount: id,
  lastPlayedAt: 100 - id,
  createdAt: 1,
}));

function loaded(fields: Partial<Model> = {}): Model {
  const [model] = update(makeModel({ timeZone: 'utc', ...fields }), tracksLoadedMsg(tracks, []));
  return model;
}

const run = (model: Model, ...msgs: Msg[]) => msgs.reduce((m, msg) => update(m, msg)[0], model);

describe('pointer messages', () => {
  it('select moves to a track by id and ignores unknown ids', () => {
    expect(run(loaded(), { type: 'select', trackId: 3 }).selectedIndex).toBe(2);
    const model = loaded();
    expect(run(model, { type: 'select', trackId: 99 })).toBe(model);
  });

  it('select is ignored while busy or editing, like the movement keys', () => {
    for (const fields of [{ syncing: true }, { savingRating: true }]) {
      expect(run(loaded(fields), { type: 'select', trackId: 2 }).selectedIndex).toBe(0);
    }
    expect(run(startRatingEditor(loaded()), { type: 'select', trackId: 2 }).selectedIndex).toBe(0);
  });

  it('setSearch filters and keeps the selection when it still matches', () => {
    const model = run(loaded(), { type: 'select', trackId: 2 }, { type: 'setSearch', query: 'track 2' });
    expect(model.tracks.map((t) => t.id)).toEqual([2]);
    expect(model.selectedIndex).toBe(0);
    expect(trackListSummary(model)).toBe('1/3 shown · sort: recent');
  });

  it('editor fields only change while editing, with stars bounded to 0-5', () => {
    expect(run(loaded(), { type: 'setDraftStars', stars: 3 }).draftStars).toBe(0);
    const editing = startRatingEditor(loaded());
    expect(run(editing, { type: 'setDraftStars', stars: 4 }).draftStars).toBe(4);
    expect(run(editing, { type: 'setDraftStars', stars: 6 }).draftStars).toBe(0);
    const typed = run(editing, { type: 'setDraftOpinion', text: 'Op. 9' });
    expect(typed.draftOpinion).toBe('Op. 9');
    expect(typed.editingOpinion).toBe(true);
    expect(run(typed, { type: 'focusField', field: 'stars' }).editingOpinion).toBe(false);
  });
});

describe('presenter', () => {
  it('hint sets follow the mode and print as the TUI does', () => {
    expect(hints(loaded()).map(hintText)).toEqual([
      'j/k or arrows: move',
      'g/G: top/bottom',
      'o: sort',
      's: sync',
      'enter/e: rate',
      'r: reload',
      'q: quit',
    ]);
    expect(hints(loaded()).find((hint) => hint.label === 'quit')?.terminalOnly).toBe(true);
    expect(hints(startRatingEditor(loaded())).map((hint) => hint.keys)).toEqual([
      '1-5',
      'tab',
      'ctrl+u',
      'enter',
      'esc',
    ]);
    expect(hints(loaded({ searching: true }))[0]?.keys).toBe('type');
  });

  it('screens and status lines', () => {
    expect(screen(makeModel({ loadingTracks: true }))).toBe('loading');
    expect(screen(makeModel({ err: new Error('x') }))).toBe('error');
    expect(screen(makeModel())).toBe('empty');
    expect(screen(run(loaded(), { type: 'setSearch', query: 'zzz' }))).toBe('noMatch');
    expect(screen(loaded())).toBe('browse');
    expect(status(loaded())).toBeNull();
    expect(status(loaded({ syncing: true }))).toEqual({ text: 'Syncing with Spotify...', isError: false });
    expect(status(loaded({ statusMessage: 'bad', statusIsError: true }))).toEqual({
      text: 'Error: bad',
      isError: true,
    });
  });

  it('details list the TUI fields in order', () => {
    const shown = details(loaded());
    expect(shown?.artists).toBe('Pianist 1');
    expect(shown?.fields.map(({ label }) => label)).toEqual(['ID', 'Spotify ID', 'Album', 'Play Count', 'Last Played']);
    expect(shown?.fields.at(-1)?.value).toBe('1970-01-01T00:01:39Z');
    expect(shown?.rating).toBeNull();
    expect(details(loaded({ savingRating: true }))?.rating).toBe('saving');
  });
});
