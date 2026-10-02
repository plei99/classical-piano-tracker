// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Deps } from '../../app/model';
import { NO_TRACKS_TEXT } from '../../app/presenter';
import { SERVER_STOPPED_TEXT, STOPPED_NOTICE_DELAY_MS, watchPresence, type PresenceStream } from './presence';
import { WebApp } from './WebApp';

/** An EventSource the test opens, fails, and recovers by hand. */
class FakeStream implements PresenceStream {
  readyState = 0;
  private readonly listeners: Record<string, (() => void)[]> = {};

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: () => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  emit(type: 'open' | 'error', readyState: number): void {
    this.readyState = readyState;
    for (const listener of this.listeners[type] ?? []) listener();
  }
}

function watch(): { stream: FakeStream; presence: ReturnType<typeof watchPresence> } {
  let stream!: FakeStream;
  const presence = watchPresence('tok/en', (url) => (stream = new FakeStream(url)));
  return { stream, presence };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

describe('presence', () => {
  it('is opened at page start, before the library request', async () => {
    const opened: string[] = [];
    vi.stubGlobal(
      'EventSource',
      class extends FakeStream {
        constructor(url: string) {
          super(url);
          opened.push(`presence ${url}`);
        }
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        opened.push(`fetch ${path}`);
        return new Response('{"tracks":[],"ratings":[]}', { headers: { 'Content-Type': 'application/json' } });
      }),
    );
    document.head.innerHTML = '<meta name="tracker-token" content="abc123">';
    document.body.innerHTML = '<div id="root"></div>';

    await act(async () => {
      await import('./main');
    });
    await screen.findByText(NO_TRACKS_TEXT);

    expect(opened[0]).toBe('presence /api/presence?token=abc123');
    expect(opened).toContain('fetch /api/library');
  });

  it('reports the server stopped once the stream has been down for a second', () => {
    vi.useFakeTimers();
    const { stream, presence } = watch();
    const changes = vi.fn();
    presence.subscribe(changes);
    expect(stream.url).toBe('/api/presence?token=tok%2Fen');

    stream.emit('open', 1);
    stream.emit('error', 0);
    vi.advanceTimersByTime(STOPPED_NOTICE_DELAY_MS - 1);
    expect(presence.serverStopped()).toBe(false);
    // A failed reconnect does not restart the wait.
    stream.emit('error', 0);
    vi.advanceTimersByTime(1);
    expect(presence.serverStopped()).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);

    stream.emit('open', 1);
    expect(presence.serverStopped()).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('ignores a blip that reconnects within the delay', () => {
    vi.useFakeTimers();
    const { stream, presence } = watch();
    stream.emit('error', 0);
    vi.advanceTimersByTime(STOPPED_NOTICE_DELAY_MS / 2);
    stream.emit('open', 1);
    vi.advanceTimersByTime(STOPPED_NOTICE_DELAY_MS * 2);
    expect(presence.serverStopped()).toBe(false);
  });

  it('shows and clears the notice in the footer status line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
    );
    const deps: Deps = {
      load: async () => ({ tracks: [], ratings: [] }),
      sync: vi.fn(),
      saveRating: vi.fn(),
    };
    const { stream, presence } = watch();
    render(<WebApp deps={deps} presence={presence} />);
    const status = await screen.findByRole('status');
    expect([status.className, status.textContent]).toEqual(['status', '']);

    vi.useFakeTimers();
    act(() => {
      stream.emit('error', 2);
      vi.advanceTimersByTime(STOPPED_NOTICE_DELAY_MS);
    });
    expect(status.outerHTML).toBe(
      `<p class="status status--error" role="status" aria-live="polite">${SERVER_STOPPED_TEXT}</p>`,
    );
    expect(SERVER_STOPPED_TEXT).toBe('tracker web has stopped. Run tracker web again to reopen this page.');

    act(() => stream.emit('open', 1));
    expect([status.className, status.textContent]).toEqual(['status', '']);
  });
});
