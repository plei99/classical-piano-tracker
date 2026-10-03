/**
 * Go `strings` package semantics that differ from the JavaScript built-ins.
 *
 * Go's notion of whitespace (unicode.IsSpace) includes U+0085 but not U+FEFF,
 * the reverse of JavaScript's `\s`, and Go lowercases rune by rune without
 * the context-sensitive (final sigma) or multi-character mappings of
 * `String.prototype.toLowerCase`. Names and LLM output pass through these
 * helpers so matching and trimming behave exactly as in the Go build.
 */

const GO_SPACE = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const LEADING_SPACE = new RegExp(`^[${GO_SPACE}]+`);
const TRAILING_SPACE = new RegExp(`[${GO_SPACE}]+$`);
const SPACE_RUNS = new RegExp(`[${GO_SPACE}]+`);

/** Go's `strings.TrimSpace`. */
export function goTrimSpace(text: string): string {
  return text.replace(LEADING_SPACE, '').replace(TRAILING_SPACE, '');
}

/** Go's `strings.Fields`: splits around runs of Unicode whitespace. */
export function goFields(text: string): string[] {
  const trimmed = goTrimSpace(text);
  return trimmed === '' ? [] : trimmed.split(SPACE_RUNS);
}

/** Go's `strings.ToLower`: simple per-rune mapping. */
export function goToLower(text: string): string {
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    // Multi-rune mappings (e.g. U+0130) keep only the first rune, which is
    // what unicode.ToLower returns for them.
    out += String.fromCodePoint(lower.codePointAt(0) ?? 0);
  }
  return out;
}

/** Go's `strings.TrimLeft(text, cutset)`. */
export function goTrimLeft(text: string, cutset: string): string {
  let start = 0;
  const chars = [...text];
  while (start < chars.length && cutset.includes(chars[start] as string)) {
    start++;
  }
  return chars.slice(start).join('');
}

/** Go's `strings.TrimPrefix`. */
export function trimPrefix(text: string, prefix: string): string {
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/** Go's `strings.TrimSuffix`. */
export function trimSuffix(text: string, suffix: string): string {
  return suffix !== '' && text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}

/** Go's `strings.TrimRight(text, cutset)` for a single-character cutset. */
export function trimRightChar(text: string, char: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === char) {
    end--;
  }
  return text.slice(0, end);
}

/**
 * Case folding for one rune, close to Go's unicode.SimpleFold orbits: two
 * runes fold together when they share an upper-then-lower mapping (so the
 * long s and Kelvin sign fold to "s" and "k", as in Go).
 */
function foldRune(ch: string): string {
  const upper = ch.toUpperCase();
  const base = [...upper].length === 1 ? upper : ch;
  const lower = base.toLowerCase();
  return [...lower].length === 1 ? lower : ch;
}

/** Go's `strings.EqualFold`. */
export function goEqualFold(a: string, b: string): boolean {
  const left = [...a];
  const right = [...b];
  if (left.length !== right.length) {
    return false;
  }
  return left.every((ch, idx) => ch === right[idx] || foldRune(ch) === foldRune(right[idx] as string));
}

/** Go's `len(s)`: the UTF-8 byte length. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
