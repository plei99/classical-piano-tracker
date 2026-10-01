import { describe, expect, it } from 'vitest';

import { Db } from '../core/db';
import { saveTestConfig, tempPath } from './testutil';
import { deferred, newTuiDeps, tuiSync } from './tui_cmd';

describe('tui wiring', () => {
  it('sync reports the created config, then validation errors', async () => {
    const configPath = tempPath('config.json');
    const quoted = JSON.stringify(configPath);
    const db = Db.openInMemory();

    await expect(tuiSync(configPath, db)).rejects.toThrow(
      `created default config at ${quoted}; set spotify.client_id and spotify.client_secret, ` +
        `run \`tracker --config ${quoted} spotify login\`, then retry sync from the TUI`,
    );
    await expect(tuiSync(configPath, db)).rejects.toThrow(`invalid config ${quoted}: spotify.client_id is required`);
    saveTestConfig(configPath, ['Martha Argerich']);
    await expect(tuiSync(configPath, db)).rejects.toThrow(
      `spotify login required for ${quoted}: spotify.token is required`,
    );
    db.close();
  });

  it('load and saveRating defer database work past the current turn', async () => {
    const db = Db.openInMemory();
    const track = db.upsertTrack({
      spotifyId: 'sp-1',
      trackName: 'Scarbo',
      albumName: 'Ravel',
      artists: '["Martha Argerich"]',
      lastPlayedAt: 100,
    });
    const deps = newTuiDeps(tempPath('config.json'), db);

    const order: string[] = [];
    const saving = deps
      .saveRating({ trackId: track.id, stars: 5, opinion: 'Electric', updatedAt: 200 })
      .then((rating) => {
        order.push('saved');
        return rating;
      });
    order.push('render');
    await Promise.resolve();
    order.push('microtask');
    expect(await saving).toEqual({ trackId: track.id, stars: 5, opinion: 'Electric', updatedAt: 200 });
    expect(order).toEqual(['render', 'microtask', 'saved']);

    const loaded = await deps.load();
    expect(loaded.tracks.map((t) => t.spotifyId)).toEqual(['sp-1']);
    expect(loaded.ratings).toHaveLength(1);
    db.close();
  });

  it('deferred surfaces thrown errors as rejections', async () => {
    await expect(
      deferred(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
