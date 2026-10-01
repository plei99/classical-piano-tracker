/**
 * The local zone the way Go computes it. Go's `MST` layout element prints the
 * abbreviation from the system's TZif data ("PDT", "CST", "+08"), while
 * JavaScript's Intl only offers names like "GMT+8". So this reads the same
 * TZif file Go reads ($TZ, else /etc/localtime) and ports Go's lookup,
 * including the POSIX TZ footer rule used past the last transition. The
 * offset comes from the same data, so the digits always agree with the
 * abbreviation (ICU, for one, does not understand an absolute-path $TZ).
 */
import { readFileSync } from 'node:fs';

/** A zone abbreviation and its offset east of UTC, in seconds. */
export interface ZoneInfo {
  name: string;
  offset: number;
}

interface Zone extends ZoneInfo {
  isDst: boolean;
}

interface Transition {
  /** Unix seconds. */
  when: number;
  index: number;
}

/** A decoded TZif file (Go's Location). */
export interface TzData {
  zones: Zone[];
  transitions: Transition[];
  /** The POSIX TZ footer used for instants after the last transition. */
  extend: string;
}

/** Go's `alpha`: the fake first transition added to transition-less data. */
const ALPHA = -(2 ** 63);
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

class Reader {
  private pos = 0;

  constructor(private readonly data: Uint8Array) {}

  private view(length: number): DataView {
    if (this.pos + length > this.data.length) {
      throw new Error('malformed time zone information');
    }
    const view = new DataView(this.data.buffer, this.data.byteOffset + this.pos, length);
    this.pos += length;
    return view;
  }

  bytes(length: number): Uint8Array {
    const start = this.pos;
    this.view(length);
    return this.data.subarray(start, start + length);
  }

  u8(): number {
    return this.view(1).getUint8(0);
  }

  i32(): number {
    return this.view(4).getInt32(0);
  }

  u32(): number {
    return this.view(4).getUint32(0);
  }

  i64(): number {
    return Number(this.view(8).getBigInt64(0));
  }

  rest(): Uint8Array {
    return this.data.subarray(this.pos);
  }
}

interface Header {
  version: number;
  isutcnt: number;
  isstdcnt: number;
  leapcnt: number;
  timecnt: number;
  typecnt: number;
  charcnt: number;
}

function readHeader(r: Reader): Header {
  const magic = new TextDecoder().decode(r.bytes(4));
  if (magic !== 'TZif') {
    throw new Error('malformed time zone information');
  }
  const versionByte = r.u8();
  const version = versionByte === 0 ? 1 : versionByte - '0'.charCodeAt(0);
  r.bytes(15);
  return {
    version,
    isutcnt: r.u32(),
    isstdcnt: r.u32(),
    leapcnt: r.u32(),
    timecnt: r.u32(),
    typecnt: r.u32(),
    charcnt: r.u32(),
  };
}

function skipData(r: Reader, h: Header, timeSize: number): void {
  r.bytes(
    h.timecnt * timeSize + h.timecnt + h.typecnt * 6 + h.charcnt + h.leapcnt * (timeSize + 4) + h.isstdcnt + h.isutcnt,
  );
}

