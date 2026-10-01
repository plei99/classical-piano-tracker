/**
 * Lenient parsing of LLM discovery and taste-summary output.
 *
 * Providers routinely wrap JSON in markdown fences, rename keys, nest the
 * payload, or drop fields. These parsers accept all of that so the client's
 * repair and fallback flow only kicks in when content is truly missing.
 *
 * Strict decoding mirrors Go's `json.Unmarshal` into the result struct
 * (see ./gojson): unknown keys are ignored, keys match case-insensitively,
 * `null` leaves a field at its zero value, and any type mismatch is an error.
 */
import { wrap } from '../core/errors';
import type { DiscoveryResult, SuggestedPianist } from './index';
import { type GoAny, type GoMap, field, goMapAny, goSlice, goString, goStruct, goUnmarshal } from './gojson';
import { byteLength, goFields, goTrimLeft, goTrimSpace, trimPrefix, trimSuffix } from './gostrings';

const PREVIEW_MAX_LEN = 240;

const suggestedPianistDecoder = goStruct<SuggestedPianist>('recommend.SuggestedPianist', [
  field('pianistName', 'pianist_name', goString),
  field('whyFit', 'why_fit', goString),
  field('similarTo', 'similar_to', goSlice(goString, '[]string')),
  field('confidence', 'confidence', goString),
]);

const discoveryResultDecoder = goStruct<DiscoveryResult>('recommend.DiscoveryResult', [
  field('summary', 'summary', goString),
  field('recommendations', 'recommendations', goSlice(suggestedPianistDecoder, '[]recommend.SuggestedPianist')),
]);

/**
 * Accepts strict JSON output plus fenced JSON snippets so the app tolerates
 * minor response-wrapper differences from the model.
 */
export function parseDiscoveryResult(raw: string): DiscoveryResult {
  const { result, cleaned } = parsePartialWithCleaned(raw);
  if (goTrimSpace(result.summary) === '') {
    throw new Error(`LLM discovery response omitted summary: ${previewJSON(cleaned)}`);
  }
  if (result.recommendations.length === 0) {
    throw new Error(`LLM discovery response omitted recommendations: ${previewJSON(cleaned)}`);
  }
  normalizeRecommendations(result.recommendations);
  return result;
}

/**
 * Extracts a summary-only LLM response and tolerates fenced JSON or plain
 * text when a provider ignores the schema wrapper.
 */
export function parseTasteSummary(raw: string): string {
  let decodeError: unknown = null;
  try {
    const { result } = parsePartialWithCleaned(raw);
    if (goTrimSpace(result.summary) !== '') {
      return goTrimSpace(result.summary);
    }
  } catch (err) {
    decodeError = err;
  }

  const cleaned = cleanLLMText(raw);
  if (cleaned === '') {
    throw new Error('LLM taste summary response omitted summary');
  }
  if (decodeError === null) {
    throw new Error(`LLM taste summary response omitted summary: ${previewJSON(cleaned)}`);
  }
  if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
    throw wrap('decode LLM taste summary response', decodeError);
  }
  return cleaned;
}

/**
 * Normalizes a provider response without requiring every field to be
 * present. The LLM client's repair logic uses it to salvage a summary.
 */
export function parseDiscoveryPartial(raw: string): DiscoveryResult {
  return parsePartialWithCleaned(raw).result;
}

/** Normalizes a provider response when the client only asked for a recommendation list. */
export function parseDiscoveryRecommendations(raw: string): SuggestedPianist[] {
  const { result, cleaned } = parsePartialWithCleaned(raw);
  if (result.recommendations.length === 0) {
    throw new Error(`LLM discovery response omitted recommendations: ${previewJSON(cleaned)}`);
  }
  normalizeRecommendations(result.recommendations);
  return result.recommendations;
}

/**
 * Parses the final fallback line format:
 * `Pianist Name || Why fit || Similar 1, Similar 2 || confidence`
 */
