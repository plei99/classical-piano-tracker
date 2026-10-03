/**
 * `tracker config`: inspect, validate, and edit the artist filters.
 */
import { type Config, addArtist, ensureLoadedConfig, removeArtist, saveConfig, validateConfig } from '../core/config';
import { errorMessage, quote, wrap } from '../core/errors';
import { type Context, createdConfigError } from './context';
import { goTrimSpace } from './gostr';

/** Which config list an allowlist/blocklist subcommand edits. */
export interface ArtistList {
  get(cfg: Config): string[];
  set(cfg: Config, artists: string[]): void;
}

export const allowlist: ArtistList = {
  get: (cfg) => cfg.pianistsAllowlist,
  set: (cfg, artists) => {
    cfg.pianistsAllowlist = artists;
  },
};

export const blocklist: ArtistList = {
  get: (cfg) => cfg.artistsBlocklist,
  set: (cfg, artists) => {
    cfg.artistsBlocklist = artists;
  },
};

function loadEditableConfig(ctx: Context): { cfg: Config; configPath: string; created: boolean } {
  const configPath = ctx.opts.resolveConfigPath();
  const { cfg, created } = ensureLoadedConfig(configPath);
  return { cfg, configPath, created };
}

export function runArtistList(ctx: Context, list: ArtistList): void {
  const { cfg } = loadEditableConfig(ctx);
  const entries = list.get(cfg);
  if (entries.length === 0) {
    ctx.out.write('no entries\n');
    return;
  }
  entries.forEach((entry, idx) => ctx.out.write(`${idx + 1}. ${entry}\n`));
}

export function runArtistEdit(ctx: Context, list: ArtistList, mode: 'add' | 'remove', rawArtist: string): void {
  const { cfg, configPath, created } = loadEditableConfig(ctx);
  const artist = goTrimSpace(rawArtist);
  let changed: boolean;
  if (mode === 'add') {
    const result = addArtist(list.get(cfg), artist);
    list.set(cfg, result.artists);
    changed = result.added;
  } else {
    const result = removeArtist(list.get(cfg), artist);
    list.set(cfg, result.artists);
    changed = result.removed;
  }

  try {
    saveConfig(configPath, cfg);
  } catch (err) {
    throw wrap(`save config ${quote(configPath)}`, err);
  }

  if (created) {
    ctx.out.write(`created default config at ${configPath}\n`);
  }
  if (mode === 'add') {
    ctx.out.write(changed ? `added ${quote(artist)}\n` : `${quote(artist)} is already present\n`);
  } else {
    ctx.out.write(changed ? `removed ${quote(artist)}\n` : `${quote(artist)} was not present\n`);
  }
}

export function runConfigPath(ctx: Context): void {
  ctx.out.write(`${ctx.opts.resolveConfigPath()}\n`);
}

export function runConfigValidate(ctx: Context): void {
  const path = ctx.opts.resolveConfigPath();
  const { cfg, created } = ensureLoadedConfig(path);
  try {
    validateConfig(cfg);
  } catch (err) {
    if (created) {
      throw createdConfigError(
        path,
        `fill the required values, then rerun \`tracker --config ${quote(path)} config validate\`: ${errorMessage(err)}`,
      );
    }
    throw wrap(`invalid config ${quote(path)}`, err);
  }
  ctx.out.write(`config is valid: ${path}\n`);
}
