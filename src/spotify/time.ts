/**
 * Exact RFC 3339 parsing into Unix nanoseconds. The sync checkpoint is the
 * Go build's `time.Time.UnixNano()` of Spotify's `played_at`, so it must be
 * computed without passing through Date's millisecond precision, or a play
 * at e.g. `12:00:00.123456Z` would compare unequal to what Go stored.
 */
import { quote } from '../core/errors';

const NS_PER_SECOND = 1_000_000_000n;
const NS_PER_MS = 1_000_000n;

/**
 * The grammar of Go's RFC 3339 fast path (`time.parseRFC3339`), which is
 * what `time.Time.UnmarshalJSON` applies to Spotify's timestamps.
 */
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysIn(month: number, year: number): number {
  if (month === 2) {
    return isLeap(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Days since 1970-01-01 for a proleptic Gregorian date (Hinnant's algorithm). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/**
 * Parses RFC 3339 text into Unix nanoseconds. Like Go, fractional digits
 * beyond nanoseconds are truncated, and out-of-range fields are rejected.
 */
export function parseRfc3339Ns(text: string): bigint {
  const match = RFC3339.exec(text);
  const fail = (): never => {
    throw new Error(`parsing time ${quote(text)} as "2006-01-02T15:04:05Z07:00": cannot parse`);
  };
  if (match === null) {
    return fail();
  }
  const field = (index: number): number => Number(match[index] ?? '0');
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map(field) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || day > daysIn(month, year) || hour > 23 || minute > 59 || second > 59) {
    return fail();
  }

  let offsetSeconds = 0;
  if (match[8] === undefined) {
    const offsetHours = field(10);
    const offsetMinutes = field(11);
    if (offsetHours > 23 || offsetMinutes > 59) {
      return fail();
    }
    offsetSeconds = (offsetHours * 60 + offsetMinutes) * 60 * (match[9] === '-' ? -1 : 1);
  }

  const fraction = (match[7] ?? '').slice(0, 9).padEnd(9, '0');
  const seconds = daysFromCivil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offsetSeconds;
  return BigInt(seconds) * NS_PER_SECOND + BigInt(fraction);
}

/** Floor division, matching Go's `Unix()` for instants before 1970 too. */
function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  return value % divisor < 0n ? quotient - 1n : quotient;
}

/** Go's `time.Unix()`: whole seconds since the epoch. */
export function unixSeconds(ns: bigint): number {
  return Number(floorDiv(ns, NS_PER_SECOND));
}

/** The millisecond Date for display; `ns` stays the source of truth. */
export function dateFromNs(ns: bigint): Date {
  return new Date(Number(floorDiv(ns, NS_PER_MS)));
}