/** Go's LoadLocationFromTZData: v1 data, or the 64-bit block of v2+ files. */
export function parseTzif(data: Uint8Array): TzData {
  const r = new Reader(data);
  let header = readHeader(r);
  let timeSize = 4;
  if (header.version >= 2) {
    skipData(r, header, 4);
    header = readHeader(r);
    timeSize = 8;
  }
  if (header.typecnt === 0) {
    throw new Error('malformed time zone information');
  }

  const times: number[] = [];
  for (let i = 0; i < header.timecnt; i++) {
    times.push(timeSize === 8 ? r.i64() : r.i32());
  }
  const indices: number[] = [];
  for (let i = 0; i < header.timecnt; i++) {
    indices.push(r.u8());
  }
  const rawZones: { offset: number; isDst: boolean; nameIndex: number }[] = [];
  for (let i = 0; i < header.typecnt; i++) {
    rawZones.push({ offset: r.i32(), isDst: r.u8() !== 0, nameIndex: r.u8() });
  }
  const chars = r.bytes(header.charcnt);
  r.bytes(header.leapcnt * (timeSize + 4) + header.isstdcnt + header.isutcnt);

  const zones = rawZones.map(({ offset, isDst, nameIndex }) => {
    if (nameIndex > chars.length) {
      throw new Error('malformed time zone information');
    }
    const end = chars.indexOf(0, nameIndex);
    const name = new TextDecoder().decode(chars.subarray(nameIndex, end === -1 ? chars.length : end));
    return { name, offset, isDst };
  });

  const transitions = times.map((when, i) => {
    const index = indices[i]!;
    if (index >= zones.length) {
      throw new Error('malformed time zone information');
    }
    return { when, index };
  });
  if (transitions.length === 0) {
    // Go builds a single transition so the footer rule still applies.
    transitions.push({ when: ALPHA, index: 0 });
  }

  let extend = '';
  const rest = r.rest();
  if (header.version >= 2 && rest.length > 2 && rest[0] === 0x0a && rest[rest.length - 1] === 0x0a) {
    extend = new TextDecoder().decode(rest.subarray(1, rest.length - 1));
  }
  return { zones, transitions, extend };
}

/** Go's Location.lookupFirstZone: the zone in effect before the first transition. */
function firstZone(tz: TzData): Zone {
  if (!tz.transitions.some((tx) => tx.index === 0)) {
    return tz.zones[0]!;
  }
  const first = tz.transitions[0];
  if (first !== undefined && tz.zones[first.index]!.isDst) {
    for (let zi = first.index - 1; zi >= 0; zi--) {
      if (!tz.zones[zi]!.isDst) {
        return tz.zones[zi]!;
      }
    }
  }
  return tz.zones.find((zone) => !zone.isDst) ?? tz.zones[0]!;
}

/** The zone in effect at `unixSeconds` (Go's Location.lookup). */
export function lookupZone(tz: TzData, unixSeconds: number): ZoneInfo {
  const tx = tz.transitions;
  if (tx.length === 0 || unixSeconds < tx[0]!.when) {
    const { name, offset } = firstZone(tz);
    return { name, offset };
  }
  let lo = 0;
  let hi = tx.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (unixSeconds < tx[mid]!.when) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  if (lo === tx.length - 1 && tz.extend !== '') {
    const zone = tzset(tz.extend, unixSeconds);
    if (zone !== null) {
      return zone;
    }
  }
  const { name, offset } = tz.zones[tx[lo]!.index]!;
  return { name, offset };
}

// ---- POSIX TZ rules (Go's tzset) ----

interface Rule {
  kind: 'julian' | 'doy' | 'monthWeekDay';
  day: number;
  week: number;
  mon: number;
  /** Seconds after local midnight. */
  time: number;
}

type Parsed<T> = [T, string] | null;

function parseName(s: string): Parsed<string> {
  if (s === '') {
    return null;
  }
  if (s[0] === '<') {
    const end = s.indexOf('>');
    return end === -1 ? null : [s.slice(1, end), s.slice(end + 1)];
  }
  const match = /[0-9,+-]/.exec(s);
  const end = match === null ? s.length : match.index;
  return end < 3 ? null : [s.slice(0, end), s.slice(end)];
}

function parseNum(s: string, min: number, max: number): Parsed<number> {
  const match = /^[0-9]+/.exec(s);
  if (match === null) {
    return null;
  }
  // Go stops as soon as the running value exceeds max.
  let num = 0;
  for (const c of match[0]) {
    num = num * 10 + Number(c);
    if (num > max) {
      return null;
    }
  }
  return num < min ? null : [num, s.slice(match[0].length)];
}

