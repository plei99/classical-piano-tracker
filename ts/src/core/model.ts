/** Plain data shared across modules. Fields mirror the SQLite columns. */

export interface Track {
  id: number;
  spotifyId: string;
  trackName: string;
  albumName: string;
  /** JSON array of artist names, kept as text exactly as stored. */
  artists: string;
  playCount: number;
  lastPlayedAt: number;
  createdAt: number;
}

export interface Rating {
  trackId: number;
  stars: number;
  opinion: string;
  updatedAt: number;
}

export interface UpsertTrackParams {
  spotifyId: string;
  trackName: string;
  albumName: string;
  artists: string;
  lastPlayedAt: number;
}

export interface UpsertRatingParams {
  trackId: number;
  stars: number;
  opinion: string;
  updatedAt: number;
}

/** Outcome of one sync run. */
export interface SyncStats {
  fetched: number;
  blocked: number;
  skipped: number;
  accepted: number;
  inserted: number;
  updated: number;
  alreadySynced: number;
}

export function emptySyncStats(): SyncStats {
  return { fetched: 0, blocked: 0, skipped: 0, accepted: 0, inserted: 0, updated: 0, alreadySynced: 0 };
}

/** One artist from a catalog search (Spotify), used to validate suggestions. */
export interface CatalogArtist {
  name: string;
  id: string;
  popularity: number;
  genres: string[];
}

/** Catalog lookup used to validate recommendations. */
export interface ArtistSearcher {
  searchArtists(query: string, limit: number): Promise<CatalogArtist[]>;
}
