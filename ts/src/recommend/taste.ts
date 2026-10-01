/**
 * Local taste analysis: favorite-pianist profiles, the taste summary sent to
 * the LLM, and catalog validation of the LLM's suggestions.
 */
import { wrap } from '../core/errors';
import { compareGoStrings } from '../core/gojson';
import type { ArtistSearcher, CatalogArtist, Rating, Track } from '../core/model';
import type {
  FavoritePianist,
  PianistProfile,
  SuggestedPianist,
  TasteSummary,
  TasteTrack,
  ValidatedPianist,
} from './index';
import { goQuote, goSlice, goString, goUnmarshal } from './gojson';
import { goLog1p, goRound } from './gomath';
import { goSortFunc } from './gosort';
import { goFields, goToLower, goTrimSpace } from './gostrings';

const MIN_RATINGS_FOR_DISCOVERY = 3;
const MAX_FAVORITE_PIANISTS = 8;
const MAX_LOVED_TRACKS = 10;
const MAX_DISLIKED_TRACKS = 5;
const MAX_COMMENTED_TRACKS = 8;
const DEFAULT_VALIDATION_LIMIT = 5;

const DISCOVERY_GUIDANCE =
  'Recommend real classical concert pianists not already present in the known pianist list. ' +
  'Use the ratings and comments to infer interpretive taste, then propose nearby but distinct pianists with substantial recording catalogs.';

/**
 * Normalized allowlist lookup. Matching is case- and whitespace-insensitive,
 * but output keeps the configured spelling.
 */
class Allowlist {
  private readonly canonical = new Map<string, string>();

  constructor(items: readonly string[]) {
    for (const item of items) {
      const trimmed = goTrimSpace(item);
      if (trimmed === '') {
        continue;
      }
      // Later duplicates win, as with the Go map assignment.
      this.canonical.set(normalizeName(trimmed), trimmed);
    }
  }

  has(normalized: string): boolean {
    return this.canonical.has(normalized);
  }

  /**
   * Keeps attribution limited to the curated pianist list instead of every
   * artist string attached to a classical recording.
   */
  matchedArtists(artists: readonly string[]): string[] {
    const seen = new Set<string>();
    const matched: string[] = [];
    for (const artist of artists) {
      const name = this.canonical.get(normalizeName(artist));
      if (name === undefined || seen.has(name)) {
        continue;
      }
      seen.add(name);
      matched.push(name);
    }
    return matched;
  }
}

/** Later ratings for the same track win, as with the Go map assignment. */
function ratingsByTrackId(ratings: readonly Rating[]): Map<number, Rating> {
  return new Map(ratings.map((rating) => [rating.trackId, rating]));
}

const artistsDecoder = goSlice(goString, '[]string');

/**
 * Decodes the artists column with Go's `json.Unmarshal` into `[]string`
 * semantics: `null` is an empty list and `null` elements become "".
 */
function decodeTrackArtists(track: Track): string[] {
  try {
    return goUnmarshal(track.artists, artistsDecoder);
  } catch (err) {
    throw wrap(`decode artists for track ${track.id}`, err);
  }
}

/**
 * Attributes local tracks and ratings to allowlisted pianists and computes
 * the deterministic favorite score used by the CLI.
 */
export function buildPianistProfiles(tracks: Track[], ratings: Rating[], allowlist: string[]): PianistProfile[] {
  const allowset = new Allowlist(allowlist);
  const ratingByTrackId = ratingsByTrackId(ratings);
  const aggregates = new Map<
    string,
    { trackCount: number; ratedTrackCount: number; totalPlayCount: number; totalStars: number }
  >();

  for (const track of tracks) {
    const matched = allowset.matchedArtists(decodeTrackArtists(track));
    if (matched.length === 0) {
      continue;
    }
    const rating = ratingByTrackId.get(track.id);
    for (const name of matched) {
      let agg = aggregates.get(name);
      if (agg === undefined) {
        agg = { trackCount: 0, ratedTrackCount: 0, totalPlayCount: 0, totalStars: 0 };
        aggregates.set(name, agg);
      }
      agg.trackCount++;
      agg.totalPlayCount += track.playCount;
      if (rating !== undefined) {
        agg.ratedTrackCount++;
        agg.totalStars += rating.stars;
      }
    }
  }

  const profiles: PianistProfile[] = [];
  for (const [name, agg] of aggregates) {
    const averageStars = agg.ratedTrackCount > 0 ? agg.totalStars / agg.ratedTrackCount : 0;
    profiles.push({
      name,
      trackCount: agg.trackCount,
      ratedTrackCount: agg.ratedTrackCount,
      totalPlayCount: agg.totalPlayCount,
      averageStars,
      favoriteScore: favoriteScore(averageStars, agg.ratedTrackCount, agg.totalPlayCount),
    });
  }

  goSortFunc(profiles, compareProfiles);
  return profiles;
}

