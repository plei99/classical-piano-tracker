import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { Db } from '../core/db';
import { run, saveTestConfig, tempPath } from './testutil';
import { localLongDateTime } from './timefmt';

describe('sync', () => {
  // Go: TestSyncStatusPrintsNeverWithoutCheckpoint
  it('status prints never without a checkpoint', async () => {
    const dbPath = tempPath('tracker.db');
    const { code, stdout } = await run(['--db', dbPath, 'sync', 'status']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('Last sync: never');
  });

  // Go: TestSyncStatusPrintsCheckpointTimestamp
  it('status prints the checkpoint timestamp', async () => {
    const dbPath = tempPath('tracker.db');
    const checkpointMs = Date.UTC(2026, 3, 3, 14, 30);
    const db = Db.open(dbPath);
    db.upsertRecentPlayCheckpoint(BigInt(checkpointMs) * 1_000_000n);
    db.close();

    const { code, stdout } = await run(['--db', dbPath, 'sync', 'status']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(`Last sync: ${localLongDateTime(checkpointMs)}`);
  });

  it('requires a filled config and a login before touching the database', async () => {
    const configPath = tempPath('config.json');
    const dbPath = tempPath('tracker.db');
    const quoted = JSON.stringify(configPath);
    const args = ['--config', configPath, '--db', dbPath, 'sync'];

    const first = await run(args);
    expect(first.code).toBe(1);
    expect(first.stderr).toBe(
      `created default config at ${quoted}; set spotify.client_id and spotify.client_secret, ` +
        `run \`tracker --config ${quoted} spotify login\`, then rerun \`tracker sync\`\n`,
    );

    const second = await run(args);
    expect(second.stderr).toMatch(new RegExp(`^invalid config ${escape(quoted)}: spotify\\.client_id is required`));

    saveTestConfig(configPath, ['Martha Argerich']);
    const third = await run(args);
    expect(third.stderr).toBe(`spotify login required for ${quoted}: spotify.token is required\n`);
    expect(existsSync(dbPath)).toBe(false);
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
