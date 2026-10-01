import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { localDateTime, localLongDateTime, localRfc3339, nanosToMillis, utcDateTime } from './timefmt';
import { tempDir } from './testutil';
import { intlZoneName, loadLocalZone, localZone, lookupZone, parseTzif, tzset } from './tzif';

interface TestZone {
  name: string;
  offset: number;
  isDst: boolean;
}

/**
 * Builds a TZif file. Version 2 files carry a throwaway v1 block followed by
 * the 64-bit block and the POSIX TZ footer, as zic writes them.
 */
function tzif(version: 1 | 2, zones: TestZone[], transitions: [number, number][], footer = ''): Uint8Array {
  const bytes: number[] = [];
  const u8 = (value: number) => bytes.push(value & 0xff);
  const u32 = (value: number) => {
    const view = new DataView(new ArrayBuffer(4));
    view.setInt32(0, value);
    bytes.push(...new Uint8Array(view.buffer));
  };
  const i64 = (value: number) => {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigInt64(0, BigInt(value));
    bytes.push(...new Uint8Array(view.buffer));
  };

  const chars: number[] = [];
  const nameIndex = zones.map((zone) => {
    const index = chars.length;
    chars.push(...new TextEncoder().encode(zone.name), 0);
    return index;
  });

  const block = (timeSize: 4 | 8) => {
    bytes.push(...new TextEncoder().encode('TZif'));
    u8(version === 1 ? 0 : '2'.charCodeAt(0));
    bytes.push(...new Array<number>(15).fill(0));
    for (const count of [0, 0, 0, transitions.length, zones.length, chars.length]) {
      u32(count);
    }
    for (const [when] of transitions) {
      (timeSize === 8 ? i64 : u32)(when);
    }
    for (const [, index] of transitions) {
      u8(index);
    }
    zones.forEach((zone, idx) => {
      u32(zone.offset);
      u8(zone.isDst ? 1 : 0);
      u8(nameIndex[idx]!);
    });
    bytes.push(...chars);
  };

  block(4);
  if (version === 2) {
    block(8);
    bytes.push(...new TextEncoder().encode(`\n${footer}\n`));
  }
  return new Uint8Array(bytes);
}

const at = (iso: string) => Date.parse(iso) / 1000;
const name = (tz: ReturnType<typeof parseTzif>, sec: number) => lookupZone(tz, sec).name;

