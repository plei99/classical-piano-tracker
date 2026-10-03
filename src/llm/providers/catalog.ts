/**
 * Onboarding model lists. Dynamic providers use their listing APIs;
 * DeepSeek and Kimi use fixed options.
 */
import type { LlmProfile } from '../../core/config';
import { compareGoStrings } from '../../core/gojson';
import { type GoDecoder, field, goQuote, goSlice, goString, goStruct, goUnmarshal } from '../../recommend/gojson';
import { goEqualFold, goToLower, goTrimSpace, trimPrefix, trimRightChar, trimSuffix } from '../../recommend/gostrings';
import { ANTHROPIC_VERSION, DEFAULT_ANTHROPIC_BASE_URL } from './anthropic';
import { CLAUDE_CLI_MODELS } from './claudecli';
import { DEFAULT_GOOGLE_BASE_URL } from './google';
import { formatURL, parseURL, setQueryParam } from './gourl';
import { HttpError, bodyText, httpRequest } from './http';
import { DEFAULT_OPENAI_BASE_URL } from './openai';
import { DEFAULT_OPENAI_COMPAT_BASE_URL } from './openaicompat';

const DEFAULT_MODEL_LIST_TIMEOUT_MS = 30_000;

/** Onboarding-friendly model identifiers for a profile. */
export async function listModels(profileName: string, profile: LlmProfile, signal?: AbortSignal): Promise<string[]> {
  switch (goToLower(goTrimSpace(profile.provider))) {
    case 'openai':
      return listOpenAIModels(profile, signal);
    case 'anthropic':
      return listAnthropicModels(profile, signal);
    case 'google':
      return listGoogleModels(profile, signal);
    case 'claude_cli':
      return [...CLAUDE_CLI_MODELS];
    case 'codex':
      throw new Error(
        'Codex CLI model listing is unavailable; omit model to use the CLI default or enter a model ID manually',
      );
    case 'openai_compat':
      switch (goToLower(goTrimSpace(profileName))) {
        case 'ollama':
          return listOllamaModels(profile, signal);
        case 'deepseek':
          return ['deepseek-chat', 'deepseek-reasoner'];
        case 'kimi':
          return ['kimi-k2.5'];
        default:
          throw new Error(`model listing is not implemented for openai_compat profile ${goQuote(profileName)}`);
      }
    default:
      throw new Error(`model listing is not implemented for provider ${goQuote(profile.provider)}`);
  }
}

const idItemType = 'struct { ID string "json:\\"id\\"" }';

function idListDecoder(goType: string): GoDecoder<{ data: Array<{ id: string }> }> {
  return goStruct(goType, [
    field('data', 'data', goSlice(goStruct(idItemType, [field('id', 'id', goString)]), `[]${idItemType}`)),
  ]);
}

const openAIModelsDecoder = idListDecoder('providers.openAIModelsEnvelope');
const anthropicModelsDecoder = idListDecoder('providers.anthropicModelsEnvelope');

const googleModelType =
  'struct { Name string "json:\\"name\\""; BaseModelID string "json:\\"baseModelId\\""; SupportedGenerationMethods []string "json:\\"supportedGenerationMethods\\"" }';
const googleModelsDecoder = goStruct<{
  models: Array<{ name: string; baseModelId: string; supportedGenerationMethods: string[] }>;
}>('providers.googleModelsEnvelope', [
  field(
    'models',
    'models',
    goSlice(
      goStruct(googleModelType, [
        field('name', 'name', goString),
        field('baseModelId', 'baseModelId', goString),
        field('supportedGenerationMethods', 'supportedGenerationMethods', goSlice(goString, '[]string')),
      ]),
      `[]${googleModelType}`,
    ),
  ),
]);

const ollamaModelType = 'struct { Name string "json:\\"name\\""; Model string "json:\\"model\\"" }';
const ollamaTagsDecoder = goStruct<{ models: Array<{ name: string; model: string }> }>('providers.ollamaTagsEnvelope', [
  field(
    'models',
    'models',
    goSlice(
      goStruct(ollamaModelType, [field('name', 'name', goString), field('model', 'model', goString)]),
      `[]${ollamaModelType}`,
    ),
  ),
]);

function sortedStrings(values: string[]): string[] {
  return values.sort(compareGoStrings);
}

async function listOpenAIModels(profile: LlmProfile, signal: AbortSignal | undefined): Promise<string[]> {
  if (goTrimSpace(profile.apiKey) === '') {
    throw new Error('OpenAI API key is required to list models');
  }
  const baseURL = goTrimSpace(profile.baseUrl) || DEFAULT_OPENAI_BASE_URL;
  const endpoint = siblingEndpoint(baseURL, 'models');

  let envelope: { data: Array<{ id: string }> };
  try {
    envelope = await getJSON(endpoint, { Authorization: `Bearer ${profile.apiKey}` }, openAIModelsDecoder, signal);
  } catch (err) {
    throw new Error(`list OpenAI models: ${(err as Error).message}`, { cause: err });
  }

  // Embedding and moderation models cannot generate recommendations.
  const models = envelope.data
    .map((item) => goTrimSpace(item.id))
    .filter((id) => id !== '' && !id.startsWith('text-embedding') && !id.includes('moderation'));
  return sortedStrings(models);
}

