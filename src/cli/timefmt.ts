/**
 * The Go time layouts used in CLI output. Unix times are rendered in the
 * local zone, matching Go's `time.Unix(...).Format(...)`: the zone (offset
 * and abbreviation) comes from the TZif data Go reads, see tzif.ts.
 */
import { intlZoneName, localZone } from './tzif';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const pad2 = (value: number) => String(value).padStart(2, '0');

/** Go prints years as at least four digits. */
const year4 = (value: number) => (value < 0 ? `-${String(-value).padStart(4, '0')}` : String(value).padStart(4, '0'));

interface Fields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** A local wall-clock reading: its fields, UTC offset in seconds, and zone abbreviation. */
interface Local extends Fields {
  offset: number;
  zone: string;
}

function local(date: Date): Local {
  const ms = date.getTime();
  const zone = localZone(ms);
  if (zone === null) {
    // No TZif data to port (e.g. Windows): use the runtime's local time.
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
      offset: -date.getTimezoneOffset() * 60,
      zone: intlZoneName(ms),
    };
  }
  return { ...utcFields(new Date(ms + zone.offset * 1000)), offset: zone.offset, zone: zone.name };
}

function utcFields(date: Date): Fields {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function dateTime(f: Fields): string {
  return `${year4(f.year)}-${pad2(f.month + 1)}-${pad2(f.day)} ${pad2(f.hour)}:${pad2(f.minute)}:${pad2(f.second)}`;
}

/** Times outside JavaScript's Date range print as the raw number instead of throwing. */
function toDate(ms: number): Date | null {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Unix seconds as Go's "2006-01-02 15:04:05" in the local zone. */
export function localDateTime(unixSeconds: number): string {
  const date = toDate(unixSeconds * 1000);
  return date === null ? String(unixSeconds) : dateTime(local(date));
}

/** A UTC instant as "2006-01-02 15:04:05" (Go's Format on a UTC time.Time). */
export function utcDateTime(date: Date): string {
  return Number.isNaN(date.getTime()) ? String(date.getTime()) : dateTime(utcFields(date));
}

/** Go's time.RFC3339 ("2006-01-02T15:04:05Z07:00") in the local zone. */
export function localRfc3339(unixSeconds: number): string {
  const date = toDate(unixSeconds * 1000);
  if (date === null) {
    return String(unixSeconds);
  }
  const f = local(date);
  const base = `${year4(f.year)}-${pad2(f.month + 1)}-${pad2(f.day)}T${pad2(f.hour)}:${pad2(f.minute)}:${pad2(f.second)}`;
  if (f.offset === 0) {
    return `${base}Z`;
  }
  // Go truncates offsets to whole minutes here.
  const minutes = Math.abs(Math.trunc(f.offset / 60));
  return `${base}${f.offset < 0 ? '-' : '+'}${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

/** Go's "January 2, 2006 at 3:04 PM MST" in the local zone. */
export function localLongDateTime(ms: number): string {
  const date = toDate(ms);
  if (date === null) {
    return String(ms);
  }
  const f = local(date);
  const hour12 = f.hour % 12 === 0 ? 12 : f.hour % 12;
  const meridiem = f.hour < 12 ? 'AM' : 'PM';
  return `${MONTHS[f.month]} ${f.day}, ${year4(f.year)} at ${hour12}:${pad2(f.minute)} ${meridiem} ${f.zone}`;
}

/** Unix nanoseconds to milliseconds, flooring like Go's time.Unix(0, ns). */
export function nanosToMillis(nanos: bigint): number {
  const ms = nanos / 1_000_000n;
  return Number(nanos < 0n && ms * 1_000_000n !== nanos ? ms - 1n : ms);
}
