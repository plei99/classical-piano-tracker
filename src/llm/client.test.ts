import { describe, expect, it } from 'vitest';
import type { TasteSummary } from '../recommend';
import { Client, type Provider, type Request } from './index';

/** Returns canned responses in order; once exhausted, "" and the configured error (like the Go stub). */
class StubProvider implements Provider {
  readonly reqs: Request[] = [];

  constructor(
    private readonly raws: string[],
    private readonly error: Error | null = null,
  ) {}

  async generate(req: Request): Promise<string> {
    this.reqs.push(req);
    const raw = this.raws.shift() ?? '';
    if (this.error !== null) {
      throw this.error;
    }
    return raw;
  }
}

function summary(overrides: Partial<TasteSummary> = {}): TasteSummary {
  return {
    totalTracks: 0,
    totalRatings: 3,
    commentCount: 0,
    favoritePianists: [
      { name: 'Martha Argerich', trackCount: 0, ratedTrackCount: 0, totalPlayCount: 0, averageStars: 0 },
    ],
    lovedTracks: [],
    dislikedTracks: [],
    commentedTracks: [],
    knownPianists: ['Martha Argerich'],
    discoveryGuidance: '',
    ...overrides,
  };
}

function recommendationsSchema(req: Request | undefined): Record<string, unknown> {
  const properties = req?.schema?.schema['properties'] as Record<string, Record<string, unknown>>;
  return properties['recommendations'] as Record<string, unknown>;
}

const COMPLETE =
  '{"summary":"You like vivid, high-energy pianists.","recommendations":[{"pianist_name":"Radu Lupu","why_fit":"lyrical contrast","similar_to":["Martha Argerich"],"confidence":"medium"}]}';

