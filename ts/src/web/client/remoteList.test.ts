import { describe, expect, it } from 'vitest';

import type { ListChunk, ListRow } from '../../app/list';
import { makeModel, selectedTrack, update, type Cmd, type Model, type Msg, type ViewRequest } from '../../app/model';
import { status, trackListSummary } from '../../app/presenter';
import { missingRows } from './fill';
import { RemoteTrackList } from './remoteList';
import { manyTracks } from './testkit';

const all = manyTracks(1000).reverse();
const rowsOf = (start: number, end: number): ListRow[] =>
  all.slice(start, end).map((track) => ({ track, rating: null, artists: 'Frédéric Chopin, Martha Argerich' }));

function chunk(offset: number, limit: number, fields: Partial<ListChunk> = {}): ListChunk {
  return {
    sort: 'recentDesc',
    query: '',
    version: 1,
    total: 1000,
    matched: 1000,
    offset,
    rows: rowsOf(offset, offset + limit),
    ...fields,
  };
}

describe('RemoteTrackList', () => {
  it('holds the rows that have arrived, and nulls for the rest', () => {
    const list = RemoteTrackList.fromChunk(chunk(0, 100));
    expect([list.count, list.total, list.sort, list.query, list.version]).toEqual([1000, 1000, 'recentDesc', '', 1]);
    expect(list.row(0)?.track.id).toBe(1000);
    expect(list.row(99)?.track.id).toBe(901);
    expect(list.row(100)).toBeNull();
    expect(list.row(-1)).toBeNull();
    expect(list.indexOf(950)).toBe(50);
    expect(list.indexOf(5)).toBe(-1);
    expect(list.requery()).toBeNull();
    expect(missingRows(list, 50, 250)).toEqual([
      { chunk: 100, offset: 100, limit: 100 },
      { chunk: 200, offset: 200, limit: 100 },
    ]);
    // A window around a selection is rarely aligned: only the rows it lacks are asked for.
    const around = RemoteTrackList.fromChunk(chunk(936, 100));
    expect(missingRows(around, 900, 1000)).toEqual([{ chunk: 900, offset: 900, limit: 36 }]);
    expect(missingRows(around, 0, 1000).at(-2)).toEqual({ chunk: 800, offset: 800, limit: 100 });
    const gap = RemoteTrackList.fromChunk(chunk(0, 10)).withRows(chunk(50, 10))!;
    expect(missingRows(gap as RemoteTrackList, 0, 100)).toEqual([{ chunk: 0, offset: 10, limit: 90 }]);
  });

  it('merges rows of the same list and version, and ignores others', () => {
    const list = RemoteTrackList.fromChunk(chunk(0, 100));
    const merged = list.withRows(chunk(150, 100));
    expect(merged).not.toBe(list);
    expect(merged?.row(150)?.track.id).toBe(850);
    expect(merged?.row(120)).toBeNull();
    expect(list.row(150)).toBeNull();
    expect(list.withRows(chunk(150, 100, { query: 'x' }))).toBe(list);
    expect(list.withRows(chunk(150, 100, { sort: 'idAsc' }))).toBe(list);
    expect(merged?.withRows(chunk(300, 10, { version: 0 }))).toBe(merged);
    // A newer version must not be mixed in: the model refetches instead.
    expect(list.withRows(chunk(150, 100, { version: 2 }))).toBeNull();
  });

  it('replaces a rating without touching the previous list', () => {
    const list = RemoteTrackList.fromChunk(chunk(0, 100));
    const rating = { trackId: 990, stars: 5, opinion: '', updatedAt: 1 };
    const rated = list.withRating(990, rating);
    expect(rated.row(10)?.rating).toEqual(rating);
    expect(list.row(10)?.rating).toBeNull();
    expect(list.withRating(5, rating)).toBe(list);
  });
});

describe('the model over a remote list', () => {
  const requests: ViewRequest[] = [];
  const view = (request: ViewRequest) => {
    requests.push(request);
    return Promise.resolve({ list: RemoteTrackList.fromChunk(chunk(0, 100, { query: request.query })), index: 0 });
  };
  const base = (): Model => makeModel({ deps: { view }, list: RemoteTrackList.fromChunk(chunk(0, 100)) });
  const step = (m: Model, msg: Msg): [Model, Cmd | null] => update(m, msg);
  const key = (k: string): Msg => ({ type: 'key', key: k, text: k.length === 1 ? k : '' });

  it('moves within loaded rows without commands, and jumps to rows still on their way', () => {
    let [m, cmd] = step(base(), key('j'));
    expect([m.selectedIndex, cmd]).toEqual([1, null]);
    [m, cmd] = step(m, key('G'));
    expect([m.selectedIndex, cmd, selectedTrack(m)]).toEqual([999, null, null]);
    // Nothing to rate until the row arrives.
    expect(step(m, key('e'))[0].editingRating).toBe(false);
    [m] = step(m, { type: 'listRows', chunk: chunk(900, 100) });
    expect(selectedTrack(m)?.id).toBe(1);
  });

  it('asks the server to sort and search, describing the rows on screen until it answers', async () => {
    requests.length = 0;
    let [m, cmd] = step(base(), key('o'));
    expect(m.sortMode).toBe('idAsc');
    expect(trackListSummary(m)).toBe('1000 loaded · sort: recent');
    expect(cmd).not.toBeNull();
    expect(requests).toEqual([]);
    const answer = await cmd!();
    expect(requests).toEqual([{ sort: 'idAsc', query: '', around: 1000, reload: false }]);

    [m] = step({ ...m, searching: true }, { type: 'setSearch', query: 'etude 1' });
    expect(status(m)?.text).toBe('Search /_ (1000/1000)');
    // The sort's answer is older than the search's request: dropped.
    expect(step(m, answer)[0]).toBe(m);
  });

  it('refetches once around the selection when rows come from a newer library version', () => {
    const [m, cmd] = step(base(), { type: 'listRows', chunk: chunk(100, 100, { version: 2 }) });
    expect(cmd).not.toBeNull();
    expect(m.listPending).toBe(true);
    expect(m.list.row(0)?.track.id).toBe(1000);
    expect(step(m, { type: 'listRows', chunk: chunk(200, 100, { version: 2 }) })).toEqual([m, null]);
  });

  it('reports a failed search in the status line and a failed reload as the error screen', () => {
    const m = { ...base(), listRequest: 3, listPending: true };
    const search = step(m, { type: 'listLoaded', seq: 3, reload: false, err: new Error('server gone') })[0];
    expect([search.err, search.statusMessage, search.statusIsError, search.listPending]).toEqual([
      null,
      'server gone',
      true,
      false,
    ]);
    const reload = step(m, { type: 'listLoaded', seq: 3, reload: true, err: new Error('database is locked') })[0];
    expect(reload.err?.message).toBe('database is locked');
  });
});