export function parsePlaintextRecommendations(raw: string): SuggestedPianist[] {
  const recommendations: SuggestedPianist[] = [];
  for (let line of goTrimSpace(raw).split('\n')) {
    line = goTrimSpace(goTrimLeft(goTrimSpace(line), '-* '));
    if (line === '') {
      continue;
    }
    const cut = line.indexOf('. ');
    if (cut >= 0 && isDigits(line.slice(0, cut))) {
      line = line.slice(cut + 2);
    }

    const parts = line.split('||');
    if (parts.length < 4) {
      continue;
    }
    const pianistName = goTrimSpace(parts[0] as string);
    const whyFit = goTrimSpace(parts[1] as string);
    const confidence = goTrimSpace(parts[3] as string);
    if (pianistName === '' || whyFit === '') {
      continue;
    }
    const similarTo = (parts[2] as string)
      .split(',')
      .map(goTrimSpace)
      .filter((item) => item !== '');

    recommendations.push({ pianistName, whyFit, similarTo, confidence });
  }

  if (recommendations.length === 0) {
    throw new Error('LLM plaintext recommendation fallback produced no parseable lines');
  }
  return recommendations;
}

/** Requires a name and reason on every recommendation and trims the text fields the UI prints. */
function normalizeRecommendations(recommendations: SuggestedPianist[]): void {
  recommendations.forEach((rec, idx) => {
    if (goTrimSpace(rec.pianistName) === '') {
      throw new Error(`recommendation ${idx + 1} omitted pianist_name`);
    }
    if (goTrimSpace(rec.whyFit) === '') {
      throw new Error(`recommendation ${idx + 1} omitted why_fit`);
    }
    rec.pianistName = goTrimSpace(rec.pianistName);
    rec.whyFit = goTrimSpace(rec.whyFit);
    rec.confidence = goTrimSpace(rec.confidence);
  });
}

/** Returns the decoded result alongside the cleaned text used for error previews. */
function parsePartialWithCleaned(raw: string): { result: DiscoveryResult; cleaned: string } {
  const cleaned = cleanLLMText(raw);
  let result: DiscoveryResult;
  try {
    result = goUnmarshal(cleaned, discoveryResultDecoder);
  } catch (err) {
    throw wrap('decode LLM discovery response', err);
  }

  const normalized = parseDiscoveryAliases(cleaned);
  if (normalized !== null && aliasResultIsBetter(normalized, result)) {
    result = normalized;
  }
  return { result, cleaned };
}

function cleanLLMText(raw: string): string {
  let cleaned = goTrimSpace(raw);
  cleaned = trimPrefix(cleaned, '```json');
  cleaned = trimPrefix(cleaned, '```');
  cleaned = trimSuffix(cleaned, '```');
  return goTrimSpace(cleaned);
}

/** Collapses whitespace and caps the length so error messages stay readable. */
export function previewJSON(cleaned: string): string {
  const collapsed = goFields(cleaned).join(' ');
  if (byteLength(collapsed) <= PREVIEW_MAX_LEN) {
    return collapsed;
  }
  // Go slices bytes; a split rune renders as U+FFFD either way.
  return `${Buffer.from(collapsed, 'utf8').subarray(0, PREVIEW_MAX_LEN).toString('utf8')}...`;
}

function isDigits(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

// ---------------------------------------------------------------------------
// Alias-tolerant decoding for providers that ignore the schema's key names.

const NAME_KEYS = ['pianist_name', 'name', 'pianist', 'artist'];
const REASON_KEYS = ['why_fit', 'reason', 'why'];
const NESTED_LIST_KEYS = ['items', 'entries', 'results', 'recommendations', 'pianists', 'suggestions', 'candidates'];

function parseDiscoveryAliases(cleaned: string): DiscoveryResult | null {
  let payload: GoMap | null;
  try {
    payload = goUnmarshal(cleaned, goMapAny);
  } catch {
    return null;
  }
  return parseDiscoveryAliasesMap(payload ?? Object.create(null));
}

function isMap(value: GoAny | undefined): value is GoMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: GoAny | undefined): string {
  return typeof value === 'string' ? value : '';
}

