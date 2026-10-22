/**
 * JSON encoding that matches Go's encoding/json byte for byte for the
 * values this app writes: Go additionally escapes <, >, &, U+2028 and
 * U+2029. Those characters can only occur inside string literals in JSON
 * text, so escaping them in the finished output is safe.
 *
 * Object keys are written in insertion order, like Go struct fields; build
 * map-like objects with sorted keys (Go sorts map keys) before encoding.
 */
export function goJSONStringify(value: unknown, indent = ''): string {
  const text = JSON.stringify(value, null, indent);
  return text.replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Returns a copy of `record` with keys sorted the way Go orders map keys. */
export function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(record).sort(compareGoStrings)) {
    sorted[key] = record[key] as T;
  }
  return sorted;
}

/** Go compares strings bytewise (UTF-8), not by UTF-16 code units. */
export function compareGoStrings(a: string, b: string): number {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return Buffer.compare(left, right);
}
