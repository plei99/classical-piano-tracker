import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Request } from '..';
import { DeadlineExceededError, aborted, contextError } from '../context';
import { ClaudeCLIProvider } from './claudecli';
import { claudeCliModels } from './index';
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

describe('ClaudeCLIProvider', () => {
  it('builds print-mode args and returns structured output', async () => {
    const record = emptyRecord();
    const envelope =
      '{"type":"result","subtype":"success","is_error":false,"result":"done","structured_output":{"summary":"You like lyrical playing.","recommendations":[{"pianist_name":"Radu Lupu","why_fit":"warm tone","similar_to":["Murray Perahia"],"confidence":"medium"}]}}';
    const provider = new ClaudeCLIProvider('sonnet', '/opt/bin/claude', stubRunner(record, envelope, '', null));

    const schema = {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    };
    const raw = await provider.generate(
      request({
        systemPrompt: 'system prompt',
        userPrompt: 'user prompt with\nmultiple lines',
        schema: { name: 'pianist_discovery', schema, strict: true },
      }),
    );

    const parsed = JSON.parse(raw) as { summary: string; recommendations: Array<{ pianist_name: string }> };
    expect(parsed.summary).toBe('You like lyrical playing.');
    expect(parsed.recommendations).toHaveLength(1);
    expect(parsed.recommendations[0]?.pianist_name).toBe('Radu Lupu');

    expect(record.name).toBe('/opt/bin/claude');
    expect(record.dir).not.toBe('');
    expect(existsSync(record.dir)).toBe(false);
    expect(record.args).toContain('--strict-mcp-config');
    expect(record.args).toContain('--disable-slash-commands');
    expect(flagValue(record.args, '--mcp-config')).toBe('{"mcpServers":{}}');
    expect(flagValue(record.args, '--permission-mode')).toBe('dontAsk');
    expect(record.stdin).toBe('user prompt with\nmultiple lines');
    expect(record.args).toContain('-p');
    // Safe mode, not bare mode (which ignores login).
    expect(record.args).toContain('--safe-mode');
    expect(record.args).not.toContain('--bare');
    expect(record.args).toContain('--no-session-persistence');
    expect(flagValue(record.args, '--output-format')).toBe('json');
    expect(flagValue(record.args, '--tools')).toBe('');
    expect(flagValue(record.args, '--model')).toBe('sonnet');
    expect(flagValue(record.args, '--system-prompt')).toBe('system prompt');
    expect((JSON.parse(flagValue(record.args, '--json-schema')) as { type: string }).type).toBe('object');
    for (const arg of record.args) {
      expect(arg).not.toContain('user prompt');
    }
  });

  it('omits schema and model when unset and returns text', async () => {
    const record = emptyRecord();
    const envelope =
      '{"type":"result","subtype":"success","is_error":false,"result":"Radu Lupu || warm tone || Murray Perahia || medium"}';
    const provider = new ClaudeCLIProvider('', '', stubRunner(record, envelope, '', null));
    const raw = await provider.generate(
      request({ systemPrompt: 'system prompt', userPrompt: 'user prompt', outputMode: 'prompt_only' }),
    );
    expect(raw).toBe('Radu Lupu || warm tone || Murray Perahia || medium');
    expect(record.name).toBe('claude');
    expect(record.args).not.toContain('--json-schema');
    expect(record.args).not.toContain('--model');
  });

  it('falls back to result text when structured output is null', async () => {
    const envelope =
      '{"type":"result","subtype":"success","is_error":false,"result":"{\\"summary\\":\\"text fallback\\"}","structured_output":null}';
    const provider = new ClaudeCLIProvider('sonnet', 'claude', stubRunner(emptyRecord(), envelope, '', null));
    const raw = await provider.generate(
      request({ userPrompt: 'user prompt', schema: { name: '', schema: { type: 'object' }, strict: false } }),
    );
    expect(raw).toBe('{"summary":"text fallback"}');
  });

  it('reports an error envelope', async () => {
    const envelope =
      '{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate: OAuth session expired"}';
    const provider = new ClaudeCLIProvider('sonnet', 'claude', stubRunner(emptyRecord(), envelope, '', null));
    await expect(provider.generate(request({ userPrompt: 'user prompt' }))).rejects.toThrow('OAuth session expired');
  });

  it('includes stderr when the command fails', async () => {
    const provider = new ClaudeCLIProvider(
      'sonnet',
      'claude',
      stubRunner(emptyRecord(), '', "unknown option '--bogus'", new Error('exit status 1')),
    );
    const err = (await provider.generate(request({ userPrompt: 'user prompt' })).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('exit status 1');
    expect(err.message).toContain('unknown option');
  });

  it('rejects empty output', async () => {
    const envelope = '{"type":"result","subtype":"success","is_error":false,"result":"   "}';
    const provider = new ClaudeCLIProvider('sonnet', 'claude', stubRunner(emptyRecord(), envelope, '', null));
    await expect(provider.generate(request({ userPrompt: 'user prompt' }))).rejects.toThrow(
      'claude returned neither structured output nor text',
    );
  });

  it('applies the default timeout', async () => {
    const provider = new ClaudeCLIProvider('sonnet', 'claude', async (inv) => {
      await aborted(inv.signal);
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: contextError(inv.signal as AbortSignal) };
    });
    expect(provider.timeoutMs).toBe(5 * 60_000);
    provider.timeoutMs = 20;
    const err = (await provider.generate(request({ userPrompt: 'user prompt' })).catch((e: unknown) => e)) as Error;
    expect(err.cause).toBeInstanceOf(DeadlineExceededError);
  });

  it('preserves runtime errors on a nonzero exit', async () => {
    const cases: Array<[string, string, string]> = [
      [
        'auth',
        '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in. Please run /login"}',
        'Please run /login',
      ],
      [
        'errors array',
        '{"type":"result","subtype":"error_during_execution","errors":["OAuth session expired"]}',
        'OAuth session expired',
      ],
      ['plain error', 'Not logged in. Please run /login', 'Please run /login'],
    ];
    for (const [name, stdout, want] of cases) {
      const record = emptyRecord();
      const cause = new Error('exit status 1');
      const provider = new ClaudeCLIProvider('', '', stubRunner(record, stdout, '', cause));
      const err = (await provider.generate(request()).catch((e: unknown) => e)) as Error;
      expect(err.cause, name).toBe(cause);
      expect(err.message, name).toContain(want);
      expect(existsSync(record.dir), name).toBe(false);
    }
  });

  it('rejects invalid envelopes', async () => {
    for (const raw of ['not json', 'null', '{}', '{"type":"system","subtype":"init","result":"not an answer"}']) {
      const provider = new ClaudeCLIProvider('', '', stubRunner(emptyRecord(), raw, '', null));
      await expect(provider.generate(request()), raw).rejects.toThrow();
    }
  });

  it('lists the fixed model choices as a fresh copy', () => {
    const models = claudeCliModels();
    expect(models).toEqual(['sonnet', 'opus', 'haiku', 'fable']);
    models.push('mutated');
    expect(claudeCliModels()).toHaveLength(4);
  });
});