describe('Client.suggestNewPianists', () => {
  it('builds the discovery request and parses the result', async () => {
    const provider = new StubProvider([COMPLETE]);
    const result = await new Client(provider).suggestNewPianists(summary(), 1);
    expect(result.summary).not.toBe('');
    expect(result.recommendations).toHaveLength(1);
    expect(provider.reqs).toHaveLength(1);
    expect(provider.reqs[0]?.schema?.name).toBe('pianist_discovery');
    expect(recommendationsSchema(provider.reqs[0])['minItems']).toBe(1);
  });

  it('repairs incomplete structured output', async () => {
    const provider = new StubProvider(['{"summary":"You like vivid, high-energy pianists."}', COMPLETE]);
    const result = await new Client(provider).suggestNewPianists(summary(), 1);
    expect(result.recommendations).toHaveLength(1);
    expect(provider.reqs).toHaveLength(2);
    expect(provider.reqs[1]?.schema?.name).toBe('pianist_discovery');
    expect(provider.reqs[1]?.userPrompt.startsWith('Repair attempt 1.\n')).toBe(true);
  });

  it('retries multiple repair passes', async () => {
    const provider = new StubProvider([
      '{"summary":"first partial"}',
      '{"summary":"second partial"}',
      '{"summary":"third partial"}',
      '{"summary":"final summary","recommendations":[{"pianist_name":"Radu Lupu","why_fit":"lyrical contrast","similar_to":["Martha Argerich"],"confidence":"medium"}]}',
    ]);
    const result = await new Client(provider).suggestNewPianists(summary(), 1);
    expect(result.summary).toBe('final summary');
    expect(result.recommendations).toHaveLength(1);
    expect(provider.reqs).toHaveLength(4);
  });

  it('falls back to a recommendations-only request', async () => {
    const provider = new StubProvider([
      '{"summary":"partial summary"}',
      '{"summary":"repair one"}',
      '{"summary":"repair two"}',
      '{"summary":"repair three"}',
      '{"recommendations":[{"pianist_name":"Radu Lupu","why_fit":"lyrical contrast","similar_to":["Martha Argerich"],"confidence":"medium"}]}',
    ]);
    const result = await new Client(provider).suggestNewPianists(summary(), 1);
    expect(result.summary).toBe('repair three');
    expect(result.recommendations).toHaveLength(1);
    expect(provider.reqs).toHaveLength(5);
    expect(provider.reqs[4]?.schema?.name).toBe('pianist_recommendations_only');
  });

  it('falls back to plaintext recommendations', async () => {
    const provider = new StubProvider([
      '{"summary":"partial summary"}',
      '{"summary":"repair one"}',
      '{"summary":"repair two"}',
      '{"summary":"repair three"}',
      '{"summary":"still no recommendations"}',
      'Radu Lupu || lyrical contrast || Martha Argerich || medium',
    ]);
    const result = await new Client(provider).suggestNewPianists(summary(), 1);
    expect(result.summary).toBe('repair three');
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]?.pianistName).toBe('Radu Lupu');
    expect(provider.reqs).toHaveLength(6);
    expect(provider.reqs[5]?.schema).toBeNull();
    expect(provider.reqs[5]?.outputMode).toBe('prompt_only');
  });

  it('recovers from a missing pianist_name', async () => {
    const provider = new StubProvider([
      '{"summary":"partial summary","recommendations":[{"why_fit":"missing name","similar_to":["Martha Argerich"],"confidence":"medium"}]}',
      '{"summary":"repair one","recommendations":[{"why_fit":"still missing name","similar_to":["Martha Argerich"],"confidence":"medium"}]}',
      '{"summary":"repair two","recommendations":[{"why_fit":"still missing name","similar_to":["Martha Argerich"],"confidence":"medium"}]}',
      '{"summary":"repair three","recommendations":[{"why_fit":"still missing name","similar_to":["Martha Argerich"],"confidence":"medium"}]}',
      '{"recommendations":[{"name":"Radu Lupu","reason":"lyrical contrast","similar":["Martha Argerich"],"confidence":"medium"}]}',
    ]);
    const result = await new Client(provider).suggestNewPianists(summary(), 1);
    expect(result.summary).toBe('repair three');
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]?.pianistName).toBe('Radu Lupu');
    expect(provider.reqs).toHaveLength(5);
    expect(provider.reqs[4]?.schema?.name).toBe('pianist_recommendations_only');
  });

  it('requires at least five recommendations when the limit is higher', async () => {
    const provider = new StubProvider([
      '{"summary":"summary","recommendations":[{"pianist_name":"Radu Lupu","why_fit":"lyrical contrast","similar_to":["Martha Argerich"],"confidence":"medium"},{"pianist_name":"Leif Ove Andsnes","why_fit":"clarity","similar_to":["Víkingur Ólafsson"],"confidence":"medium"},{"pianist_name":"Marc-Andre Hamelin","why_fit":"virtuosity","similar_to":["Yuja Wang"],"confidence":"medium"},{"pianist_name":"Jean-Yves Thibaudet","why_fit":"color","similar_to":["Alice Sara Ott"],"confidence":"medium"},{"pianist_name":"Khatia Buniatishvili","why_fit":"fire","similar_to":["Yuja Wang"],"confidence":"medium"}]}',
    ]);
    await new Client(provider).suggestNewPianists(summary(), 5);
    expect(recommendationsSchema(provider.reqs[0])['minItems']).toBe(5);
    expect(recommendationsSchema(provider.reqs[0])['maxItems']).toBe(5);
  });

  it('rejects discovery input without enough ratings', async () => {
    const provider = new StubProvider([]);
    await expect(new Client(provider).suggestNewPianists(summary({ totalRatings: 1 }), 5)).rejects.toThrow(
      'need at least 3 rated tracks',
    );
    expect(provider.reqs).toHaveLength(0);
  });

  it('defaults the limit, truncates extra recommendations, and wraps final parse errors', async () => {
    const many = JSON.stringify({
      summary: 's',
      recommendations: Array.from({ length: 7 }, (_, idx) => ({ pianist_name: `P${idx}`, why_fit: 'w' })),
    });
    const provider = new StubProvider([many]);
    const result = await new Client(provider).suggestNewPianists(summary(), 0);
    expect(result.recommendations).toHaveLength(5);
    expect(recommendationsSchema(provider.reqs[0])['maxItems']).toBe(5);

    // A summary-less answer is repaired but never recovered, so the parse error surfaces.
    const failing = new StubProvider(Array<string>(4).fill('{"recommendations":[]}'));
    await expect(new Client(failing).suggestNewPianists(summary(), 1)).rejects.toThrow(
      'parse LLM discovery response: LLM discovery response omitted summary: ',
    );
    expect(failing.reqs).toHaveLength(4);

    // Provider errors on the first call propagate unchanged.
    await expect(new Client(new StubProvider([], new Error('boom'))).suggestNewPianists(summary(), 1)).rejects.toThrow(
      /^boom$/,
    );
  });

  it('requires a provider', () => {
    expect(() => new Client(null as unknown as Provider)).toThrow('LLM provider is required');
  });
});

describe('Client.summarizeTaste', () => {
  it('builds the summary request and parses the result', async () => {
    const provider = new StubProvider([
      '{"summary":"You gravitate toward vivid, rhythmically incisive pianism with strong contrapuntal clarity."}',
    ]);
    const got = await new Client(provider).summarizeTaste(summary());
    expect(got).toBe('You gravitate toward vivid, rhythmically incisive pianism with strong contrapuntal clarity.');
    expect(provider.reqs).toHaveLength(1);
    expect(provider.reqs[0]?.schema?.name).toBe('taste_summary');
  });

  it('wraps parse failures', async () => {
    await expect(new Client(new StubProvider(['{"summary":""}'])).summarizeTaste(summary())).rejects.toThrow(
      'parse LLM taste summary response: LLM taste summary response omitted summary: {"summary":""}',
    );
  });
});
