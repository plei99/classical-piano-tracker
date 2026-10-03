/**
 * Byte-for-byte parity with the Go build. testdata/go_golden.json was
 * captured from the Go implementation (a throwaway test in a copy of the Go
 * module) for the same inputs used here: prompts, schemas, provider request
 * bodies and headers, CLI argv, envelope decoding, and error texts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Rating, Track } from '../core/model';
import { type TasteSummary, buildTasteSummary } from '../recommend';
import { goMarshal } from '../recommend/gojson';
import { marshalTasteSummary } from './discovery';
import { Client, type Provider, type Request } from './index';
import { AnthropicProvider } from './providers/anthropic';
import { siblingEndpoint, ollamaTagsEndpoint } from './providers/catalog';
import { ClaudeCLIProvider } from './providers/claudecli';
import { CodexProvider } from './providers/codex';
import { GoogleProvider } from './providers/google';
import { OpenAIProvider } from './providers/openai';
import { OpenAICompatProvider } from './providers/openaicompat';
import { type TestServer, emptyRecord, jsonReply, startServer, stubRunner } from './providers/testsupport';
import goldenText from './testdata/go_golden.json?raw';

interface GoldenRequest {
  system: string;
  user: string;
  mode: string;
  temperature: number;
  maxOutputTokens: number;
  schemaName?: string;
  schemaJSON?: string;
  strict?: boolean;
}

interface Golden {
  summaryJSON: string;
  requests: GoldenRequest[];
  providers: Array<{
    name: string;
    captures: Array<{ method: string; path: string; query: string; headers: Record<string, string>; body: string }>;
  }>;
  claudeArgs: string[];
  claudeStdin: string;
  codexArgs: string[];
  codexStdin: string;
  codexSchema: string;
  decodeBodies: string[];
  decode: Record<string, string[]>;
  statusError: string;
  claudeCases: string[];
  codexCases: string[];
  urls: string[];
}

const golden = JSON.parse(goldenText) as Golden;

function track(
  id: number,
  trackName: string,
  albumName: string,
  artists: string,
  playCount: number,
  lastPlayedAt: number,
): Track {
  return { id, spotifyId: '', trackName, albumName, artists, playCount, lastPlayedAt, createdAt: 0 };
}

/** The same fixture the Go golden run used. */
function sampleSummary(): TasteSummary {
  const tracks = [
    track(1, 'Concerto <No. 1> & "Finale"', 'Album A', '["Martha Argerich","London Symphony Orchestra"]', 4, 30),
    track(2, 'Sonata', 'Album B', '["Daniil Trifonov"]', 2, 20),
    track(3, 'Ballade', 'Album C', '["martha  argerich"]', 1, 10),
    track(4, 'Étude\u2028x', 'Album D', '["Víkingur Ólafsson"]', 7, 40),
    track(5, 'Prelude', '', '["Víkingur Ólafsson"]', 0, 50),
  ];
  const ratings: Rating[] = [
    { trackId: 1, stars: 5, opinion: '  Explosive & clear <3 ', updatedAt: 0 },
    { trackId: 2, stars: 2, opinion: 'Too heavy', updatedAt: 0 },
    { trackId: 3, stars: 4, opinion: '', updatedAt: 0 },
    { trackId: 4, stars: 4, opinion: 'glassy', updatedAt: 0 },
    { trackId: 5, stars: 3, opinion: '', updatedAt: 0 },
  ];
  return buildTasteSummary(tracks, ratings, ['Martha Argerich', 'Daniil Trifonov', ' Víkingur Ólafsson ', '']);
}

class Recorder implements Provider {
  readonly reqs: Request[] = [];

  constructor(private readonly raws: string[]) {}

  async generate(req: Request): Promise<string> {
    this.reqs.push(req);
    return this.raws.shift() ?? '';
  }
}

async function recordedRequests(): Promise<Request[]> {
  const summary = sampleSummary();
  const discovery = new Recorder([
    '{"summary":"partial"}',
    '{"summary":"r1"}',
    '{"summary":"r2"}',
    '{"summary":"r3"}',
    '{"summary":"still"}',
    'A || b || c || d',
  ]);
  await new Client(discovery).suggestNewPianists(summary, 3);
  const taste = new Recorder(['{"summary":"taste"}']);
  await new Client(taste).summarizeTaste(summary);
  return [...discovery.reqs, ...taste.reqs];
}

