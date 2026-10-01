import {
  type GoMap,
  field,
  goMapAny,
  goMarshal,
  goPointer,
  goSlice,
  goString,
  goStruct,
  goUnmarshal,
} from '../../recommend/gojson';
import { goTrimSpace } from '../../recommend/gostrings';
import type { Provider, Request } from '..';
import { DEFAULT_PROVIDER_TIMEOUT_MS, type HttpOptions, bodyText, postJSON, resolveHttpOptions } from './http';
import { type ApiError, apiErrorDecoder } from './openai';

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';
export const DEFAULT_ANTHROPIC_TIMEOUT_MS = DEFAULT_PROVIDER_TIMEOUT_MS;
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_TOOL_NAME = 'emit_recommendations';

interface AnthropicResponseEnvelope {
  content: Array<{ type: string; text: string; name: string; input: GoMap | null }>;
  error: ApiError | null;
}

const contentType =
  'struct { Type string "json:\\"type\\""; Text string "json:\\"text\\""; Name string "json:\\"name\\""; Input map[string]interface {} "json:\\"input\\"" }';

const anthropicEnvelopeDecoder = goStruct<AnthropicResponseEnvelope>('providers.anthropicResponseEnvelope', [
  field(
    'content',
    'content',
    goSlice(
      goStruct(contentType, [
        field('type', 'type', goString),
        field('text', 'text', goString),
        field('name', 'name', goString),
        field('input', 'input', goMapAny),
      ]),
      `[]${contentType}`,
    ),
  ),
  field('error', 'error', goPointer(apiErrorDecoder)),
]);

/**
 * Anthropic's Messages API. When a schema is supplied, the provider forces a
 * tool call so Claude returns JSON-shaped tool input instead of free text.
 */
export class AnthropicProvider implements Provider {
  readonly apiKey: string;
  readonly model: string;
  readonly baseURL: string;
  readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, model: string, baseURL: string, options?: HttpOptions) {
    if (goTrimSpace(apiKey) === '') {
      throw new Error('Anthropic API key is required');
    }
    const http = resolveHttpOptions(options, DEFAULT_ANTHROPIC_TIMEOUT_MS);
    this.apiKey = apiKey;
    this.model = goTrimSpace(model) === '' ? DEFAULT_ANTHROPIC_MODEL : model;
    this.baseURL = goTrimSpace(baseURL) === '' ? DEFAULT_ANTHROPIC_BASE_URL : baseURL;
    this.timeoutMs = http.timeoutMs;
    this.fetchImpl = http.fetch;
  }

  async generate(req: Request, signal?: AbortSignal): Promise<string> {
    const payload = this.buildRequest(req);
    const resp = await postJSON(
      this.baseURL,
      { 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'Content-Type': 'application/json' },
      payload,
      { fetch: this.fetchImpl, timeoutMs: this.timeoutMs },
      { build: 'build Anthropic request', call: 'call Anthropic Messages API', read: 'read Anthropic response' },
      signal,
    );
    if (resp.status >= 400) {
      throw new Error(`Anthropic Messages API returned ${resp.statusLine}: ${bodyText(resp)}`);
    }

    let envelope: AnthropicResponseEnvelope;
    try {
      envelope = goUnmarshal(resp.body, anthropicEnvelopeDecoder);
    } catch (err) {
      throw new Error(`decode Anthropic response envelope: ${(err as Error).message}`, { cause: err });
    }
    if (envelope.error !== null && goTrimSpace(envelope.error.message) !== '') {
      throw new Error(envelope.error.message);
    }

    for (const item of envelope.content) {
      if (item.type === 'tool_use' && item.input !== null && Object.keys(item.input).length > 0) {
        try {
          return goMarshal(item.input, { sortKeys: true });
        } catch (err) {
          throw new Error(`marshal Anthropic tool result: ${(err as Error).message}`, { cause: err });
        }
      }
    }

    const parts = envelope.content.map((item) => item.text).filter((text) => goTrimSpace(text) !== '');
    const raw = goTrimSpace(parts.join('\n'));
    if (raw === '') {
      throw new Error('Anthropic response did not include tool output or text content');
    }
    return raw;
  }

  /** The exact request body (a Go map, so keys are sorted). */
  buildRequest(req: Request): string {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: Math.max(req.maxOutputTokens, 1024),
      system: req.systemPrompt,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: req.userPrompt }],
        },
      ],
    };
    if (req.temperature > 0) {
      body['temperature'] = req.temperature;
    }
    if (req.schema !== null) {
      body['tools'] = [
        {
          name: ANTHROPIC_TOOL_NAME,
          description:
            'Return the final pianist recommendation result as structured JSON. The input must include both a non-empty summary and a non-empty recommendations array.',
          input_schema: req.schema.schema,
        },
      ];
      body['tool_choice'] = { type: 'tool', name: ANTHROPIC_TOOL_NAME };
    }
    try {
      return goMarshal(body, { sortKeys: true });
    } catch (err) {
      throw new Error(`marshal Anthropic request: ${(err as Error).message}`, { cause: err });
    }
  }
}
