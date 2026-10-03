import {
  field,
  goMarshal,
  goPointer,
  goRawMessage,
  goSlice,
  goString,
  goStruct,
  goUnmarshal,
} from '../../recommend/gojson';
import { goTrimSpace, trimRightChar } from '../../recommend/gostrings';
import type { Provider, Request } from '..';
import { DEFAULT_PROVIDER_TIMEOUT_MS, type HttpOptions, bodyText, postJSON, resolveHttpOptions } from './http';
import { type ApiError, apiErrorDecoder } from './openai';

export const DEFAULT_OPENAI_COMPAT_BASE_URL = 'http://localhost:11434/v1';
export const DEFAULT_OPENAI_COMPAT_TIMEOUT_MS = DEFAULT_PROVIDER_TIMEOUT_MS;

interface ChatCompletionsEnvelope {
  choices: Array<{ message: { content: string } }>;
  error: ApiError | null;
}

const messageType = 'struct { Content jsontext.Value "json:\\"content\\"" }';
const choiceType = `struct { Message ${messageType} "json:\\"message\\"" }`;

const chatCompletionsEnvelopeDecoder = goStruct<ChatCompletionsEnvelope>('providers.chatCompletionsEnvelope', [
  field(
    'choices',
    'choices',
    goSlice(
      goStruct(choiceType, [
        field('message', 'message', goStruct(messageType, [field('content', 'content', goRawMessage)])),
      ]),
      `[]${choiceType}`,
    ),
  ),
  field('error', 'error', goPointer(apiErrorDecoder)),
]);

const textPartType = 'struct { Text string "json:\\"text\\"" }';
const textPartsDecoder = goSlice(
  goStruct<{ text: string }>(textPartType, [field('text', 'text', goString)]),
  `[]${textPartType}`,
);

/**
 * A Chat Completions adapter for OpenAI-compatible APIs such as Ollama,
 * Kimi, and DeepSeek. It relies on the shared discovery repair/fallback
 * logic instead of provider-specific JSON features that many compatible
 * backends only partially implement.
 */
export class OpenAICompatProvider implements Provider {
  readonly apiKey: string;
  readonly model: string;
  readonly baseURL: string;
  readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, model: string, baseURL: string, options?: HttpOptions) {
    if (goTrimSpace(model) === '') {
      throw new Error('OpenAI-compatible model is required');
    }
    if (goTrimSpace(baseURL) === '') {
      baseURL = DEFAULT_OPENAI_COMPAT_BASE_URL;
    }
    const http = resolveHttpOptions(options, DEFAULT_OPENAI_COMPAT_TIMEOUT_MS);
    this.apiKey = goTrimSpace(apiKey);
    this.model = goTrimSpace(model);
    this.baseURL = trimRightChar(baseURL, '/');
    this.timeoutMs = http.timeoutMs;
    this.fetchImpl = http.fetch;
  }

  async generate(req: Request, signal?: AbortSignal): Promise<string> {
    const payload = this.buildRequest(req);
    let endpoint = this.baseURL;
    if (!endpoint.endsWith('/chat/completions')) {
      endpoint += '/chat/completions';
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey !== '') {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    const resp = await postJSON(
      endpoint,
      headers,
      payload,
      { fetch: this.fetchImpl, timeoutMs: this.timeoutMs },
      {
        build: 'build OpenAI-compatible request',
        call: 'call OpenAI-compatible chat completions API',
        read: 'read OpenAI-compatible response',
      },
      signal,
    );
    if (resp.status >= 400) {
      throw new Error(`OpenAI-compatible chat completions API returned ${resp.statusLine}: ${bodyText(resp)}`);
    }

    let envelope: ChatCompletionsEnvelope;
    try {
      envelope = goUnmarshal(resp.body, chatCompletionsEnvelopeDecoder);
    } catch (err) {
      throw new Error(`decode OpenAI-compatible response envelope: ${(err as Error).message}`, { cause: err });
    }
    if (envelope.error !== null && goTrimSpace(envelope.error.message) !== '') {
      throw new Error(envelope.error.message);
    }

    for (const choice of envelope.choices) {
      const raw = goTrimSpace(extractChatMessageContent(choice.message.content));
      if (raw !== '') {
        return raw;
      }
    }
    throw new Error('OpenAI-compatible response did not include message content');
  }

  /** The exact request body (a Go map, so keys are sorted). */
  buildRequest(req: Request): string {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.userPrompt },
      ],
    };
    if (req.temperature > 0) {
      body['temperature'] = req.temperature;
    }
    if (req.maxOutputTokens > 0) {
      body['max_tokens'] = req.maxOutputTokens;
    }
    try {
      return goMarshal(body, { sortKeys: true });
    } catch (err) {
      throw new Error(`marshal OpenAI-compatible request: ${(err as Error).message}`, { cause: err });
    }
  }
}

/** Message content is either a string or a list of `{"text": ...}` parts. */
function extractChatMessageContent(raw: string): string {
  if (raw === '') {
    return '';
  }
  try {
    return goUnmarshal(raw, goString);
  } catch {
    // Not a string; try the content-parts form.
  }
  try {
    return goUnmarshal(raw, textPartsDecoder)
      .map((part) => part.text)
      .filter((text) => goTrimSpace(text) !== '')
      .join('\n');
  } catch {
    return '';
  }
}
