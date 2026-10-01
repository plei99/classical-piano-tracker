/**
 * The command tree. It keeps user-facing orchestration (prompts, output
 * formats, first-run messaging) out of the library modules, which only deal
 * in data and errors.
 *
 * Commander stands in for cobra; the wiring below reproduces cobra's
 * behavior where users can observe it: help on stdout for the bare root and
 * for parent commands, `--version` printing `tracker <version>`, positional
 * arguments accepted (and ignored) unless a command declares exact ones,
 * and pflag/cobra wording for parse errors, which surface as a single line.
 */
import { Command, CommanderError, Option } from 'commander';

import { errorMessage, quote } from '../core/errors';
import { defaultConfigPath, defaultDbPath } from '../core/paths';
import { buildInfo } from './buildinfo';
import { allowlist, blocklist, runArtistEdit, runArtistList, runConfigPath, runConfigValidate } from './config_cmd';
import { type CliDeps, type CliIo, Context, RootOptions } from './context';
import type { Out } from './format';
import { parseGoBool, parseGoInt } from './gostr';
import { type ListView, runTrackList } from './list';
import { defaultOnboardingDeps, runOnboarding } from './onboarding';
import { DEFAULT_RATE_SELECTION_LIMIT, runRate, runRatePrompt } from './rate';
import { runRecommendFavorites, runRecommendPianists, runRecommendProfile, runRecommendSummary } from './recommend_cmd';
import { runShow } from './show';
import { runSpotifyLogin, runSpotifyRecent } from './spotify_cmd';
import { runSync, runSyncStatus } from './sync';
import { runTuiCommand } from './tui_cmd';
import { DEFAULT_WEB_PORT, runWebCommand } from './web_cmd';

export type { CliDeps, CliIo } from './context';

/** The process streams, as the binary uses them. */
export function defaultIo(): CliIo {
  return { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
}

/**
 * Parses `argv` (without the node and script entries) and runs the selected
 * command. Returns the exit code: 0 on success (including help and version
 * requests), 1 after printing a single-line error to stderr.
 */
export async function runCli(argv: string[], io: CliIo = defaultIo(), deps: Partial<CliDeps> = {}): Promise<number> {
  const program = buildProgram(io, { onboarding: deps.onboarding ?? defaultOnboardingDeps() });
  try {
    await program.parseAsync(normalizeBoolFlags(argv), { from: 'user' });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError && err.exitCode === 0) {
      return 0;
    }
    const message = err instanceof CommanderError ? commanderMessage(err) : errorMessage(err);
    io.stderr.write(`${message}\n`);
    return 1;
  }
}

/**
 * pflag accepts `--flag=<bool>` for boolean flags; commander does not. The
 * only boolean flag is rate-prompt's --unrated, so its explicit forms are
 * rewritten to `--unrated` / `--no-unrated` after that subcommand's name.
 */
function normalizeBoolFlags(argv: string[]): string[] {
  const command = argv.indexOf('rate-prompt');
  if (command === -1) {
    return argv;
  }
  return argv.map((arg, idx) => {
    const match = /^--unrated=(.*)$/s.exec(arg);
    if (idx < command || match === null) {
      return arg;
    }
    const value = match[1]!;
    try {
      return parseGoBool(value) ? '--unrated' : '--no-unrated';
    } catch (err) {
      throw new Error(`invalid argument ${quote(value)} for "--unrated" flag: ${errorMessage(err)}`, { cause: err });
    }
  });
}

/** Cobra wording for commander's parse errors. */
function commanderMessage(err: CommanderError): string {
  const message = err.message.replace(/^error: /, '');
  switch (err.code) {
    case 'commander.unknownOption': {
      const flag = /unknown option '([^']*)'/.exec(message)?.[1] ?? '';
      if (flag.startsWith('--')) {
        return `unknown flag: ${flag.split('=')[0]}`;
      }
      return `unknown shorthand flag: '${flag.charAt(1)}' in ${flag}`;
    }
    case 'commander.optionMissingArgument': {
      const flag = /(--[\w-]+)/.exec(message)?.[1] ?? '';
      return `flag needs an argument: ${flag}`;
    }
    // Only cobra.ExactArgs(1) commands declare positional arguments.
    case 'commander.missingArgument':
      return 'accepts 1 arg(s), received 0';
    case 'commander.excessArguments':
      return `accepts 1 arg(s), received ${/got (\d+)/.exec(message)?.[1] ?? '?'}`;
    default:
      return message;
  }
}

