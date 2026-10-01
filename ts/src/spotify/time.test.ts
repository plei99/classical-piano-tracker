import { describe, expect, it } from 'vitest';

import { dateFromNs, parseRfc3339Ns, unixSeconds } from './time';

describe('parseRfc3339Ns', () => {
  it('matches Go UnixNano for whole seconds', () => {
    // time.Date(2026, time.April, 1, 10, 0, 0, 0, time.UTC).UnixNano()
    expect(parseRfc3339Ns('2026-04-01T10:00:00Z')).toBe(1_775_037_600_000_000_000n);
    expect(parseRfc3339Ns('1970-01-01T00:00:00Z')).toBe(0n);
  });

  it('keeps every fractional digit up to nanoseconds', () => {
    expect(parseRfc3339Ns('2026-04-01T10:00:00.123456789Z')).toBe(1_775_037_600_123_456_789n);
    expect(parseRfc3339Ns('2026-04-01T10:00:00.1Z')).toBe(1_775_037_600_100_000_000n);
    expect(parseRfc3339Ns('2026-04-01T10:00:00.000000001Z')).toBe(1_775_037_600_000_000_001n);
  });

  it('truncates digits beyond nanoseconds like Go', () => {
    expect(parseRfc3339Ns('2026-04-01T10:00:00.1234567899Z')).toBe(1_775_037_600_123_456_789n);
  });

  it('applies offsets', () => {
    expect(parseRfc3339Ns('2026-04-01T12:30:00+02:30')).toBe(parseRfc3339Ns('2026-04-01T10:00:00Z'));
    expect(parseRfc3339Ns('2026-04-01T03:00:00-07:00')).toBe(parseRfc3339Ns('2026-04-01T10:00:00Z'));
  });

  it('handles leap days and pre-epoch dates', () => {
    expect(parseRfc3339Ns('2024-02-29T00:00:00Z')).toBe(BigInt(Date.parse('2024-02-29T00:00:00Z')) * 1_000_000n);
    expect(parseRfc3339Ns('0001-01-01T00:00:00Z')).toBe(-62_135_596_800n * 1_000_000_000n);
  });

  it.each([
    '',
    '2026-04-01',
    '2026-04-01 10:00:00Z',
    '2026-04-01t10:00:00Z',
    '2026-04-01T10:00:00z',
    '2026-04-01T10:00:00',
    '2026-13-01T10:00:00Z',
    '2025-02-29T10:00:00Z',
    '2026-04-01T24:00:00Z',
    '2026-04-01T10:60:00Z',
    '2026-04-01T10:00:60Z',
    '2026-04-01T10:00:00+24:00',
    '2026-04-01T10:00:00+0200',
    '2026-04-01T10:00:00.Z',
  ])('rejects %j', (text) => {
    expect(() => parseRfc3339Ns(text)).toThrow(
      `parsing time ${JSON.stringify(text)} as "2006-01-02T15:04:05Z07:00": cannot parse`,
    );
  });
});

describe('ns conversions', () => {
  it('floors to seconds and milliseconds like Go', () => {
    expect(unixSeconds(1_775_037_600_999_999_999n)).toBe(1_775_037_600);
    expect(unixSeconds(-1n)).toBe(-1);
    expect(dateFromNs(1_775_037_600_123_456_789n).toISOString()).toBe('2026-04-01T10:00:00.123Z');
  });
});