function parseOffset(s: string): Parsed<number> {
  if (s === '') {
    return null;
  }
  let negative = false;
  if (s[0] === '+' || s[0] === '-') {
    negative = s[0] === '-';
    s = s.slice(1);
  }
  const sign = (value: number) => (negative ? -value : value);
  const hours = parseNum(s, 0, 24 * 7);
  if (hours === null) {
    return null;
  }
  let offset = hours[0] * SECONDS_PER_HOUR;
  s = hours[1];
  if (!s.startsWith(':')) {
    return [sign(offset), s];
  }
  const mins = parseNum(s.slice(1), 0, 59);
  if (mins === null) {
    return null;
  }
  offset += mins[0] * 60;
  s = mins[1];
  if (!s.startsWith(':')) {
    return [sign(offset), s];
  }
  const secs = parseNum(s.slice(1), 0, 59);
  if (secs === null) {
    return null;
  }
  return [sign(offset + secs[0]), secs[1]];
}

function parseRule(s: string): Parsed<Rule> {
  let rule: Rule;
  if (s.startsWith('J')) {
    const day = parseNum(s.slice(1), 1, 365);
    if (day === null) {
      return null;
    }
    rule = { kind: 'julian', day: day[0], week: 0, mon: 0, time: 0 };
    s = day[1];
  } else if (s.startsWith('M')) {
    const mon = parseNum(s.slice(1), 1, 12);
    if (mon === null || !mon[1].startsWith('.')) {
      return null;
    }
    const week = parseNum(mon[1].slice(1), 1, 5);
    if (week === null || !week[1].startsWith('.')) {
      return null;
    }
    const day = parseNum(week[1].slice(1), 0, 6);
    if (day === null) {
      return null;
    }
    rule = { kind: 'monthWeekDay', day: day[0], week: week[0], mon: mon[0], time: 0 };
    s = day[1];
  } else {
    const day = parseNum(s, 0, 365);
    if (day === null) {
      return null;
    }
    rule = { kind: 'doy', day: day[0], week: 0, mon: 0, time: 0 };
    s = day[1];
  }
  if (!s.startsWith('/')) {
    rule.time = 2 * SECONDS_PER_HOUR;
    return [rule, s];
  }
  const time = parseOffset(s.slice(1));
  if (time === null) {
    return null;
  }
  rule.time = time[0];
  return [rule, time[1]];
}

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

const DAYS_BEFORE = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];

function daysIn(month: number, year: number): number {
  if (month === 2 && isLeap(year)) {
    return 29;
  }
  return DAYS_BEFORE[month]! - DAYS_BEFORE[month - 1]!;
}

/** Seconds since the start of `year` (UTC) at which `rule` fires (Go's tzruleTime). */
function ruleTime(year: number, rule: Rule, offset: number): number {
  let s = 0;
  switch (rule.kind) {
    case 'julian':
      s = (rule.day - 1) * SECONDS_PER_DAY;
      if (isLeap(year) && rule.day >= 60) {
        s += SECONDS_PER_DAY;
      }
      break;
    case 'doy':
      s = rule.day * SECONDS_PER_DAY;
      break;
    case 'monthWeekDay': {
      // Zeller's congruence gives the weekday of the month's first day.
      const m1 = ((rule.mon + 9) % 12) + 1;
      const yy0 = rule.mon <= 2 ? year - 1 : year;
      const yy1 = Math.trunc(yy0 / 100);
      const yy2 = yy0 % 100;
      let dow = (Math.trunc((26 * m1 - 2) / 10) + 1 + yy2 + Math.trunc(yy2 / 4) + Math.trunc(yy1 / 4) - 2 * yy1) % 7;
      if (dow < 0) {
        dow += 7;
      }
      let d = rule.day - dow;
      if (d < 0) {
        d += 7;
      }
      for (let i = 1; i < rule.week; i++) {
        if (d + 7 >= daysIn(rule.mon, year)) {
          break;
        }
        d += 7;
      }
      d += DAYS_BEFORE[rule.mon - 1]!;
      if (isLeap(year) && rule.mon > 2) {
        d++;
      }
      s = d * SECONDS_PER_DAY;
      break;
    }
  }
  return s + rule.time - offset;
}

