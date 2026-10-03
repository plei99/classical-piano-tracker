/**
 * `tracker sync`: pull recent Spotify plays into SQLite, and report when
 * that last happened.
 */
import { ensureLoadedConfig } from '../core/config';
import { quote, wrap } from '../core/errors';
import { type Context, createdConfigError, spotifyClient, validateSyncConfig, withDb } from './context';
import { localLongDateTime, nanosToMillis } from './timefmt';

export async function runSync(ctx: Context, limit: number): Promise<void> {
  const configPath = ctx.opts.resolveConfigPath();
  const { cfg, created } = ensureLoadedConfig(configPath);
  if (created) {
    throw createdConfigError(
      configPath,
      `set spotify.client_id and spotify.client_secret, run \`tracker --config ${quote(configPath)} spotify login\`, then rerun \`tracker sync\``,
    );
  }
  validateSyncConfig(cfg, configPath);

  const databasePath = ctx.opts.resolveDbPath();
  const client = await spotifyClient(cfg, configPath);
  const { runSync: sync } = await import('../spotify');
  const stats = await withDb(databasePath, (db) => sync(cfg, client, db, limit));

  const out = ctx.out;
  out.write(`database: ${databasePath}\n`);
  out.write(`fetched: ${stats.fetched}\n`);
  out.write(`already_synced: ${stats.alreadySynced}\n`);
  out.write(`blocked: ${stats.blocked}\n`);
  out.write(`skipped: ${stats.skipped}\n`);
  out.write(`accepted: ${stats.accepted}\n`);
  out.write(`inserted: ${stats.inserted}\n`);
  out.write(`updated: ${stats.updated}\n`);
}

export async function runSyncStatus(ctx: Context): Promise<void> {
  const checkpoint = await withDb(ctx.opts.resolveDbPath(), (db) => {
    try {
      return db.recentPlayCheckpoint();
    } catch (err) {
      throw wrap('load recent play checkpoint', err);
    }
  });
  if (checkpoint === null) {
    ctx.out.write('Last sync: never\n');
    return;
  }
  ctx.out.write(`Last sync: ${localLongDateTime(nanosToMillis(checkpoint))}\n`);
}
