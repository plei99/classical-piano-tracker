import { describe, expect, it } from 'vitest';
import {
  field,
  goAny,
  goBool,
  goMapAny,
  goMarshal,
  goPointer,
  goQuote,
  goRawMessage,
  goSlice,
  goString,
  goStruct,
  goUnmarshal,
} from './gojson';
import { goSortFunc } from './gosort';

const strings = goSlice(goString, '[]string');

function syntaxError(input: string | Uint8Array): string {
  try {
    goUnmarshal(input, goAny);
  } catch (err) {
    return (err as Error).message;
  }
  return '<nil>';
}

describe('parseGoJSON syntax errors', () => {
  it('uses Go 1.27 wording', () => {
    // Messages captured from Go's json.Unmarshal.
    const cases: Array<[string | Uint8Array, string]> = [
      ['', 'unexpected end of JSON input'],
      [' ', 'unexpected end of JSON input'],
      ['not json', "invalid character 'o' in literal null (expecting 'u')"],
      ['{"summary": ', 'unexpected end of JSON input'],
      ['{"summary":"a"} trailing', "invalid character 't' after top-level value"],
      ['{"a" 1}', "invalid character '1' after object key"],
      ['{"a":1 "b"}', "invalid character '\"' after object key:value pair"],
      ['[1 2]', "invalid character '2' after array element"],
      ['{,}', "invalid character ',' looking for beginning of object key string"],
      ['{"a":tru}', "invalid character '}' in literal true (expecting 'e')"],
      ['{"a":"\\x"}', 'invalid escape sequence `\\x` in string'],
      ['{"a":"\\u12g4"}', 'invalid escape sequence `\\u12g4` in string'],
      ['{"a":"\x01"}', "invalid character '\\x01' in string"],
      ['{"a":01}', "invalid character '1' after object key:value pair"],
      ['{"a":1.}', "invalid character '}' in numeric literal"],
      ['{"a":-}', "invalid character '}' in numeric literal"],
      ["{'a':1}", "invalid character '\\'' looking for beginning of object key string"],
      ['é', "invalid character 'é' looking for beginning of value"],
      ['[1,]', "invalid character ']' looking for beginning of value"],
      ['{"a":1,}', "invalid character '}' looking for beginning of object key string"],
      ['[}', "invalid character '}' looking for beginning of value"],
      ['[1}', "invalid character '}' after array element"],
      ['"\\u12"}', 'invalid escape sequence `\\u12"}` in string'],
      ['"\\u12', 'unexpected end of JSON input'],
      ['"\\\n"', 'invalid escape sequence "\\\\\\n" in string'],
      [' ', "invalid character '\\u00a0' looking for beginning of value"],
      [Uint8Array.of(0xff), "invalid character '\\xff' looking for beginning of value"],
      [Uint8Array.of(0x22, 0xe2, 0x82), 'unexpected end of JSON input'],
      ['1 2', "invalid character '2' after top-level value"],
      ['1e+', 'unexpected end of JSON input'],
      ['['.repeat(10001) + ']'.repeat(10001), 'exceeded max depth'],
    ];
    for (const [input, want] of cases) {
      expect(syntaxError(input), JSON.stringify(typeof input === 'string' ? input.slice(0, 40) : [...input])).toBe(
        want,
      );
    }
    expect(syntaxError('['.repeat(10000) + ']'.repeat(10000))).toBe('<nil>');
  });
});

