// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Deps } from '../../app/model';
import type { Rating, Track } from '../../core/model';
import { httpDeps } from './deps';
import { keyMessage } from './keys';
import type { EmbedController, IFrameAPI } from './player';
import { WebApp } from './WebApp';

function track(
  id: number,
  name: string,
  lastPlayedAt: number,
  artists = '["Frédéric Chopin","Martha Argerich"]',
): Track {
  return {
    id,
    spotifyId: `spotify${String(id).padStart(15, '0')}`,
    trackName: name,
    albumName: `Album ${id}`,
    artists,
    playCount: id,
    lastPlayedAt,
    createdAt: 1,
  };
}

const tracks = [
  track(1, 'Ballade No. 1 in G Minor', 300),
  track(2, 'Gaspard de la nuit: Scarbo', 200, '["Maurice Ravel","Martha Argerich"]'),
  track(3, 'Partita No. 2: Sinfonia', 100, '["Johann Sebastian Bach","Martha Argerich"]'),
];

function fakeDeps(ratings: Rating[] = []): Deps & { saveRating: ReturnType<typeof vi.fn> } {
  return {
    load: vi.fn(async () => ({ tracks, ratings })),
    sync: vi.fn(async () => ({
      fetched: 1,
      blocked: 0,
      skipped: 0,
      accepted: 1,
      inserted: 1,
      updated: 0,
      alreadySynced: 0,
    })),
    saveRating: vi.fn(async (params) => ({ ...params })),
  };
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
  });

async function renderApp(props: Partial<Parameters<typeof WebApp>[0]> = {}) {
  const deps = props.deps ?? fakeDeps();
  render(<WebApp deps={deps} {...props} />);
  await screen.findByRole('listbox', { name: 'Tracks' });
  return deps;
}

const selectedTitle = () =>
  within(screen.getByRole('listbox', { name: 'Tracks' })).getByRole('option', { selected: true }).textContent;

beforeEach(() => {
  // Album art lookups go to the local server; answer "no art".
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
  );
  localStorage.clear();
  delete document.documentElement.dataset['theme'];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WebApp', () => {
  it('shows the TUI header, list summary, and selected track details', async () => {
    await renderApp();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Classical Piano Tracker');
    expect(screen.getByText('Local track history')).toBeTruthy();
    expect(screen.getByText('3 loaded · sort: recent')).toBeTruthy();
    expect(selectedTitle()).toContain('Ballade No. 1 in G Minor');
    const details = screen.getByRole('region', { name: 'Track details' });
    expect(within(details).getByRole('heading', { level: 2 }).textContent).toBe('Ballade No. 1 in G Minor');
    expect(within(details).getByText('Frédéric Chopin, Martha Argerich')).toBeTruthy();
    expect(within(details).getByText('Rating: none')).toBeTruthy();
  });

  it('moves and sorts with the TUI keys', async () => {
    await renderApp();
    await press('j');
    expect(selectedTitle()).toContain('Scarbo');
    await press('G');
    expect(selectedTitle()).toContain('Partita');
    await press('k');
    expect(selectedTitle()).toContain('Scarbo');
    await press('o');
    expect(screen.getByText('3 loaded · sort: id')).toBeTruthy();
    expect(selectedTitle()).toContain('Scarbo');
  });

  it('selects a track on click and opens the editor on double click', async () => {
    await renderApp();
    fireEvent.click(screen.getByText('Partita No. 2: Sinfonia'));
    expect(selectedTitle()).toContain('Partita');
    fireEvent.doubleClick(screen.getByText('Gaspard de la nuit: Scarbo'));
    expect(screen.getByRole('region', { name: 'Rating editor' })).toBeTruthy();
  });

  it('searches from "/" and applies the filter with Enter', async () => {
    await renderApp();
    await press('/');
    const input = screen.getByRole('searchbox', { name: 'Search tracks' });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'ravel' } });
    expect(screen.getByText('1/3 shown · sort: recent')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Search /ravel_ (1/3)');
    await press('Enter');
    expect(document.activeElement).not.toBe(input);
    expect(screen.getByRole('status').textContent).toBe('Filter /ravel (1/3)');
    await press('Escape');
    expect(screen.getByText('3 loaded · sort: recent')).toBeTruthy();
  });

  it('rates with the TUI focus model: 1-5 sets stars, then type the opinion', async () => {
    const deps = await renderApp();
    await press('e');
    const editor = screen.getByRole('region', { name: 'Rating editor' });
    expect(document.activeElement).toBe(within(editor).getByRole('radiogroup'));
    await press('4');
    expect(within(editor).getByText('Stars: 4/5')).toBeTruthy();
    const opinion = within(editor).getByRole('textbox');
    expect(document.activeElement).toBe(opinion);
    // Digits are text once the opinion has focus.
    fireEvent.change(opinion, { target: { value: 'Op. 23, 1 take' } });
    await press('Enter');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved 4/5 rating for track 1'));
    expect(deps.saveRating).toHaveBeenCalledWith(
      expect.objectContaining({ trackId: 1, stars: 4, opinion: 'Op. 23, 1 take' }),
    );
    expect(screen.getByLabelText('4 out of 5 stars')).toBeTruthy();
  });

  it('starts the opinion when text is typed on the stars field, and Tab switches back', async () => {
    await renderApp();
    await press('e');
    await press('L');
    const editor = screen.getByRole('region', { name: 'Rating editor' });
    const opinion = within(editor).getByRole<HTMLTextAreaElement>('textbox');
    expect(opinion.value).toBe('L');
    expect(document.activeElement).toBe(opinion);
    await press('Tab');
    expect(document.activeElement).toBe(within(editor).getByRole('radiogroup'));
    fireEvent.click(within(editor).getByRole('radio', { name: '2 stars' }));
    expect(within(editor).getByText('Stars: 2/5')).toBeTruthy();
    await press('Escape');
    expect(screen.getByRole('status').textContent).toBe('Rating edit canceled.');
  });

  it('refuses to save without stars, like the TUI', async () => {
    const deps = await renderApp();
    await press('e');
    await press('Enter');
    expect(screen.getByRole('status').textContent).toBe('Error: Choose a star rating from 1 to 5 before saving.');
    expect(deps.saveRating).not.toHaveBeenCalled();
  });

  it('runs footer hints as keys and hides the terminal-only quit hint', async () => {
    const deps = await renderApp();
    const hints = screen.getByRole('list', { name: 'Keyboard shortcuts' });
    expect(within(hints).queryByText('quit')).toBeNull();
    fireEvent.click(within(hints).getByRole('button', { name: /sort/ }));
    expect(screen.getByText('3 loaded · sort: id')).toBeTruthy();
    fireEvent.click(within(hints).getByRole('button', { name: /sync/ }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Sync complete. fetched=1 accepted=1 inserted=1 updated=0'),
    );
    expect(deps.sync).toHaveBeenCalledOnce();
  });

  it('opens the track in the Spotify app and plays it in the page', async () => {
    const openUri = vi.fn();
    const listeners = new Map<string, (arg?: unknown) => void>();
    const controller = {
      listeners,
      loadUri: vi.fn(),
      play: vi.fn(),
      togglePlay: vi.fn(),
      addListener: (event: string, listener: (arg?: unknown) => void) => void listeners.set(event, listener),
    } as unknown as EmbedController & { listeners: typeof listeners };
    const api: IFrameAPI = {
      createController: vi.fn((_element, _options, callback) => callback(controller)),
    };
    await renderApp({ openUri, loadPlayer: async () => api });

    const link = screen.getByRole('link', { name: 'Open in Spotify' });
    expect(link.getAttribute('href')).toBe(`spotify:track:${tracks[0]!.spotifyId}`);
    await press('a');
    expect(openUri).toHaveBeenCalledWith(`spotify:track:${tracks[0]!.spotifyId}`);

    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(api.createController).toHaveBeenCalledOnce());
    expect(vi.mocked(api.createController).mock.calls[0]![1]).toMatchObject({
      uri: `spotify:track:${tracks[0]!.spotifyId}`,
    });
    act(() => controller.listeners.get('ready')?.());
    expect(controller.play).toHaveBeenCalledOnce();
    act(() =>
      controller.listeners.get('playback_update')?.({
        data: { isPaused: false, isBuffering: false, duration: 1, position: 0 },
      }),
    );
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();

    // Another track loads into the same embed.
    await press('j');
    await press('p');
    expect(controller.loadUri).toHaveBeenCalledWith(`spotify:track:${tracks[1]!.spotifyId}`);
    expect(api.createController).toHaveBeenCalledOnce();
  });

  it('switches and remembers the theme, and keys still work after clicking it', async () => {
    await renderApp();
    fireEvent.click(screen.getByLabelText('Dark'));
    screen.getByLabelText('Dark').focus();
    await press('j');
    expect(selectedTitle()).toContain('Scarbo');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(localStorage.getItem('tracker-theme')).toBe('dark');
    fireEvent.click(screen.getByLabelText('Auto'));
    expect(document.documentElement.dataset['theme']).toBeUndefined();
    expect(localStorage.getItem('tracker-theme')).toBeNull();
  });

  it('reports a load failure with a retry', async () => {
    const deps = fakeDeps();
    deps.load = vi
      .fn()
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockResolvedValue({ tracks, ratings: [] });
    render(<WebApp deps={deps} />);
    expect(await screen.findByText('Error: database is locked')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('3 loaded · sort: recent')).toBeTruthy();
  });
});

