/**
 * `tracker spotify`: OAuth login and a raw view of recent plays.
 */
import { ensureLoadedConfig, mergeToken, saveConfig } from '../core/config';
import { quote, wrap } from '../core/errors';
import { type Context, createdConfigError, spotifyClient } from './context';
import { printRecentSpotifyTracks } from './format';

export async function runSpotifyLogin(ctx: Context): Promise<void> {
  const configPath = ctx.opts.resolveConfigPath();
  const { cfg, created } = ensureLoadedConfig(configPath);
  if (created) {
    throw createdConfigError(
      configPath,
      `set spotify.client_id and spotify.client_secret, then rerun \`tracker --config ${quote(configPath)} spotify login\``,
    );
  }

  const { login, DEFAULT_REDIRECT_URL } = await import('../spotify');
  const token = await login(cfg.spotify, (url) => {
    ctx.out.write(
      `Open this URL in your browser:\n${url}\n\nWaiting for the Spotify callback at ${DEFAULT_REDIRECT_URL}\n`,
    );
  });

  cfg.spotify.token = mergeToken(token, cfg.spotify.token);
  try {
    saveConfig(configPath, cfg);
  } catch (err) {
    throw wrap(`save Spotify token to ${quote(configPath)}`, err);
  }
  ctx.out.write(`spotify login succeeded: token saved to ${configPath}\n`);
}

export async function runSpotifyRecent(ctx: Context, limit: number): Promise<void> {
  const configPath = ctx.opts.resolveConfigPath();
  const { cfg, created } = ensureLoadedConfig(configPath);
  if (created) {
    throw createdConfigError(
      configPath,
      `set spotify.client_id and spotify.client_secret, run \`tracker --config ${quote(configPath)} spotify login\`, then rerun this command`,
    );
  }

  const client = await spotifyClient(cfg, configPath);
  const tracks = await client.recentTracks(limit);
  if (tracks.length === 0) {
    ctx.out.write('no recent Spotify plays returned\n');
    return;
  }
  printRecentSpotifyTracks(ctx.out, tracks);
}