const losAngeles = () =>
  tzif(
    2,
    [
      { name: 'LMT', offset: -28378, isDst: false },
      { name: 'PDT', offset: -25200, isDst: true },
      { name: 'PST', offset: -28800, isDst: false },
    ],
    [
      [at('2020-03-08T10:00:00Z'), 1],
      [at('2020-11-01T09:00:00Z'), 2],
    ],
    'PST8PDT,M3.2.0,M11.1.0',
  );

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('TZif zone names', () => {
  it('uses the transition table, then the footer rule', () => {
    const tz = parseTzif(losAngeles());
    expect(name(tz, at('1900-01-01T00:00:00Z'))).toBe('LMT');
    expect(name(tz, at('2020-06-01T00:00:00Z'))).toBe('PDT');
    expect(name(tz, at('2020-12-01T00:00:00Z'))).toBe('PST');
    expect(name(tz, at('2026-07-01T00:00:00Z'))).toBe('PDT');
    expect(name(tz, at('2026-12-25T00:00:00Z'))).toBe('PST');
    // 2026's switch is March 8 at 2:00 PST and November 1 at 2:00 PDT.
    expect(name(tz, at('2026-03-08T09:59:59Z'))).toBe('PST');
    expect(name(tz, at('2026-03-08T10:00:00Z'))).toBe('PDT');
    expect(name(tz, at('2026-11-01T08:59:59Z'))).toBe('PDT');
    expect(name(tz, at('2026-11-01T09:00:00Z'))).toBe('PST');
  });

  it('applies footer-only zones with numeric abbreviations', () => {
    const tz = parseTzif(tzif(2, [{ name: '+08', offset: 28800, isDst: false }], [], '<+08>-8'));
    expect(name(tz, at('2026-04-03T14:30:00Z'))).toBe('+08');
  });

  it('flips the rules in the southern hemisphere', () => {
    const tz = parseTzif(
      tzif(
        2,
        [
          { name: 'AEDT', offset: 39600, isDst: true },
          { name: 'AEST', offset: 36000, isDst: false },
        ],
        [[at('2008-04-05T16:00:00Z'), 1]],
        'AEST-10AEDT,M10.1.0,M4.1.0/3',
      ),
    );
    expect(name(tz, at('2026-01-15T00:00:00Z'))).toBe('AEDT');
    expect(name(tz, at('2026-07-15T00:00:00Z'))).toBe('AEST');
    expect(name(tz, at('2026-10-03T15:59:59Z'))).toBe('AEST');
    expect(name(tz, at('2026-10-03T16:00:00Z'))).toBe('AEDT');
  });

  it('reads version 1 files without a footer', () => {
    const tz = parseTzif(
      tzif(
        1,
        [
          { name: 'EST', offset: -18000, isDst: false },
          { name: 'EDT', offset: -14400, isDst: true },
        ],
        [
          [at('2007-03-11T07:00:00Z'), 1],
          [at('2007-11-04T06:00:00Z'), 0],
        ],
      ),
    );
    expect(tz.extend).toBe('');
    expect(name(tz, at('2007-06-01T00:00:00Z'))).toBe('EDT');
    expect(name(tz, at('2026-06-01T00:00:00Z'))).toBe('EST');
  });

  it('rejects malformed data', () => {
    expect(() => parseTzif(new TextEncoder().encode('not a zone file at all, really not'))).toThrow(
      'malformed time zone information',
    );
    expect(() => parseTzif(losAngeles().subarray(0, 60))).toThrow('malformed time zone information');
  });

  it('evaluates POSIX TZ rules like Go tzset', () => {
    const summer = at('2026-07-01T12:00:00Z');
    const winter = at('2026-01-01T12:00:00Z');
    expect(tzset('EST5EDT', summer)?.name).toBe('EDT');
    expect(tzset('EST5EDT', winter)?.name).toBe('EST');
    expect(tzset('CET-1CEST,M3.5.0,M10.5.0/3', summer)?.name).toBe('CEST');
    expect(tzset('IST-2IDT,M3.4.4/26,M10.5.0', summer)?.name).toBe('IDT');
    expect(tzset('XXX3YYY,J60,300', at('2026-06-01T00:00:00Z'))?.name).toBe('YYY');
    expect(tzset('XXX3YYY,J60,300', winter)?.name).toBe('XXX');
    expect(tzset('<-03>3', summer)?.name).toBe('-03');
    expect(tzset('AB5', summer)).toBeNull();
    expect(tzset('EST5EDT,M13.1.0,M11.1.0', summer)).toBeNull();
  });

  it('reads the local zone from $TZ like Go', () => {
    const dir = tempDir();
    const path = join(dir, 'Los_Angeles');
    writeFileSync(path, losAngeles());
    const july = Date.parse('2026-07-01T00:00:00Z');

    vi.stubEnv('TZ', path);
    expect(localZone(july)).toEqual({ name: 'PDT', offset: -25200 });
    expect(localLongDateTime(july)).toBe('June 30, 2026 at 5:00 PM PDT');
    expect(localRfc3339(july / 1000)).toBe('2026-06-30T17:00:00-07:00');
    vi.stubEnv('TZ', `:${path}`);
    expect(localZone(Date.parse('2026-12-01T00:00:00Z'))).toEqual({ name: 'PST', offset: -28800 });
    for (const utc of ['', 'UTC', ':']) {
      vi.stubEnv('TZ', utc);
      expect(localZone(july)).toEqual({ name: 'UTC', offset: 0 });
    }

    // Go falls back to UTC when $TZ names something it cannot load.
    const garbage = join(dir, 'garbage');
    writeFileSync(garbage, 'nope');
    for (const unloadable of [garbage, 'Nonexistent/Zone']) {
      vi.stubEnv('TZ', unloadable);
      expect(localLongDateTime(july)).toBe('July 1, 2026 at 12:00 AM UTC');
    }
  });

  it('defers to the runtime only when there is no zone data at all', () => {
    expect(loadLocalZone(undefined, join(tempDir(), 'missing'))).toBeNull();
    const path = join(tempDir(), 'localtime');
    writeFileSync(path, losAngeles());
    expect(loadLocalZone(undefined, path)).toMatchObject({ extend: 'PST8PDT,M3.2.0,M11.1.0' });
    expect(intlZoneName(Date.parse('2026-07-01T00:00:00Z'))).toMatch(/\S/);
  });

  it('reports offsets alongside names', () => {
    const tz = parseTzif(losAngeles());
    expect(lookupZone(tz, at('1900-01-01T00:00:00Z'))).toEqual({ name: 'LMT', offset: -28378 });
    expect(tzset('<+0530>-5:30', 0)).toEqual({ name: '+0530', offset: 19800 });
    expect(tzset('EST5EDT', at('2026-07-01T12:00:00Z'))).toEqual({ name: 'EDT', offset: -14400 });
  });
});

