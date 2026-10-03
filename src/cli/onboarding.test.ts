import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PIANISTS_ALLOWLIST,
  effectiveLlmConfig,
  emptyConfig,
  emptyProfile,
  loadConfig,
  saveConfig,
  setLlmProfile,
  validateConfig,
} from '../core/config';
import { Context, RootOptions } from './context';
import { LineReader } from './lines';
import {
  type OnboardingDeps,
  type OnboardingProvider,
  compactNonEmpty,
  initialProviderIndex,
  lookPath,
  onboardingProviders,
  promptProviderModel,
  promptRequiredValue,
} from './onboarding';
import { MemoryOut, fakeOnboardingDeps, run, tempPath } from './testutil';

const defaults = [...DEFAULT_PIANISTS_ALLOWLIST];

function choose(profileName: string): OnboardingDeps['selectProvider'] {
  return async (_input, _output, choices) => {
    const choice = choices.find((candidate) => candidate.profileName === profileName);
    if (choice === undefined) {
      throw new Error(`${profileName} choice not found`);
    }
    return choice;
  };
}

async function runOnboarding(configPath: string, stdin: string, onboarding: OnboardingDeps): Promise<string> {
  const result = await run(['--config', configPath, 'onboarding'], stdin, { onboarding });
  if (result.code !== 0) {
    throw new Error(`onboarding failed: ${result.stderr}\noutput: ${result.stdout}`);
  }
  return result.stdout;
}