/** Go's tzset, reduced to the zone in effect at `sec`; null when the rule is malformed. */
export function tzset(rule: string, sec: number): ZoneInfo | null {
  const std = parseName(rule);
  if (std === null) {
    return null;
  }
  const stdOffsetParsed = parseOffset(std[1]);
  if (stdOffsetParsed === null) {
    return null;
  }
  let [stdName, s] = [std[0], stdOffsetParsed[1]];
  // POSIX offsets are added to local time to get UTC; Go's are the reverse.
  let stdOffset = -stdOffsetParsed[0];
  if (s === '' || s[0] === ',') {
    return { name: stdName, offset: stdOffset };
  }

  const dst = parseName(s);
  if (dst === null) {
    return null;
  }
  let dstName = dst[0];
  s = dst[1];
  let dstOffset: number;
  if (s === '' || s[0] === ',') {
    dstOffset = stdOffset + SECONDS_PER_HOUR;
  } else {
    const parsed = parseOffset(s);
    if (parsed === null) {
      return null;
    }
    dstOffset = -parsed[0];
    s = parsed[1];
  }
  if (s === '') {
    // tzcode's default rules.
    s = ',M3.2.0,M11.1.0';
  }
  if (s[0] !== ',' && s[0] !== ';') {
    return null;
  }
  const start = parseRule(s.slice(1));
  if (start === null || !start[1].startsWith(',')) {
    return null;
  }
  const end = parseRule(start[1].slice(1));
  if (end === null || end[1] !== '') {
    return null;
  }

  const year = new Date(sec * 1000).getUTCFullYear();
  if (Number.isNaN(year)) {
    return null;
  }
  const ysec = sec - Date.UTC(year, 0, 1) / 1000;
  let startSec = ruleTime(year, start[0], stdOffset);
  let endSec = ruleTime(year, end[0], dstOffset);
  if (endSec < startSec) {
    // Southern hemisphere: DST spans the new year, so the labels flip.
    [startSec, endSec] = [endSec, startSec];
    [stdName, dstName] = [dstName, stdName];
    [stdOffset, dstOffset] = [dstOffset, stdOffset];
  }
  return ysec < startSec || ysec >= endSec
    ? { name: stdName, offset: stdOffset }
    : { name: dstName, offset: dstOffset };
}

// ---- The local zone ----

/** Go's platformZoneSources on Unix. */
const ZONE_SOURCES = ['/usr/share/zoneinfo/', '/usr/share/lib/zoneinfo/', '/usr/lib/locale/TZ/', '/etc/zoneinfo/'];

const UTC: ZoneInfo = { name: 'UTC', offset: 0 };

/**
 * Go's initLocal: the TZif data named by $TZ (a path, or a name under the
 * zoneinfo directories), else /etc/localtime. An empty, "UTC", or unloadable
 * $TZ means UTC, as in Go. With $TZ unset and no readable /etc/localtime
 * (Windows, minimal containers) there is nothing to port, so the result is
 * null and callers use the runtime's own local time.
 */
export function loadLocalZone(tz: string | undefined, localtime = '/etc/localtime'): TzData | 'UTC' | null {
  if (tz === undefined) {
    return readTzif([localtime]);
  }
  const name = tz.startsWith(':') ? tz.slice(1) : tz;
  if (name === '' || name === 'UTC') {
    return 'UTC';
  }
  const paths = name.startsWith('/') ? [name] : ZONE_SOURCES.map((dir) => dir + name);
  return readTzif(paths) ?? 'UTC';
}

function readTzif(paths: string[]): TzData | null {
  for (const path of paths) {
    try {
      return parseTzif(readFileSync(path));
    } catch {
      // Try the next source.
    }
  }
  return null;
}

let cached: { tz: string | undefined; zone: TzData | 'UTC' | null } | null = null;

/** The local zone at `ms` (Unix milliseconds), or null when only the runtime knows it. */
export function localZone(ms: number): ZoneInfo | null {
  const tz = process.env['TZ'];
  if (cached === null || cached.tz !== tz) {
    cached = { tz, zone: loadLocalZone(tz) };
  }
  const zone = cached.zone;
  if (zone === 'UTC') {
    return UTC;
  }
  return zone === null ? null : lookupZone(zone, Math.floor(ms / 1000));
}

/** The runtime's abbreviation for its local zone, e.g. "PDT" or "GMT+8". */
export function intlZoneName(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date(ms));
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? 'UTC';
}