describe('Go golden parity', () => {
  it('marshals the taste summary like json.MarshalIndent', () => {
    expect(marshalTasteSummary(sampleSummary())).toBe(golden.summaryJSON);
  });

  it('builds identical prompts and schemas through the repair and fallback flow', async () => {
    const reqs = await recordedRequests();
    expect(reqs).toHaveLength(golden.requests.length);
    reqs.forEach((req, idx) => {
      const want = golden.requests[idx] as GoldenRequest;
      expect(req.systemPrompt, `request ${idx} system`).toBe(want.system);
      expect(req.userPrompt, `request ${idx} user`).toBe(want.user);
      expect(req.outputMode).toBe(want.mode);
      expect(req.temperature).toBe(want.temperature);
      expect(req.maxOutputTokens).toBe(want.maxOutputTokens);
      expect(req.schema?.name).toBe(want.schemaName);
      expect(req.schema?.strict).toBe(want.strict);
      if (req.schema !== null) {
        expect(goMarshal(req.schema.schema, { sortKeys: true }), `request ${idx} schema`).toBe(want.schemaJSON);
      }
    });
  });

  describe('HTTP providers', () => {
    let server: TestServer;
    beforeAll(async () => {
      server = await startServer(
        jsonReply(
          '{"output_text":"x","choices":[{"message":{"content":"x"}}],"content":[{"type":"text","text":"x"}],"candidates":[{"content":{"parts":[{"text":"x"}]}}]}',
        ),
      );
    });
    afterAll(() => server.close());

    it('send identical bodies, headers, and paths', async () => {
      const reqs = await recordedRequests();
      const discovery = reqs[0] as Request;
      const tuned: Request = { ...discovery, temperature: 0.3, maxOutputTokens: 2048 };
      const plain = reqs[reqs.length - 2] as Request;
      const providers: Record<string, () => Provider> = {
        openai: () => new OpenAIProvider('k-openai', 'gpt-x', `${server.url}/v1/responses`),
        anthropic: () => new AnthropicProvider('k-anth', 'claude-x', `${server.url}/v1/messages`),
        google: () => new GoogleProvider('k-goog', 'gemini-x', `${server.url}/v1beta/models/`),
        openaicompat: () => new OpenAICompatProvider(' k-compat ', ' qwen ', `${server.url}/v1/`),
      };
      for (const want of golden.providers) {
        server.requests.length = 0;
        const provider = (providers[want.name] as () => Provider)();
        for (const req of [discovery, tuned, plain]) {
          await provider.generate(req);
        }
        expect(server.requests).toHaveLength(want.captures.length);
        want.captures.forEach((capture, idx) => {
          const got = server.requests[idx];
          expect(got?.method).toBe(capture.method);
          expect(got?.path).toBe(capture.path);
          expect(got?.query).toBe(capture.query);
          expect(got?.body, `${want.name} body ${idx}`).toBe(capture.body);
          for (const [name, value] of Object.entries(capture.headers)) {
            expect(got?.headers[name.toLowerCase()], `${want.name} ${name}`).toBe(value);
          }
          // Headers Go did not send must be absent too (e.g. Authorization without a key).
          for (const name of ['authorization', 'x-api-key', 'anthropic-version', 'x-goog-api-key']) {
            if (!Object.keys(capture.headers).some((key) => key.toLowerCase() === name)) {
              expect(got?.headers[name], `${want.name} unexpected ${name}`).toBeUndefined();
            }
          }
        });
      }
    });

    it('decode response envelopes with the same results and errors', async () => {
      for (const [name, outcomes] of Object.entries(golden.decode)) {
        for (const [idx, body] of golden.decodeBodies.entries()) {
          const one = await startServer(jsonReply(body));
          const make: Record<string, () => Provider> = {
            openai: () => new OpenAIProvider('k', 'm', one.url),
            anthropic: () => new AnthropicProvider('k', 'm', one.url),
            google: () => new GoogleProvider('k', 'm', one.url),
            openaicompat: () => new OpenAICompatProvider('k', 'm', one.url),
          };
          const request: Request = {
            systemPrompt: '',
            userPrompt: 'u',
            outputMode: 'strict',
            schema: null,
            temperature: 0,
            maxOutputTokens: 0,
          };
          let got: string;
          try {
            got = `OK ${await (make[name] as () => Provider)().generate(request)}`;
          } catch (err) {
            got = `ERR ${(err as Error).message}`;
          }
          await one.close();
          expect(got, `${name} body ${body}`).toBe(outcomes[idx]);
        }
      }
    });

    it('reports HTTP status errors like Go', async () => {
      const one = await startServer((_req, res) => {
        res.writeHead(429);
        res.end('  slow down \n');
      });
      const provider = new OpenAIProvider('k', 'm', one.url);
      await expect(
        provider.generate({
          systemPrompt: '',
          userPrompt: '',
          outputMode: 'strict',
          schema: null,
          temperature: 0,
          maxOutputTokens: 0,
        }),
      ).rejects.toThrow(golden.statusError);
      await one.close();
    });
  });

  it('passes identical argv and stdin to the claude CLI', async () => {
    const reqs = await recordedRequests();
    const record = emptyRecord();
    const provider = new ClaudeCLIProvider(
      ' opus ',
      '',
      stubRunner(record, '{"type":"result","subtype":"success","result":"x"}', '', null),
    );
    await provider.generate(reqs[0] as Request);
    expect(record.args).toEqual(golden.claudeArgs);
    expect(record.stdin).toBe(golden.claudeStdin);
  });

  it('passes identical argv, stdin, and schema file to codex', async () => {
    const reqs = await recordedRequests();
    let args: string[] = [];
    let stdin = '';
    let schema = '';
    const provider = new CodexProvider('m', '', async (inv) => {
      const { readFileSync, writeFileSync } = await import('node:fs');
      args = inv.args.map((arg) =>
        arg.includes('piano-tracker-codex-') ? `<tmp>/${arg.slice(arg.lastIndexOf('/') + 1)}` : arg,
      );
      stdin = inv.stdin;
      schema = readFileSync(inv.args[inv.args.indexOf('--output-schema') + 1] as string, 'utf8');
      writeFileSync(inv.args[inv.args.indexOf('--output-last-message') + 1] as string, 'ok');
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: null };
    });
    await provider.generate(reqs[0] as Request);
    expect(args).toEqual(golden.codexArgs);
    expect(stdin).toBe(golden.codexStdin);
    expect(schema).toBe(golden.codexSchema);
  });

  it('interprets claude CLI envelopes and failures identically', async () => {
    const cases: Array<{ stdout: string; stderr: string; fail: boolean }> = [
      { stdout: 'not json', stderr: '', fail: false },
      { stdout: 'null', stderr: '', fail: false },
      { stdout: '{}', stderr: '', fail: false },
      { stdout: '{"type":"system","subtype":"init","result":"x"}', stderr: '', fail: false },
      {
        stdout: '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in"}',
        stderr: '',
        fail: true,
      },
      { stdout: '{"type":"result","subtype":"error_during_execution","errors":["e1","e2"]}', stderr: '', fail: true },
      {
        stdout: '{"type":"result","subtype":"error_max_turns","result":" r ","errors":["e1"]}',
        stderr: '',
        fail: false,
      },
      { stdout: 'plain failure', stderr: '', fail: true },
      { stdout: 'plain', stderr: 'the stderr', fail: true },
      { stdout: '', stderr: '', fail: true },
      { stdout: '{"type":"result","subtype":"success","structured_output":{"b" : 2,"a":1}}', stderr: '', fail: false },
      {
        stdout: '{"type":"result","subtype":"success","result":"  ","structured_output":null}',
        stderr: '',
        fail: false,
      },
      { stdout: '{"type":"result","subtype":"success","is_error":"x"}', stderr: '', fail: false },
    ];
    const outcomes: string[] = [];
    for (const tc of cases) {
      const provider = new ClaudeCLIProvider(
        '',
        '',
        stubRunner(emptyRecord(), tc.stdout, tc.stderr, tc.fail ? new Error('exit status 1') : null),
      );
      try {
        outcomes.push(`OK ${await provider.generate(emptyRequest())}`);
      } catch (err) {
        outcomes.push(`ERR ${(err as Error).message}`);
      }
    }
    expect(outcomes).toEqual(golden.claudeCases);
  });

  it('reports codex failures identically', async () => {
    const missing = Object.assign(new Error('file does not exist'), { code: 'ENOENT' });
    const outcomes: string[] = [];
    for (const [stderr, error] of [
      ['', null],
      [' Please login \n', new Error('exit status 1')],
      ['', missing],
    ] as const) {
      const provider = new CodexProvider('', '', stubRunner(emptyRecord(), 'x', stderr, error));
      try {
        await provider.generate(emptyRequest());
      } catch (err) {
        outcomes.push((err as Error).message);
      }
    }
    expect(outcomes).toEqual(golden.codexCases);
  });

  it('derives catalog endpoints like net/url', () => {
    for (const line of golden.urls) {
      const [input, rest] = line.split(' => ') as [string, string];
      const [sibling, siblingErr, ollama, ollamaErr] = rest.split(' | ');
      const run = (fn: () => string): [string, string] => {
        try {
          return [fn(), '<nil>'];
        } catch (err) {
          return ['', (err as Error).message];
        }
      };
      expect(
        run(() => siblingEndpoint(input, 'models')),
        input,
      ).toEqual([sibling, siblingErr]);
      expect(
        run(() => ollamaTagsEndpoint(input)),
        input,
      ).toEqual([ollama, ollamaErr]);
    }
  });
});

function emptyRequest(): Request {
  return { systemPrompt: '', userPrompt: '', outputMode: 'strict', schema: null, temperature: 0, maxOutputTokens: 0 };
}
