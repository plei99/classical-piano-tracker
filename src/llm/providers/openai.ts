import { field, goMarshal, goPointer, goSlice, goString, goStruct, goUnmarshal } from '../../recommend/gojson';
import { goTrimSpace } from '../../recommend/gostrings';
import type { Provider, Request } from '..';
import { DEFAULT_PROVIDER_TIMEOUT_MS, type HttpOptions, bodyText, postJSON, resolveHttpOptions } from './http';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1/responses';
export const DEFAULT_OPENAI_MODEL = 'gpt-5.4';
export const DEFAULT_OPENAI_TIMEOUT_MS = DEFAULT_PROVIDER_TIMEOUT_MS;

export interface ApiError {
  message: string;
}

/** Go's `apiError`, the `{"error": {"message": ...}}` shape shared by several APIs. */
export const apiErrorDecoder = goStruct<ApiError>('providers.apiError', [field('message', 'message', goString)]);

interface ResponseEnvelope {
  outputText: string;
  output: Array<{ type: string; content: Array<{ type: string; text: string }> }>;
  error: ApiError | null;
}

const outputContentType = 'struct { Type string "json:\\"type\\""; Text string "json:\\"text\\"" }';
const outputItemType = `struct { Type string "json:\\"type\\""; Content []${outputContentType} "json:\\"content\\"" }`;

const responseEnvelopeDecoder = goStruct<ResponseEnvelope>('providers.responseEnvelope', [
  field('outputText', 'output_text', goString),
  field(
    'output',
    'output',
    goSlice(
      goStruct(outputItemType, [
        field('type', 'type', goString),
        field(
          'content',
          'content',
          goSlice(
            goStruct(outputContentType, [field('type', 'type', goString), field('text', 'text', goString)]),
            `[]${outputContentType}`,
          ),
        ),
      ]),
      `[]${outputItemType}`,
    ),
  ),
  field('error', 'error', goPointer(apiErrorDecoder)),
]);

/**
 * Resolves credentials and endpoint settings from env overrides first, then
 * falls back to the legacy persisted `openai` config block.
 */
export function newOpenAIFromConfig(cfg: { apiKey: string }): OpenAIProvider {
  let apiKey = goTrimSpace(process.env['OPENAI_API_KEY'] ?? '');
  if (apiKey === '') {
    apiKey = goTrimSpace(cfg.apiKey);
  }
  if (apiKey === '') {
    throw new Error('OpenAI API key is required; set OPENAI_API_KEY or configure openai.api_key');
  }
  const model = goTrimSpace(process.env['OPENAI_MODEL'] ?? '') || DEFAULT_OPENAI_MODEL;
  const baseURL = goTrimSpace(process.env['OPENAI_BASE_URL'] ?? '') || DEFAULT_OPENAI_BASE_URL;
  return new OpenAIProvider(apiKey, model, baseURL);
}

/** The OpenAI Responses API with strict JSON-schema output. */
export class OpenAIProvider implements Provider {
  readonly apiKey: string;
  readonly model: string;
  readonly baseURL: string;
  readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  /** The transport is injectable so behavior can be tested without network calls. */
  constructor(apiKey: string, model: string, baseURL: string, options?: HttpOptions) {
    if (goTrimSpace(apiKey) === '') {
      throw new Error('OpenAI API key is required');
    }
    const http = resolveHttpOptions(options, DEFAULT_OPENAI_TIMEOUT_MS);
    this.apiKey = apiKey;
    this.model = goTrimSpace(model) === '' ? DEFAULT_OPENAI_MODEL : model;
    this.baseURL = goTrimSpace(baseURL) === '' ? DEFAULT_OPENAI_BASE_URL : baseURL;
    this.timeoutMs = http.timeoutMs;
    this.fetchImpl = http.fetch;
  }

  async generate(req: Request, signal?: AbortSignal): Promise<string> {
    const payload = this.buildRequest(req);
    const resp = await postJSON(
      this.baseURL,
      { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      payload,
      { fetch: this.fetchImpl, timeoutMs: this.timeoutMs },
      { build: 'build OpenAI request', call: 'call OpenAI Responses API', read: 'read OpenAI response' },
      signal,
    );
    if (resp.status >= 400) {
      throw new Error(`OpenAI Responses API returned ${resp.statusLine}: ${bodyText(resp)}`);
    }

    let envelope: ResponseEnvelope;
    try {
      envelope = goUnmarshal(resp.body, responseEnvelopeDecoder);
    } catch (err) {
      throw new Error(`decode OpenAI response envelope: ${(err as Error).message}`, { cause: err });
    }
    if (envelope.error !== null && goTrimSpace(envelope.error.message) !== '') {
      throw new Error(envelope.error.message);
    }

    let raw = goTrimSpace(envelope.outputText);
    if (raw === '') {
      raw = extractOutputText(envelope);
    }
    if (raw === '') {
      throw new Error('OpenAI response did not include structured output text');
    }
    return raw;
  }

  /** The exact request body (a Go map, so keys are sorted). */
  buildRequest(req: Request): string {
    const body: Record<string, unknown> = {
      model: this.model,
      input: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.userPrompt },
      ],
    };
    if (req.schema !== null) {
      body['text'] = {
        format: {
          type: 'json_schema',
          name: req.schema.name,
          schema: req.schema.schema,
          strict: req.schema.strict,
        },
      };
    }
    try {
      return goMarshal(body, { sortKeys: true });
    } catch (err) {
      throw new Error(`marshal OpenAI request: ${(err as Error).message}`, { cause: err });
    }
  }
}

function extractOutputText(envelope: ResponseEnvelope): string {
  const parts: string[] = [];
  for (const item of envelope.output) {
    for (const content of item.content) {
      if (goTrimSpace(content.text) !== '') {
        parts.push(content.text);
      }
    }
  }
  return parts.join('\n');
}