describe('goUnmarshal', () => {
  it('replaces invalid UTF-8 and lone surrogates with U+FFFD, byte by byte', () => {
    const input = Buffer.from([0x22, 0x61, 0xe2, 0x82, 0x41, 0x62, 0xff, 0x22]);
    expect(goUnmarshal(input, goString)).toBe('a��Ab�');
    expect(goUnmarshal('"\\ud800\\u0041 \\udc00 \\ud83d\\ude00"', goString)).toBe('�A � \u{1F600}');
  });

  it('reports type errors with the Go path and type', () => {
    type Cli = { isError: boolean; raw: string; input: unknown; errors: string[] };
    const cli = goStruct<Cli>('main.cli', [
      field('isError', 'is_error', goBool),
      field('raw', 'structured_output', goRawMessage),
      field('input', 'input', goMapAny),
      field('errors', 'errors', strings),
    ]);
    expect(() => goUnmarshal('{"is_error":"yes"}', cli)).toThrow(
      'json: cannot unmarshal string into Go struct field cli.is_error of type bool',
    );
    expect(() => goUnmarshal('{"errors":[1]}', cli)).toThrow(
      'json: cannot unmarshal number into cli.errors.0 of type string',
    );
    expect(() => goUnmarshal('{"input":[1]}', cli)).toThrow(
      'json: cannot unmarshal array into Go struct field cli.input of type map[string]interface {}',
    );
    expect(() => goUnmarshal('{"input":{"a":1e400}}', cli)).toThrow(
      'json: cannot unmarshal number 1e400 into Go struct field cli.input.a of type float64',
    );
    expect(() => goUnmarshal('[1]', strings)).toThrow('json: cannot unmarshal number into .0 of type string');
    expect(() => goUnmarshal('{"a":1}', strings)).toThrow(
      'json: cannot unmarshal object into Go value of type []string',
    );

    // Raw messages keep the exact bytes, and null is "null".
    expect(goUnmarshal('{"structured_output": {"a" : 1} }', cli).raw).toBe('{"a" : 1}');
    expect(goUnmarshal('{"structured_output":"x","structured_output":null}', cli).raw).toBe('null');
    expect(goUnmarshal('{}', cli).raw).toBe('');
    // null leaves a bool alone.
    expect(goUnmarshal('{"is_error":true,"is_error":null}', cli).isError).toBe(true);
  });

  it('matches struct fields exactly first, then with Unicode case folding', () => {
    const decoder = goStruct<{ summary: string }>('main.S', [field('summary', 'summary', goString)]);
    expect(goUnmarshal('{"ſummary":"k"}', decoder).summary).toBe('k');
    expect(goUnmarshal('{"SUMMARY":"a","summary":"b"}', decoder).summary).toBe('b');
    expect(goUnmarshal('{"summary":"a","SUMMARY":"b"}', decoder).summary).toBe('b');
    expect(() => goUnmarshal('{"SUMMARY":5}', decoder)).toThrow(
      'json: cannot unmarshal number into Go struct field S.SUMMARY of type string',
    );
  });

  it('decodes pointers as null or merged structs', () => {
    const apiError = goStruct<{ message: string }>('main.apiError', [field('message', 'message', goString)]);
    const envelope = goStruct<{ error: { message: string } | null }>('main.env', [
      field('error', 'error', goPointer(apiError)),
    ]);
    expect(goUnmarshal('{"error":null}', envelope).error).toBeNull();
    expect(goUnmarshal('{"error":{"message":"a"},"error":{}}', envelope).error).toEqual({ message: 'a' });
    expect(() => goUnmarshal('{"error":"x"}', envelope)).toThrow(
      'json: cannot unmarshal string into Go struct field env.error of type main.apiError',
    );
  });

  it('decodes any keys safely, including __proto__', () => {
    const map = goUnmarshal('{"__proto__":{"x":1},"a":[true,null,"s",2.5]}', goMapAny);
    expect(map).not.toBeNull();
    expect(Object.keys(map ?? {})).toEqual(['__proto__', 'a']);
    expect(goUnmarshal('null', goMapAny)).toBeNull();
  });
});

describe('goMarshal', () => {
  it('matches Go for maps decoded from JSON', () => {
    // Go: json.Marshal of a map decoded from the same input.
    const map = goUnmarshal('{"b":1e21,"a":-0,"c":1.0,"10":1,"9":2,"s":"a<b & c>","small":0.0000001}', goMapAny);
    expect(goMarshal(map, { sortKeys: true })).toBe(
      '{"10":1,"9":2,"a":-0,"b":1e+21,"c":1,"s":"a\\u003cb \\u0026 c\\u003e","small":1e-7}',
    );
  });

  it('indents like MarshalIndent and escapes like Go', () => {
    const value = { t: 'T\u2028\u2029\u0001\b\f\t\n\r"\\/é😀\uD800', empty: [], obj: {}, skipped: undefined };
    expect(goMarshal(value, { sortKeys: true, indent: '  ' })).toBe(
      '{\n  "empty": [],\n  "obj": {},\n  "t": "T\\u2028\\u2029\\u0001\\b\\f\\t\\n\\r\\"\\\\/é😀�"\n}',
    );
  });

  it('rejects values Go cannot encode', () => {
    expect(() => goMarshal({ x: NaN }, { sortKeys: true })).toThrow('json: unsupported value: NaN');
    expect(() => goMarshal({ x: () => 1 }, { sortKeys: true })).toThrow('json: unsupported type: function');
  });
});

describe('goQuote', () => {
  it('quotes like strconv.Quote', () => {
    expect(goQuote('a"b\\c\n\x01é \u{1F600}')).toBe('"a\\"b\\\\c\\n\\x01é\\u00a0😀"');
  });
});

describe('goSortFunc', () => {
  it('orders ties exactly like Go slices.SortFunc', () => {
    // Golden index orders from Go for keys drawn from a small set.
    const golden: Record<number, number[]> = {
      5: [0, 3, 1, 4, 2],
      13: [6, 3, 8, 11, 12, 1, 4, 10, 5, 0, 7, 2, 9],
      40: [
        34, 31, 35, 3, 4, 5, 36, 20, 25, 33, 7, 27, 21, 23, 14, 8, 26, 17, 12, 10, 30, 37, 22, 16, 24, 15, 13, 1, 6, 29,
        19, 32, 0, 9, 28, 2, 11, 18, 38, 39,
      ],
      64: [
        12, 52, 32, 47, 15, 60, 59, 11, 29, 46, 51, 58, 1, 50, 25, 4, 63, 9, 2, 31, 30, 13, 22, 28, 27, 16, 53, 24, 23,
        62, 61, 19, 6, 33, 7, 56, 26, 8, 49, 39, 48, 41, 42, 17, 44, 36, 55, 0, 54, 38, 14, 10, 37, 43, 45, 40, 35, 57,
        34, 18, 5, 20, 21, 3,
      ],
    };
    for (const [n, want] of Object.entries(golden)) {
      const length = Number(n);
      const data: Array<{ key: number; idx: number }> = [];
      let x = (length * 7919) >>> 0;
      for (let i = 0; i < length; i++) {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        data.push({ key: (x >>> 24) % 4, idx: i });
      }
      goSortFunc(data, (a, b) => a.key - b.key);
      expect(
        data.map((d) => d.idx),
        `n=${n}`,
      ).toEqual(want);
    }
  });
});
