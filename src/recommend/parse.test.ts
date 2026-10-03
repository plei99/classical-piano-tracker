import { describe, expect, it } from 'vitest';
import {
  parseDiscoveryPartial,
  parseDiscoveryRecommendations,
  parseDiscoveryResult,
  parsePlaintextRecommendations,
  parseTasteSummary,
} from './index';
import { previewJSON, recommendationCompletenessScore } from './parse';

describe('parseDiscoveryResult', () => {
  it('handles fenced JSON', () => {
    const raw =
      '```json\n{"summary":"lyrical","recommendations":[{"pianist_name":"Radu Lupu","why_fit":"poetic touch","similar_to":["Martha Argerich"],"confidence":"medium"}]}\n```';
    const result = parseDiscoveryResult(raw);
    expect(result.summary).toBe('lyrical');
    expect(result.recommendations).toHaveLength(1);
  });

  it('accepts the pianists alias', () => {
    const raw =
      '{"summary":"lyrical","pianists":[{"name":"Radu Lupu","reason":"poetic touch","similar":["Martha Argerich"],"confidence":"medium"}]}';
    const result = parseDiscoveryResult(raw);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]?.pianistName).toBe('Radu Lupu');
    expect(result.recommendations[0]?.whyFit).toBe('poetic touch');
    expect(result.recommendations[0]?.similarTo).toEqual(['Martha Argerich']);
  });

  it('accepts a nested result alias', () => {
    const raw =
      '{"result":{"overview":"lyrical","suggestions":[{"pianist":"Radu Lupu","why":"poetic touch","similar_to":["Martha Argerich"],"confidence":"medium"}]}}';
    const result = parseDiscoveryResult(raw);
    expect(result.summary).toBe('lyrical');
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]?.pianistName).toBe('Radu Lupu');
  });

  it('finds recommendation-shaped arrays anywhere', () => {
    let raw = '{"summary":"s","picks":{"items":[{"artist":"Radu Lupu","reason":"r"}]}}';
    expect(parseDiscoveryResult(raw).recommendations[0]?.pianistName).toBe('Radu Lupu');

    raw = '{"summary":"s","list":[{"name":"Radu Lupu","why_fit":"r"}],"other":[{"unrelated":1}]}';
    expect(parseDiscoveryResult(raw).recommendations).toHaveLength(1);
  });

  it('only replaces the strict result when the alias result is more complete', () => {
    // Strict keys win when the alias decode finds nothing better.
    let raw =
      '{"summary":"s","recommendations":[{"pianist_name":" A ","why_fit":" w ","similar_to":["x"],"confidence":" high "}]}';
    let result = parseDiscoveryResult(raw);
    expect(result.recommendations[0]?.pianistName).toBe('A');
    expect(result.recommendations[0]?.confidence).toBe('high');

    // Mixed keys: the strict decode sees an empty name, the aliases see the name.
    raw = '{"summary":"s","recommendations":[{"name":"A","why_fit":"w"}]}';
    result = parseDiscoveryResult(raw);
    expect(result.recommendations[0]?.pianistName).toBe('A');

    expect(
      recommendationCompletenessScore([{ pianistName: 'a', whyFit: 'b', similarTo: ['c'], confidence: 'd' }]),
    ).toBe(6);
  });

  it('reports missing fields', () => {
    expect(() => parseDiscoveryResult('{"recommendations":[]}')).toThrow(
      'LLM discovery response omitted summary: {"recommendations":[]}',
    );
    expect(() => parseDiscoveryResult('{"summary":"s",\n\n  "recommendations":[]}')).toThrow(
      'LLM discovery response omitted recommendations: {"summary":"s", "recommendations":[]}',
    );
    expect(() => parseDiscoveryResult('{"summary":"s","recommendations":[{"pianist_name":"A"}]}')).toThrow(
      'recommendation 1 omitted why_fit',
    );
    expect(() => parseDiscoveryResult('{"summary":"s","recommendations":[{"why_fit":"w"}]}')).toThrow(
      'recommendation 1 omitted pianist_name',
    );
  });
});

