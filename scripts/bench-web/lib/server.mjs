// Spawning a `tracker web` server, timing its readiness, sampling its
// resources, and waiting for it to exit.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import http from 'node:http';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** What `web --help` advertises; `--keep-running` marks a build with auto-stop. */
export function probeBinary(bin) {
  let help = '';
  try {
    help = execFileSync(bin, ['web', '--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });
  } catch (e) {
    help = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  return { keepRunningFlag: /--keep-running\b/.test(help) };
}

function get(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { agent: false, headers: { Connection: 'close' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
      res.on('error', () => resolve(0));
    });
    req.on('error', () => resolve(0));
    req.setTimeout(2000, () => req.destroy());
  });
}

/**
 * Spawns the server and polls GET / until the first 200.
 * Returns timings in ms from spawn: `ready` (first 200), `banner` (the
 * "Serving ..." line on stdout).
 */
export async function startServer({ bin, config, db, keepRunning, timeoutMs = 30000 }) {
  const port = await freePort();
  const args = ['--config', config, '--db', db, 'web', '--no-open', '--port', String(port)];
  if (keepRunning) args.push('--keep-running');
  const url = `http://127.0.0.1:${port}/`;
  const t0 = performance.now();
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const srv = { proc, port, url, pid: proc.pid, banner: null, output: '', exited: null, exitAt: null };
  srv.exitPromise = new Promise((resolve) => {
    proc.once('exit', (code, signal) => {
      srv.exited = { code, signal };
      srv.exitAt = performance.now();
      resolve(srv.exited);
    });
  });
  const onData = (d) => {
    const s = String(d);
    if (srv.output.length < 20000) srv.output += s;
    if (srv.banner === null && s.includes('Serving the tracker web UI at')) srv.banner = performance.now() - t0;
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  for (;;) {
    if (srv.exited) throw new Error(`server exited early (${JSON.stringify(srv.exited)}): ${srv.output.slice(0, 500)}`);
    const status = await get(url);
    if (status === 200) break;
    if (performance.now() - t0 > timeoutMs) {
      proc.kill('SIGKILL');
      throw new Error(`server not ready after ${timeoutMs} ms: ${srv.output.slice(0, 500)}`);
    }
    await new Promise((r) => setTimeout(r, 2));
  }
  srv.ready = performance.now() - t0;
  return srv;
}

function parseCpuTime(s) {
  // ps TIME: [[dd-]hh:]mm:ss.cc
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s.trim());
  if (!m) return null;
  const [, d = 0, h = 0, mm, ss] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(mm)) * 60 + Number(ss);
}

/** RSS (KiB) and CPU time (user+system, s) of the server and its descendants. */
export async function processStats(pid) {
  const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,rss=,time=']);
  const rows = stdout
    .trim()
    .split('\n')
    .map((l) => {
      const [p, pp, rss, time] = l.trim().split(/\s+/);
      return { pid: Number(p), ppid: Number(pp), rss: Number(rss), cpu: parseCpuTime(time) };
    });
  const tree = new Set([pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) if (!tree.has(r.pid) && tree.has(r.ppid)) (tree.add(r.pid), (grew = true));
  }
  const mine = rows.filter((r) => tree.has(r.pid));
  if (mine.length === 0) return null;
  return {
    rssMiB: mine.reduce((a, r) => a + r.rss, 0) / 1024,
    cpuSec: mine.reduce((a, r) => a + (r.cpu ?? 0), 0),
    processes: mine.length,
  };
}

/** Non-loopback sockets the server holds (should be none: no Spotify traffic). */
export async function externalSockets(pid) {
  try {
    const { stdout } = await execFileP('lsof', ['-nP', '-a', '-p', String(pid), '-i']);
    return stdout
      .split('\n')
      .slice(1)
      .filter((l) => l.trim() !== '' && !/127\.0\.0\.1|\[::1\]|localhost/.test(l))
      .map((l) => l.trim().split(/\s+/).slice(-2).join(' '));
  } catch {
    return []; // lsof exits 1 when there is nothing to list
  }
}

export async function stopServer(srv, graceMs = 3000) {
  if (srv.exited) return srv.exited;
  srv.proc.kill('SIGTERM');
  const t = setTimeout(() => srv.proc.kill('SIGKILL'), graceMs);
  const r = await srv.exitPromise;
  clearTimeout(t);
  return r;
}

/** Resolves with ms until exit, or null after `timeoutMs`. */
export async function waitExit(srv, sinceT, timeoutMs) {
  if (srv.exited) return srv.exitAt - sinceT;
  const r = await Promise.race([
    srv.exitPromise.then(() => true),
    new Promise((res) => setTimeout(() => res(false), timeoutMs)),
  ]);
  return r ? srv.exitAt - sinceT : null;
}