/** pflag's IntVar parsing (base-prefix aware) and error wording. */
function intFlag(name: string): (value: string) => number {
  return (value) => {
    try {
      return Number(parseGoInt(value, 0));
    } catch (err) {
      throw new Error(`invalid argument ${quote(value)} for ${quote(`--${name}`)} flag: ${errorMessage(err)}`, {
        cause: err,
      });
    }
  };
}

function orEmpty(resolve: () => string): string {
  try {
    return resolve();
  } catch {
    return '';
  }
}

function examples(...lines: string[]): string {
  return `\nExamples:\n${lines.map((line) => `  ${line}`).join('\n')}`;
}

/** Adds a subcommand that inherits the root's output and exit settings. */
function sub(parent: Command, nameAndArgs: string, short: string, example?: string): Command {
  const cmd = parent.command(nameAndArgs).description(short);
  cmd.helpOption('-h, --help', `help for ${cmd.name()}`);
  if (example !== undefined) {
    cmd.addHelpText('after', example);
  }
  return cmd;
}

/** A parent command: like cobra's non-runnable commands, it prints its help, even for unknown args. */
function group(parent: Command, name: string, short: string, example?: string): Command {
  const cmd = sub(parent, name, short, example);
  cmd.action(() => cmd.outputHelp());
  return cmd;
}

/** Declares cobra.ExactArgs(1). */
function exactArgs(cmd: Command): Command {
  return cmd.allowExcessArguments(false);
}

