/**
 * The page's presence stream (API.presence): while it is open the server
 * knows this tab is still using it, and when it fails for good the server
 * has stopped, which the footer then says.
 */
import { API, PRESENCE_TOKEN_PARAM } from '../api';

export const SERVER_STOPPED_TEXT = 'tracker web has stopped. Run tracker web again to reopen this page.';

/** How long the stream may stay down before the page says so, so a reconnect blip does not flash the notice. */
export const STOPPED_NOTICE_DELAY_MS = 1000;

/** EventSource.OPEN, which test environments without EventSource lack. */
const OPEN = 1;

export interface Presence {
  /** True while the stream has been down for STOPPED_NOTICE_DELAY_MS or more. */
  serverStopped(): boolean;
  subscribe(listener: () => void): () => void;
}

/** The part of EventSource used here, so tests can drive it. */
export interface PresenceStream {
  readonly readyState: number;
  addEventListener(type: 'open' | 'error', listener: () => void): void;
}

export function presenceUrl(token: string): string {
  return `${API.presence}?${PRESENCE_TOKEN_PARAM}=${encodeURIComponent(token)}`;
}

/** Opens the stream and keeps it for the life of the page. */
export function watchPresence(
  token: string,
  open: (url: string) => PresenceStream = (url) => new EventSource(url),
): Presence {
  const listeners = new Set<() => void>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const set = (value: boolean): void => {
    if (stopped === value) return;
    stopped = value;
    for (const listener of listeners) listener();
  };

  const stream = open(presenceUrl(token));
  stream.addEventListener('open', () => {
    clearTimeout(timer);
    timer = undefined;
    set(false);
  });
  // EventSource retries on its own; give it a moment before calling the server gone.
  stream.addEventListener('error', () => {
    timer ??= setTimeout(() => {
      timer = undefined;
      if (stream.readyState !== OPEN) set(true);
    }, STOPPED_NOTICE_DELAY_MS);
  });

  return {
    serverStopped: () => stopped,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
