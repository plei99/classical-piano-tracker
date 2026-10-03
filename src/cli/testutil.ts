/**
 * Helpers for driving the CLI in-process from tests.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { type Config, emptyConfig, saveConfig } from '../core/config';
import { type CliDeps, runCli } from './index';
import type { OnboardingDeps } from './onboarding';

/** An in-memory output stream. */
export class MemoryOut {
  private chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  text(): string {
    return this.chunks.join('');
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI with the given stdin text, capturing both output streams. */
export async function run(args: string[], stdin = '', deps: Partial<CliDeps> = {}): Promise<RunResult> {
  const stdout = new MemoryOut();
  const stderr = new MemoryOut();
  const code = await runCli(args, { stdin: Readable.from([stdin]), stdout, stderr }, deps);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tracker-cli-'));
}

export function tempPath(name: string): string {
  return join(tempDir(), name);
}

/** Saves a config with Spotify credentials and the given filters. */
export function saveTestConfig(path: string, allowlist: string[], blocklist: string[] = []): Config {
  const cfg = emptyConfig();
  cfg.spotify.clientId = 'client-id';
  cfg.spotify.clientSecret = 'client-secret';
  cfg.pianistsAllowlist = allowlist;
  cfg.artistsBlocklist = blocklist;
  saveConfig(path, cfg);
  return cfg;
}

/**
 * Onboarding fakes that fail loudly unless a test overrides them, so no test
 * can reach a real terminal, network, or PATH.
 */
export function fakeOnboardingDeps(overrides: Partial<OnboardingDeps> = {}): OnboardingDeps {
  const unexpected = (what: string) => () => {
    throw new Error(`unexpected ${what}`);
  };
  return {
    selectPianists: unexpected('pianist selection'),
    selectProvider: unexpected('provider selection'),
    selectModel: unexpected('model selection'),
    listModels: unexpected('model listing'),
    lookupClaude: unexpected('claude lookup'),
    lookupCodex: unexpected('codex lookup'),
    ...overrides,
  };
}