describe('keyMessage', () => {
  const ev = (key: string, mods: Partial<KeyboardEvent> = {}) =>
    keyMessage({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

  it('names keys the way the model expects', () => {
    expect(ev('j')).toEqual({ type: 'key', key: 'j', text: 'j' });
    expect(ev('G', { shiftKey: true })).toEqual({ type: 'key', key: 'G', text: 'G' });
    expect(ev('Enter')?.key).toBe('enter');
    expect(ev('Escape')?.key).toBe('esc');
    expect(ev('Tab', { shiftKey: true })?.key).toBe('shift+tab');
    expect(ev('u', { ctrlKey: true })).toEqual({ type: 'key', key: 'ctrl+u', text: '' });
    expect(ev(' ')).toEqual({ type: 'key', key: 'space', text: ' ' });
    expect(ev('é')?.text).toBe('é');
  });

  it('leaves modifiers and browser shortcuts alone', () => {
    expect(ev('Shift')).toBeNull();
    expect(ev('r', { metaKey: true })).toBeNull();
    expect(ev('F5')).toBeNull();
  });
});

describe('httpDeps', () => {
  it('sends the page token on writes and surfaces server errors', async () => {
    const fetcher = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'stars must be between 1 and 5' }), { status: 400 });
      }
      return new Response(JSON.stringify({ tracks: [], ratings: [] }), { status: 200 });
    });
    const deps = httpDeps('secret', fetcher as typeof fetch);
    await expect(deps.load()).resolves.toEqual({ tracks: [], ratings: [] });
    await expect(deps.saveRating({ trackId: 1, stars: 9, opinion: '', updatedAt: 1 })).rejects.toThrow(
      'stars must be between 1 and 5',
    );
    const init = fetcher.mock.calls[1]![1]!;
    expect(new Headers(init.headers).get('X-Tracker-Token')).toBe('secret');
    expect(init.body).toBe(JSON.stringify({ trackId: 1, stars: 9, opinion: '', updatedAt: 1 }));
  });
});