function parseDiscoveryAliasesMap(payload: GoMap): DiscoveryResult | null {
  for (const wrapper of ['result', 'data']) {
    const nested = payload[wrapper];
    if (isMap(nested)) {
      const result = parseDiscoveryAliasesMap(nested);
      if (result !== null) {
        return result;
      }
    }
  }

  const summary = goTrimSpace(firstNonEmpty(asString(payload['summary']), asString(payload['overview'])));

  let source = firstArray(payload, ['recommendations', 'pianists', 'suggestions', 'candidates']);
  if (source.length === 0) {
    source = findRecommendationArray(payload);
  }
  if (source.length === 0) {
    return summary !== '' ? { summary, recommendations: [] } : null;
  }

  const recommendations: SuggestedPianist[] = [];
  for (const item of source) {
    if (!isMap(item)) {
      continue;
    }
    recommendations.push({
      pianistName: goTrimSpace(firstAlias(item, NAME_KEYS)),
      whyFit: goTrimSpace(firstAlias(item, REASON_KEYS)),
      similarTo: firstStringArray(item, ['similar_to', 'similar']),
      confidence: goTrimSpace(asString(item['confidence'])),
    });
  }
  return { summary, recommendations };
}

function aliasResultIsBetter(candidate: DiscoveryResult, current: DiscoveryResult): boolean {
  if (candidate.recommendations.length === 0) {
    return false;
  }
  if (current.recommendations.length === 0) {
    return true;
  }
  return (
    recommendationCompletenessScore(candidate.recommendations) >
    recommendationCompletenessScore(current.recommendations)
  );
}

/**
 * Weighs the required fields (name, reason) above the optional ones so a
 * decode that found the real content wins over one that found only keys.
 */
export function recommendationCompletenessScore(items: SuggestedPianist[]): number {
  let score = 0;
  for (const item of items) {
    if (goTrimSpace(item.pianistName) !== '') {
      score += 2;
    }
    if (goTrimSpace(item.whyFit) !== '') {
      score += 2;
    }
    if (item.similarTo.length > 0) {
      score++;
    }
    if (goTrimSpace(item.confidence) !== '') {
      score++;
    }
  }
  return score;
}

function firstArray(payload: GoMap, keys: string[]): GoAny[] {
  for (const key of keys) {
    const items = payload[key];
    if (Array.isArray(items) && items.length > 0) {
      return items;
    }
  }
  return [];
}

function firstStringArray(payload: GoMap, keys: string[]): string[] {
  for (const key of keys) {
    const values = payload[key];
    if (!Array.isArray(values) || values.length === 0) {
      continue;
    }
    const result = values.map((value) => goTrimSpace(asString(value))).filter((text) => text !== '');
    if (result.length > 0) {
      return result;
    }
  }
  return [];
}

function firstAlias(payload: GoMap, keys: string[]): string {
  return firstNonEmpty(...keys.map((key) => asString(payload[key])));
}

/**
 * Searches every value for something shaped like a recommendation list.
 * Go walks its map in random order; here keys are visited in Go's sorted
 * order, which makes the choice deterministic when several arrays qualify.
 */
function findRecommendationArray(payload: GoMap): GoAny[] {
  const keys = Object.keys(payload).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const key of keys) {
    const items = recommendationArrayFromValue(payload[key]);
    if (items.length > 0) {
      return items;
    }
  }
  return [];
}

function recommendationArrayFromValue(value: GoAny | undefined): GoAny[] {
  const looksLike = (items: GoAny[]): boolean => {
    const first = items[0];
    return isMap(first) && looksLikeRecommendationObject(first);
  };
  if (Array.isArray(value)) {
    return value.length > 0 && looksLike(value) ? value : [];
  }
  if (isMap(value)) {
    for (const key of NESTED_LIST_KEYS) {
      const items = value[key];
      if (Array.isArray(items) && items.length > 0 && looksLike(items)) {
        return items;
      }
    }
  }
  return [];
}

function looksLikeRecommendationObject(payload: GoMap): boolean {
  return goTrimSpace(firstAlias(payload, NAME_KEYS)) !== '' && goTrimSpace(firstAlias(payload, REASON_KEYS)) !== '';
}

function firstNonEmpty(...values: string[]): string {
  return values.find((value) => goTrimSpace(value) !== '') ?? '';
}
