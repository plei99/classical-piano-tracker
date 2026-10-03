/**
 * The web client's track list: a sparse window of the list the server
 * holds for one sort and query, at one library version. Rows arrive in
 * chunks (API.view) and are kept until the sort, query, or version changes;
 * a row that has not arrived yet is null, which the list pane draws as a
 * placeholder of the same height.
 */
import type { ListChunk, ListRow, SortMode, TrackList } from '../../app/list';
import type { Rating } from '../../core/model';

/** Rows are stored in pages, so merging a chunk copies a few small arrays rather than the whole cache. */
const PAGE = 128;

type Page = readonly (ListRow | undefined)[];

export class RemoteTrackList implements TrackList {
  private constructor(
    readonly sort: SortMode,
    readonly query: string,
    readonly version: number,
    readonly total: number,
    readonly count: number,
    private readonly pages: ReadonlyMap<number, Page>,
  ) {}

  /** A list holding just the chunk's rows. */
  static fromChunk(chunk: ListChunk): RemoteTrackList {
    return new RemoteTrackList(chunk.sort, chunk.query, chunk.version, chunk.total, chunk.matched, new Map()).merge(
      chunk,
    );
  }

  /** An empty list that no chunk belongs to, for a page whose library could not load. */
  static empty(sort: SortMode = 'recentDesc', query = ''): RemoteTrackList {
    return new RemoteTrackList(sort, query, 0, 0, 0, new Map());
  }

  row(index: number): ListRow | null {
    if (index < 0 || index >= this.count) {
      return null;
    }
    return this.pages.get(Math.floor(index / PAGE))?.[index % PAGE] ?? null;
  }

  /** Searches loaded rows only: a track that has not arrived is not "in" the list yet. */
  indexOf(trackId: number): number {
    for (const [page, rows] of this.pages) {
      const at = rows.findIndex((row) => row?.track.id === trackId);
      if (at >= 0) {
        return page * PAGE + at;
      }
    }
    return -1;
  }

  /** The server sorts and filters; the model asks it. */
  requery(): null {
    return null;
  }

  withRating(trackId: number, rating: Rating): RemoteTrackList {
    const index = this.indexOf(trackId);
    const row = this.row(index);
    if (row === null) {
      return this;
    }
    const page = Math.floor(index / PAGE);
    const rows = (this.pages.get(page) ?? []).slice();
    rows[index % PAGE] = { ...row, rating };
    const pages = new Map(this.pages);
    pages.set(page, rows);
    return new RemoteTrackList(this.sort, this.query, this.version, this.total, this.count, pages);
  }

  withRows(chunk: ListChunk): RemoteTrackList | null {
    if (chunk.sort !== this.sort || chunk.query !== this.query || chunk.version < this.version) {
      return this;
    }
    if (chunk.version > this.version) {
      return null;
    }
    return this.merge(chunk);
  }

  /** Whether every row in [start, end) has arrived (the range is clamped to the list). */
  loaded(start: number, end: number): boolean {
    return this.firstMissing(start, end) === -1;
  }

  /** The first row in [start, end) that has not arrived, or -1. */
  firstMissing(start: number, end: number): number {
    const last = Math.min(end, this.count);
    for (let index = Math.max(0, start); index < last; index++) {
      if (this.pages.get(Math.floor(index / PAGE))?.[index % PAGE] === undefined) {
        return index;
      }
    }
    return -1;
  }

  private merge(chunk: ListChunk): RemoteTrackList {
    if (chunk.rows.length === 0) {
      return this;
    }
    const pages = new Map(this.pages);
    const copied = new Set<number>();
    for (const [offset, row] of chunk.rows.entries()) {
      const index = chunk.offset + offset;
      if (index >= this.count) break;
      const page = Math.floor(index / PAGE);
      let rows = pages.get(page) as (ListRow | undefined)[] | undefined;
      if (!copied.has(page)) {
        rows = rows === undefined ? [] : rows.slice();
        pages.set(page, rows);
        copied.add(page);
      }
      (rows as (ListRow | undefined)[])[index % PAGE] = row;
    }
    return new RemoteTrackList(this.sort, this.query, this.version, this.total, this.count, pages);
  }
}
