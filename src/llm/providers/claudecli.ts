import { wrap } from '../../core/errors';
import {
  field,
  goBool,
  goMarshal,
  goRawMessage,
  goSlice,
  goString,
  goStruct,
  goUnmarshal,
} from '../../recommend/gojson';
import { goTrimSpace } from '../../recommend/gostrings';
import type { Provider, Request } from '..';
import { withTimeout } from '../context';
import { type CommandRunner, commandError, execCommand, makePrivateTempDir, removeAll } from './command';

export const DEFAULT_CLAUDE_CLI_COMMAND = 'claude';
/**
 * Generous because each call pays for CLI startup on top of model latency,
 * and discovery may chain several calls.
 */
export const DEFAULT_CLAUDE_CLI_TIMEOUT_MS = 5 * 60_000;

/**
 * The model aliases the Claude Code CLI accepts. The CLI has no
 * model-listing endpoint, so onboarding offers these fixed choices.
 */
export const CLAUDE_CLI_MODELS: readonly string[] = ['sonnet', 'opus', 'haiku', 'fable'];

/** The single-object envelope printed by `claude -p --output-format json`. */
interface ClaudeCLIResult {
  type: string;
  subtype: string;
  isError: boolean;
  result: string;
  structuredOutput: string;
  errors: string[];
}

const claudeCLIResultDecoder = goStruct<ClaudeCLIResult>('providers.claudeCLIResult', [
  field('type', 'type', goString),
  field('subtype', 'subtype', goString),
  field('isError', 'is_error', goBool),
  field('result', 'result', goString),
  field('structuredOutput', 'structured_output', goRawMessage),
  field('errors', 'errors', goSlice(goString, '[]string')),
]);

/**
 * Shells out to the Claude Code CLI in print mode. It needs no API key: the
 * CLI uses the user's existing login.
 */
export class ClaudeCLIProvider implements Provider {
  readonly command: string;
  readonly model: string;
  /** Per-call deadline; tests shorten it. */
  timeoutMs = DEFAULT_CLAUDE_CLI_TIMEOUT_MS;
  private readonly run: CommandRunner;

  constructor(model: string, command: string, run?: CommandRunner) {
    this.command = goTrimSpace(command) === '' ? DEFAULT_CLAUDE_CLI_COMMAND : goTrimSpace(command);
    this.model = goTrimSpace(model);
    this.run = run ?? execCommand;
  }

  /**
   * Runs `claude -p` with all built-in tools disabled. When a schema is
   * supplied it is passed via --json-schema so the CLI validates the output
   * and returns it in the structured_output field.
   */
  async generate(req: Request, signal?: AbortSignal): Promise<string> {
    const args = this.buildArgs(req);
    let dir: string;
    try {
      dir = makePrivateTempDir('piano-tracker-claude-');
    } catch (err) {
      throw wrap('create Claude CLI working directory', err);
    }
    try {
      const {
        stdout,
        stderr,
        error: runError,
      } = await this.run({
        dir,
        stdin: req.userPrompt,
        name: this.command,
        args,
        signal: withTimeout(signal, this.timeoutMs),
      });
      return this.interpret(stdout, stderr, runError);
    } finally {
      removeAll(dir);
    }
  }

  private interpret(stdout: Buffer, stderr: Buffer, runError: Error | null): string {
    // Claude reports runtime failures on stdout, often with a nonzero exit.
    // Decode that envelope before falling back to stderr/exit status.
    let result: ClaudeCLIResult | null = null;
    let decodeError: unknown = null;
    try {
      result = goUnmarshal(goTrimSpace(stdout.toString('utf8')), claudeCLIResultDecoder);
    } catch (err) {
      decodeError = err;
    }

    if (result !== null && (result.isError || result.subtype.startsWith('error'))) {
      const detail = goTrimSpace([result.result, ...result.errors].join('\n'));
      if (runError !== null) {
        throw commandError(this.command, runError, `${result.subtype}: ${detail}`);
      }
      throw new Error(`${this.command} reported an error (${result.subtype}): ${detail}`);
    }
    if (runError !== null) {
      throw commandError(this.command, runError, goTrimSpace(stderr.toString('utf8')) === '' ? stdout : stderr);
    }
    if (result === null) {
      throw wrap(`decode ${this.command} result`, decodeError);
    }
    if (result.type !== 'result' || result.subtype !== 'success') {
      throw new Error(`${this.command} returned an unexpected result envelope (${result.type}/${result.subtype})`);
    }

    const structured = goTrimSpace(result.structuredOutput);
    if (structured !== '' && structured !== 'null') {
      return structured;
    }
    const raw = goTrimSpace(result.result);
    if (raw === '') {
      throw new Error(`${this.command} returned neither structured output nor text`);
    }
    return raw;
  }

  /** The argv passed to the CLI (the user prompt travels via stdin, not argv). */
  buildArgs(req: Request): string[] {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--tools',
      '',
      // Unlike --bare, safe mode preserves OAuth/keychain authentication while
      // disabling custom instructions, hooks, skills, plugins, and MCP servers.
      '--safe-mode',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--disable-slash-commands',
      '--permission-mode',
      'dontAsk',
      '--no-session-persistence',
    ];
    if (this.model !== '') {
      args.push('--model', this.model);
    }
    if (goTrimSpace(req.systemPrompt) !== '') {
      args.push('--system-prompt', req.systemPrompt);
    }
    if (req.schema !== null) {
      try {
        args.push('--json-schema', goMarshal(req.schema.schema, { sortKeys: true }));
      } catch (err) {
        throw wrap('marshal Claude CLI JSON schema', err);
      }
    }
    return args;
  }
}
