/**
 * `tracker tui`: injects database and sync callbacks into the TUI, so the
 * TUI never constructs clients or touches the database itself.
 */
import { ensureLoadedConfig } from '../core/config';
import type { Db } from '../core/db';
import { quote, wrap } from '../core/errors';
import type { SyncStats } from '../core/model';
import type { Deps } from '../tui';
import { type Context, createdConfigError, spotifyClient, validateSyncConfig, withDb } from './context';

export async function runTuiCommand(ctx: Context): Promise<void> {
  const configPath = ctx.opts.resolveConfigPath();
  const databasePath = ctx.opts.resolveDbPath();
  await withDb(databasePath, async (db) => {
    const { runTui } = await import('../tui');
    try {
      await runTui(newTuiDeps(configPath, db));
    } catch (err) {
      throw wrap('run tracker TUI', err);
    }
  });
}

/**
 * Runs synchronous work on a later macrotask. The Db is synchronous, so
 * calling it inline from a TUI callback would block the frame the TUI is
 * about to render (a loading or saving indicator); deferring lets it paint.
 */
export function deferred<T>(work: () => T | Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        resolve(work());
      } catch (err) {
        reject(err);
      }
    });
  });
}

export function newTuiDeps(configPath: string, db: Db): Deps {
  return {
    load: () => deferred(() => ({ tracks: db.listAllTracks(), ratings: db.listAllRatings() })),
    saveRating: (params) => deferred(() => db.upsertRating(params)),
    sync: () => deferred(() => tuiSync(configPath, db)),
  };
}

/**
 * The CLI's sync path (config loading, validation, token persistence),
 * re-read on every TUI sync so config edits made while it is open apply.
 * `surface` names the UI in the first-run hint (`tracker web` shares this).
 */
export async function tuiSync(configPath: string, db: Db, surface = 'the TUI'): Promise<SyncStats> {
  const { cfg, created } = ensureLoadedConfig(configPath);
  if (created) {
    throw createdConfigError(
      configPath,
      `set spotify.client_id and spotify.client_secret, run \`tracker --config ${quote(configPath)} spotify login\`, then retry sync from ${surface}`,
    );
  }
  validateSyncConfig(cfg, configPath);

  const client = await spotifyClient(cfg, configPath);
  const { runSync } = await import('../spotify');
  return runSync(cfg, client, db, 50);
}
