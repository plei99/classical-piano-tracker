import { field, goMarshal, goPointer, goSlice, goString, goStruct, goUnmarshal } from '../../recommend/gojson';
import { goTrimSpace, trimRightChar } from '../../recommend/gostrings';
import type { Provider, Request } from '..';
import { DEFAULT_PROVIDER_TIMEOUT_MS, type HttpOptions, bodyText, postJSON, resolveHttpOptions } from './http';

export const DEFAULT_GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
export const DEFAULT_GOOGLE_MODEL = 'gemini-2.5-pro';
export const DEFAULT_GOOGLE_TIMEOUT_MS = DEFAULT_PROVIDER_TIMEOUT_MS;

interface GoogleResponseEnvelope {
  candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  error: { message: string; status: string } | null;
}

const partType = 'struct { Text string "json:\\"text\\"" }';
const contentType = `struct { Parts []${partType} "json:\\"parts\\"" }`;
const candidateType = `struct { Content ${contentType} "json:\\"content\\"" }`;
const errorType = 'struct { Message string "json:\\"message\\""; Status string "json:\\"status\\"" }';

const googleEnvelopeDecoder = goStruct<GoogleResponseEnvelope>('providers.googleResponseEnvelope', [
  field(
    'candidates',
    'candidates',
    goSlice(
      goStruct(candidateType, [
        field(
          'content',
          'content',
          goStruct(contentType, [
            field('parts', 'parts', goSlice(goStruct(partType, [field('text', 'text', goString)]), `[]${partType}`)),
          ]),
        ),
      ]),
      `[]${candidateType}`,
    ),
  ),
  field(
    'error',
    'error',
    goPointer(goStruct(errorType, [field('message', 'message', goString), field('status', 'status', goString)])),
  ),
]);

/** Gemini's generateContent endpoint, requesting JSON output when a schema is supplied. */
export class GoogleProvider implements Provider {
  readonly apiKey: string;
  readonly model: string;
  readonly baseURL: string;
  readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, model: string, baseURL: string, options?: HttpOptions) {
    if (goTrimSpace(apiKey) === '') {
      throw new Error('Google API key is required');
    }
    const http = resolveHttpOptions(options, DEFAULT_GOOGLE_TIMEOUT_MS);
    this.apiKey = apiKey;
    this.model = goTrimSpace(model) === '' ? DEFAULT_GOOGLE_MODEL : model;
    this.baseURL = trimRightChar(goTrimSpace(baseURL) === '' ? DEFAULT_GOOGLE_BASE_URL : baseURL, '/');
    this.timeoutMs = http.timeoutMs;
    this.fetchImpl = http.fetch;
  }

  async generate(req: Request, signal?: AbortSignal): Promise<string> {
    const payload = this.buildRequest(req);
    const endpoint = `${this.baseURL}/${this.model}:generateContent`;
    const resp = await postJSON(
      endpoint,
      { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
      payload,
      { fetch: this.fetchImpl, timeoutMs: this.timeoutMs },
      { build: 'build Google request', call: 'call Gemini generateContent API', read: 'read Google response' },
      signal,
    );
    if (resp.status >= 400) {
      throw new Error(`Gemini generateContent API returned ${resp.statusLine}: ${bodyText(resp)}`);
    }

    let envelope: GoogleResponseEnvelope;
    try {
      envelope = goUnmarshal(resp.body, googleEnvelopeDecoder);
    } catch (err) {
      throw new Error(`decode Google response envelope: ${(err as Error).message}`, { cause: err });
    }
    if (envelope.error !== null && goTrimSpace(envelope.error.message) !== '') {
      throw new Error(envelope.error.message);
    }

    for (const candidate of envelope.candidates) {
      for (const part of candidate.content.parts) {
        const raw = goTrimSpace(part.text);
        if (raw !== '') {
          return raw;
        }
      }
    }
    throw new Error('Gemini response did not include generated text');
  }

  /** The exact request body (a Go map, so keys are sorted). */
  buildRequest(req: Request): string {
    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: req.userPrompt }] }],
    };
    if (goTrimSpace(req.systemPrompt) !== '') {
      body['systemInstruction'] = { parts: [{ text: req.systemPrompt }] };
    }
    const generationConfig: Record<string, unknown> = {};
    if (req.temperature > 0) {
      generationConfig['temperature'] = req.temperature;
    }
    if (req.maxOutputTokens > 0) {
      generationConfig['maxOutputTokens'] = req.maxOutputTokens;
    }
    if (req.schema !== null) {
      generationConfig['responseMimeType'] = 'application/json';
      generationConfig['responseJsonSchema'] = req.schema.schema;
    }
    if (Object.keys(generationConfig).length > 0) {
      body['generationConfig'] = generationConfig;
    }
    try {
      return goMarshal(body, { sortKeys: true });
    } catch (err) {
      throw new Error(`marshal Google request: ${(err as Error).message}`, { cause: err });
    }
  }
}