const hasZoneinfo = existsSync('/usr/share/zoneinfo/America/New_York');

describe('Go time layouts', () => {
  it.runIf(hasZoneinfo)('formats in the local zone with tzdata abbreviations', () => {
    vi.stubEnv('TZ', 'America/New_York');
    const unix = at('2026-01-09T05:04:00Z');
    expect(localDateTime(unix)).toBe('2026-01-09 00:04:00');
    expect(localRfc3339(unix)).toBe('2026-01-09T00:04:00-05:00');
    expect(localLongDateTime(unix * 1000)).toBe('January 9, 2026 at 12:04 AM EST');
    expect(localLongDateTime(Date.parse('2026-07-04T17:30:00Z'))).toBe('July 4, 2026 at 1:30 PM EDT');

    vi.stubEnv('TZ', 'Asia/Singapore');
    expect(localLongDateTime(Date.parse('2026-04-03T14:30:00Z'))).toBe('April 3, 2026 at 10:30 PM +08');
    expect(localRfc3339(at('2026-04-03T14:30:00Z'))).toBe('2026-04-03T22:30:00+08:00');
  });

  it('uses Z for a zero offset and pads small years', () => {
    vi.stubEnv('TZ', 'UTC');
    const unix = at('2026-04-03T14:30:05Z');
    expect(localDateTime(unix)).toBe('2026-04-03 14:30:05');
    expect(localRfc3339(unix)).toBe('2026-04-03T14:30:05Z');
    expect(localLongDateTime(unix * 1000)).toBe('April 3, 2026 at 2:30 PM UTC');
    expect(localLongDateTime(Date.parse('2026-04-03T00:05:00Z'))).toBe('April 3, 2026 at 12:05 AM UTC');
    expect(localDateTime(at('0099-01-01T00:00:00Z'))).toBe('0099-01-01 00:00:00');
  });

  it('formats UTC instants and out-of-range times', () => {
    expect(utcDateTime(new Date(Date.UTC(2026, 3, 1, 12, 30)))).toBe('2026-04-01 12:30:00');
    expect(localDateTime(1e16)).toBe('10000000000000000');
  });

  it('converts nanoseconds by flooring', () => {
    expect(nanosToMillis(1_775_226_600_123_456_789n)).toBe(1_775_226_600_123);
    expect(nanosToMillis(-1n)).toBe(-1);
    expect(nanosToMillis(-1_000_000n)).toBe(-1);
  });
});