describe('strict decoding', () => {
  it('follows Go json.Unmarshal rules', () => {
    // Case-insensitive keys and nulls.
    const raw = '{"Summary":"s","RECOMMENDATIONS":[null,{"Pianist_Name":"A","why_fit":"w","similar_to":null}]}';
    const result = parseDiscoveryPartial(raw);
    expect(result.summary).toBe('s');
    expect(result.recommendations).toHaveLength(2);
    expect(result.recommendations[1]?.pianistName).toBe('A');

    expect(parseDiscoveryPartial('null')).toEqual({ summary: '', recommendations: [] });

    // The last duplicate wins, null leaves a value alone, and repeated
    // arrays merge element-wise into the existing elements.
    expect(parseDiscoveryPartial('{"summary":"a","SUMMARY":"b","summary":null}').summary).toBe('b');
    const merged = parseDiscoveryPartial(
      '{"recommendations":[{"pianist_name":"A"}],"recommendations":[{"why_fit":"B"}]}',
    ).recommendations;
    expect(merged).toEqual([{ pianistName: 'A', whyFit: 'B', similarTo: [], confidence: '' }]);

    expect(() => parseDiscoveryPartial('{"summary":5}')).toThrow(
      'decode LLM discovery response: json: cannot unmarshal number into Go struct field DiscoveryResult.summary of type string',
    );
    expect(() => parseDiscoveryPartial('{"recommendations":[1]}')).toThrow(
      'decode LLM discovery response: json: cannot unmarshal number into DiscoveryResult.recommendations.0 of type recommend.SuggestedPianist',
    );
    expect(() => parseDiscoveryPartial('[1]')).toThrow(
      'decode LLM discovery response: json: cannot unmarshal array into Go value of type recommend.DiscoveryResult',
    );
    expect(() => parseDiscoveryPartial('not json')).toThrow(
      "decode LLM discovery response: invalid character 'o' in literal null (expecting 'u')",
    );
    expect(() => parseDiscoveryPartial('{"summary":"a"} trailing')).toThrow(
      "decode LLM discovery response: invalid character 't' after top-level value",
    );
  });
});

describe('previewJSON', () => {
  it('collapses whitespace and truncates long payloads by bytes', () => {
    const long = `{"summary":"${'x'.repeat(500)}"}`;
    const preview = previewJSON(long);
    expect(preview).toHaveLength(243);
    expect(preview.endsWith('...')).toBe(true);
    expect(previewJSON(' a \n\t b ')).toBe('a b');
    // A rune split by the byte cut renders as U+FFFD.
    expect(previewJSON(`${'x'.repeat(239)}é`)).toBe(`${'x'.repeat(239)}�...`);
  });
});

describe('parseTasteSummary', () => {
  it('handles JSON, plaintext, and fences', () => {
    for (const raw of [
      '{"summary":"You prefer high-voltage precision with clear voicing."}',
      '```json\n{"summary":"You prefer high-voltage precision with clear voicing."}\n```',
      'You prefer high-voltage precision with clear voicing.',
    ]) {
      expect(parseTasteSummary(raw), raw).toBe('You prefer high-voltage precision with clear voicing.');
    }
  });

  it('reports errors', () => {
    expect(() => parseTasteSummary('  ```  ')).toThrow(/^LLM taste summary response omitted summary$/);
    expect(() => parseTasteSummary('{"overview":""}')).toThrow(
      'LLM taste summary response omitted summary: {"overview":""}',
    );
    expect(() => parseTasteSummary('{"summary": ')).toThrow(
      'decode LLM taste summary response: decode LLM discovery response: unexpected end of JSON input',
    );
    // Plain text that happens to be a JSON scalar is still prose.
    expect(parseTasteSummary('42')).toBe('42');
  });
});

describe('parseDiscoveryRecommendations', () => {
  it('accepts a recommendations-only payload', () => {
    const raw =
      '{"recommendations":[{"pianist_name":"Radu Lupu","why_fit":"poetic touch","similar_to":["Martha Argerich"],"confidence":"medium"}]}';
    const recommendations = parseDiscoveryRecommendations(raw);
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]?.pianistName).toBe('Radu Lupu');

    expect(() => parseDiscoveryRecommendations('{"summary":"only"}')).toThrow(
      'LLM discovery response omitted recommendations: {"summary":"only"}',
    );
  });
});

describe('parsePlaintextRecommendations', () => {
  it('parses the rigid fallback format', () => {
    const raw =
      'Radu Lupu || poetic touch || Martha Argerich, Daniil Trifonov || medium\nMarc-André Hamelin || virtuosity with brains || Yuja Wang || high';
    const recommendations = parsePlaintextRecommendations(raw);
    expect(recommendations).toHaveLength(2);
    expect(recommendations[0]?.pianistName).toBe('Radu Lupu');
    expect(recommendations[0]?.similarTo).toEqual(['Martha Argerich', 'Daniil Trifonov']);
    expect(recommendations[1]?.pianistName).toBe('Marc-André Hamelin');
  });

  it('strips bullets and numbering', () => {
    const raw =
      'Here you go:\n- 1. A || why || , || \n* B || why2 || X ,Y|| low\n12. C ||  || X || high\n2.D || w || || ';
    const recs = parsePlaintextRecommendations(raw);
    expect(recs.map((rec) => rec.pianistName)).toEqual(['A', 'B', '2.D']);
    expect(recs[0]?.similarTo).toEqual([]);
    expect(recs[1]?.similarTo).toEqual(['X', 'Y']);
    expect(recs[1]?.confidence).toBe('low');

    expect(() => parsePlaintextRecommendations('nothing here')).toThrow(
      'LLM plaintext recommendation fallback produced no parseable lines',
    );
  });
});