function buildProgram(io: CliIo, deps: CliDeps): Command {
  const program = new Command('tracker');
  const values = () => program.opts<{ config: string; db: string }>();
  const ctx = new Context(io, deps, new RootOptions(values));
  const writer = (out: Out) => (text: string) => {
    out.write(text);
  };

  program
    .description('Track, rate, and explore classical piano listening history from Spotify.')
    .summary('Track and rate classical piano listening history from Spotify')
    .configureOutput({
      writeOut: writer(io.stdout),
      writeErr: writer(io.stderr),
      // runCli prints errors itself, as one line in cobra's wording.
      outputError: () => {},
      getOutHelpWidth: () => (io.stdout.isTTY === true ? io.stdout.columns : undefined) ?? 80,
      getErrHelpWidth: () => (io.stderr.isTTY === true ? io.stderr.columns : undefined) ?? 80,
      getOutHasColors: () => false,
      getErrHasColors: () => false,
    })
    .exitOverride()
    .allowExcessArguments(true)
    .helpOption('-h, --help', 'help for tracker')
    .version(`tracker ${buildInfo.version}`, '-v, --version', 'version for tracker')
    .option('--config <path>', 'path to the config file', orEmpty(defaultConfigPath))
    .option('--db <path>', 'path to the SQLite database file', orEmpty(defaultDbPath))
    .helpCommand('help [command]', 'Help about any command')
    .addHelpText(
      'after',
      examples(
        'tracker onboarding',
        'tracker spotify login',
        'tracker sync',
        'tracker tui',
        'tracker recommend favorites',
      ),
    )
    .action(() => {
      // Cobra rejects positional arguments to a root command with subcommands.
      const [unknown] = program.args;
      if (unknown !== undefined) {
        throw new Error(`unknown command ${quote(unknown)} for "tracker"`);
      }
      program.outputHelp();
    });

  addConfigCommands(program, ctx);
  addListCommands(program, ctx);

  sub(
    program,
    'onboarding',
    'Interactive first-run setup for Spotify, LLM, and pianist filters',
    examples('tracker onboarding', 'tracker --config ~/custom-config.json onboarding'),
  ).action(() => runOnboarding(ctx));

  const rate = sub(
    program,
    'rate',
    'Rate a locally synced track by ID',
    examples(
      'tracker rate --track-id 12 --stars 5 --opinion "Explosive and clear"',
      'tracker rate --spotify-id 4uLU6hMCjMI75M1A2tKUQC --stars 4',
    ),
  )
    .option('--track-id <int>', 'local track ID to rate', intFlag('track-id'))
    .option('--spotify-id <string>', 'Spotify track ID to rate')
    .option('--stars <int>', 'star rating to save (1-5)', intFlag('stars'))
    .option('--opinion <string>', 'free-form opinion to store with the rating');
  rate.action(() => {
    const opts = rate.opts<{ trackId?: number; spotifyId?: string; stars?: number; opinion?: string }>();
    return runRate(ctx, {
      trackId: opts.trackId ?? 0,
      spotifyId: opts.spotifyId ?? '',
      stars: opts.stars ?? 0,
      opinion: opts.opinion ?? '',
    });
  });

  const ratePrompt = sub(
    program,
    'rate-prompt',
    'Choose a local track interactively and rate it',
    examples('tracker rate-prompt', 'tracker rate-prompt --unrated'),
  )
    .option('--unrated', 'select from unrated tracks instead of recent tracks')
    .addOption(new Option('--no-unrated').hideHelp())
    .option(
      '--limit <int>',
      'number of candidate tracks to list for interactive selection',
      intFlag('limit'),
      DEFAULT_RATE_SELECTION_LIMIT,
    );
  ratePrompt.action(() => {
    const opts = ratePrompt.opts<{ unrated?: boolean; limit: number }>();
    return runRatePrompt(ctx, opts.unrated === true, opts.limit);
  });

  addRecommendCommands(program, ctx);

  exactArgs(
    sub(
      program,
      'show <track-id>',
      'Show details for a local track',
      examples('tracker show 12', 'tracker --db ~/tmp/tracker.db show 7'),
    ),
  ).action((trackId: string) => runShow(ctx, trackId));

  addSpotifyCommands(program, ctx);
  addSyncCommands(program, ctx);

  sub(
    program,
    'tui',
    'Browse, sync, and rate tracks in a terminal UI',
    examples('tracker tui', 'tracker --db ~/tmp/tracker.db tui'),
  ).action(() => runTuiCommand(ctx));

  const web = sub(
    program,
    'web',
    'Browse, sync, and rate tracks in a local web UI',
    examples('tracker web', 'tracker web --port 9000 --no-open', 'tracker --db ~/tmp/tracker.db web'),
  )
    .option('--port <int>', 'local port to serve on (0 picks a free one)', intFlag('port'), DEFAULT_WEB_PORT)
    .option('--no-open', 'print the URL without opening a browser');
  web.action(() => runWebCommand(ctx, web.opts<{ port: number; open: boolean }>()));

  sub(program, 'version', 'Print build and version metadata', examples('tracker version', 'tracker --version')).action(
    () => {
      io.stdout.write(`tracker ${buildInfo.version}\n`);
      io.stdout.write(`commit: ${buildInfo.commit}\n`);
      io.stdout.write(`built:  ${buildInfo.date}\n`);
    },
  );

  return program;
}

function addConfigCommands(program: Command, ctx: Context): void {
  const config = group(program, 'config', 'Inspect and validate local configuration');
  for (const [name, list, field, short] of [
    ['allowlist', allowlist, 'pianists_allowlist', 'Inspect and edit pianists_allowlist entries'],
    ['blocklist', blocklist, 'artists_blocklist', 'Inspect and edit artists_blocklist entries'],
  ] as const) {
    const parent = group(config, name, short);
    sub(parent, 'list', `Print ${field} entries`).action(() => runArtistList(ctx, list));
    exactArgs(sub(parent, 'add <artist>', `Add an artist to ${field}`)).action((artist: string) =>
      runArtistEdit(ctx, list, 'add', artist),
    );
    exactArgs(sub(parent, 'remove <artist>', `Remove an artist from ${field}`)).action((artist: string) =>
      runArtistEdit(ctx, list, 'remove', artist),
    );
  }
  sub(config, 'path', 'Print the config file path').action(() => runConfigPath(ctx));
  sub(config, 'validate', 'Validate the config file').action(() => runConfigValidate(ctx));
}

