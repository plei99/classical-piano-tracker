import { describe, expect, it } from 'vitest';

import { goAtoi, goFields, goTrimSpace, parseGoBool, parseGoInt, runeCount } from './gostr';

describe('Go string helpers', () => {
  it('trims and splits on exactly Go whitespace', () => {
    expect(goTrimSpace('\u0085\t a b \u3000')).toBe('a b');
    expect(goTrimSpace('\ufeffx')).toBe('\ufeffx');
    expect(goFields('  a\u00a0b\n\nc ')).toEqual(['a', 'b', 'c']);
    expect(goFields(' \t ')).toEqual([]);
  });

  it('counts runes, not UTF-16 units', () => {
    expect(runeCount('é🎹a')).toBe(3);
  });
});

describe('parseGoInt', () => {
  it('parses base-0 syntax like strconv.ParseInt(s, 0, 64)', () => {
    const cases: [string, bigint][] = [
      ['10', 10n],
      ['+7', 7n],
      ['-3', -3n],
      ['0', 0n],
      ['0x1F', 31n],
      ['0X1f', 31n],
      ['0b101', 5n],
      ['0o17', 15n],
      ['017', 15n],
      ['1_000', 1000n],
      ['0x_ff', 255n],
      ['9223372036854775807', 9223372036854775807n],
      ['-9223372036854775808', -9223372036854775808n],
    ];
    for (const [input, want] of cases) {
      expect(parseGoInt(input, 0), input).toBe(want);
    }
  });

  it('rejects invalid syntax with strconv messages', () => {
    for (const input of ['', '-', 'abc', '08', '0x', '1__0', '_1', '1_', '1.5', ' 1', '١']) {
      expect(() => parseGoInt(input, 0), input).toThrow(
        `strconv.ParseInt: parsing ${JSON.stringify(input)}: invalid syntax`,
      );
    }
    expect(() => parseGoInt('9223372036854775808', 0)).toThrow(
      'strconv.ParseInt: parsing "9223372036854775808": value out of range',
    );
  });

  it('accepts only decimal digits in base 10', () => {
    expect(parseGoInt('010', 10)).toBe(10n);
    expect(() => parseGoInt('0x10', 10)).toThrow('invalid syntax');
    expect(() => parseGoInt('1_0', 10)).toThrow('invalid syntax');
  });

  it('goAtoi returns null where Atoi fails', () => {
    expect(goAtoi('42')).toBe(42);
    expect(goAtoi('-1')).toBe(-1);
    expect(goAtoi('x')).toBeNull();
    expect(goAtoi('')).toBeNull();
  });

  it('parses Go booleans', () => {
    expect(parseGoBool('T')).toBe(true);
    expect(parseGoBool('False')).toBe(false);
    expect(() => parseGoBool('yes')).toThrow('strconv.ParseBool: parsing "yes": invalid syntax');
  });
});
