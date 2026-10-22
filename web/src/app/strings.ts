/** String helpers shared by the terminal and web front ends. */

/** Drops the last code point, as Go's utf8.DecodeLastRuneInString-based backspace does. */
export function dropLastRune(value: string): string {
  if (value === '') {
    return value;
  }
  const last = value.charCodeAt(value.length - 1);
  const isLowSurrogate = last >= 0xdc00 && last <= 0xdfff;
  if (isLowSurrogate && value.length >= 2) {
    const prev = value.charCodeAt(value.length - 2);
    if (prev >= 0xd800 && prev <= 0xdbff) {
      return value.slice(0, -2);
    }
  }
  return value.slice(0, -1);
}