describe('onboarding', () => {
  // Go: TestOnboardingCommandWritesSelectedConfig
  it('writes the selected config', async () => {
    const configPath = tempPath('config.json');
    const wantAllowlist = [defaults[0]!, defaults[2]!];

    const out = await runOnboarding(
      configPath,
      'spotify-client\nspotify-secret\nopenai-key\n',
      fakeOnboardingDeps({
        selectPianists: async () => [...wantAllowlist],
        selectProvider: async (_input, _output, choices) => choices[0]!,
        selectModel: async () => 'gpt-5.4',
        listModels: async () => ['gpt-5.4', 'gpt-4o-mini'],
      }),
    );

    const cfg = loadConfig(configPath);
    expect(cfg.spotify.clientId).toBe('spotify-client');
    expect(cfg.spotify.clientSecret).toBe('spotify-secret');
    const llm = effectiveLlmConfig(cfg);
    expect(llm.profiles['openai']?.apiKey).toBe('openai-key');
    expect(llm.activeProfile).toBe('openai');
    expect(llm.profiles['openai']?.model).toBe('gpt-5.4');
    expect(cfg.pianistsAllowlist).toEqual(wantAllowlist);
    expect(out).toContain('Saved onboarding config');
    expect(out).toBe(
      `Config path: ${configPath}\n\nSpotify client ID: Spotify client secret: OpenAI API key (optional): ` +
        `\nSaved onboarding config to ${configPath}\nSelected LLM provider: OpenAI (gpt-5.4)\n` +
        'Selected 2 pianists for pianists_allowlist\nNext steps:\n' +
        '  1. Add http://127.0.0.1:8000/api/auth/spotify/callback to your Spotify app redirect URIs\n' +
        '  2. Run `tracker spotify login`\n  3. Run `tracker sync`\n',
    );
  });

  // Go: TestOnboardingCommandKeepsFullDefaultAllowlistOnBlankSelection
  it('keeps the full default allowlist and a blank optional key', async () => {
    const configPath = tempPath('config.json');
    await runOnboarding(
      configPath,
      'spotify-client\nspotify-secret\n\n',
      fakeOnboardingDeps({
        selectPianists: async (_input, _output, pianists) => [...pianists],
        selectProvider: async (_input, _output, choices) => choices[0]!,
        selectModel: async () => 'gpt-5.4',
        listModels: async () => ['gpt-5.4'],
      }),
    );

    const cfg = loadConfig(configPath);
    expect(cfg.pianistsAllowlist).toHaveLength(DEFAULT_PIANISTS_ALLOWLIST.length);
    expect(effectiveLlmConfig(cfg).profiles['openai']?.apiKey).toBe('');
  });

  // Go: TestOnboardingCommandWritesFixedDeepSeekModel
  it('writes a fixed DeepSeek model without listing models', async () => {
    const configPath = tempPath('config.json');
    await runOnboarding(
      configPath,
      'spotify-client\nspotify-secret\ndeepseek-key\nhttps://api.deepseek.com/v1\n',
      fakeOnboardingDeps({
        selectPianists: async () => [defaults[0]!],
        selectProvider: choose('deepseek'),
        selectModel: async (_input, _output, _title, models) => models[1]!,
        listModels: () => {
          throw new Error('listModels should not be called for fixed-model provider');
        },
      }),
    );

    const llm = effectiveLlmConfig(loadConfig(configPath));
    expect(llm.activeProfile).toBe('deepseek');
    expect(llm.profiles['deepseek']).toMatchObject({
      provider: 'openai_compat',
      model: 'deepseek-reasoner',
      apiKey: 'deepseek-key',
    });
  });

  // Go: TestOnboardingCommandWritesClaudeCLIProfileWithResolvedCommand
  it('writes a claude_cli profile with the resolved command', async () => {
    const configPath = tempPath('config.json');
    await runOnboarding(
      configPath,
      'spotify-client\nspotify-secret\n',
      fakeOnboardingDeps({
        selectPianists: async () => [defaults[0]!],
        selectProvider: async (_input, _output, choices) => {
          const choice = choices.find((candidate) => candidate.profileName === 'claude_cli');
          if (choice === undefined || choice.promptApiKey) {
            throw new Error('claude_cli choice missing or prompts for an API key');
          }
          return choice;
        },
        selectModel: async (_input, _output, _title, models, initial) => {
          expect(models[initial]).toBe('sonnet');
          return models[initial]!;
        },
        lookupClaude: () => '/stub/bin/claude',
      }),
    );

    const llm = effectiveLlmConfig(loadConfig(configPath));
    expect(llm.activeProfile).toBe('claude_cli');
    expect(llm.profiles['claude_cli']).toEqual(
      emptyProfile({ provider: 'claude_cli', model: 'sonnet', command: '/stub/bin/claude' }),
    );
  });

  // Go: TestOnboardingCommandWarnsWhenClaudeCLIIsMissing
  it('warns when the claude CLI is missing', async () => {
    const configPath = tempPath('config.json');
    const out = await runOnboarding(
      configPath,
      'spotify-client\nspotify-secret\n',
      fakeOnboardingDeps({
        selectPianists: async () => [defaults[0]!],
        selectProvider: choose('claude_cli'),
        selectModel: async (_input, _output, _title, models) => models[0]!,
        lookupClaude: () => {
          throw new Error('executable file not found in $PATH');
        },
      }),
    );

    expect(out).toContain('Could not find the claude command');
    expect(out).toContain(
      '\nCould not find the claude command on PATH (executable file not found in $PATH).\n' +
        'Install the CLI and sign in, or set llm.profiles.claude_cli.command to its path.\n\n' +
        "Uses the CLI's existing login. Sign in with `claude` first; no tracker API key is needed.\n\n",
    );
    expect(effectiveLlmConfig(loadConfig(configPath)).profiles['claude_cli']?.command).toBe('');
  });

  // Go: TestOnboardingCodexProfile
  describe('codex profile', () => {
    const cases = [
      { name: 'default model', model: '', existingCommand: '', foundCommand: '/opt/bin/codex', missing: false },
      {
        name: 'manual model',
        model: 'chosen-model',
        existingCommand: '',
        foundCommand: '/opt/bin/codex',
        missing: false,
      },
      { name: 'missing command', model: '', existingCommand: '', foundCommand: '', missing: true },
      {
        name: 'preserve custom command',
        model: '',
        existingCommand: '/custom/codex',
        foundCommand: '',
        missing: false,
      },
    ];
    for (const tc of cases) {
      it(tc.name, async () => {
        const path = tempPath('config.json');
        if (tc.existingCommand !== '') {
          const cfg = emptyConfig();
          cfg.spotify.clientId = 'old';
          cfg.spotify.clientSecret = 'old';
          setLlmProfile(cfg, 'codex', emptyProfile({ provider: 'codex', command: tc.existingCommand }));
          saveConfig(path, cfg);
        }

        const out = await runOnboarding(
          path,
          `spotify-client\nspotify-secret\n${tc.model}\n`,
          fakeOnboardingDeps({
            selectPianists: async () => ['Martha Argerich'],
            selectProvider: async (_input, _output, choices) => {
              const choice = choices.find((candidate) => candidate.providerKind === 'codex');
              if (choice === undefined || choice.promptApiKey || choice.promptBaseUrl) {
                throw new Error('Codex choice missing or prompts for API credentials');
              }
              return choice;
            },
            lookupCodex: () => {
              if (tc.existingCommand !== '') {
                throw new Error('must preserve existing executable path');
              }
              if (tc.missing) {
                throw new Error('not installed');
              }
              return tc.foundCommand;
            },
            listModels: () => {
              throw new Error('Codex onboarding must not use API model listing');
            },
          }),
        );

        const cfg = loadConfig(path);
        expect(() => validateConfig(cfg)).not.toThrow();
        const command = tc.existingCommand === '' ? tc.foundCommand : tc.existingCommand;
        expect(cfg.llm.activeProfile).toBe('codex');
        expect(effectiveLlmConfig(cfg).profiles['codex']).toEqual(
          emptyProfile({ provider: 'codex', model: tc.model, command }),
        );
        if (tc.missing) {
          expect(out).toContain('Could not find the codex command');
        }
        expect(out).toContain('Selected LLM provider: Codex CLI (uses your Codex login) (');
      });
    }
  });

  it('keeps current values on Enter and preselects the active provider', async () => {
    const path = tempPath('config.json');
    const cfg = emptyConfig();
    cfg.spotify.clientId = 'old-id';
    cfg.spotify.clientSecret = 'old-secret';
    setLlmProfile(cfg, 'kimi', emptyProfile({ provider: 'openai_compat', model: 'kimi-k2.5', apiKey: 'old-key' }));
    saveConfig(path, cfg);

    let initialChoice: OnboardingProvider | undefined;
    const out = await runOnboarding(
      path,
      '\n\n\n\n',
      fakeOnboardingDeps({
        selectPianists: async () => ['Yuja Wang'],
        selectProvider: async (_input, _output, choices, initial) => {
          initialChoice = choices[initial];
          return choices[initial]!;
        },
      }),
    );

    expect(initialChoice?.profileName).toBe('kimi');
    expect(out).toContain(
      'Spotify client ID [old-id]: Spotify client secret [old-secret]: Kimi API key (optional) [old-key]: ' +
        'Kimi base URL [https://api.moonshot.ai/v1]: Kimi model: kimi-k2.5\n\n',
    );
    const saved = loadConfig(path);
    expect(saved.spotify.clientId).toBe('old-id');
    expect(effectiveLlmConfig(saved).profiles['kimi']).toEqual(
      emptyProfile({
        provider: 'openai_compat',
        model: 'kimi-k2.5',
        apiKey: 'old-key',
        baseUrl: 'https://api.moonshot.ai/v1',
      }),
    );
  });

  it('fails cleanly when input ends before required values', async () => {
    const result = await run(['--config', tempPath('config.json'), 'onboarding'], '', {
      onboarding: fakeOnboardingDeps(),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('read Spotify client ID: EOF\n');
  });

  it('propagates picker cancellation', async () => {
    const result = await run(['--config', tempPath('config.json'), 'onboarding'], 'a\nb\n', {
      onboarding: fakeOnboardingDeps({
        selectProvider: () => Promise.reject(new Error('selection canceled')),
      }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('selection canceled\n');
  });
});

function testContext(stdin: string, onboarding: OnboardingDeps): { ctx: Context; out: MemoryOut } {
  const out = new MemoryOut();
  const ctx = new Context(
    { stdin: Readable.from([stdin]), stdout: out, stderr: new MemoryOut() },
    { onboarding },
    new RootOptions(() => ({ config: '', db: '' })),
  );
  return { ctx, out };
}

describe('onboarding helpers', () => {
  const anthropic = onboardingProviders([]).find((provider) => provider.profileName === 'anthropic')!;

  it('falls back to manual model entry when listing fails', async () => {
    const { ctx, out } = testContext(
      '\n',
      fakeOnboardingDeps({
        listModels: () => Promise.reject(new Error('Anthropic API key is required to list models')),
      }),
    );
    const model = await promptProviderModel(ctx, anthropic, emptyProfile());
    expect(model).toBe('claude-sonnet-4-5');
    expect(out.text()).toContain('Could not list models for Anthropic: Anthropic API key is required to list models');
    expect(out.text().endsWith('Anthropic model [claude-sonnet-4-5]: ')).toBe(true);
  });

  it('uses a single listed model directly and falls back when none are returned', async () => {
    const single = testContext('', fakeOnboardingDeps({ listModels: async () => [' ', 'x', 'x '] }));
    expect(await promptProviderModel(single.ctx, anthropic, emptyProfile())).toBe('x');
    expect(single.out.text()).toBe('Anthropic model: x\n\n');

    const none = testContext('typed-model\n', fakeOnboardingDeps({ listModels: async () => ['', '  '] }));
    expect(await promptProviderModel(none.ctx, anthropic, emptyProfile())).toBe('typed-model');
    expect(none.out.text()).toBe(
      '\nNo models were returned for Anthropic.\nFalling back to manual model entry.\n\nAnthropic model [claude-sonnet-4-5]: ',
    );
  });

  it('offers listed models with the current one preselected', async () => {
    let seen: { title: string; models: string[]; initial: number } | undefined;
    const { ctx } = testContext(
      '',
      fakeOnboardingDeps({
        listModels: async () => ['b', 'a', 'claude-sonnet-4-5'],
        selectModel: async (_input, _output, title, models, initial) => {
          seen = { title, models, initial };
          return models[initial]!;
        },
      }),
    );
    expect(await promptProviderModel(ctx, anthropic, emptyProfile())).toBe('claude-sonnet-4-5');
    expect(seen).toEqual({ title: 'Select model for Anthropic', models: ['a', 'b', 'claude-sonnet-4-5'], initial: 2 });
  });

  it('retries required prompts and stops at EOF', async () => {
    const out = new MemoryOut();
    const reader = (text: string) => new LineReader(Readable.from([text]));
    expect(await promptRequiredValue(reader('\n  id  \n'), out, 'Spotify client ID', '')).toBe('id');
    expect(out.text()).toBe('Spotify client ID: Spotify client ID is required.\nSpotify client ID: ');

    await expect(promptRequiredValue(reader(''), new MemoryOut(), 'Spotify client ID', '')).rejects.toThrow(
      'read Spotify client ID: EOF',
    );
    expect(await promptRequiredValue(reader(''), new MemoryOut(), 'Spotify client ID', 'old')).toBe('old');
    expect(await promptRequiredValue(reader('last'), new MemoryOut(), 'Spotify client ID', '')).toBe('last');
  });

  it('compactNonEmpty trims, dedupes, and sorts', () => {
    expect(compactNonEmpty(['b', ' a ', '', 'b ', 'c', 'B'])).toEqual(['B', 'a', 'b', 'c']);
  });

  it('initialProviderIndex follows the active profile', () => {
    const choices = onboardingProviders(['sonnet']);
    expect(choices[initialProviderIndex(choices, { activeProfile: ' deepseek ', profiles: {} })]?.profileName).toBe(
      'deepseek',
    );
    expect(initialProviderIndex(choices, { activeProfile: '', profiles: {} })).toBe(0);
    expect(choices.find((choice) => choice.profileName === 'claude_cli')?.fixedModels).toEqual(['sonnet']);
  });

  it('lookPath reports Go-style errors', () => {
    expect(() => lookPath('definitely-not-a-real-tracker-binary')).toThrow(
      'exec: "definitely-not-a-real-tracker-binary": executable file not found in $PATH',
    );
    expect(lookPath('sh', '/nonexistent:/bin')).toBe('/bin/sh');
    expect(() => lookPath('sh', '')).toThrow('executable file not found in $PATH');
  });
});
