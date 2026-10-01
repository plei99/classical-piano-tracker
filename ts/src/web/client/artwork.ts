/**
 * Album art, fetched lazily for the rows on screen and the selected track.
 * Requests from many rows in the same frame are batched (Spotify looks up at
 * most 50 tracks per call) and each ID is asked for once per page load.
 */
import { useSyncExternalStore } from 'react';

import { API, ARTWORK_BATCH, type Artwork, type ArtworkResponse } from '../api';

type Listener = () => void;

export class ArtworkStore {
  private readonly art = new Map<string, Artwork | null>();
  private readonly requested = new Set<string>();
  private queue: string[] = [];
  private flushing: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<Listener>();
  private version = 0;

  constructor(
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
    private readonly delayMs = 16,
  ) {}

  /** Art for a track: undefined while unknown, null when Spotify has none. */
  get(spotifyId: string): Artwork | null | undefined {
    return this.art.get(spotifyId);
  }

  /** Asks for art for these tracks unless already known or on the way. */
  request(spotifyIds: Iterable<string>): void {
    for (const id of spotifyIds) {
      if (id !== '' && !this.requested.has(id)) {
        this.requested.add(id);
        this.queue.push(id);
      }
    }
    if (this.queue.length > 0 && this.flushing === null) {
      this.flushing = setTimeout(() => void this.flush(), this.delayMs);
    }
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): number => this.version;

  private async flush(): Promise<void> {
    this.flushing = null;
    const ids = this.queue;
    this.queue = [];
    const batches: string[][] = [];
    for (let start = 0; start < ids.length; start += ARTWORK_BATCH) {
      batches.push(ids.slice(start, start + ARTWORK_BATCH));
    }
    await Promise.all(batches.map((batch) => this.fetchBatch(batch)));
  }

  private async fetchBatch(ids: string[]): Promise<void> {
    try {
      const response = await this.fetcher(`${API.artwork}?ids=${ids.map(encodeURIComponent).join(',')}`);
      if (!response.ok) {
        throw new Error(String(response.status));
      }
      const found = (await response.json()) as ArtworkResponse;
      for (const id of ids) {
        this.art.set(id, found[id] ?? null);
      }
    } catch {
      // Let a later render ask again rather than caching a transient failure.
      for (const id of ids) {
        this.requested.delete(id);
      }
      return;
    }
    this.version++;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const artworkStore = new ArtworkStore();

/** Re-renders the caller when new art arrives; returns the store for lookups. */
export function useArtworkStore(store: ArtworkStore = artworkStore): ArtworkStore {
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  return store;
}
