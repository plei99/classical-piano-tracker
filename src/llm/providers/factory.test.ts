import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Config, emptyConfig, emptyProfile } from '../../core/config';
import { AnthropicProvider } from './anthropic';
import { ClaudeCLIProvider } from './claudecli';
import { CodexProvider } from './codex';
import { fromConfig } from './factory';
import { GoogleProvider } from './google';
import { OpenAIProvider } from './openai';
import { OpenAICompatProvider } from './openaicompat';

const ENV_VARS = [
  'LLM_PROFILE',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_COMMAND',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'KIMI_API_KEY',
];

// Isolate from the developer's real environment, as each Go test does with t.Setenv.
beforeEach(() => {
  for (const name of ENV_VARS) {
    vi.stubEnv(name, '');
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function config(activeProfile: string, profiles: Config['llm']['profiles']): Config {
  return { ...emptyConfig(), llm: { activeProfile, profiles } };
}

describe('fromConfig', () => {
  it('uses the LLM profile and generic env overrides', () => {
    vi.stubEnv('LLM_MODEL', 'override-model');
    vi.stubEnv('LLM_BASE_URL', 'https://override.example/v1');
    vi.stubEnv('LLM_API_KEY', 'override-key');

    const provider = fromConfig(
      config('openai', {
        openai: emptyProfile({
          provider: 'openai',
          model: 'config-model',
          apiKey: 'config-key',
          baseUrl: 'https://config.example/v1',
        }),
      }),
    );
    expect(provider).toBeInstanceOf(OpenAIProvider);
    const openAI = provider as OpenAIProvider;
    expect(openAI.model).toBe('override-model');
    expect(openAI.baseURL).toBe('https://override.example/v1');
    expect(openAI.apiKey).toBe('override-key');
  });

  it('falls back to the legacy OpenAI block', () => {
    const provider = fromConfig({ ...emptyConfig(), openai: { apiKey: 'legacy-key' } });
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect((provider as OpenAIProvider).apiKey).toBe('legacy-key');
    expect((provider as OpenAIProvider).model).toBe('gpt-5.4');
  });

  it('supports an Anthropic profile', () => {
    const provider = fromConfig(
      config('anthropic', {
        anthropic: emptyProfile({ provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'key' }),
      }),
    );
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect((provider as AnthropicProvider).model).toBe('claude-sonnet-4-5');
  });

  it('supports a Google profile', () => {
    const provider = fromConfig(
      config('google', { google: emptyProfile({ provider: 'google', model: 'gemini-2.5-pro', apiKey: 'key' }) }),
    );
    expect(provider).toBeInstanceOf(GoogleProvider);
    expect((provider as GoogleProvider).model).toBe('gemini-2.5-pro');
  });

  it('supports an OpenAI-compatible profile', () => {
    const provider = fromConfig(
      config('ollama', { ollama: emptyProfile({ provider: 'openai_compat', model: 'qwen2.5:latest' }) }),
    );
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    expect((provider as OpenAICompatProvider).baseURL).toBe('http://localhost:11434/v1');
    expect((provider as OpenAICompatProvider).apiKey).toBe('');
  });

  it('uses the DeepSeek API key fallback and default base URL', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'deepseek-key');
    const provider = fromConfig(
      config('deepseek', { deepseek: emptyProfile({ provider: 'openai_compat', model: 'deepseek-chat' }) }),
    );
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    expect((provider as OpenAICompatProvider).apiKey).toBe('deepseek-key');
    expect((provider as OpenAICompatProvider).baseURL).toBe('https://api.deepseek.com/v1');

    vi.stubEnv('KIMI_API_KEY', 'kimi-key');
    const kimi = fromConfig(config('Kimi', { Kimi: emptyProfile({ provider: 'openai_compat', model: 'kimi-k2.5' }) }));
    expect((kimi as OpenAICompatProvider).apiKey).toBe('kimi-key');
    expect((kimi as OpenAICompatProvider).baseURL).toBe('https://api.moonshot.ai/v1');
  });

  it('supports a claude_cli profile without an API key', () => {
    const provider = fromConfig(
      config('claude_cli', {
        claude_cli: emptyProfile({ provider: 'claude_cli', model: 'opus', command: '/opt/bin/claude' }),
      }),
    );
    expect(provider).toBeInstanceOf(ClaudeCLIProvider);
    expect((provider as ClaudeCLIProvider).model).toBe('opus');
    expect((provider as ClaudeCLIProvider).command).toBe('/opt/bin/claude');
  });

  it('honors the LLM_COMMAND override for claude_cli', () => {
    vi.stubEnv('LLM_COMMAND', '/override/claude');
    const provider = fromConfig(
      config('claude_cli', { claude_cli: emptyProfile({ provider: 'claude_cli', command: '/config/claude' }) }),
    );
    expect((provider as ClaudeCLIProvider).command).toBe('/override/claude');
  });

  it('supports codex without a key or model', () => {
    const cfg = config('local-codex', {
      'local-codex': emptyProfile({ provider: 'codex', command: '/opt/bin/codex' }),
    });
    let provider = fromConfig(cfg);
    expect(provider).toBeInstanceOf(CodexProvider);
    expect((provider as CodexProvider).model).toBe('');
    expect((provider as CodexProvider).command).toBe('/opt/bin/codex');

    vi.stubEnv('LLM_MODEL', 'override-model');
    vi.stubEnv('LLM_COMMAND', '/override/codex');
    provider = fromConfig(cfg);
    expect((provider as CodexProvider).model).toBe('override-model');
    expect((provider as CodexProvider).command).toBe('/override/codex');
  });

  it('applies LLM_PROFILE, LLM_PROVIDER, and the OpenAI-only env gap fillers', () => {
    vi.stubEnv('LLM_PROFILE', 'second');
    vi.stubEnv('LLM_PROVIDER', 'OpenAI');
    vi.stubEnv('OPENAI_MODEL', 'env-model');
    vi.stubEnv('OPENAI_BASE_URL', 'https://env.example/v1/responses');
    vi.stubEnv('OPENAI_API_KEY', 'env-key');
    const provider = fromConfig(
      config('first', {
        first: emptyProfile({ provider: 'anthropic', apiKey: 'a' }),
        second: emptyProfile({ provider: 'google' }),
      }),
    );
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect((provider as OpenAIProvider).model).toBe('env-model');
    expect((provider as OpenAIProvider).baseURL).toBe('https://env.example/v1/responses');
    expect((provider as OpenAIProvider).apiKey).toBe('env-key');
  });

  it('reports unknown profiles and providers', () => {
    expect(() => fromConfig(config('missing', { other: emptyProfile({ provider: 'openai' }) }))).toThrow(
      'LLM profile "missing" was not found in llm.profiles',
    );
    // Prototype keys are not profiles.
    expect(() => fromConfig(config('toString', { other: emptyProfile() }))).toThrow(
      'LLM profile "toString" was not found in llm.profiles',
    );
    expect(() => fromConfig(config('x', { x: emptyProfile({ provider: 'mystery' }) }))).toThrow(
      'LLM provider "mystery" for profile "x" is not implemented yet',
    );
    // A blank provider defaults to OpenAI, which then needs a key.
    expect(() => fromConfig(config('x', { x: emptyProfile() }))).toThrow('OpenAI API key is required');
    expect(() => fromConfig(null)).toThrow('OpenAI API key is required');
  });
});
