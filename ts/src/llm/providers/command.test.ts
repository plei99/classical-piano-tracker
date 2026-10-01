import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanceledError, DeadlineExceededError } from '../context';
import { ExecError, ExitError, commandError, execCommand } from './command';
import { writeScript } from './testsupport';

function workDir(): string {
  return mkdtempSync(join(tmpdir(), 'tracker-work-'));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('execCommand', () => {
  // Go re-executes its test binary as the helper; a shell script plays that role here.
  it('pipes stdin, sets the working directory, and captures output', async () => {
    const script = writeScript('echo', 'pwd\ncat\nprintf diagnostic >&2');
    const dir = workDir();
    const result = await execCommand({ dir, stdin: 'piped input', name: script, args: [] });
    expect(result.error).toBeNull();
    const stdout = result.stdout.toString('utf8');
    const newline = stdout.indexOf('\n');
    expect(realpathSync(stdout.slice(0, newline))).toBe(realpathSync(dir));
    expect(stdout.slice(newline + 1)).toBe('piped input');
    expect(result.stderr.toString('utf8')).toBe('diagnostic');
  });

  it('reports deadline and cancellation as context errors', async () => {
    const script = writeScript('wait', 'exec sleep 60');
    const started = Date.now();
    const timedOut = await execCommand({
      dir: workDir(),
      stdin: '',
      name: script,
      args: [],
      signal: AbortSignal.timeout(50),
    });
    expect(timedOut.error).toBeInstanceOf(DeadlineExceededError);
    expect(timedOut.error?.message).toBe('context deadline exceeded');
    expect(Date.now() - started).toBeLessThan(5000);

    const controller = new AbortController();
    controller.abort();
    const canceled = await execCommand({
      dir: workDir(),
      stdin: '',
      name: script,
      args: [],
      signal: controller.signal,
    });
    expect(canceled.error).toBeInstanceOf(CanceledError);
    expect(canceled.error?.message).toBe('context canceled');

    const late = new AbortController();
    const pending = execCommand({ dir: workDir(), stdin: '', name: script, args: [], signal: late.signal });
    setTimeout(() => late.abort(), 20);
    expect((await pending).error).toBeInstanceOf(CanceledError);
  });

  it('bounds waits on pipes held open by grandchildren', async () => {
    const script = writeScript('fork', 'sleep 5 &\nexit 0');
    const started = Date.now();
    const result = await execCommand({ dir: workDir(), stdin: '', name: script, args: [] });
    expect(result.error?.message).toBe('exec: WaitDelay expired before I/O complete');
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('reports exit status and missing programs with Go wording', async () => {
    const script = writeScript('fail', 'echo oops >&2\nexit 3');
    const failed = await execCommand({ dir: workDir(), stdin: '', name: script, args: [] });
    expect(failed.error).toBeInstanceOf(ExitError);
    expect(failed.error?.message).toBe('exit status 3');
    expect(failed.stderr.toString('utf8')).toBe('oops\n');

    const killed = await execCommand({ dir: workDir(), stdin: '', name: writeScript('kill', 'kill -9 $$'), args: [] });
    expect(killed.error?.message).toBe('signal: killed');

    const missingPath = await execCommand({ dir: workDir(), stdin: '', name: '/nonexistent/claude', args: [] });
    expect(missingPath.error?.message).toBe('fork/exec /nonexistent/claude: no such file or directory');

    const missing = await execCommand({
      dir: workDir(),
      stdin: '',
      name: 'definitely-not-a-real-tracker-cli',
      args: [],
    });
    expect(missing.error).toBeInstanceOf(ExecError);
    expect(missing.error?.message).toBe(
      'exec: "definitely-not-a-real-tracker-cli": executable file not found in $PATH',
    );
  });

  it('resolves bare names on PATH and relative paths against the working directory', async () => {
    const script = writeScript('tracker-fake-cli', 'printf "%s" "$1"');
    vi.stubEnv('PATH', `${dirname(script)}:${process.env['PATH'] ?? ''}`);
    const found = await execCommand({ dir: workDir(), stdin: '', name: 'tracker-fake-cli', args: ['arg'] });
    expect(found.error).toBeNull();
    expect(found.stdout.toString('utf8')).toBe('arg');

    const dir = workDir();
    writeScript('local', 'printf local', dir);
    const local = await execCommand({ dir, stdin: '', name: './local', args: [] });
    expect(local.stdout.toString('utf8')).toBe('local');

    // A PATH match relative to the current directory is refused, as in Go.
    vi.stubEnv('PATH', `${relative(process.cwd(), dirname(script))}:${process.env['PATH'] ?? ''}`);
    const refused = await execCommand({ dir: workDir(), stdin: '', name: 'tracker-fake-cli', args: [] });
    expect(refused.error?.message).toBe(
      'exec: "tracker-fake-cli": cannot run executable found relative to current directory',
    );
  });
});

describe('commandError', () => {
  it('includes trimmed detail or a setup hint', () => {
    const cause = new Error('exit status 1');
    const withDetail = commandError('codex', cause, Buffer.from(' Please run codex login\n'));
    expect(withDetail.message).toBe('run codex: exit status 1: Please run codex login');
    expect(withDetail.cause).toBe(cause);
    expect(commandError('claude', new DeadlineExceededError(), '  ').message).toBe(
      'run claude: context deadline exceeded (check that the CLI is installed and signed in; configure command or LLM_COMMAND if it is not on PATH)',
    );
  });
});
