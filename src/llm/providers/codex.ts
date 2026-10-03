import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wrap } from '../../core/errors';
import { goMarshal } from '../../recommend/gojson';
import { goTrimSpace } from '../../recommend/gostrings';
import type { Provider, Request } from '..';
import { withTimeout } from '../context';
import { type CommandRunner, commandError, execCommand, goPathError, makePrivateTempDir, removeAll } from './command';

export const DEFAULT_CODEX_TIMEOUT_MS = 5 * 60_000;

/**
 * Shells out to `codex exec`. It uses the CLI's existing authentication,
 * never tracker API keys; an empty model leaves selection to the CLI's
 * built-in default, not user config.
 */
export class CodexProvider implements Provider {
  readonly command: string;
  readonly model: string;
  /** Per-call deadline; tests shorten it. */
  timeoutMs = DEFAULT_CODEX_TIMEOUT_MS;
  private readonly run: CommandRunner;

  constructor(model: string, command: string, run?: CommandRunner) {
    this.command = goTrimSpace(command) === '' ? 'codex' : goTrimSpace(command);
    this.model = goTrimSpace(model);
    this.run = run ?? execCommand;
  }

  async generate(req: Request, signal?: AbortSignal): Promise<string> {
    let dir: string;
    try {
      dir = makePrivateTempDir('piano-tracker-codex-');
    } catch (err) {
      throw wrap('create Codex working directory', err);
    }
    try {
      return await this.generateIn(dir, req, signal);
    } finally {
      removeAll(dir);
    }
  }

  private async generateIn(dir: string, req: Request, signal: AbortSignal | undefined): Promise<string> {
    const outputPath = join(dir, 'response.txt');
    // Precreate with private permissions; the CLI writes the final answer here,
    // while stdout/stderr may contain progress and must not be parsed as JSON.
    try {
      writeFileSync(outputPath, '', { mode: 0o600 });
    } catch (err) {
      throw new Error(`create Codex output file: ${goPathError('open', outputPath, err).message}`, { cause: err });
    }
    const args = [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--color',
      'never',
      '-c',
      'approval_policy="never"',
      '-c',
      'web_search="disabled"',
      '-c',
      'features.shell_tool=false',
      '-c',
      'features.unified_exec=false',
      '-c',
      'project_doc_max_bytes=0',
      '--output-last-message',
      outputPath,
    ];
    if (this.model !== '') {
      args.push('--model', this.model);
    }
    if (req.schema !== null) {
      let schema: string;
      try {
        schema = goMarshal(req.schema.schema, { sortKeys: true });
      } catch (err) {
        throw new Error(`marshal Codex JSON schema: ${(err as Error).message}`, { cause: err });
      }
      const schemaPath = join(dir, 'schema.json');
      try {
        writeFileSync(schemaPath, schema, { mode: 0o600 });
      } catch (err) {
        throw new Error(`write Codex JSON schema: ${goPathError('open', schemaPath, err).message}`, { cause: err });
      }
      args.push('--output-schema', schemaPath);
    }
    args.push('-');

    // Codex exec has one prompt input rather than separate API message roles.
    // Both task instructions and taste data travel via stdin, not process argv.
    const prompt = `Answer only the following music taste task using the supplied data and your existing knowledge. Do not use tools, browse, inspect files, or execute commands. Return only the requested output.\n\n${req.systemPrompt}\n\n${req.userPrompt}`;
    const result = await this.run({
      dir,
      stdin: prompt,
      name: this.command,
      args,
      signal: withTimeout(signal, this.timeoutMs),
    });
    if (result.error !== null) {
      throw commandError(this.command, result.error, result.stderr);
    }

    let output: string;
    try {
      output = readFileSync(outputPath, 'utf8');
    } catch (err) {
      throw new Error(`read Codex final response: ${goPathError('open', outputPath, err).message}`, { cause: err });
    }
    const raw = goTrimSpace(output);
    if (raw === '') {
      throw new Error(`${this.command} returned no final response`);
    }
    return raw;
  }
}
