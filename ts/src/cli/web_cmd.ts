/**
 * `tracker web`: serves the browser UI from a local server until Ctrl+C.
 * Like `tracker tui`, it owns the database and the Spotify wiring and hands
 * the server plain callbacks.
 */
import { spawn } from 'node:child_process';

import { wrap } from '../core/errors';
import type { WebAssets, WebServer, WebServerOptions } from '../web/server';
import { type Context, withDb } from './context';
import { tuiSync } from './tui_cmd';

export const DEFAULT_WEB_PORT = 8765;

/** Seams that tests replace: nothing here may reach a real browser, signal, or build artifact. */
export interface WebCommandDeps {
  loadAssets: () => Promise<WebAssets>;
  startServer: (options: WebServerOptions) => Promise<WebServer>;
  openBrowser: (url: string) => void;
  /** Resolves when the server should stop. */
  waitForShutdown: () => Promise<void>;
}

export interface WebCommandOptions {
  port: number;
  open: boolean;
}

export function defaultWebDeps(): WebCommandDeps {
  return {
    // Provided by scripts/build.mjs; only the bundled binary can resolve it.
    loadAssets: async () => (await import('virtual:web-assets')).default,
    startServer: async (options) => (await import('../web/server')).startWebServer(options),
    openBrowser,
    waitForShutdown,
  };
}

export async function runWebCommand(
  ctx: Context,
  options: WebCommandOptions,
  deps: WebCommandDeps = defaultWebDeps(),
): Promise<void> {
  const { port } = options;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`--port must be between 0 and 65535, got ${port}`);
  }
  const configPath = ctx.opts.resolveConfigPath();
  const databasePath = ctx.opts.resolveDbPath();
  let assets: WebAssets;
  try {
    assets = await deps.loadAssets();
  } catch (err) {
    throw wrap('load web UI assets (run the bundled build)', err);
  }

  await withDb(databasePath, async (db) => {
    const { ArtworkService, artworkCachePath, configArtworkApi } = await import('../web/server');
    const artwork = new ArtworkService({
      cachePath: artworkCachePath(databasePath),
      spotify: () => configArtworkApi(configPath),
    });
    let server: WebServer;
    try {
      server = await deps.startServer({
        db,
        assets,
        artwork,
        port,
        sync: () => tuiSync(configPath, db, 'the web UI'),
      });
    } catch (err) {
      artwork.close();
      if ((err as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE') {
        throw new Error(`port ${port} is in use; pass --port to choose another`, { cause: err });
      }
      throw wrap('start web server', err);
    }

    try {
      ctx.out.write(`Serving the tracker web UI at ${server.url} (Ctrl+C to stop)\n`);
      if (options.open) {
        deps.openBrowser(server.url);
      }
      await deps.waitForShutdown();
    } finally {
      await server.close();
      artwork.close();
    }
  });
}

/**
 * Best effort: the URL is already printed, so a missing `open`/`xdg-open`
 * (e.g. over SSH) must not fail the command.
 */
function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Ignored, as above.
  }
}

/** Taking over SIGINT/SIGTERM replaces Node's immediate exit, so the server and artwork cache close cleanly. */
function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
