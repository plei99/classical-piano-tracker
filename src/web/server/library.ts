/**
 * The server's copy of the library, which answers every page's list
 * queries. It reads the database once (and again on reload or after a
 * sync), keeps the list in all four sort orders, and filters with the TUI's
 * own search (app/list.ts), so the web UI shows exactly what the TUI would.
 */
import { type ListRow, LocalTrackList, type SortMode, sortModeCycle } from '../../app/list';
import type { Rating, Track } from '../../core/model';

export interface LibrarySource {
  listAllTracks(): Track[];
  listAllRatings(): Rating[];
}

export interface ViewQuery {
  sort: SortMode;
  query: string;
  offset: number;
  limit: number;
  /** A track to center the window on, when it matches. */
  around?: number;
}

export interface LibraryView {
  version: number;
  total: number;
  matched: number;
  offset: number;
  rows: ListRow[];
  index: number | null;
}

/** Filtered lists kept for repeat queries (a page fetching more rows of its search). */
const FILTER_CACHE_SIZE = 16;

export class Library {
  private version = 0;
  /** Every track as read, with its rating; null until the database has been read. */
  private base: LocalTrackList | null = null;
  /** The library in each sort order computed so far. */
  private readonly sorted = new Map<SortMode, LocalTrackList>();
  private readonly filtered = new Map<string, LocalTrackList>();

  constructor(private readonly source: LibrarySource) {}

  /** Whether the database has been read successfully. */
  get loaded(): boolean {
    return this.base !== null;
  }

  /**
   * Re-reads the database (throwing its error) and starts a new version.
   * Only the default order is sorted here; `warm` (or the first query for
   * one) sorts the others.
   */
  reload(): { version: number; total: number } {
    const ratings = new Map<number, Rating>();
    for (const rating of this.source.listAllRatings()) {
      ratings.set(rating.trackId, rating);
    }
    this.base = LocalTrackList.load(this.source.listAllTracks(), ratings);
    this.sorted.clear();
    this.filtered.clear();
    this.sortedBy('recentDesc');
    this.version++;
    return { version: this.version, total: this.base.total };
  }

  /** Sorts the orders not used yet, ahead of the first request for them. */
  warm(): void {
    if (this.base !== null) {
      for (const sort of sortModeCycle) {
        this.sortedBy(sort);
      }
    }
  }

  /** Drops the library, so the next request reads the database again (and reports its error). */
  forget(): void {
    this.base = null;
    this.sorted.clear();
    this.filtered.clear();
  }

  /** Reads the database unless that has already succeeded. */
  ensureLoaded(): void {
    if (this.base === null) {
      this.reload();
    }
  }

  /** Records a saved rating: only the unrated-first order moves. */
  setRating(rating: Rating): void {
    if (this.base === null) {
      return;
    }
    this.base = this.base.withRating(rating.trackId, rating);
    for (const [sort, list] of this.sorted) {
      const rated = list.withRating(rating.trackId, rating);
      this.sorted.set(sort, sort === 'unratedFirst' ? rated.requery(sort, '') : rated);
    }
    this.filtered.clear();
    this.version++;
  }

  private sortedBy(sort: SortMode): LocalTrackList {
    let list = this.sorted.get(sort);
    if (list === undefined) {
      list = (this.base ?? LocalTrackList.empty).requery(sort, '');
      this.sorted.set(sort, list);
    }
    return list;
  }

  list(sort: SortMode, query: string): LocalTrackList {
    this.ensureLoaded();
    const all = this.sortedBy(sort);
    if (query.trim() === '') {
      return all;
    }
    const key = `${sort}\0${query}`;
    let list = this.filtered.get(key);
    if (list === undefined) {
      list = all.requery(sort, query);
      if (this.filtered.size >= FILTER_CACHE_SIZE) {
        this.filtered.delete(this.filtered.keys().next().value as string);
      }
    } else {
      // Most recently used last.
      this.filtered.delete(key);
    }
    this.filtered.set(key, list);
    return list;
  }

  view({ sort, query, offset, limit, around }: ViewQuery): LibraryView {
    const list = this.list(sort, query);
    const matched = list.count;
    let start = offset;
    let index: number | null = null;
    if (around !== undefined) {
      const found = list.indexOf(around);
      if (found >= 0) {
        index = found;
        start = Math.max(0, Math.min(found - Math.floor(limit / 2), matched - limit));
      }
    }
    const rows: ListRow[] = [];
    const end = Math.min(matched, start + limit);
    for (let position = start; position < end; position++) {
      const row = list.row(position);
      if (row !== null) {
        rows.push(row);
      }
    }
    return { version: this.version, total: list.total, matched, offset: start, rows, index };
  }
}