function addListCommands(program: Command, ctx: Context): void {
  const list = group(
    program,
    'list',
    'List locally synced tracks and their IDs',
    examples('tracker list recent', 'tracker list top --limit 20', 'tracker list unrated'),
  );
  const views: [ListView, string, string][] = [
    [
      'recent',
      'List recent local tracks',
      examples('tracker list recent', 'tracker --db ~/tmp/tracker.db list recent --limit 25'),
    ],
    ['unrated', 'List unrated local tracks', examples('tracker list unrated', 'tracker list unrated --limit 15')],
    ['top', 'List top-played local tracks', examples('tracker list top', 'tracker list top --limit 20')],
  ];
  for (const [view, short, example] of views) {
    const cmd = sub(list, view, short, example).option(
      '--limit <int>',
      'maximum number of tracks to list',
      intFlag('limit'),
      10,
    );
    cmd.action(() => runTrackList(ctx, view, cmd.opts<{ limit: number }>().limit));
  }
}

function addRecommendCommands(program: Command, ctx: Context): void {
  const recommend = group(
    program,
    'recommend',
    'Analyze favorites and generate pianist recommendations',
    examples(
      'tracker recommend favorites',
      'tracker recommend profile',
      'tracker recommend summary',
      'tracker recommend pianists --limit 5',
    ),
  );

  const favorites = sub(
    recommend,
    'favorites',
    'Rank favorite pianists from local ratings and replay counts',
    examples('tracker recommend favorites', 'tracker recommend favorites --limit 15'),
  ).option('--limit <int>', 'maximum number of favorite pianists to print', intFlag('limit'), 10);
  favorites.action(() => runRecommendFavorites(ctx, favorites.opts<{ limit: number }>().limit));

  sub(
    recommend,
    'profile',
    'Print the local taste profile used for recommendations',
    examples(
      'tracker recommend profile',
      'tracker --config /custom/config.json --db /custom/tracker.db recommend profile',
    ),
  ).action(() => runRecommendProfile(ctx));

  sub(
    recommend,
    'summary',
    'Ask the active LLM profile to summarize your local taste profile',
    examples('tracker recommend summary', 'LLM_PROFILE=anthropic tracker recommend summary'),
  ).action(() => runRecommendSummary(ctx));

  const pianists = sub(
    recommend,
    'pianists',
    'Use an LLM plus Spotify validation to recommend new pianists',
    examples('tracker recommend pianists', 'LLM_MODEL=gpt-5.4 tracker recommend pianists --limit 5'),
  ).option('--limit <int>', 'maximum number of new pianist recommendations to request', intFlag('limit'), 5);
  pianists.action(() => runRecommendPianists(ctx, pianists.opts<{ limit: number }>().limit));
}

function addSpotifyCommands(program: Command, ctx: Context): void {
  const spotify = group(
    program,
    'spotify',
    'Authenticate with Spotify and inspect playback data',
    examples('tracker spotify login', 'tracker spotify recent --limit 10'),
  );
  sub(
    spotify,
    'login',
    'Run the Spotify OAuth login flow and save the token',
    examples('tracker spotify login', 'tracker --config ~/custom-config.json spotify login'),
  ).action(() => runSpotifyLogin(ctx));

  const recent = sub(
    spotify,
    'recent',
    "Fetch the current user's recent Spotify plays",
    examples('tracker spotify recent', 'tracker spotify recent --limit 10'),
  ).option('--limit <int>', 'maximum number of recent plays to fetch (1-50)', intFlag('limit'), 50);
  recent.action(() => runSpotifyRecent(ctx, recent.opts<{ limit: number }>().limit));
}

function addSyncCommands(program: Command, ctx: Context): void {
  const sync = sub(
    program,
    'sync',
    'Sync recent Spotify plays into the local SQLite database',
    examples(
      'tracker sync',
      'tracker sync --limit 25',
      'tracker sync status',
      'tracker --config ~/custom-config.json --db ~/custom-tracker.db sync',
    ),
  ).option('--limit <int>', 'maximum number of recent plays to fetch from Spotify (1-50)', intFlag('limit'), 50);
  sync.action(() => runSync(ctx, sync.opts<{ limit: number }>().limit));

  sub(
    sync,
    'status',
    'Print the timestamp of the last successful sync checkpoint',
    examples('tracker sync status', 'tracker --db ~/custom-tracker.db sync status'),
  ).action(() => runSyncStatus(ctx));
}
