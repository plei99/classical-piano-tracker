/**
 * Go-style error wrapping: `wrap('read config "x"', err)` produces
 * `read config "x": <cause message>`, keeping the cause for inspection.
 * Command errors print as a single line, as they did in the Go build.
 */
export function wrap(context: string, cause: unknown): Error {
  return new Error(`${context}: ${errorMessage(cause)}`, { cause });
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Go's `%q` for plain strings: a double-quoted, escaped literal. */
export function quote(value: string): string {
  return JSON.stringify(value);
}
