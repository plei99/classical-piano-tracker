import { afterEach, describe, expect, it } from 'vitest';
import { emptyProfile } from '../../core/config';
import { listModels } from './catalog';
import { type TestServer, jsonReply, startServer } from './testsupport';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('listModels', () => {
  it('returns fixed DeepSeek and Kimi choices', async () => {
    expect(await listModels('deepseek', emptyProfile({ provider: 'openai_compat' }))).toEqual([
      'deepseek-chat',
      'deepseek-reasoner',
    ]);
    expect(await listModels('kimi', emptyProfile({ provider: 'openai_compat' }))).toEqual(['kimi-k2.5']);
  });

  it('removes the OpenAI responses suffix and uses auth', async () => {
    server = await startServer(
      jsonReply('{"data":[{"id":"gpt-5.4"},{"id":"text-embedding-3-large"},{"id":"omni-moderation"},{"id":" a "}]}'),
    );
    const models = await listModels(
      'openai',
      emptyProfile({ provider: 'openai', apiKey: 'test-key', baseUrl: `${server.url}/v1/responses` }),
    );
    expect(models).toEqual(['a', 'gpt-5.4']);
    expect(server.requests[0]?.path).toBe('/v1/models');
    expect(server.requests[0]?.headers['authorization']).toBe('Bearer test-key');
  });

  it('uses the Anthropic models endpoint', async () => {
    server = await startServer(jsonReply('{"data":[{"id":"claude-sonnet-4-5"}]}'));
    const models = await listModels(
      'anthropic',
      emptyProfile({ provider: 'anthropic', apiKey: 'test-key', baseUrl: `${server.url}/v1/messages` }),
    );
    expect(models).toEqual(['claude-sonnet-4-5']);
    expect(server.requests[0]?.path).toBe('/v1/models');
    expect(server.requests[0]?.headers['x-api-key']).toBe('test-key');
    expect(server.requests[0]?.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('filters Google models to generateContent', async () => {
    server = await startServer(
      jsonReply(
        JSON.stringify({
          models: [
            {
              name: 'models/gemini-2.5-pro',
              baseModelId: 'gemini-2.5-pro',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/gemini-2.5-pro-001',
              baseModelId: 'gemini-2.5-pro',
              supportedGenerationMethods: [' GENERATECONTENT '],
            },
            { name: 'models/gemini-flash', supportedGenerationMethods: ['generateContent'] },
            {
              name: 'models/text-embedding-004',
              baseModelId: 'text-embedding-004',
              supportedGenerationMethods: ['embedContent'],
            },
          ],
        }),
      ),
    );
    const models = await listModels(
      'google',
      emptyProfile({ provider: 'google', apiKey: 'test key~*', baseUrl: `${server.url}/v1beta/models?alt=json` }),
    );
    expect(models).toEqual(['gemini-2.5-pro', 'gemini-flash']);
    expect(server.requests[0]?.path).toBe('/v1beta/models');
    // As in Go, "/models" is appended after the existing query, and
    // Values.Encode sorts keys and QueryEscapes (space as +, ~ kept, * escaped).
    expect(server.requests[0]?.query).toBe('alt=json%2Fmodels&key=test+key~%2A');
  });

  it('uses the Ollama tags endpoint', async () => {
    server = await startServer(jsonReply('{"models":[{"name":"qwen2.5:latest"},{"name":"llama3.1:8b"}]}'));
    const models = await listModels('ollama', emptyProfile({ provider: 'openai_compat', baseUrl: `${server.url}/v1` }));
    expect(models).toEqual(['llama3.1:8b', 'qwen2.5:latest']);
    expect(server.requests[0]?.path).toBe('/api/tags');
  });

  it('returns fixed claude_cli choices', async () => {
    expect(await listModels('claude_cli', emptyProfile({ provider: 'claude_cli' }))).toEqual([
      'sonnet',
      'opus',
      'haiku',
      'fable',
    ]);
  });

  it('reports unsupported providers and missing keys', async () => {
    await expect(listModels('x', emptyProfile({ provider: 'codex' }))).rejects.toThrow(
      'Codex CLI model listing is unavailable; omit model to use the CLI default or enter a model ID manually',
    );
    await expect(listModels('custom', emptyProfile({ provider: 'openai_compat' }))).rejects.toThrow(
      'model listing is not implemented for openai_compat profile "custom"',
    );
    await expect(listModels('x', emptyProfile({ provider: 'mystery' }))).rejects.toThrow(
      'model listing is not implemented for provider "mystery"',
    );
    await expect(listModels('openai', emptyProfile({ provider: 'openai' }))).rejects.toThrow(
      'OpenAI API key is required to list models',
    );
    await expect(listModels('anthropic', emptyProfile({ provider: 'anthropic' }))).rejects.toThrow(
      'Anthropic API key is required to list models',
    );
    await expect(listModels('google', emptyProfile({ provider: 'google' }))).rejects.toThrow(
      'Google API key is required to list models',
    );
  });

  it('wraps HTTP and decode failures', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(401);
      res.end(' nope ');
    });
    await expect(
      listModels('openai', emptyProfile({ provider: 'openai', apiKey: 'k', baseUrl: `${server.url}/v1/responses` })),
    ).rejects.toThrow(`list OpenAI models: ${server.url}/v1/models returned 401 Unauthorized: nope`);
    await server.close();

    server = await startServer(jsonReply('{"data":5}'));
    await expect(
      listModels(
        'anthropic',
        emptyProfile({ provider: 'anthropic', apiKey: 'k', baseUrl: `${server.url}/v1/messages` }),
      ),
    ).rejects.toThrow(
      `list Anthropic models: decode response "${server.url}/v1/models": json: cannot unmarshal number into Go struct field anthropicModelsEnvelope.data of type []struct { ID string "json:\\"id\\"" }`,
    );
  });
});
