import { type Config, type LlmProfile, effectiveLlmConfig } from '../../core/config';
import { goQuote } from '../../recommend/gojson';
import { goEqualFold, goToLower, goTrimSpace } from '../../recommend/gostrings';
import type { Provider } from '..';
import { AnthropicProvider } from './anthropic';
import { ClaudeCLIProvider } from './claudecli';
import { CodexProvider } from './codex';
import { GoogleProvider } from './google';
import { OpenAIProvider } from './openai';
import { DEFAULT_OPENAI_COMPAT_BASE_URL, OpenAICompatProvider } from './openaicompat';

function getenv(key: string): string {
  return goTrimSpace(process.env[key] ?? '');
}

/**
 * Resolves the effective LLM profile from config and the LLM_PROFILE /
 * LLM_PROVIDER / LLM_MODEL / LLM_BASE_URL / LLM_API_KEY / LLM_COMMAND and
 * per-provider API-key environment overrides.
 */
export function fromConfig(cfg: Config | null): Provider {
  const { profileName, profile } = resolveProfile(cfg);

  switch (goToLower(goTrimSpace(profile.provider))) {
    case 'openai':
      return new OpenAIProvider(profile.apiKey, profile.model, profile.baseUrl);
    case 'anthropic':
      return new AnthropicProvider(profile.apiKey, profile.model, profile.baseUrl);
    case 'google':
      return new GoogleProvider(profile.apiKey, profile.model, profile.baseUrl);
    case 'claude_cli':
      return new ClaudeCLIProvider(profile.model, profile.command);
    case 'codex':
      return new CodexProvider(profile.model, profile.command);
    case 'openai_compat': {
      const baseUrl =
        goTrimSpace(profile.baseUrl) === '' ? defaultOpenAICompatBaseURLForProfile(profileName) : profile.baseUrl;
      return new OpenAICompatProvider(profile.apiKey, profile.model, baseUrl);
    }
    default:
      throw new Error(
        `LLM provider ${goQuote(profile.provider)} for profile ${goQuote(profileName)} is not implemented yet`,
      );
  }
}

/**
 * Picks the profile (LLM_PROFILE, else the active one, else "openai") and
 * layers the environment overrides on top.
 */
export function resolveProfile(cfg: Config | null): { profileName: string; profile: LlmProfile } {
  const effective = effectiveLlmConfig(cfg);

  let profileName = getenv('LLM_PROFILE');
  if (profileName === '') {
    profileName = goTrimSpace(effective.activeProfile);
  }
  if (profileName === '') {
    profileName = 'openai';
  }

  const configured = Object.hasOwn(effective.profiles, profileName) ? effective.profiles[profileName] : undefined;
  if (configured === undefined) {
    throw new Error(`LLM profile ${goQuote(profileName)} was not found in llm.profiles`);
  }
  const profile: LlmProfile = { ...configured };

  const overrides: Array<[string, keyof LlmProfile]> = [
    ['LLM_PROVIDER', 'provider'],
    ['LLM_MODEL', 'model'],
    ['LLM_BASE_URL', 'baseUrl'],
    ['LLM_API_KEY', 'apiKey'],
    ['LLM_COMMAND', 'command'],
  ];
  for (const [key, prop] of overrides) {
    const value = getenv(key);
    if (value !== '') {
      profile[prop] = value;
    }
  }

  if (goTrimSpace(profile.provider) === '') {
    profile.provider = 'openai';
  }
  // Legacy OpenAI-specific overrides only fill gaps.
  if (goEqualFold(profile.provider, 'openai')) {
    if (goTrimSpace(profile.model) === '') {
      profile.model = getenv('OPENAI_MODEL');
    }
    if (goTrimSpace(profile.baseUrl) === '') {
      profile.baseUrl = getenv('OPENAI_BASE_URL');
    }
  }

  if (goTrimSpace(profile.apiKey) === '') {
    for (const envVar of providerApiKeyEnvVars(profileName, profile.provider)) {
      const value = getenv(envVar);
      if (value !== '') {
        profile.apiKey = value;
        break;
      }
    }
  }

  return { profileName, profile };
}

function providerApiKeyEnvVars(profileName: string, provider: string): string[] {
  switch (goToLower(goTrimSpace(provider))) {
    case 'openai':
      return ['OPENAI_API_KEY'];
    case 'anthropic':
      return ['ANTHROPIC_API_KEY'];
    case 'google':
      return ['GOOGLE_API_KEY', 'GEMINI_API_KEY'];
    case 'openai_compat':
      switch (goToLower(goTrimSpace(profileName))) {
        case 'deepseek':
          return ['DEEPSEEK_API_KEY'];
        case 'kimi':
          return ['KIMI_API_KEY'];
        default:
          return [];
      }
    default:
      return [];
  }
}

function defaultOpenAICompatBaseURLForProfile(profileName: string): string {
  switch (goToLower(goTrimSpace(profileName))) {
    case 'deepseek':
      return 'https://api.deepseek.com/v1';
    case 'kimi':
      return 'https://api.moonshot.ai/v1';
    default:
      return DEFAULT_OPENAI_COMPAT_BASE_URL;
  }
}
