/**
 * Platform-specific locations for the database and config file. These must
 * match the Go build so every build shares one set of state.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_DIR_NAME = 'piano-tracker';
const DATABASE_NAME = 'tracker.db';
const CONFIG_NAME = 'config.json';

type Lookup = (key: string) => string | undefined;

const envLookup: Lookup = (key) => process.env[key] || undefined;

function homeDir(): string {
  const home = process.env['HOME'] || homedir();
  if (!home) {
    throw new Error('resolve user home directory: $HOME is not defined');
  }
  return home;
}

/** Split out for testability and to keep platform path policy in one place. */
export function dataDirForOS(platform: NodeJS.Platform, home: string, lookup: Lookup): string {
  switch (platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', APP_DIR_NAME);
    case 'win32':
      return join(lookup('LOCALAPPDATA') ?? lookup('APPDATA') ?? join(home, 'AppData', 'Local'), APP_DIR_NAME);
    default:
      return join(lookup('XDG_DATA_HOME') ?? join(home, '.local', 'share'), APP_DIR_NAME);
  }
}

/** Mirrors Go's `os.UserConfigDir`, which the Go build used for the config path. */
export function configDirForOS(platform: NodeJS.Platform, home: string, lookup: Lookup): string {
  switch (platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support');
    case 'win32':
      return lookup('APPDATA') ?? join(home, 'AppData', 'Roaming');
    default:
      return lookup('XDG_CONFIG_HOME') ?? join(home, '.config');
  }
}

export function defaultDataDir(): string {
  return dataDirForOS(process.platform, homeDir(), envLookup);
}

export function defaultDbPath(): string {
  return join(defaultDataDir(), DATABASE_NAME);
}

export function configPathFromConfigDir(configDir: string): string {
  return join(configDir, APP_DIR_NAME, CONFIG_NAME);
}

export function defaultConfigPath(): string {
  return configPathFromConfigDir(configDirForOS(process.platform, homeDir(), envLookup));
}
