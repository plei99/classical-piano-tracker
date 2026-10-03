/**
 * Go `context` error equivalents for AbortSignal-based cancellation.
 *
 * Go code distinguishes a deadline (`context deadline exceeded`) from an
 * explicit cancellation (`context canceled`), and both texts reach users in
 * error messages. An AbortSignal created by `AbortSignal.timeout` aborts with
 * a "TimeoutError" DOMException, which maps to the deadline error; any other
 * abort maps to cancellation.
 */

export class DeadlineExceededError extends Error {
  constructor() {
    super('context deadline exceeded');
    this.name = 'DeadlineExceededError';
  }
}

export class CanceledError extends Error {
  constructor() {
    super('context canceled');
    this.name = 'CanceledError';
  }
}

function isTimeoutReason(reason: unknown): boolean {
  return (
    reason instanceof DeadlineExceededError ||
    (typeof reason === 'object' && reason !== null && (reason as { name?: unknown }).name === 'TimeoutError')
  );
}

/** The Go context error for an aborted signal (`ctx.Err()`). */
export function contextError(signal: AbortSignal): Error {
  return isTimeoutReason(signal.reason) ? new DeadlineExceededError() : new CanceledError();
}

/**
 * Combines the caller's signal with a timeout, like `context.WithTimeout`.
 * A non-positive timeout leaves the caller's signal unchanged.
 */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  if (timeoutMs <= 0) {
    return signal;
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** Go's `errors.Is` for cause chains: whether `err` or any cause matches. */
export function errorChainIncludes(err: unknown, predicate: (candidate: unknown) => boolean): boolean {
  const seen = new Set<unknown>();
  for (let current: unknown = err; current !== undefined && current !== null && !seen.has(current);) {
    if (predicate(current)) {
      return true;
    }
    seen.add(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/** Resolves when the signal aborts (never, without a signal). */
export function aborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined) {
      return;
    }
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}
