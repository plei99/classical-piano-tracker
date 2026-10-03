import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../core/config';
import { run, saveTestConfig, tempPath } from './testutil';

describe('config commands', () => {
  // Go: TestConfigAllowlistAddUpdatesConfigFile
  it('allowlist add updates the config file', async () => {
    const configPath = tempPath('config.json');
    saveTestConfig(configPath, ['Martha Argerich']);

    const { code, stdout } = await run(['--config', configPath, 'config', 'allowlist', 'add', 'Daniil Trifonov']);
    expect(code).toBe(0);
    expect(stdout).toContain('added "Daniil Trifonov"');
    expect(loadConfig(configPath).pianistsAllowlist).toContain('Daniil Trifonov');
  });

  // Go: TestConfigBlocklistRemovePersistsChange
  it('blocklist remove persists the change', async () => {
    const configPath = tempPath('config.json');
    saveTestConfig(configPath, ['Martha Argerich'], ['Yiruma']);

    const { code, stdout } = await run(['--config', configPath, 'config', 'blocklist', 'remove', 'yiruma']);
    expect(code).toBe(0);
    expect(stdout).toContain('removed "yiruma"');
    expect(loadConfig(configPath).artistsBlocklist).not.toContain('Yiruma');
  });

  // Go: TestConfigAllowlistListPrintsEntries
  it('allowlist list prints entries', async () => {
    const configPath = tempPath('config.json');
    saveTestConfig(configPath, ['Martha Argerich', 'Daniil Trifonov']);

    const { code, stdout } = await run(['--config', configPath, 'config', 'allowlist', 'list']);
    expect(code).toBe(0);
    expect(stdout).toContain('1. Martha Argerich');
    expect(stdout).toContain('2. Daniil Trifonov');
  });

  it('reports unchanged lists and empty entries', async () => {
    const configPath = tempPath('config.json');
    saveTestConfig(configPath, ['Martha Argerich']);

    expect((await run(['--config', configPath, 'config', 'blocklist', 'list'])).stdout).toBe('no entries\n');
    expect((await run(['--config', configPath, 'config', 'allowlist', 'add', '  martha  argerich '])).stdout).toBe(
      '"martha  argerich" is already present\n',
    );
    expect((await run(['--config', configPath, 'config', 'blocklist', 'remove', 'Nobody'])).stdout).toBe(
      '"Nobody" was not present\n',
    );
    const blank = await run(['--config', configPath, 'config', 'allowlist', 'add', '   ']);
    expect(blank.code).toBe(1);
    expect(blank.stderr).toBe('artist name must not be blank\n');
  });

  it('announces a created default config when editing', async () => {
    const configPath = tempPath('config.json');
    const { stdout } = await run(['--config', configPath, 'config', 'blocklist', 'add', 'Yiruma']);
    expect(stdout).toBe(`created default config at ${configPath}\nadded "Yiruma"\n`);
    expect(loadConfig(configPath).artistsBlocklist).toEqual(['Yiruma']);
  });

  it('path prints the config path without creating it', async () => {
    const configPath = tempPath('config.json');
    const { code, stdout, stderr } = await run(['--config', configPath, 'config', 'path']);
    expect(code).toBe(0);
    expect(stdout).toBe(`${configPath}\n`);
    expect(stderr).toBe('');
    expect(existsSync(configPath)).toBe(false);
  });

  it('validate explains first-run setup, then reports problems', async () => {
    const configPath = tempPath('config.json');
    const quoted = JSON.stringify(configPath);

    const first = await run(['--config', configPath, 'config', 'validate']);
    expect(first.code).toBe(1);
    expect(first.stderr).toBe(
      `created default config at ${quoted}; fill the required values, then rerun ` +
        `\`tracker --config ${quoted} config validate\`: spotify.client_id is required; spotify.client_secret is required\n`,
    );

    const second = await run(['--config', configPath, 'config', 'validate']);
    expect(second.stderr).toBe(
      `invalid config ${quoted}: spotify.client_id is required; spotify.client_secret is required\n`,
    );

    saveTestConfig(configPath, ['Martha Argerich']);
    const valid = await run(['--config', configPath, 'config', 'validate']);
    expect(valid.code).toBe(0);
    expect(valid.stdout).toBe(`config is valid: ${configPath}\n`);
  });
});
