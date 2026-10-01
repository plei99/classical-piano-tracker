/**
 * `tracker onboarding`: interactive first-run setup for Spotify
 * credentials, the LLM provider, and the pianist allowlist.
 */
import { statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';

import {
  DEFAULT_PIANISTS_ALLOWLIST,
  type LlmConfig,
  type LlmProfile,
  effectiveLlmConfig,
  emptyProfile,
  ensureLoadedConfig,
  saveConfig,
  setLlmProfile,
} from '../core/config';
import { errorMessage, quote, wrap } from '../core/errors';
import { compareGoStrings } from '../core/gojson';
import type { Context } from './context';
import type { Out } from './format';
import { goTrimSpace } from './gostr';
import type { LineReader } from './lines';

const CLAUDE_CLI_PROVIDER_KIND = 'claude_cli';
const CODEX_PROVIDER_KIND = 'codex';
const PICKER_HELP = 'Up/down or j/k: move   enter: confirm   q: cancel';
/** Spotify's redirect URI; duplicated from the spotify module to keep it off this command's load path. */
const SPOTIFY_REDIRECT_URL = 'http://127.0.0.1:8000/api/auth/spotify/callback';

/** One LLM provider choice offered during onboarding. */
export interface OnboardingProvider {
  profileName: string;
  displayName: string;
  providerKind: string;
  defaultModel: string;
  defaultBaseUrl: string;
  promptApiKey: boolean;
  promptBaseUrl: boolean;
  /** Offered instead of querying the provider's model-listing API. */
  fixedModels: string[];
}

/**
 * The interactive and environment-dependent steps of onboarding. Tests swap
 * these for deterministic fakes; the defaults use the terminal pickers, the
 * providers' model-listing APIs, and a PATH lookup.
 */
export interface OnboardingDeps {
  selectPianists(input: Readable, output: Out, pianists: string[]): Promise<string[]>;
  selectProvider(
    input: Readable,
    output: Out,
    choices: OnboardingProvider[],
    initial: number,
  ): Promise<OnboardingProvider>;
  selectModel(input: Readable, output: Out, title: string, models: string[], initial: number): Promise<string>;
  listModels(profileName: string, profile: LlmProfile): Promise<string[]>;
  /** Resolves the Claude Code CLI so its absolute path can be stored in the profile; throws when missing. */
  lookupClaude(): string;
  lookupCodex(): string;
}

export function defaultOnboardingDeps(): OnboardingDeps {
  return {
    selectPianists: async (input, output, pianists) => {
      const { promptPianistSelection } = await import('./picker_ink');
      return promptPianistSelection(input, output, pianists);
    },
    selectProvider: promptProviderSelection,
    selectModel: async (input, output, title, models, initial) => {
      const { runSingleChoiceSelection } = await import('./picker_ink');
      return runSingleChoiceSelection(input, output, title, PICKER_HELP, models, initial);
    },
    listModels: async (profileName, profile) => {
      const { listModels } = await import('../llm/providers');
      return listModels(profileName, profile);
    },
    lookupClaude: () => lookPath('claude'),
    lookupCodex: () => lookPath(CODEX_PROVIDER_KIND),
  };
}

function provider(fields: Partial<OnboardingProvider> & Pick<OnboardingProvider, 'profileName'>): OnboardingProvider {
  return {
    displayName: '',
    providerKind: '',
    defaultModel: '',
    defaultBaseUrl: '',
    promptApiKey: false,
    promptBaseUrl: false,
    fixedModels: [],
    ...fields,
  };
}

export function onboardingProviders(claudeCliModels: string[]): OnboardingProvider[] {
  return [
    provider({
      profileName: 'openai',
      displayName: 'OpenAI',
      providerKind: 'openai',
      defaultModel: 'gpt-5.4',
      promptApiKey: true,
    }),
    provider({
      profileName: CODEX_PROVIDER_KIND,
      displayName: 'Codex CLI (uses your Codex login)',
      providerKind: CODEX_PROVIDER_KIND,
    }),
    provider({
      profileName: 'anthropic',
      displayName: 'Anthropic',
      providerKind: 'anthropic',
      defaultModel: 'claude-sonnet-4-5',
      promptApiKey: true,
    }),
    provider({
      profileName: CLAUDE_CLI_PROVIDER_KIND,
      displayName: 'Claude Code CLI (claude -p, uses your Claude login)',
      providerKind: CLAUDE_CLI_PROVIDER_KIND,
      defaultModel: 'sonnet',
      fixedModels: [...claudeCliModels],
    }),
    provider({
      profileName: 'google',
      displayName: 'Google Gemini',
      providerKind: 'google',
      defaultModel: 'gemini-2.5-pro',
      promptApiKey: true,
    }),
    provider({
      profileName: 'ollama',
      displayName: 'Ollama',
      providerKind: 'openai_compat',
      defaultBaseUrl: 'http://localhost:11434/v1',
      promptBaseUrl: true,
    }),
    provider({
      profileName: 'deepseek',
      displayName: 'DeepSeek',
      providerKind: 'openai_compat',
      defaultModel: 'deepseek-chat',
      defaultBaseUrl: 'https://api.deepseek.com/v1',
      promptApiKey: true,
      promptBaseUrl: true,
      fixedModels: ['deepseek-chat', 'deepseek-reasoner'],
    }),
    provider({
      profileName: 'kimi',
      displayName: 'Kimi',
      providerKind: 'openai_compat',
      defaultModel: 'kimi-k2.5',
      defaultBaseUrl: 'https://api.moonshot.ai/v1',
      promptApiKey: true,
      promptBaseUrl: true,
      fixedModels: ['kimi-k2.5'],
    }),
  ];
}

export async function runOnboarding(ctx: Context): Promise<void> {
  const deps = ctx.deps.onboarding;
  const configPath = ctx.opts.resolveConfigPath();
  const { cfg } = ensureLoadedConfig(configPath);
  const input = ctx.io.stdin;
  const lines = ctx.lines;
  const out = ctx.out;

  out.write(`Config path: ${configPath}\n\n`);

  const clientId = await promptRequiredValue(lines, out, 'Spotify client ID', cfg.spotify.clientId);
  const clientSecret = await promptRequiredValue(lines, out, 'Spotify client secret', cfg.spotify.clientSecret);

  const llmConfig = effectiveLlmConfig(cfg);
  const { claudeCliModels } = await import('../llm/providers');
  const choices = onboardingProviders(claudeCliModels());
  const selected = await deps.selectProvider(input, out, choices, initialProviderIndex(choices, llmConfig));
  const current = llmConfig.profiles[selected.profileName] ?? emptyProfile();

  let apiKey = '';
  if (selected.promptApiKey) {
    apiKey = await promptOptionalValue(lines, out, `${selected.displayName} API key (optional)`, current.apiKey);
  }

  let baseUrl = current.baseUrl;
  if (goTrimSpace(baseUrl) === '') {
    baseUrl = selected.defaultBaseUrl;
  }
  if (selected.promptBaseUrl) {
    baseUrl = await promptRequiredValue(lines, out, `${selected.displayName} base URL`, baseUrl);
  }

  let command = '';
  if (selected.providerKind === CLAUDE_CLI_PROVIDER_KIND || selected.providerKind === CODEX_PROVIDER_KIND) {
    const isCodex = selected.providerKind === CODEX_PROVIDER_KIND;
    const binary = isCodex ? 'codex' : 'claude';
    command = goTrimSpace(current.command);
    if (command === '') {
      // A missing CLI is not fatal: an empty command means the provider
      // resolves it from PATH at runtime.
      try {
        command = isCodex ? deps.lookupCodex() : deps.lookupClaude();
      } catch (err) {
        out.write(
          `\nCould not find the ${binary} command on PATH (${errorMessage(err)}).\n` +
            `Install the CLI and sign in, or set llm.profiles.${selected.profileName}.command to its path.\n\n`,
        );
        command = '';
      }
    }
    out.write(`Uses the CLI's existing login. Sign in with \`${binary}\` first; no tracker API key is needed.\n\n`);
  }

  const listingProfile = emptyProfile({
    provider: selected.providerKind,
    model: current.model,
    apiKey,
    baseUrl,
  });
  const model = await promptProviderModel(ctx, selected, listingProfile);

  const pianists = await deps.selectPianists(input, out, [...DEFAULT_PIANISTS_ALLOWLIST]);

  cfg.spotify.clientId = clientId;
  cfg.spotify.clientSecret = clientSecret;
  setLlmProfile(cfg, selected.profileName, {
    provider: selected.providerKind,
    model,
    apiKey: goTrimSpace(apiKey),
    baseUrl: goTrimSpace(baseUrl),
    command: goTrimSpace(command),
  });
  cfg.pianistsAllowlist = pianists;

  try {
    saveConfig(configPath, cfg);
  } catch (err) {
    throw wrap(`save config ${quote(configPath)}`, err);
  }

  out.write(`\nSaved onboarding config to ${configPath}\n`);
  out.write(`Selected LLM provider: ${selected.displayName} (${model === '' ? 'CLI default model' : model})\n`);
  out.write(`Selected ${pianists.length} pianists for pianists_allowlist\n`);
  out.write('Next steps:\n');
  out.write(`  1. Add ${SPOTIFY_REDIRECT_URL} to your Spotify app redirect URIs\n`);
  out.write('  2. Run `tracker spotify login`\n');
  out.write('  3. Run `tracker sync`\n');
}

/** Preselects the provider of the currently active profile. */
export function initialProviderIndex(choices: OnboardingProvider[], cfg: LlmConfig): number {
  const active = goTrimSpace(cfg.activeProfile);
  return Math.max(
    choices.findIndex((choice) => choice.profileName === active),
    0,
  );
}

export async function promptProviderModel(
  ctx: Context,
  provider: OnboardingProvider,
  profile: LlmProfile,
): Promise<string> {
  const { lines, out } = ctx;
  if (provider.providerKind === CODEX_PROVIDER_KIND) {
    // Codex has no simple model-list command. Avoid hardcoded choices that
    // may not be available to the user's CLI account.
    return promptOptionalValue(lines, out, 'Codex model (optional; unset uses CLI default)', profile.model);
  }

  let currentModel = goTrimSpace(profile.model);
  if (currentModel === '') {
    currentModel = provider.defaultModel;
  }
  const manualLabel = `${provider.displayName} model`;

  let models = [...provider.fixedModels];
  if (models.length === 0) {
    try {
      models = await ctx.deps.onboarding.listModels(provider.profileName, profile);
    } catch (err) {
      out.write(
        `\nCould not list models for ${provider.displayName}: ${errorMessage(err)}\nFalling back to manual model entry.\n\n`,
      );
      return promptRequiredValue(lines, out, manualLabel, currentModel);
    }
  }

  models = compactNonEmpty(models);
  const [only] = models;
  if (only === undefined) {
    out.write(`\nNo models were returned for ${provider.displayName}.\nFalling back to manual model entry.\n\n`);
    return promptRequiredValue(lines, out, manualLabel, currentModel);
  }
  if (models.length === 1) {
    out.write(`${provider.displayName} model: ${only}\n\n`);
    return only;
  }

  const initial = Math.max(models.indexOf(currentModel), 0);
  return ctx.deps.onboarding.selectModel(
    ctx.io.stdin,
    out,
    `Select model for ${provider.displayName}`,
    models,
    initial,
  );
}

/** Trims, drops blanks and duplicates, and sorts bytewise like Go's slices.Sort. */
export function compactNonEmpty(values: string[]): string[] {
  const unique = new Set(values.map(goTrimSpace).filter((value) => value !== ''));
  return [...unique].sort(compareGoStrings);
}

async function promptProviderSelection(
  input: Readable,
  output: Out,
  choices: OnboardingProvider[],
  initial: number,
): Promise<OnboardingProvider> {
  const { runSingleChoiceSelection } = await import('./picker_ink');
  const labels = choices.map((choice) => choice.displayName);
  const selected = await runSingleChoiceSelection(input, output, 'Select LLM provider', PICKER_HELP, labels, initial);
  const choice = choices.find((candidate) => candidate.displayName === selected);
  if (choice === undefined) {
    throw new Error(`selected provider ${quote(selected)} was not found`);
  }
  return choice;
}

/**
 * Prompts until a non-blank value is given (Enter keeps a non-blank current
 * value). Input that ends with nothing usable is an error; the Go build
 * re-prompted forever there.
 */
export async function promptRequiredValue(
  lines: LineReader,
  out: Out,
  label: string,
  current: string,
): Promise<string> {
  for (;;) {
    const { value, eof } = await promptValue(lines, out, label, current);
    if (goTrimSpace(value) !== '') {
      return value;
    }
    out.write(`${label} is required.\n`);
    if (eof) {
      throw new Error(`read ${label}: EOF`);
    }
  }
}

/** Like {@link promptRequiredValue} but accepts blank input. */
export async function promptOptionalValue(
  lines: LineReader,
  out: Out,
  label: string,
  current: string,
): Promise<string> {
  return (await promptValue(lines, out, label, current)).value;
}

/** The shared "show the current value, Enter keeps it" prompt. */
async function promptValue(
  lines: LineReader,
  out: Out,
  label: string,
  current: string,
): Promise<{ value: string; eof: boolean }> {
  out.write(goTrimSpace(current) !== '' ? `${label} [${current}]: ` : `${label}: `);
  let line;
  try {
    line = await lines.readLine();
  } catch (err) {
    throw wrap(`read ${label}`, err);
  }
  const trimmed = goTrimSpace(line.text);
  return { value: trimmed === '' ? current : trimmed, eof: line.eof };
}

/** Go's exec.LookPath: the first executable named `name` on PATH. */
export function lookPath(name: string, path = process.env['PATH'] ?? ''): string {
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const entry of path.split(delimiter)) {
    const dir = entry === '' ? '.' : entry;
    for (const extension of extensions) {
      const candidate = join(dir, name + extension);
      if (!isExecutable(candidate)) {
        continue;
      }
      if (!isAbsolute(candidate)) {
        throw new Error(`exec: ${quote(name)}: cannot run executable found relative to current directory`);
      }
      return candidate;
    }
  }
  throw new Error(`exec: ${quote(name)}: executable file not found in $PATH`);
}

function isExecutable(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}