/**
 * Reduces the local DB into a compact explanation of the user's taste for
 * the LLM-backed discovery flow.
 */
export function buildTasteSummary(tracks: Track[], ratings: Rating[], allowlist: string[]): TasteSummary {
  const profiles = buildPianistProfiles(tracks, ratings, allowlist);
  const ratingByTrackId = ratingsByTrackId(ratings);
  const allowset = new Allowlist(allowlist);

  const ratedTracks: TasteTrack[] = [];
  const commentedTracks: TasteTrack[] = [];
  for (const track of tracks) {
    const rating = ratingByTrackId.get(track.id);
    if (rating === undefined) {
      continue;
    }
    const artists = decodeTrackArtists(track);
    const entry: TasteTrack = {
      trackId: track.id,
      trackName: track.trackName,
      albumName: track.albumName,
      artists,
      playCount: track.playCount,
      lastPlayedAt: track.lastPlayedAt,
      stars: rating.stars,
      opinion: goTrimSpace(rating.opinion),
      matchedArtist: allowset.matchedArtists(artists)[0] ?? '',
    };
    ratedTracks.push(entry);
    if (entry.opinion !== '') {
      commentedTracks.push(entry);
    }
  }

  const lovedTracks = filterRatedTracks(ratedTracks, (track) => track.stars >= 4, MAX_LOVED_TRACKS);
  const dislikedTracks = filterRatedTracks(ratedTracks, (track) => track.stars <= 2, MAX_DISLIKED_TRACKS);

  goSortFunc(commentedTracks, compareTasteTracks);

  const favoritePianists: FavoritePianist[] = profiles.slice(0, MAX_FAVORITE_PIANISTS).map((profile) => ({
    name: profile.name,
    trackCount: profile.trackCount,
    ratedTrackCount: profile.ratedTrackCount,
    totalPlayCount: profile.totalPlayCount,
    averageStars: roundToTwoDecimals(profile.averageStars),
  }));

  const knownPianists = allowlist.map(goTrimSpace).filter((name) => name !== '');

  return {
    totalTracks: tracks.length,
    totalRatings: ratings.length,
    commentCount: ratedTracks.filter((track) => track.opinion !== '').length,
    favoritePianists,
    lovedTracks,
    dislikedTracks,
    commentedTracks: commentedTracks.slice(0, MAX_COMMENTED_TRACKS),
    knownPianists,
    discoveryGuidance: DISCOVERY_GUIDANCE,
  };
}

/**
 * Enforces a minimum amount of local signal before the app spends
 * network/API budget on LLM recommendations.
 */
export function validateDiscoveryInput(summary: TasteSummary): void {
  if (summary.totalRatings < MIN_RATINGS_FOR_DISCOVERY) {
    throw new Error(
      `need at least ${MIN_RATINGS_FOR_DISCOVERY} rated tracks before generating pianist recommendations`,
    );
  }
  if (summary.favoritePianists.length === 0) {
    throw new Error('no favorite pianists could be derived from the current database and allowlist');
  }
}

/**
 * Removes duplicates and known pianists, then checks every remaining
 * suggestion against a real catalog search before surfacing it, so
 * hallucinated names never reach the user.
 */
