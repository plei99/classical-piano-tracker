/**
 * A local mock HTTP server for tests: every request is recorded and then
 * answered by a handler. Never imported by production code.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded {
  method: string;
  target: string;
  headers: Record<string, string>;
  body: string;
  /** First value of a form-encoded body field, or "" when absent. */
  form(key: string): string;
}

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export function jsonReply(status: number, body: string): Reply {
  return { status, headers: { 'Content-Type': 'application/json' }, body };
}

export function textReply(status: number, body: string, headers: Record<string, string> = {}): Reply {
  return { status, headers, body };
}

export interface MockServer {
  baseUrl: string;
  requests: Recorded[];
  close(): Promise<void>;
}

export async function startMockServer(handler: (request: Recorded) => Reply): Promise<MockServer> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        headers[name] = Array.isArray(value) ? value.join(', ') : (value ?? '');
      }
      const recorded: Recorded = {
        method: req.method ?? '',
        target: req.url ?? '',
        headers,
        body,
        form: (key) => new URLSearchParams(body).get(key) ?? '',
      };
      // Record before replying so assertions never race the client.
      requests.push(recorded);
      const reply = handler(recorded);
      res.writeHead(reply.status, reply.headers ?? {});
      res.end(reply.body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
