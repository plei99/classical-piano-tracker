import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Request } from '..';
import { CanceledError, DeadlineExceededError, aborted, contextError } from '../context';
import { CodexProvider } from './codex';
import { emptyRecord, flagValue, stubRunner } from './testsupport';

function request(overrides: Partial<Request> = {}): Request {
  return {
    systemPrompt: '',
    userPrompt: '',
    outputMode: 'strict',
    schema: null,
    temperature: 0,
    maxOutputTokens: 0,
    ...overrides,
  };
}

describe('CodexProvider', () => {
  it('sends the request via stdin and keeps artifacts private', async () => {
    let dir = '';
    const provider = new CodexProvider(' chosen-model ', '/opt/bin/codex', async (inv) => {
      dir = inv.dir;
      expect(inv.name).toBe('/opt/bin/codex');
      expect(inv.stdin).toContain('task instructions');
      expect(inv.stdin).toContain('private taste data');
      expect(inv.args[0]).toBe('exec');
      expect(inv.args.at(-1)).toBe('-');
      for (const flag of ['--ephemeral', '--ignore-user-config', '--skip-git-repo-check']) {
        expect(inv.args).toContain(flag);
      }
      expect(flagValue(inv.args, '--sandbox')).toBe('read-only');
      expect(flagValue(inv.args, '--color')).toBe('never');
      expect(flagValue(inv.args, '--model')).toBe('chosen-model');
      for (const setting of [
        'approval_policy="never"',
        'web_search="disabled"',
        'features.shell_tool=false',
        'features.unified_exec=false',
        'project_doc_max_bytes=0',
      ]) {
        expect(inv.args).toContain(setting);
      }
      expect(inv.args.join(' ')).not.toContain('private taste data');

      const schemaPath = flagValue(inv.args, '--output-schema');
      const outputPath = flagValue(inv.args, '--output-last-message');
      const modes: Array<[string, number]> = [
        [inv.dir, 0o700],
        [schemaPath, 0o600],
        [outputPath, 0o600],
      ];
      for (const [path, mode] of modes) {
        expect(statSync(path).mode & 0o777, path).toBe(mode);
      }
      expect(dirname(schemaPath)).toBe(inv.dir);
      expect(dirname(outputPath)).toBe(inv.dir);
      expect((JSON.parse(readFileSync(schemaPath, 'utf8')) as { type: string }).type).toBe('object');
      writeFileSync(outputPath, ' {"summary":"lyrical playing"}\n', { mode: 0o600 });
      return { stdout: Buffer.from('progress, not JSON'), stderr: Buffer.alloc(0), error: null };
    });

    const raw = await provider.generate(
      request({
        systemPrompt: 'task instructions',
        userPrompt: 'private taste data',
        schema: { name: '', schema: { type: 'object' }, strict: false },
      }),
    );
    expect(raw).toBe('{"summary":"lyrical playing"}');
    expect(existsSync(dir)).toBe(false);
  });

  it('returns text without a model or schema', async () => {
    const provider = new CodexProvider('', '', async (inv) => {
      expect(inv.name).toBe('codex');
      expect(inv.args).not.toContain('--model');
      expect(inv.args).not.toContain('--output-schema');
      writeFileSync(flagValue(inv.args, '--output-last-message'), 'plain text fallback', { mode: 0o600 });
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: null };
    });
    expect(await provider.generate(request({ userPrompt: 'task' }))).toBe('plain text fallback');
  });

  it('reports failures and cleans up', async () => {
    const missing = Object.assign(new Error('file does not exist'), { code: 'ENOENT' });
    const cases: Array<{ name: string; stderr: string; error: Error | null; want: string }> = [
      { name: 'empty', stderr: '', error: null, want: 'no final response' },
      {
        name: 'exit',
        stderr: 'Please run codex login',
        error: new Error('exit status 1'),
        want: 'Please run codex login',
      },
      { name: 'missing', stderr: '', error: missing, want: 'installed and signed in' },
    ];
    for (const tc of cases) {
      const record = emptyRecord();
      const provider = new CodexProvider('', '', stubRunner(record, 'ignored stdout', tc.stderr, tc.error));
      const err = (await provider.generate(request()).catch((e: unknown) => e)) as Error;
      expect(err.message, tc.name).toContain(tc.want);
      if (tc.error !== null) {
        // Go's errors.Is: the runner's error stays reachable as the cause.
        expect(err.cause, tc.name).toBe(tc.error);
      }
      expect(existsSync(record.dir), tc.name).toBe(false);
    }
  });

  it('applies the deadline and honors cancellation', async () => {
    const provider = new CodexProvider('', '', async (inv) => {
      await aborted(inv.signal);
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: contextError(inv.signal as AbortSignal) };
    });
    expect(provider.timeoutMs).toBe(5 * 60_000);
    provider.timeoutMs = 10;
    const timedOut = (await provider.generate(request()).catch((e: unknown) => e)) as Error;
    expect(timedOut.cause).toBeInstanceOf(DeadlineExceededError);

    const controller = new AbortController();
    controller.abort();
    const canceled = (await provider.generate(request(), controller.signal).catch((e: unknown) => e)) as Error;
    expect(canceled.cause).toBeInstanceOf(CanceledError);
  });

  it('rejects an unmarshalable schema without running the CLI', async () => {
    const provider = new CodexProvider('', '', async () => {
      throw new Error('must not execute CLI for invalid schema');
    });
    await expect(
      provider.generate(request({ schema: { name: '', schema: { bad: () => 1 }, strict: false } })),
    ).rejects.toThrow('marshal Codex JSON schema');
  });
});
