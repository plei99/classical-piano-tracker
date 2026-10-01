import { goJSONStringify } from './gojson';

/**
 * The `tracks.artists` column holds a JSON array of names. These helpers are
 * the single place that decodes it for display and attribution.
 */

/** Decodes the stored JSON array of artist names. */
export function decodeArtists(raw: string): string[] {
  const value: unknown = JSON.parse(raw);
  if (value === null) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('json: cannot unmarshal into []string');
  }
  return value;
}

/** Encodes artist names the way sync stores them (compact JSON, as Go's json.Marshal). */
export function encodeArtists(artists: string[]): string {
  return goJSONStringify(artists);
}

/**
 * Joins artist names with ", " for display, falling back to the raw column
 * text when it is not a non-empty JSON array of strings.
 */
export function formatArtists(raw: string): string {
  // Fast path for the compact form sync writes: with no escapes,
  // `["A","B"]` decodes to exactly the text between the quotes.
  if (raw.startsWith('["') && raw.endsWith('"]') && !raw.includes('\\')) {
    const inner = raw.slice(2, -2);
    if (inner !== '') {
      const joined = inner.replaceAll('","', ', ');
      if (!joined.includes('"')) {
        return joined;
      }
    }
  }
  try {
    const artists = decodeArtists(raw);
    return artists.length > 0 ? artists.join(', ') : raw;
  } catch {
    return raw;
  }
}