export async function validateSuggestedPianists(
  searcher: ArtistSearcher,
  knownPianists: string[],
  suggestions: SuggestedPianist[],
  limit: number,
): Promise<ValidatedPianist[]> {
  // Defensive parity with Go's nil check; callers may pass an untyped value.
  if ((searcher as ArtistSearcher | null | undefined) == null) {
    throw new Error('artist searcher is required');
  }
  if (limit < 1) {
    limit = DEFAULT_VALIDATION_LIMIT;
  }

  const known = new Allowlist(knownPianists);
  const seen = new Set<string>();
  const validated: ValidatedPianist[] = [];

  for (const suggestion of suggestions) {
    const query = goTrimSpace(suggestion.pianistName);
    if (query === '') {
      continue;
    }
    const normalized = normalizeName(query);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    if (known.has(normalized)) {
      continue;
    }

    let artists: CatalogArtist[];
    try {
      artists = await searcher.searchArtists(query, limit);
    } catch (err) {
      throw wrap(`validate pianist ${goQuote(query)}`, err);
    }
    const match = pickBestArtistMatch(query, artists);
    if (match === undefined) {
      continue;
    }

    validated.push({
      ...suggestion,
      similarTo: [...suggestion.similarTo],
      spotifyName: match.name,
      spotifyId: match.id,
      popularity: match.popularity,
      genres: [...match.genres],
    });
  }
  return validated;
}

/**
 * Deliberately favors explicit ratings over raw replay volume, with a small
 * penalty for tiny sample sizes.
 */
export function favoriteScore(averageStars: number, ratedTrackCount: number, totalPlayCount: number): number {
  const ratingScore = averageStars * 20;
  const sampleScore = Math.min(ratedTrackCount, 5) * 5;
  const playScore = goLog1p(totalPlayCount) * 8;
  const penalty = ratedTrackCount === 0 ? 8 : ratedTrackCount === 1 ? 4 : 0;
  // Go fuses at most the exact products (sampleScore, playScore) here, so
  // plain left-to-right evaluation matches it bit for bit.
  return ratingScore + sampleScore + playScore - penalty;
}

function compareNumbers(left: number, right: number): number {
  return left > right ? -1 : left < right ? 1 : 0;
}

/** Descending on the numeric keys, then ascending by name (bytewise). */
function compareProfiles(left: PianistProfile, right: PianistProfile): number {
  return (
    compareNumbers(left.favoriteScore, right.favoriteScore) ||
    compareNumbers(left.ratedTrackCount, right.ratedTrackCount) ||
    compareNumbers(left.totalPlayCount, right.totalPlayCount) ||
    compareGoStrings(left.name, right.name)
  );
}

function compareTasteTracks(left: TasteTrack, right: TasteTrack): number {
  return (
    compareNumbers(left.stars, right.stars) ||
    compareNumbers(left.playCount, right.playCount) ||
    compareNumbers(left.lastPlayedAt, right.lastPlayedAt) ||
    compareGoStrings(left.trackName, right.trackName)
  );
}

/**
 * Keeps the summary payload small while still preserving the strongest
 * positive/negative examples for the model.
 */
function filterRatedTracks(tracks: TasteTrack[], keep: (track: TasteTrack) => boolean, limit: number): TasteTrack[] {
  const filtered = tracks.filter(keep);
  goSortFunc(filtered, compareTasteTracks);
  return filtered.slice(0, limit);
}

/**
 * Prefers exact normalized-name matches before falling back to substring
 * matches from the validation catalog.
 */
export function pickBestArtistMatch(query: string, artists: CatalogArtist[]): CatalogArtist | undefined {
  const normalizedQuery = normalizeName(query);
  return (
    artists.find((artist) => normalizeName(artist.name) === normalizedQuery) ??
    artists.find((artist) => normalizeName(artist.name).includes(normalizedQuery))
  );
}

/** Case- and whitespace-insensitive name key, with Go's rune-wise lowercasing. */
export function normalizeName(name: string): string {
  return goToLower(goFields(name).join(' '));
}

/** Go's `math.Round(value*100) / 100`. */
export function roundToTwoDecimals(value: number): number {
  return goRound(value * 100) / 100;
}
