/**
 * Local taste analysis (favorite pianists, taste summaries) and parsing and
 * validation of LLM pianist suggestions.
 *
 * Property names are camelCase; producing Go's snake_case JSON for prompts
 * is the llm module's job (see llm/discovery).
 */

/** Deterministic per-pianist aggregate used by `recommend favorites`. */
export interface PianistProfile {
  name: string;
  trackCount: number;
  ratedTrackCount: number;
  totalPlayCount: number;
  averageStars: number;
  favoriteScore: number;
}

export interface TasteTrack {
  trackId: number;
  trackName: string;
  albumName: string;
  artists: string[];
  playCount: number;
  lastPlayedAt: number;
  stars: number;
  opinion: string;
  matchedArtist: string;
}

/**
 * The JSON-facing version of {@link PianistProfile}; it deliberately omits
 * the favorite score so the LLM infers taste from ratings, not our heuristic.
 */
export interface FavoritePianist {
  name: string;
  trackCount: number;
  ratedTrackCount: number;
  totalPlayCount: number;
  averageStars: number;
}

/** The taste snapshot sent to the LLM. */
export interface TasteSummary {
  totalTracks: number;
  totalRatings: number;
  commentCount: number;
  favoritePianists: FavoritePianist[];
  lovedTracks: TasteTrack[];
  dislikedTracks: TasteTrack[];
  commentedTracks: TasteTrack[];
  knownPianists: string[];
  discoveryGuidance: string;
}

export interface SuggestedPianist {
  pianistName: string;
  whyFit: string;
  similarTo: string[];
  confidence: string;
}

export interface DiscoveryResult {
  summary: string;
  recommendations: SuggestedPianist[];
}

/** A suggestion that survived Spotify catalog validation. */
export interface ValidatedPianist extends SuggestedPianist {
  spotifyName: string;
  spotifyId: string;
  popularity: number;
  genres: string[];
}

export {
  buildPianistProfiles,
  buildTasteSummary,
  favoriteScore,
  normalizeName,
  pickBestArtistMatch,
  roundToTwoDecimals,
  validateDiscoveryInput,
  validateSuggestedPianists,
} from './taste';
export {
  parseDiscoveryPartial,
  parseDiscoveryRecommendations,
  parseDiscoveryResult,
  parsePlaintextRecommendations,
  parseTasteSummary,
} from './parse';
export { goFormatFixed, goLog1p, goRound } from './gomath';
