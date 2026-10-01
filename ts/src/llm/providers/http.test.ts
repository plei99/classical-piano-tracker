import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from '..';
import { errorChainIncludes } from '../context';
import { AnthropicProvider } from './anthropic';
import { DEFAULT_GOOGLE_MODEL, GoogleProvider } from './google';
import { OpenAIProvider, newOpenAIFromConfig } from './openai';
import { OpenAICompatProvider } from './openaicompat';
import { type TestServer, jsonReply, startServer } from './testsupport';

const DISCOVERY_JSON =
  '{\\"summary\\":\\"You like vivid, high-energy pianists.\\",\\"recommendations\\":[{\\"pianist_name\\":\\"Radu Lupu\\",\\"why_fit\\":\\"lyrical contrast\\",\\"similar_to\\":[\\"Martha Argerich\\"],\\"confidence\\":\\"medium\\"}]}';

function request(overrides: Partial<Request> = {}): Request {
  return {
    systemPrompt: 'system prompt',
    userPrompt: 'user prompt',
    outputMode: 'strict',
    schema: { name: 'pianist_discovery', schema: { type: 'object' }, strict: true },
    temperature: 0,
    maxOutputTokens: 0,
    ...overrides,
  };
}

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('OpenAIProvider', () => {
  it('uses a structured request and parses the response text', async () => {
    server = await startServer(jsonReply(`{"output_text":"${DISCOVERY_JSON}"}`));
    const provider = new OpenAIProvider('test-key', 'gpt-4o-mini', server.url);
    const raw = await provider.generate(request());
    expect(raw).not.toBe('');

    const got = server.requests[0];
    expect(got?.method).toBe('POST');
    expect(got?.headers['authorization']).toBe('Bearer test-key');
    const body = JSON.parse(got?.body ?? '') as { text: { format: { type: string } } };
    expect(body.text.format.type).toBe('json_schema');
  });

  it('uses a longer default timeout', () => {
    const provider = new OpenAIProvider('test-key', 'gpt-5.4', 'https://api.openai.com/v1/responses');
    expect(provider.timeoutMs).toBe(90_000);
    expect(provider.timeoutMs).toBeGreaterThan(30_000);
  });

  it('applies constructor defaults and validation', () => {
    expect(() => new OpenAIProvider(' ', '', '')).toThrow('OpenAI API key is required');
    const provider = new OpenAIProvider('k', ' ', '');
    expect(provider.model).toBe('gpt-5.4');
    expect(provider.baseURL).toBe('https://api.openai.com/v1/responses');
  });

  it('resolves the legacy config block with env overrides first', () => {
    try {
      vi.stubEnv('OPENAI_API_KEY', '');
      vi.stubEnv('OPENAI_MODEL', '');
      vi.stubEnv('OPENAI_BASE_URL', '');
      expect(() => newOpenAIFromConfig({ apiKey: '' })).toThrow(
        'OpenAI API key is required; set OPENAI_API_KEY or configure openai.api_key',
      );
      expect(newOpenAIFromConfig({ apiKey: ' legacy ' }).apiKey).toBe('legacy');
      vi.stubEnv('OPENAI_API_KEY', 'env-key');
      vi.stubEnv('OPENAI_MODEL', 'env-model');
      const provider = newOpenAIFromConfig({ apiKey: 'legacy' });
      expect([provider.apiKey, provider.model]).toEqual(['env-key', 'env-model']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('honors cancellation and timeouts with Go context wording', async () => {
    server = await startServer(() => {
      // Never respond.
    });
    const controller = new AbortController();
    const pending = new OpenAIProvider('k', 'm', server.url).generate(request(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(`call OpenAI Responses API: Post "${server.url}": context canceled`);

    const slow = new OpenAIProvider('k', 'm', server.url, { timeoutMs: 20 });
    await expect(slow.generate(request())).rejects.toThrow(
      `call OpenAI Responses API: Post "${server.url}": context deadline exceeded (Client.Timeout exceeded while awaiting headers)`,
    );
  });

  it('wraps connection failures', async () => {
    const closed = await startServer(jsonReply('{}'));
    await closed.close();
    const err = await new OpenAIProvider('k', 'm', closed.url).generate(request()).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(new RegExp(`^call OpenAI Responses API: Post "${closed.url}": `));
    expect(errorChainIncludes(err, (e) => e instanceof Error)).toBe(true);
  });
});

describe('OpenAICompatProvider', () => {
  it('uses chat completions and optional auth', async () => {
    server = await startServer(jsonReply(`{"choices":[{"message":{"content":"${DISCOVERY_JSON}"}}]}`));
    const provider = new OpenAICompatProvider('', 'qwen2.5:latest', `${server.url}/v1`);
    const raw = await provider.generate(request({ outputMode: 'prompt_only', schema: null }));
    expect(raw).not.toBe('');

    const got = server.requests[0];
    expect(got?.method).toBe('POST');
    expect(got?.path).toBe('/v1/chat/completions');
    expect(got?.headers['authorization']).toBeUndefined();
    const body = JSON.parse(got?.body ?? '') as { model: string; messages: unknown[] };
    expect(body.model).toBe('qwen2.5:latest');
    expect(body.messages).toHaveLength(2);
  });

  it('uses auth when an API key is present', async () => {
    server = await startServer(jsonReply('{"choices":[{"message":{"content":"ok"}}]}'));
    const provider = new OpenAICompatProvider('test-key', 'deepseek-chat', server.url);
    await provider.generate(request({ schema: null }));
    expect(server.requests[0]?.headers['authorization']).toBe('Bearer test-key');
  });

  it('requires a model and keeps an explicit chat completions endpoint', async () => {
    expect(() => new OpenAICompatProvider('', ' ', '')).toThrow('OpenAI-compatible model is required');
    expect(new OpenAICompatProvider('', 'm', '').baseURL).toBe('http://localhost:11434/v1');
    server = await startServer(jsonReply('{"choices":[{"message":{"content":"ok"}}]}'));
    await new OpenAICompatProvider('', 'm', `${server.url}/x/chat/completions/`).generate(request());
    expect(server.requests[0]?.path).toBe('/x/chat/completions');
  });
});

describe('AnthropicProvider', () => {
  it('uses a tool schema and parses tool input', async () => {
    server = await startServer(
      jsonReply(
        '{"content":[{"type":"tool_use","name":"emit_recommendations","input":{"summary":"You like vivid, high-energy pianists.","recommendations":[{"pianist_name":"Radu Lupu","why_fit":"lyrical contrast","similar_to":["Martha Argerich"],"confidence":"medium"}]}}]}',
      ),
    );
    const provider = new AnthropicProvider('test-key', 'claude-sonnet-4-5', server.url);
    const raw = await provider.generate(request());
    expect(raw).not.toBe('');

    const got = server.requests[0];
    expect(got?.method).toBe('POST');
    expect(got?.headers['x-api-key']).toBe('test-key');
    expect(got?.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(got?.body ?? '') as {
      tools: Array<{ name: string }>;
      messages: Array<{ content: unknown[] }>;
      max_tokens: number;
    };
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]?.name).toBe('emit_recommendations');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.content).toHaveLength(1);
    expect(body.max_tokens).toBe(1024);
  });

  it('uses a longer default timeout', () => {
    const provider = new AnthropicProvider('test-key', 'claude-sonnet-4-5', 'https://api.anthropic.com/v1/messages');
    expect(provider.timeoutMs).toBe(90_000);
    expect(provider.timeoutMs).toBeGreaterThan(30_000);
    expect(() => new AnthropicProvider('', '', '')).toThrow('Anthropic API key is required');
  });
});

describe('GoogleProvider', () => {
  it('uses a JSON schema and parses the response text', async () => {
    server = await startServer(jsonReply(`{"candidates":[{"content":{"parts":[{"text":"${DISCOVERY_JSON}"}]}}]}`));
    const provider = new GoogleProvider('test-key', 'gemini-2.5-pro', server.url);
    const raw = await provider.generate(request());
    expect(raw).not.toBe('');

    const got = server.requests[0];
    expect(got?.method).toBe('POST');
    expect(got?.path).toBe('/gemini-2.5-pro:generateContent');
    expect(got?.headers['x-goog-api-key']).toBe('test-key');
    const body = JSON.parse(got?.body ?? '') as {
      generationConfig: { responseMimeType: string; responseJsonSchema: unknown };
    };
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(typeof body.generationConfig.responseJsonSchema).toBe('object');
  });

  it('uses a longer default timeout', () => {
    const provider = new GoogleProvider('test-key', '', '');
    expect(provider.timeoutMs).toBe(90_000);
    expect(provider.model).toBe(DEFAULT_GOOGLE_MODEL);
    expect(provider.baseURL).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(() => new GoogleProvider('', '', '')).toThrow('Google API key is required');
  });
});
