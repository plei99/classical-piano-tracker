/**
 * Keeps a remote list's rows loaded ahead of the reader: around the
 * selection (so holding j/k never reaches a row that has not arrived) and
 * around the scroll position. Rows are fetched by aligned chunk, each at
 * most once at a time, and arrive as `listRows` messages, which the model
 * merges or (when the library has changed meanwhile) answers by refetching.
 */
import { useEffect, useRef } from 'react';

import type { ListChunk, SortMode } from '../../app/list';
import type { Model, Msg } from '../../app/model';
import { VIEW_CHUNK } from './deps';
import { RemoteTrackList } from './remoteList';

export type RowsFetcher = (sort: SortMode, query: string, offset: number, limit: number) => Promise<ListChunk>;

/**
 * Screens of rows to keep loaded on each side. A chunk is several screens,
 * so the next one is requested well before the selection gets near it.
 */
const AHEAD_SCREENS = 2;

/** One request for rows: the missing part of one aligned chunk. */
export interface RowRequest {
  /** The aligned chunk's first row, which identifies the request. */
  chunk: number;
  offset: number;
  limit: number;
}

/**
 * The requests that load [start, end) of the list: one per aligned chunk
 * with rows missing, trimmed to the rows it lacks (a window fetched around
 * the selection is rarely aligned, and its rows need not come again).
 */
export function missingRows(list: RemoteTrackList, start: number, end: number): RowRequest[] {
  const requests: RowRequest[] = [];
  let from = Math.max(0, start);
  const to = Math.min(list.count, end);
  while (from < to) {
    const missing = list.firstMissing(from, to);
    if (missing < 0) break;
    const chunk = Math.floor(missing / VIEW_CHUNK) * VIEW_CHUNK;
    const chunkEnd = Math.min(chunk + VIEW_CHUNK, list.count);
    let last = chunkEnd - 1;
    while (last > missing && list.row(last) !== null) last--;
    const first = list.firstMissing(chunk, chunkEnd);
    requests.push({ chunk, offset: first, limit: last - first + 1 });
    from = chunkEnd;
  }
  return requests;
}

export function useListFill(
  { list, selectedIndex, listPending }: Pick<Model, 'list' | 'selectedIndex' | 'listPending'>,
  first: number,
  last: number,
  fetchRows: RowsFetcher | undefined,
  dispatch: (msg: Msg) => void,
): void {
  const inflight = useRef(new Set<string>());
  useEffect(() => {
    // While a new list is on its way, rows of this one would be thrown away.
    if (fetchRows === undefined || listPending || !(list instanceof RemoteTrackList) || list.count === 0) {
      return;
    }
    const margin = AHEAD_SCREENS * Math.max(1, last - first);
    const requests = [
      ...missingRows(list, selectedIndex - margin, selectedIndex + margin + 1),
      ...missingRows(list, first - margin, last + margin),
    ];
    for (const { chunk, offset, limit } of requests) {
      const key = `${list.sort}\0${list.query}\0${list.version}\0${chunk}`;
      if (inflight.current.has(key)) continue;
      inflight.current.add(key);
      fetchRows(list.sort, list.query, offset, limit)
        .then(
          (chunk) => dispatch({ type: 'listRows', chunk }),
          () => {
            // Asked again on the next move or scroll.
          },
        )
        .finally(() => inflight.current.delete(key));
    }
  }, [list, selectedIndex, listPending, first, last, fetchRows, dispatch]);
}
