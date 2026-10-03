/**
 * Small ports of Go standard-library string and number behavior that the CLI
 * output depends on. JavaScript's built-ins differ in edge cases (which
 * characters count as whitespace, how ties round, what integer syntax is
 * accepted), and the CLI promises byte-identical output and error text.
 */
import { quote } from '../core/errors';

/** Go's unicode.IsSpace set (JS `\s` adds U+FEFF and omits U+0085). */
const GO_SPACE = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const GO_SPACE_RUN = new RegExp(`[${GO_SPACE}]+`, 'u');
const GO_TRIM = new RegExp(`^[${GO_SPACE}]+|[${GO_SPACE}]+$`, 'gu');

/** Go's strings.TrimSpace. */
export function goTrimSpace(value: string): string {
  return value.replace(GO_TRIM, '');
}

/** Go's strings.Fields: splits on runs of whitespace, dropping empty fields. */
export function goFields(value: string): string[] {
  return value.split(GO_SPACE_RUN).filter((field) => field !== '');
}

/** Go's utf8.RuneCountInString, for strings that are valid UTF-16. */
export function runeCount(value: string): number {
  let count = 0;
  for (const _ of value) {
    count++;
  }
  return count;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** The error strconv returns, with Go's exact message. */
export class NumError extends Error {
  constructor(
    readonly func: string,
    readonly input: string,
    readonly reason: 'invalid syntax' | 'value out of range',
  ) {
    super(`strconv.${func}: parsing ${quote(input)}: ${reason}`);
    this.name = 'NumError';
  }
}

/** Go's underscoreOK: underscores may only separate digits (base-0 parsing only). */
function underscoreOK(s: string): boolean {
  let saw = '^';
  let i = 0;
  if (s.startsWith('-') || s.startsWith('+')) {
    s = s.slice(1);
  }
  let hex = false;
  if (s.length >= 2 && s[0] === '0' && 'box'.includes(s[1]!.toLowerCase())) {
    i = 2;
    saw = '0';
    hex = s[1]!.toLowerCase() === 'x';
  }
  for (; i < s.length; i++) {
    const c = s[i]!;
    const lower = c.toLowerCase();
    if ((c >= '0' && c <= '9') || (hex && lower >= 'a' && lower <= 'f')) {
      saw = '0';
      continue;
    }
    if (c === '_') {
      if (saw !== '0') {
        return false;
      }
      saw = '_';
      continue;
    }
    if (saw === '_') {
      return false;
    }
    saw = '!';
  }
  return saw !== '_';
}

/**
 * Go's strconv.ParseInt(s, base, 64) for base 0 (prefix-detected, as pflag's
 * int flags use) or base 10 (as strconv.Atoi and parsePositiveInt64 use).
 * Returns a bigint because int64 exceeds JavaScript's safe integer range.
 */
export function parseGoInt(input: string, base: 0 | 10, func = 'ParseInt'): bigint {
  const syntax = () => new NumError(func, input, 'invalid syntax');
  if (input === '') {
    throw syntax();
  }
  let s = input;
  let negative = false;
  if (s[0] === '+' || s[0] === '-') {
    negative = s[0] === '-';
    s = s.slice(1);
    if (s === '') {
      throw syntax();
    }
  }

  let radix = 10;
  if (base === 0) {
    const prefix = s.slice(0, 2).toLowerCase();
    if (s.length >= 3 && prefix === '0x') {
      radix = 16;
      s = s.slice(2);
    } else if (s.length >= 3 && prefix === '0b') {
      radix = 2;
      s = s.slice(2);
    } else if (s.length >= 3 && prefix === '0o') {
      radix = 8;
      s = s.slice(2);
    } else if (s.length >= 2 && s[0] === '0') {
      radix = 8;
      s = s.slice(1);
    }
  }

  let value = 0n;
  let sawUnderscore = false;
  let digits = 0;
  for (const c of s) {
    if (c === '_' && base === 0) {
      sawUnderscore = true;
      continue;
    }
    const digit = Number.parseInt(c, 36);
    if (Number.isNaN(digit) || digit >= radix) {
      throw syntax();
    }
    value = value * BigInt(radix) + BigInt(digit);
    digits++;
  }
  if (digits === 0 || (sawUnderscore && !underscoreOK(input))) {
    throw syntax();
  }

  const signed = negative ? -value : value;
  if (signed < INT64_MIN || signed > INT64_MAX) {
    throw new NumError(func, input, 'value out of range');
  }
  return signed;
}

/** Go's strconv.Atoi, returning null wherever Go would return an error. */
export function goAtoi(input: string): number | null {
  try {
    return Number(parseGoInt(input, 10, 'Atoi'));
  } catch {
    return null;
  }
}

/** Go's strconv.ParseBool. */
export function parseGoBool(input: string): boolean {
  if (['1', 't', 'T', 'TRUE', 'true', 'True'].includes(input)) {
    return true;
  }
  if (['0', 'f', 'F', 'FALSE', 'false', 'False'].includes(input)) {
    return false;
  }
  throw new NumError('ParseBool', input, 'invalid syntax');
}