async function listAnthropicModels(profile: LlmProfile, signal: AbortSignal | undefined): Promise<string[]> {
  if (goTrimSpace(profile.apiKey) === '') {
    throw new Error('Anthropic API key is required to list models');
  }
  const baseURL = goTrimSpace(profile.baseUrl) || DEFAULT_ANTHROPIC_BASE_URL;
  const endpoint = siblingEndpoint(baseURL, 'models');

  let envelope: { data: Array<{ id: string }> };
  try {
    envelope = await getJSON(
      endpoint,
      { 'x-api-key': profile.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      anthropicModelsDecoder,
      signal,
    );
  } catch (err) {
    throw new Error(`list Anthropic models: ${(err as Error).message}`, { cause: err });
  }

  return sortedStrings(envelope.data.map((item) => goTrimSpace(item.id)).filter((id) => id !== ''));
}

async function listGoogleModels(profile: LlmProfile, signal: AbortSignal | undefined): Promise<string[]> {
  if (goTrimSpace(profile.apiKey) === '') {
    throw new Error('Google API key is required to list models');
  }
  const baseURL = goTrimSpace(profile.baseUrl) || DEFAULT_GOOGLE_BASE_URL;
  let endpoint = trimRightChar(baseURL, '/');
  if (!endpoint.endsWith('/models')) {
    endpoint += '/models';
  }
  let url;
  try {
    url = parseURL(endpoint);
  } catch (err) {
    throw new Error(`parse Google model list URL ${goQuote(endpoint)}: ${(err as Error).message}`, { cause: err });
  }
  url.rawQuery = setQueryParam(url.rawQuery, 'key', profile.apiKey);

  let envelope: { models: Array<{ name: string; baseModelId: string; supportedGenerationMethods: string[] }> };
  try {
    envelope = await getJSON(formatURL(url), {}, googleModelsDecoder, signal);
  } catch (err) {
    throw new Error(`list Google models: ${(err as Error).message}`, { cause: err });
  }

  const models = envelope.models
    .filter((item) =>
      item.supportedGenerationMethods.some((method) => goEqualFold(goTrimSpace(method), 'generateContent')),
    )
    .map((item) => goTrimSpace(firstNonEmpty(item.baseModelId, trimPrefix(item.name, 'models/'))))
    .filter((id) => id !== '');
  // Sort, then drop adjacent duplicates (slices.Compact).
  return sortedStrings(models).filter((id, idx, all) => idx === 0 || all[idx - 1] !== id);
}

async function listOllamaModels(profile: LlmProfile, signal: AbortSignal | undefined): Promise<string[]> {
  const baseURL = goTrimSpace(profile.baseUrl) || DEFAULT_OPENAI_COMPAT_BASE_URL;
  const endpoint = ollamaTagsEndpoint(baseURL);

  let envelope: { models: Array<{ name: string; model: string }> };
  try {
    envelope = await getJSON(endpoint, {}, ollamaTagsDecoder, signal);
  } catch (err) {
    throw new Error(`list Ollama models: ${(err as Error).message}`, { cause: err });
  }

  return sortedStrings(
    envelope.models.map((item) => goTrimSpace(firstNonEmpty(item.model, item.name))).filter((id) => id !== ''),
  );
}

async function getJSON<T>(
  endpoint: string,
  headers: Record<string, string>,
  decoder: GoDecoder<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  const quoted = goQuote(endpoint);
  let resp;
  try {
    resp = await httpRequest(
      'GET',
      endpoint,
      headers,
      undefined,
      { fetch: globalThis.fetch.bind(globalThis), timeoutMs: DEFAULT_MODEL_LIST_TIMEOUT_MS },
      signal,
    );
  } catch (err) {
    if (err instanceof HttpError) {
      const context = err.stage === 'build' ? 'build request' : err.stage === 'send' ? 'request' : 'read response';
      throw new Error(`${context} ${quoted}: ${err.message}`, { cause: err.cause ?? err });
    }
    throw err;
  }
  if (resp.status >= 400) {
    throw new Error(`${endpoint} returned ${resp.statusLine}: ${bodyText(resp)}`);
  }
  try {
    return goUnmarshal(resp.body, decoder);
  } catch (err) {
    throw new Error(`decode response ${quoted}: ${(err as Error).message}`, { cause: err });
  }
}

/**
 * Derives a sibling endpoint (e.g. `/v1/models`) from a configured
 * generation endpoint such as `/v1/responses` or `/v1/messages`.
 */
export function siblingEndpoint(baseURL: string, sibling: string): string {
  let url;
  try {
    url = parseURL(goTrimSpace(baseURL));
  } catch (err) {
    throw new Error(`parse base URL ${goQuote(baseURL)}: ${(err as Error).message}`, { cause: err });
  }

  let path = trimSuffix(url.path, '/');
  let trimmedKnownLeaf = false;
  for (const leaf of ['/responses', '/messages']) {
    if (path.endsWith(leaf)) {
      path = trimSuffix(path, leaf);
      trimmedKnownLeaf = true;
      break;
    }
  }

  if (path === '') {
    path = `/${sibling}`;
  } else if (trimmedKnownLeaf) {
    path = `${path}/${sibling}`;
  } else {
    const parts = path.split('/');
    parts[parts.length - 1] = sibling;
    path = parts.join('/');
  }
  url.path = path;
  url.rawQuery = '';
  url.forceQuery = false;
  return formatURL(url);
}

/** Ollama lists models at `/api/tags` on the same host. */
export function ollamaTagsEndpoint(baseURL: string): string {
  let url;
  try {
    url = parseURL(goTrimSpace(baseURL));
  } catch (err) {
    throw new Error(`parse Ollama base URL ${goQuote(baseURL)}: ${(err as Error).message}`, { cause: err });
  }
  url.rawQuery = '';
  url.forceQuery = false;
  url.path = '/api/tags';
  return formatURL(url);
}

function firstNonEmpty(...values: string[]): string {
  return values.find((value) => goTrimSpace(value) !== '') ?? '';
}
