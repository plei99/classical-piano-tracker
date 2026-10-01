/**
 * Entry point. Kept thin: all command wiring lives in ./cli so it can be
 * driven in tests with in-memory streams.
 */
import { runCli } from './cli';

const code = await runCli(process.argv.slice(2));
process.exitCode = code;

// Exit explicitly: an Ink instance or a stdin listener left behind by an
// interactive command would otherwise keep the event loop alive. Waiting for
// empty writes first flushes output still queued on piped stdout/stderr.
await Promise.all(
  [process.stdout, process.stderr].map((stream) => new Promise((resolve) => stream.write('', resolve))),
);
process.exit(code);
