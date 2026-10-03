/**
 * Test helpers: a local HTTP server (Go's httptest.NewServer), fake CLI
 * executables, and a recording command runner. Not imported by app code.
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandInvocation, CommandResult, CommandRunner } from './command';

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface TestServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** Starts a server on 127.0.0.1 with an ephemeral port. */
export async function startServer(handler: (req: RecordedRequest, res: ServerResponse) => void): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        path: url.pathname,
        query: url.search.slice(1),
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Replies with a fixed JSON body. */
export function jsonReply(body: string, status = 200): (req: RecordedRequest, res: ServerResponse) => void {
  return (_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  };
}

/** Writes an executable shell script into a fresh temp directory. */
export function writeScript(name: string, body: string, dir = mkdtempSync(join(tmpdir(), 'tracker-test-'))): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

export interface RecordedCommand {
  dir: string;
  name: string;
  args: string[];
  stdin: string;
}

/** A runner that records its invocation and returns canned output. */
export function stubRunner(
  record: RecordedCommand,
  stdout: string,
  stderr: string,
  error: Error | null,
): CommandRunner {
  return async (inv: CommandInvocation): Promise<CommandResult> => {
    record.dir = inv.dir;
    record.name = inv.name;
    record.args = [...inv.args];
    record.stdin = inv.stdin;
    return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), error };
  };
}

export function emptyRecord(): RecordedCommand {
  return { dir: '', name: '', args: [], stdin: '' };
}

/** The value following `flag` in `args`; throws if absent. */
export function flagValue(args: string[], flag: string): string {
  const idx = args.indexOf(flag);
  if (idx < 0 || idx + 1 >= args.length) {
    throw new Error(`args ${JSON.stringify(args)} do not contain ${flag} with a value`);
  }
  return args[idx + 1] as string;
}
