/**
 * The shared prompts and JSON contracts for pianist discovery and taste
 * summaries. Prompt text and the embedded taste-summary JSON are identical to
 * the Go build (`json.MarshalIndent` of the Go structs: snake_case keys in
 * declaration order, omitempty, HTML-safe escaping).
 */
import type { JSONSchema, Request } from './index';
import type { TasteSummary, TasteTrack } from '../recommend';
import { goMarshal } from '../recommend/gojson';

/** The Go `recommend.TasteTrack` JSON shape, in struct field order. */
function tasteTrackJSON(track: TasteTrack): Record<string, unknown> {
  return {
    track_id: track.trackId,
    track_name: track.trackName,
    album_name: track.albumName,
    artists: track.artists,
    play_count: track.playCount,
    last_played_at: track.lastPlayedAt,
    stars: track.stars,
    opinion: track.opinion === '' ? undefined : track.opinion,
    matched_artist: track.matchedArtist === '' ? undefined : track.matchedArtist,
  };
}

/** `json.MarshalIndent(summary, "", "  ")` of the Go `recommend.TasteSummary`. */
export function marshalTasteSummary(summary: TasteSummary): string {
  const value = {
    total_tracks: summary.totalTracks,
    total_ratings: summary.totalRatings,
    comment_count: summary.commentCount,
    favorite_pianists: summary.favoritePianists.map((pianist) => ({
      name: pianist.name,
      track_count: pianist.trackCount,
      rated_track_count: pianist.ratedTrackCount,
      total_play_count: pianist.totalPlayCount,
      average_stars: pianist.averageStars,
    })),
    loved_tracks: summary.lovedTracks.map(tasteTrackJSON),
    disliked_tracks: summary.dislikedTracks.map(tasteTrackJSON),
    commented_tracks: summary.commentedTracks.map(tasteTrackJSON),
    known_pianists: summary.knownPianists,
    discovery_guidance: summary.discoveryGuidance,
  };
  try {
    return goMarshal(value, { sortKeys: false, indent: '  ' });
  } catch (err) {
    throw new Error(`marshal taste summary: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

function recommendationItemsSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      pianist_name: { type: 'string', minLength: 1 },
      why_fit: { type: 'string', minLength: 1 },
      similar_to: {
        type: 'array',
        items: { type: 'string' },
      },
      confidence: { type: 'string', minLength: 1 },
    },
    required: ['pianist_name', 'why_fit', 'similar_to', 'confidence'],
    additionalProperties: false,
  };
}

/** Owns the shared prompt and JSON contract for pianist discovery. */
export function buildDiscoveryRequest(summary: TasteSummary, limit: number): Request {
  const summaryJSON = marshalTasteSummary(summary);
  const minRecommendations = minimumDiscoveryRecommendations(limit);

  return {
    systemPrompt:
      'You are a classical piano recommendation assistant. Recommend real classical concert pianists, not tracks. Ground every recommendation in the supplied ratings and comments. Do not recommend pianists already listed in known_pianists. A valid answer must include both a non-empty summary and a non-empty recommendations list.',
    userPrompt: `Use this taste profile JSON to recommend ${limit} new pianists.\nReturn a complete JSON object with a summary and a recommendations array. The recommendations array must contain at least ${minRecommendations} and at most ${limit} pianist objects.\n\n${summaryJSON}`,
    outputMode: 'strict',
    schema: {
      name: 'pianist_discovery',
      schema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            minLength: 1,
          },
          recommendations: {
            type: 'array',
            minItems: minRecommendations,
            maxItems: limit,
            items: recommendationItemsSchema(),
          },
        },
        required: ['summary', 'recommendations'],
        additionalProperties: false,
      },
      strict: true,
    },
    temperature: 0,
    maxOutputTokens: 0,
  };
}

/**
 * Asks the provider to rewrite an incomplete first pass into a complete
 * object that matches the original discovery schema.
 */
export function buildDiscoveryRepairRequest(raw: string, limit: number, attempt: number): Request {
  if (limit < 1) {
    limit = 5;
  }
  const minRecommendations = minimumDiscoveryRecommendations(limit);

  const req = buildDiscoveryRequest(emptyTasteSummary(), limit);
  req.systemPrompt =
    'You repair incomplete JSON responses for a classical piano recommendation task. Return only a complete JSON object that matches the required schema.';
  req.userPrompt = `Repair attempt ${attempt}.\nThe previous response was incomplete or malformed, and often omits the recommendations array entirely.\nRewrite it into a valid JSON object with a non-empty summary and a recommendations array containing at least ${minRecommendations} and at most ${limit} items.\nDo not return a summary-only object. Do not add markdown fences.\n\nPrevious response:\n${raw}`;
  return req;
}

/**
 * Asks the provider for only the missing recommendation objects when a
 * full-object response keeps collapsing into summary-only JSON.
 */
export function buildDiscoveryRecommendationsOnlyRequest(summary: TasteSummary, limit: number): Request {
  if (limit < 1) {
    limit = 5;
  }
  const minRecommendations = minimumDiscoveryRecommendations(limit);
  const summaryJSON = marshalTasteSummary(summary);

  return {
    systemPrompt:
      'You are a classical piano recommendation assistant. Return only recommendation objects for real classical concert pianists not already listed in known_pianists.',
    userPrompt: `Using this taste profile JSON, return only a JSON object with a recommendations array containing at least ${minRecommendations} and at most ${limit} pianist objects. Do not include a summary field.\n\n${summaryJSON}`,
    outputMode: 'strict',
    schema: {
      name: 'pianist_recommendations_only',
      schema: {
        type: 'object',
        properties: {
          recommendations: {
            type: 'array',
            minItems: minRecommendations,
            maxItems: limit,
            items: recommendationItemsSchema(),
          },
        },
        required: ['recommendations'],
        additionalProperties: false,
      },
      strict: true,
    },
    temperature: 0,
    maxOutputTokens: 0,
  };
}

/**
 * The last-resort fallback for providers that keep ignoring every
 * structured-output contract. It requests a rigid line format that can
 * still be parsed locally.
 */
export function buildDiscoveryPlaintextRecommendationsRequest(summary: TasteSummary, limit: number): Request {
  if (limit < 1) {
    limit = 5;
  }
  const minRecommendations = minimumDiscoveryRecommendations(limit);
  const summaryJSON = marshalTasteSummary(summary);

  return {
    systemPrompt:
      'You are a classical piano recommendation assistant. Recommend real classical concert pianists not already listed in known_pianists. Return no prose outside the requested line format.',
    userPrompt: `Using this taste profile JSON, return between ${minRecommendations} and ${limit} recommendation lines.\nEach line must follow exactly this format:\nPianist Name || Why fit sentence || Similar pianist 1, Similar pianist 2 || confidence\nNo heading, no markdown, no numbering.\n\n${summaryJSON}`,
    outputMode: 'prompt_only',
    schema: null,
    temperature: 0,
    maxOutputTokens: 0,
  };
}

export function minimumDiscoveryRecommendations(limit: number): number {
  if (limit <= 0) {
    return 1;
  }
  return limit < 5 ? limit : 5;
}

/**
 * Asks the provider for a prose description of the user's current listening
 * and rating profile, not for recommendations.
 */
export function buildTasteSummaryRequest(summary: TasteSummary): Request {
  const summaryJSON = marshalTasteSummary({ ...summary, discoveryGuidance: '' });
  const schema: JSONSchema = {
    name: 'taste_summary',
    schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          minLength: 1,
        },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    strict: true,
  };

  return {
    systemPrompt:
      "You are a classical piano listening analyst. Summarize the user's listening taste from the supplied ratings, comments, and favorite-pianist aggregates. Do not recommend new pianists or tracks. Return one concise but specific prose summary grounded only in the supplied JSON.",
    userPrompt: `Summarize this user taste profile in one paragraph. Describe repertoire, interpretive style, and pianist preferences when those signals are present. Return a JSON object with a single non-empty summary string.\n\n${summaryJSON}`,
    outputMode: 'strict',
    schema,
    temperature: 0,
    maxOutputTokens: 0,
  };
}

function emptyTasteSummary(): TasteSummary {
  return {
    totalTracks: 0,
    totalRatings: 0,
    commentCount: 0,
    favoritePianists: [],
    lovedTracks: [],
    dislikedTracks: [],
    commentedTracks: [],
    knownPianists: [],
    discoveryGuidance: '',
  };
}
