import { describe, expect, it } from 'vitest';

import { buildInfo } from './buildinfo';
import { createdConfigError, parsePositiveInt64 } from './context';
import { defaultIo } from './index';
import { run, tempPath } from './testutil';

describe('root command', () => {
  // Go: TestNewRootCmdDefaultsOutputStreams
  it('defaults output streams to the process streams', () => {
    const io = defaultIo();
    expect(io.stdout).toBe(process.stdout);
    expect(io.stderr).toBe(process.stderr);
    expect(io.stdin).toBe(process.stdin);
  });

  it('prints help without a subcommand', async () => {
    const { code, stdout, stderr } = await run([]);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Track, rate, and explore classical piano listening history from Spotify.');
    expect(stdout).toContain('Examples:\n  tracker onboarding');
    for (const command of ['config', 'list', 'onboarding', 'rate-prompt', 'recommend', 'sync', 'tui', 'version']) {
      expect(stdout).toContain(command);
    }
  });

  it('prints the cobra version template for --version and -v', async () => {
    for (const flag of ['--version', '-v']) {
      const { code, stdout } = await run([flag]);
      expect(code).toBe(0);
      expect(stdout).toBe(`tracker ${buildInfo.version}\n`);
    }
  });

  it('prints build metadata for the version command', async () => {
    const { code, stdout } = await run(['version']);
    expect(code).toBe(0);
    expect(stdout).toBe(`tracker ${buildInfo.version}\ncommit: ${buildInfo.commit}\nbuilt:  ${buildInfo.date}\n`);
  });

  it('falls back to dev metadata when not bundled', () => {
    expect(buildInfo).toEqual({ version: 'dev', commit: 'unknown', date: 'unknown' });
  });

  it('prints help for parent commands, even with unknown arguments', async () => {
    for (const args of [['config'], ['config', 'allowlist'], ['list'], ['recommend'], ['spotify'], ['list', 'bogus']]) {
      const { code, stdout } = await run(args);
      expect(code, args.join(' ')).toBe(0);
      expect(stdout, args.join(' ')).toContain('Usage:');
    }
    expect((await run(['list'])).stdout).toContain('unrated');
  });

  it('prints subcommand help through the help command and -h', async () => {
    for (const args of [
      ['help', 'sync'],
      ['sync', '-h'],
      ['sync', '--help'],
    ]) {
      const { code, stdout } = await run(args);
      expect(code).toBe(0);
      expect(stdout).toContain('Sync recent Spotify plays into the local SQLite database');
      expect(stdout).toContain('tracker sync status');
    }
  });

  it('rejects unknown commands with a single line', async () => {
    const { code, stdout, stderr } = await run(['bogus']);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toBe('unknown command "bogus" for "tracker"\n');
  });

  it('reports parse errors as single pflag-style lines', async () => {
    const db = tempPath('tracker.db');
    const cases: [string[], string][] = [
      [
        ['--db', db, 'list', 'recent', '--limit', 'abc'],
        'invalid argument "abc" for "--limit" flag: strconv.ParseInt: parsing "abc": invalid syntax',
      ],
      [
        ['--db', db, 'list', 'top', '--limit=99999999999999999999'],
        'invalid argument "99999999999999999999" for "--limit" flag: strconv.ParseInt: parsing "99999999999999999999": value out of range',
      ],
      [['--db', db, 'list', 'recent', '--limit'], 'flag needs an argument: --limit'],
      [['--bogus'], 'unknown flag: --bogus'],
      [['list', 'recent', '--bogus=1'], 'unknown flag: --bogus'],
      [['list', 'recent', '-x'], "unknown shorthand flag: 'x' in -x"],
      [['show'], 'accepts 1 arg(s), received 0'],
      [['show', '1', '2'], 'accepts 1 arg(s), received 2'],
      [['config', 'allowlist', 'add'], 'accepts 1 arg(s), received 0'],
    ];
    for (const [args, message] of cases) {
      const { code, stdout, stderr } = await run(args);
      expect(code, args.join(' ')).toBe(1);
      expect(stdout, args.join(' ')).toBe('');
      expect(stderr, args.join(' ')).toBe(`${message}\n`);
    }
  });

  it('lets negative and base-prefixed limits reach command validation', async () => {
    const db = tempPath('tracker.db');
    expect((await run(['--db', db, 'list', 'recent', '--limit', '-1'])).stderr).toBe(
      'limit must be at least 1, got -1\n',
    );
    expect((await run(['--db', db, 'list', 'recent', '--limit', '0x0'])).stderr).toBe(
      'limit must be at least 1, got 0\n',
    );
    expect((await run(['--db', db, 'list', 'recent', '--limit', '0x10'])).stdout).toBe('no tracks found\n');
  });

  it('accepts global flags after the subcommand', async () => {
    const db = tempPath('tracker.db');
    const { code, stdout } = await run(['list', 'recent', '--db', db]);
    expect(code).toBe(0);
    expect(stdout).toBe('no tracks found\n');
  });

  it('ignores extra positional arguments like cobra', async () => {
    const { code, stdout } = await run(['version', 'extra']);
    expect(code).toBe(0);
    expect(stdout).toContain('commit: ');
  });

  it('parsePositiveInt64 rejects non-positive values', () => {
    expect(parsePositiveInt64('12', 'track ID')).toBe(12);
    expect(parsePositiveInt64('+7', 'track ID')).toBe(7);
    for (const raw of ['0', '-3', 'abc', '', '1.5', '0x10']) {
      expect(() => parsePositiveInt64(raw, 'track ID')).toThrow(
        `track ID must be a positive integer, got ${JSON.stringify(raw)}`,
      );
    }
  });

  it('createdConfigError quotes the path', () => {
    expect(createdConfigError('/tmp/c.json', 'do the thing').message).toBe(
      'created default config at "/tmp/c.json"; do the thing',
    );
  });
});
