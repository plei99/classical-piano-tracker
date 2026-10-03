/**
 * Running the codex and claude CLIs. Process execution is injectable so the
 * providers can be tested without real CLIs; providers own private working
 * directories so caller repositories cannot contribute instructions.
 *
 * {@link execCommand} mirrors Go's `exec.CommandContext` + `cmd.Run`: the
 * same PATH lookup and error wording ("exec: \"codex\": executable file not
 * found in $PATH", "exit status 1", "signal: killed"), SIGKILL on
 * cancellation reported as the context error, and a one-second WaitDelay
 * for output pipes held open by grandchildren.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { goQuote } from '../../recommend/gojson';
import { goTrimSpace } from '../../recommend/gostrings';
import { contextError } from '../context';

/** How long to keep reading output after the process exits, like Go's `cmd.WaitDelay`. */
const WAIT_DELAY_MS = 1000;

export interface CommandInvocation {
  /** Working directory for the child process. */
  dir: string;
  /** Text piped to the child's stdin. */
  stdin: string;
  /** Program name or path. */
  name: string;
  args: string[];
  signal?: AbortSignal;
}

/** Captured output plus the reason the command failed, if it did (Go's `(stdout, stderr, err)`). */
export interface CommandResult {
  stdout: Buffer;
  stderr: Buffer;
  error: Error | null;
}

export type CommandRunner = (invocation: CommandInvocation) => Promise<CommandResult>;

/** Go's `*exec.Error`: the program could not be located. */
export class ExecError extends Error {
  constructor(
    readonly program: string,
    reason: string,
  ) {
    super(`exec: ${goQuote(program)}: ${reason}`);
    this.name = 'ExecError';
  }
}

/** Go's `*exec.ExitError`: the process ran but did not succeed. */
export class ExitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly signalName: NodeJS.Signals | null,
  ) {
    super(message);
    this.name = 'ExitError';
  }
}

/** Go's errno texts, which end up in user-facing errors. */
const ERRNO_TEXT: Record<string, string> = {
  ENOENT: 'no such file or directory',
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  ENOTDIR: 'not a directory',
  EISDIR: 'is a directory',
  EEXIST: 'file exists',
  ENOEXEC: 'exec format error',
  E2BIG: 'argument list too long',
  ETXTBSY: 'text file busy',
};

/** Renders a Node fs/spawn error as Go's `*fs.PathError` ("op path: errno text"). */
export function goPathError(op: string, path: string, err: unknown): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const text =
    (code !== undefined ? ERRNO_TEXT[code] : undefined) ?? (err instanceof Error ? err.message : String(err));
  return new Error(`${op} ${path}: ${text}`, { cause: err });
}

const SIGNAL_TEXT: Partial<Record<NodeJS.Signals, string>> = {
  SIGHUP: 'hangup',
  SIGINT: 'interrupt',
  SIGQUIT: 'quit',
  SIGILL: 'illegal instruction',
  SIGTRAP: 'trace/breakpoint trap',
  SIGABRT: process.platform === 'darwin' ? 'abort trap' : 'aborted',
  SIGBUS: 'bus error',
  SIGFPE: 'floating point exception',
  SIGKILL: 'killed',
  SIGUSR1: 'user defined signal 1',
  SIGSEGV: 'segmentation fault',
  SIGUSR2: 'user defined signal 2',
  SIGPIPE: 'broken pipe',
  SIGALRM: 'alarm clock',
  SIGTERM: 'terminated',
};

/** Go's `ProcessState.String()` for a failed process. */
function exitText(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) {
    return `signal: ${SIGNAL_TEXT[signal] ?? signal}`;
  }
  return `exit status ${code ?? -1}`;
}

function isExecutable(path: string): boolean {
  try {
    if (statSync(path).isDirectory()) {
      return false;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirrors Go's `exec.Command` resolution: names containing a separator are
 * used as paths (relative ones resolve against the working directory), bare
 * names are looked up in `$PATH`, and a match relative to the current
 * directory is refused.
 */
export function resolveProgram(name: string, dir: string): string {
  if (name.includes('/') || name.includes(sep)) {
    return isAbsolute(name) ? name : resolve(dir, name);
  }
  const pathVar = process.env['PATH'] ?? '';
  if (pathVar !== '') {
    for (const entry of pathVar.split(delimiter)) {
      const candidate = join(entry === '' ? '.' : entry, name);
      if (!isExecutable(candidate)) {
        continue;
      }
      if (!isAbsolute(candidate)) {
        throw new ExecError(name, 'cannot run executable found relative to current directory');
      }
      return candidate;
    }
  }
  throw new ExecError(name, 'executable file not found in $PATH');
}

/** Runs a command with stdin piped in and stdout/stderr captured. */
export function execCommand(invocation: CommandInvocation): Promise<CommandResult> {
  const { signal } = invocation;
  const empty = (error: Error): Promise<CommandResult> =>
    Promise.resolve({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error });

  if (signal?.aborted) {
    return empty(contextError(signal));
  }
  let program: string;
  try {
    program = resolveProgram(invocation.name, invocation.dir);
  } catch (err) {
    return empty(err as Error);
  }

  return new Promise((done) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let waitTimer: NodeJS.Timeout | undefined;

    const child = spawn(program, invocation.args, { cwd: invocation.dir, stdio: ['pipe', 'pipe', 'pipe'] });

    const onAbort = (): void => {
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (error: Error | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(waitTimer);
      signal?.removeEventListener('abort', onAbort);
      // Once the context is done, its error replaces whatever the process reported.
      const finalError = error !== null && signal?.aborted === true ? contextError(signal) : error;
      done({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), error: finalError });
    };

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    // A CLI that exits without reading stdin closes the pipe; Go ignores that EPIPE too.
    child.stdin.on('error', () => {});
    child.stdin.end(invocation.stdin);

    child.on('error', (err) => {
      finish(goPathError('fork/exec', invocation.name, err));
    });

    let exitError: Error | null = null;
    child.on('exit', (code, signalName) => {
      exitError = code === 0 ? null : new ExitError(exitText(code, signalName), code, signalName);
      // Bound waits on inherited output pipes if the CLI left children running.
      waitTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(exitError ?? new Error('exec: WaitDelay expired before I/O complete'));
      }, WAIT_DELAY_MS);
    });
    child.on('close', () => finish(exitError));
  });
}

/** Go's `commandError`: names the CLI and suggests setup steps when there is no detail. */
export function commandError(command: string, err: Error, detail: Buffer | string): Error {
  const text = goTrimSpace(typeof detail === 'string' ? detail : detail.toString('utf8'));
  if (text !== '') {
    return new Error(`run ${command}: ${err.message}: ${text}`, { cause: err });
  }
  return new Error(
    `run ${command}: ${err.message} (check that the CLI is installed and signed in; configure command or LLM_COMMAND if it is not on PATH)`,
    { cause: err },
  );
}

/**
 * Creates an owner-only (0700) scratch directory like Go's
 * `os.MkdirTemp("", prefix + "*")`; the caller removes it.
 */
export function makePrivateTempDir(prefix: string): string {
  try {
    return mkdtempSync(join(tmpdir(), prefix));
  } catch (err) {
    throw goPathError('mkdirtemp', join(tmpdir(), `${prefix}*`), err);
  }
}

export function removeAll(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
