import { createServer } from 'node:net';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { TOKEN_HEADER } from '../web/api';
import { startWebServer, type WebAssets } from '../web/server';
import { Context, RootOptions } from './context';
import { fakeOnboardingDeps, MemoryOut, run, tempDir } from './testutil';
import { runWebCommand, type WebCommandDeps } from './web_cmd';

const ASSETS: WebAssets = {
  '/': { contentType: 'text/html; charset=utf-8', body: '<meta content="%TRACKER_TOKEN%">' },
};

function context(): { ctx: Context; stdout: MemoryOut; configPath: string } {
  const dir = tempDir();
  const configPath = `${dir}/config.json`;
  const stdout = new MemoryOut();
  const ctx = new Context(
    { stdin: Readable.from(['']), stdout, stderr: new MemoryOut() },
    { onboarding: fakeOnboardingDeps() },
    new RootOptions(() => ({ config: configPath, db: `${dir}/tracker.db` })),
  );
  return { ctx, stdout, configPath };
}

/**
 * Real server on a free port with fake assets; `visit` runs while it is up,
 * standing in for the user's browser session before Ctrl+C.
 */
function fakeDeps(visit: (url: string) => Promise<void>): WebCommandDeps & { opened: string[]; url: () => string } {
  const opened: string[] = [];
  let url = '';
  return {
    opened,
    url: () => url,
    loadAssets: () => Promise.resolve(ASSETS),
    startServer: async (options) => {
      const server = await startWebServer(options);
      url = server.url;
      return server;
    },
    openBrowser: (target) => void opened.push(target),
    waitForShutdown: () => visit(url),
  };
}

describe('tracker web', () => {
  it('prints the URL, opens the browser, serves until shutdown, then closes', async () => {
    const { ctx, stdout, configPath } = context();
    let page = '';
    let syncError = '';
    const deps = fakeDeps(async (url) => {
      page = await (await fetch(url)).text();
      const token = /content="([0-9a-f]{32})"/.exec(page)![1]!;
      const sync = await fetch(`${url}api/sync`, { method: 'POST', headers: { [TOKEN_HEADER]: token } });
      syncError = ((await sync.json()) as { error: string }).error;
    });

    await runWebCommand(ctx, { port: 0, open: true }, deps);

    const url = deps.url();
    expect(stdout.text()).toBe(`Serving the tracker web UI at ${url} (Ctrl+C to stop)\n`);
    expect(deps.opened).toEqual([url]);
    expect(page).toMatch(/^<meta content="[0-9a-f]{32}">$/);
    // Sync goes through the CLI's config path, with the hint naming the web UI.
    expect(syncError).toBe(
      `created default config at ${JSON.stringify(configPath)}; set spotify.client_id and spotify.client_secret, ` +
        `run \`tracker --config ${JSON.stringify(configPath)} spotify login\`, then retry sync from the web UI`,
    );
    await expect(fetch(url)).rejects.toThrow();
  });

  it('skips the browser with --no-open', async () => {
    const { ctx, stdout } = context();
    const deps = fakeDeps(() => Promise.resolve());
    await runWebCommand(ctx, { port: 0, open: false }, deps);
    expect(stdout.text()).toContain('Serving the tracker web UI at http://127.0.0.1:');
    expect(deps.opened).toEqual([]);
  });

  it('reports a busy port', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      const { ctx } = context();
      await expect(
        runWebCommand(
          ctx,
          { port, open: false },
          fakeDeps(() => Promise.resolve()),
        ),
      ).rejects.toThrow(`port ${port} is in use; pass --port to choose another`);
    } finally {
      blocker.close();
    }
  });

  it('is registered with help, a default port, and port validation', async () => {
    const help = await run(['web', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Browse, sync, and rate tracks in a local web UI');
    expect(help.stdout).toContain('--port <int>');
    expect(help.stdout).toContain('(default: 8765)');
    expect(help.stdout).toContain('--no-open');
    expect(help.stdout).toContain('tracker web --port 9000 --no-open');

    const bad = await run(['web', '--port', '70000']);
    expect([bad.code, bad.stderr]).toEqual([1, '--port must be between 0 and 65535, got 70000\n']);
    const word = await run(['web', '--port', 'abc']);
    expect(word.stderr).toMatch(/^invalid argument "abc" for "--port" flag/);
  });
});
