/**
 * What every command receives: the injectable streams, the global path
 * flags, and the test seams. Commands never touch the process streams
 * directly, so tests drive them in-process with in-memory buffers.
 */
import type { Readable } from 'node:stream';

import { type Config, mergeToken, saveConfig, validateConfig, validateStoredToken } from '../core/config';
import { Db } from '../core/db';
import { quote, wrap } from '../core/errors';
import { defaultConfigPath, defaultDbPath } from '../core/paths';
import type { Client as SpotifyClient } from '../spotify';
import type { Out } from './format';
import { parseGoInt } from './gostr';
import { LineReader } from './lines';
import type { OnboardingDeps } from './onboarding';

export interface CliIo {
  stdin: Readable;
  stdout: Out;
  stderr: Out;
}

/** Interactive seams that tests replace (the Go build used package-level function variables). */
export interface CliDeps {
  onboarding: OnboardingDeps;
}

/**
 * Global path overrides carried down into subcommands. An empty value (when
 * the platform default could not be resolved at startup) defers that error
 * to the commands that actually need the path.
 */
export class RootOptions {
  constructor(private readonly values: () => { config: string; db: string }) {}

  resolveConfigPath(): string {
    return this.values().config || defaultConfigPath();
  }

  resolveDbPath(): string {
    return this.values().db || defaultDbPath();
  }
}

export class Context {
  private lineReader: LineReader | null = null;

  constructor(
    readonly io: CliIo,
    readonly deps: CliDeps,
    readonly opts: RootOptions,
  ) {}

  get out(): Out {
    return this.io.stdout;
  }

  /**
   * One shared buffered reader over stdin, so consecutive prompts never lose
   * input that an earlier read already buffered.
   */
  get lines(): LineReader {
    this.lineReader ??= new LineReader(this.io.stdin);
    return this.lineReader;
  }
}

/** The default template was just written; tell the user what to fill in next. */
export function createdConfigError(path: string, nextStep: string): Error {
  return new Error(`created default config at ${quote(path)}; ${nextStep}`);
}

/**
 * Everything sync-like commands need: a valid config plus a stored Spotify
 * token from `tracker spotify login`.
 */
export function validateSyncConfig(cfg: Config, configPath: string): void {
  try {
    validateConfig(cfg);
  } catch (err) {
    throw wrap(`invalid config ${quote(configPath)}`, err);
  }
  try {
    validateStoredToken(cfg.spotify);
  } catch (err) {
    throw wrap(`spotify login required for ${quote(configPath)}`, err);
  }
}

/** Shared by commands that accept local numeric IDs, for a consistent error shape. */
export function parsePositiveInt64(raw: string, field: string): number {
  let value: bigint;
  try {
    value = parseGoInt(raw, 10);
  } catch {
    value = 0n;
  }
  if (value < 1n) {
    throw new Error(`${field} must be a positive integer, got ${quote(raw)}`);
  }
  return Number(value);
}

/** Opens the database for the duration of `fn`, closing it even when `fn` throws. */
export async function withDb<T>(path: string, fn: (db: Db) => T | Promise<T>): Promise<T> {
  const db = Db.open(path);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/**
 * An authenticated Spotify client whose token refreshes are merged into the
 * config and saved back to `configPath`, so the next run reuses them. The
 * spotify module is loaded lazily to keep it off the startup path of
 * commands that never touch the network.
 */
export async function spotifyClient(cfg: Config, configPath: string): Promise<SpotifyClient> {
  const { Client } = await import('../spotify');
  // Go passed the Spotify settings by value; the persister below replaces
  // cfg.spotify.token, which must not reach into the client's copy.
  return new Client({ ...cfg.spotify }, (token) => {
    cfg.spotify.token = mergeToken(token, cfg.spotify.token);
    saveConfig(configPath, cfg);
  });
}
