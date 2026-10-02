// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Rating } from '../../core/model';
import { ArtworkStore } from './artwork';
import { httpDeps } from './deps';
import { initialModel, readInitialData } from './initial';
import { keyMessage } from './keys';
import type { EmbedController, IFrameAPI } from './player';
import { fakeServer, manyTracks, pageParts, track, type FakeServer } from './testkit';
import { renderedTheme } from './theme';
import { WebRoot, type WebAppProps } from './WebApp';

const tracks = [
  track(1, 'Ballade No. 1 in G Minor', 300),
  track(2, 'Gaspard de la nuit: Scarbo', 200, '["Maurice Ravel","Martha Argerich"]'),
  track(3, 'Partita No. 2: Sinfonia', 100, '["Johann Sebastian Bach","Martha Argerich"]'),
];

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
  });

/** Lets fetches resolve and their messages render. */
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

interface Rendered {
  server: FakeServer;
  deps: ReturnType<typeof httpDeps>;
}

/** Renders the app as the page would start: from the server's initial data, over the fake server. */
function renderApp({
  server = fakeServer(tracks),
  props = {},
  initial = server.initial(),
}: { server?: FakeServer; props?: Partial<WebAppProps>; initial?: ReturnType<FakeServer['initial']> } = {}): Rendered {
  const store = new ArtworkStore(server.fetch, 0);
  const deps = httpDeps('secret', { fetcher: server.fetch, store });
  if ('view' in initial) store.seed(initial.view.rows);
  render(<WebRoot store={store} deps={deps} initialModel={initialModel(initial, deps)} {...props} />);
  return { server, deps };
}

const listbox = () => screen.getByRole('listbox', { name: 'Tracks' });
const selected = () => within(listbox()).getByRole('option', { selected: true });
const selectedTitle = () => selected().textContent;
const summary = () => screen.getByRole('heading', { name: 'Tracks' }).nextElementSibling?.textContent;
const placeholders = () => listbox().querySelectorAll('.row--placeholder').length;
/** Requests other than album art, which the visible rows ask for on their own. */
const apiRequests = (server: FakeServer) =>
  server.requests.filter((request) => !request.startsWith('GET /api/artwork'));

beforeEach(() => {
  document.cookie = 'tracker-theme=; Max-Age=0; Path=/';
  delete document.documentElement.dataset['theme'];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WebApp', () => {
  it('shows the TUI header, list summary, and selected track details', () => {
    renderApp();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Classical Piano Tracker');
    expect(screen.getByText('Local track history')).toBeTruthy();
    expect(summary()).toBe('3 loaded · sort: recent');
    expect(selectedTitle()).toContain('Ballade No. 1 in G Minor');
    const details = screen.getByRole('region', { name: 'Track details' });
    expect(within(details).getByRole('heading', { level: 2 }).textContent).toBe('Ballade No. 1 in G Minor');
    expect(within(details).getByText('Frédéric Chopin, Martha Argerich')).toBeTruthy();
    expect(within(details).getByText('Rating: none')).toBeTruthy();
  });

  it('moves with the TUI keys, and sorts on the server keeping the selection', async () => {
    const { server } = renderApp();
    await press('j');
    expect(selectedTitle()).toContain('Scarbo');
    await press('G');
    expect(selectedTitle()).toContain('Partita');
    await press('k');
    expect(selectedTitle()).toContain('Scarbo');
    expect(server.views()).toHaveLength(0);
    await press('o');
    await waitFor(() => expect(summary()).toBe('3 loaded · sort: id'));
    expect(selectedTitle()).toContain('Scarbo');
    const request = server.views()[0]!;
    expect([request.get('sort'), request.get('q'), request.get('around')]).toEqual(['idAsc', '', '2']);
  });

  it('selects a track on click and opens the editor on double click', () => {
    renderApp();
    fireEvent.click(screen.getByText('Partita No. 2: Sinfonia'));
    expect(selectedTitle()).toContain('Partita');
    fireEvent.doubleClick(screen.getByText('Gaspard de la nuit: Scarbo'));
    expect(screen.getByRole('region', { name: 'Rating editor' })).toBeTruthy();
  });

  it('searches from "/" on the server and applies the filter with Enter', async () => {
    renderApp();
    await press('/');
    const input = screen.getByRole('searchbox', { name: 'Search tracks' });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'ravel' } });
    // The field shows the typing at once; the counts follow the server's answer.
    expect(input).toHaveProperty('value', 'ravel');
    await waitFor(() => expect(summary()).toBe('1/3 shown · sort: recent'));
    expect(screen.getByRole('status').textContent).toBe('Search /ravel_ (1/3)');
    await press('Enter');
    expect(document.activeElement).not.toBe(input);
    expect(screen.getByRole('status').textContent).toBe('Filter /ravel (1/3)');
    await press('Escape');
    await waitFor(() => expect(summary()).toBe('3 loaded · sort: recent'));
  });

  it('rates with the TUI focus model: 1-5 sets stars, then type the opinion', async () => {
    const { server } = renderApp();
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
    expect(server.ratings).toEqual([expect.objectContaining({ trackId: 1, stars: 4, opinion: 'Op. 23, 1 take' })]);
    expect(screen.getByLabelText('4 out of 5 stars')).toBeTruthy();
  });

  it('starts the opinion when text is typed on the stars field, and Tab switches back', async () => {
    renderApp();
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
    const { server } = renderApp();
    await press('e');
    await press('Enter');
    expect(screen.getByRole('status').textContent).toBe('Error: Choose a star rating from 1 to 5 before saving.');
    expect(server.requests.filter((request) => request.startsWith('POST'))).toEqual([]);
  });

  it('runs footer hints as keys and hides the terminal-only quit hint', async () => {
    const server = fakeServer(tracks);
    server.sync = vi.fn(async () => {
      server.tracks = [...server.tracks, track(4, 'Kreisleriana', 400)];
      return { fetched: 1, blocked: 0, skipped: 0, accepted: 1, inserted: 1, updated: 0, alreadySynced: 0 };
    });
    renderApp({ server });
    const hints = screen.getByRole('list', { name: 'Keyboard shortcuts' });
    expect(within(hints).queryByText('quit')).toBeNull();
    fireEvent.click(within(hints).getByRole('button', { name: /sort/ }));
    await waitFor(() => expect(summary()).toBe('3 loaded · sort: id'));
    fireEvent.click(within(hints).getByRole('button', { name: /sync/ }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Sync complete. fetched=1 accepted=1 inserted=1 updated=0'),
    );
    expect(server.sync).toHaveBeenCalledOnce();
    // The server reloaded after the sync; the page asks again, without a second reload.
    await waitFor(() => expect(summary()).toBe('4 loaded · sort: id'));
    expect(server.requests.filter((request) => request.startsWith('POST'))).toEqual(['POST /api/sync']);
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
    renderApp({ props: { openUri, loadPlayer: async () => api } });

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

  it('switches the theme and remembers it in a cookie, and keys still work after clicking it', async () => {
    renderApp({ props: { initialTheme: 'light' } });
    expect(screen.getByLabelText<HTMLInputElement>('Light').checked).toBe(true);
    fireEvent.click(screen.getByLabelText('Dark'));
    screen.getByLabelText('Dark').focus();
    await press('j');
    expect(selectedTitle()).toContain('Scarbo');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(document.cookie).toContain('tracker-theme=dark');
    fireEvent.click(screen.getByLabelText('Auto'));
    expect(document.documentElement.dataset['theme']).toBeUndefined();
    expect(document.cookie).toContain('tracker-theme=auto');
  });

  it('reports a library the server could not read, with a retry that reloads it', async () => {
    const server = fakeServer(tracks);
    server.failReload = 'database is locked';
    renderApp({ server, initial: { error: 'database is locked' } });
    expect(screen.getByText('Error: database is locked')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Error: database is locked')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(summary()).toBe('3 loaded · sort: recent'));
    expect(server.requests.filter((request) => request.startsWith('POST'))).toEqual([
      'POST /api/reload',
      'POST /api/reload',
    ]);
  });
});

describe('windowed list', () => {
  it('moves within loaded rows without touching the network', async () => {
    const { server } = renderApp({ server: fakeServer(manyTracks(1000)) });
    expect(summary()).toBe('1000 loaded · sort: recent');
    for (let i = 0; i < 30; i++) {
      await press('j');
    }
    expect(selectedTitle()).toContain('Etude 970');
    await press('k');
    await press('g');
    expect(selectedTitle()).toContain('Etude 1000');
    expect(apiRequests(server)).toEqual([]);
  });

  it('fetches the next chunk before the selection reaches it', async () => {
    const { server } = renderApp({ server: fakeServer(manyTracks(1000)) });
    let presses = 0;
    while (server.views().length === 0 && presses < 100) {
      await press('j');
      presses++;
    }
    // Requested well ahead of the edge of the first 100 rows.
    expect(presses).toBeLessThan(95);
    expect([server.views()[0]?.get('offset'), server.views()[0]?.get('limit')]).toEqual(['100', '100']);
    await settle();
    while (presses < 110) {
      await press('j');
      presses++;
      expect(placeholders()).toBe(0);
    }
    expect(selectedTitle()).toContain('Etude 890');
  });

  it('draws placeholders for rows on their way, then fills them in', async () => {
    const server = fakeServer(manyTracks(1000));
    const hold = server.hold((url) => url.pathname === '/api/view');
    renderApp({ server });
    await press('G');
    await waitFor(() => expect(hold.held()).toBeGreaterThan(0));
    const pending = within(listbox()).getByRole('option', { selected: true });
    expect(pending.className).toBe('row row--placeholder');
    expect(pending.getAttribute('aria-busy')).toBe('true');
    expect(pending.getAttribute('style')).toBe(`transform: translateY(${999 * 60}px);`);
    expect(screen.getByRole('region', { name: 'Track details' }).getAttribute('aria-busy')).toBe('true');
    hold.release();
    await waitFor(() => expect(selectedTitle()).toContain('Etude 1'));
    expect(selected().getAttribute('style')).toBe(`transform: translateY(${999 * 60}px);`);
    expect(placeholders()).toBe(0);
    expect(server.views().map((params) => params.get('offset'))).toContain('900');
  });

  it('shows the latest search even when an older answer arrives last', async () => {
    const server = fakeServer([...tracks, track(4, 'Gaspard: Ondine', 50, '["Maurice Ravel","Ivo Pogorelich"]')]);
    renderApp({ server });
    await press('/');
    const input = screen.getByRole('searchbox', { name: 'Search tracks' });
    const hold = server.hold((url) => url.searchParams.get('q') === 'r');
    fireEvent.change(input, { target: { value: 'r' } });
    await waitFor(() => expect(hold.held()).toBe(1));
    fireEvent.change(input, { target: { value: 'ravel' } });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Search /ravel_ (2/4)'));
    hold.release();
    await settle();
    expect(screen.getByRole('status').textContent).toBe('Search /ravel_ (2/4)');
    expect(summary()).toBe('2/4 shown · sort: recent');
  });

  it('keeps the selected track through sorts and searches, even outside the loaded rows', async () => {
    const server = fakeServer(manyTracks(1000));
    renderApp({ server });
    await press('j');
    await press('j');
    expect(selectedTitle()).toContain('Etude 998');
    // In id order, track 998 sits at position 997, far beyond the first window.
    await press('o');
    await waitFor(() => expect(summary()).toBe('1000 loaded · sort: id'));
    expect(selectedTitle()).toContain('Etude 998');
    expect(selected().getAttribute('style')).toBe(`transform: translateY(${997 * 60}px);`);
    // Still matched: kept. Filtered out: the top, as in the TUI.
    await press('/');
    const input = screen.getByRole('searchbox', { name: 'Search tracks' });
    fireEvent.change(input, { target: { value: 'etude 99' } });
    await waitFor(() => expect(summary()).toBe('11/1000 shown · sort: id'));
    expect(selectedTitle()).toContain('Etude 998');
    fireEvent.change(input, { target: { value: 'etude 5' } });
    await waitFor(() => expect(summary()).toBe('111/1000 shown · sort: id'));
    expect(selectedTitle()).toContain('Etude 5');
    expect(selected().getAttribute('style')).toBe('transform: translateY(0px);');
  });

  it('shows a saved rating at once and refetches quietly when the library version moves on', async () => {
    const server = fakeServer(manyTracks(1000));
    renderApp({ server });
    await press('e');
    await press('5');
    await press('Enter');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved 5/5 rating for track 1000'));
    expect(screen.getByLabelText('5 out of 5 stars')).toBeTruthy();
    expect(server.views()).toHaveLength(0);

    // The next chunk comes from the new version: the page refetches around the
    // selection, keeping the rows it has on screen meanwhile.
    const hold = server.hold((url) => url.searchParams.has('around'));
    for (let i = 0; i < 90 && server.views().length === 0; i++) {
      await press('j');
    }
    await waitFor(() => expect(hold.held()).toBe(1));
    const title = selectedTitle();
    expect(placeholders()).toBe(0);
    const refetch = server.views().find((params) => params.has('around'))!;
    expect(refetch.get('around')).toBe(/Etude (\d+)/.exec(title ?? '')?.[1]);
    hold.release();
    await settle();
    expect(selectedTitle()).toBe(title);
    expect(placeholders()).toBe(0);
  });

  it('re-sorts unrated-first after a save, following the rated track', async () => {
    const ratings: Rating[] = [{ trackId: 999, stars: 3, opinion: '', updatedAt: 1 }];
    const server = fakeServer(manyTracks(5), ratings);
    renderApp({ server });
    for (let i = 0; i < 3; i++) {
      await press('o');
      await settle();
    }
    expect(summary()).toBe('5 loaded · sort: unrated first');
    expect(selectedTitle()).toContain('Etude 5');
    await press('e');
    await press('4');
    await press('Enter');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved 4/5 rating for track 5'));
    await waitFor(() => expect(selected().getAttribute('style')).toBe(`transform: translateY(${4 * 60}px);`));
    expect(selectedTitle()).toContain('Etude 5');
  });
});

describe('hydration', () => {
  it('attaches to the server-rendered page without mismatches', async () => {
    const server = fakeServer(manyTracks(40), [{ trackId: 40, stars: 4, opinion: 'Crisp', updatedAt: 1_700_000_000 }]);
    const { head, body } = pageParts(server.initial(), 'dark');
    // Without the stylesheet and script, which the test environment would try to fetch.
    document.head.innerHTML = head.replace(/<link[^>]*>|<script[^>]*><\/script>/g, '');
    document.body.innerHTML = body;
    document.documentElement.dataset['theme'] = 'dark';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recoverable = vi.fn();
    const initial = readInitialData();
    const store = new ArtworkStore(server.fetch, 0);
    if ('view' in initial) store.seed(initial.view.rows);
    const deps = httpDeps('secret', { fetcher: server.fetch, store });
    const root = document.getElementById('root')!;
    const before = root.innerHTML;
    let unmount = () => {};
    await act(async () => {
      const app = hydrateRoot(
        root,
        <StrictMode>
          <WebRoot
            store={store}
            deps={deps}
            initialModel={initialModel(initial, deps)}
            initialTheme={renderedTheme()}
          />
        </StrictMode>,
        { onRecoverableError: recoverable },
      );
      unmount = () => app.unmount();
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(before).toContain('Etude 40');
    expect(screen.getByLabelText<HTMLInputElement>('Dark').checked).toBe(true);
    expect(screen.getByLabelText('4 out of 5 stars')).toBeTruthy();
    await press('j');
    expect(selectedTitle()).toContain('Etude 39');
    expect(apiRequests(server)).toEqual([]);
    act(() => unmount());
    errors.mockRestore();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
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
    const fetcher = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      if (path === '/api/ratings') {
        return new Response(JSON.stringify({ error: 'stars must be between 1 and 5' }), { status: 400 });
      }
      return new Response(JSON.stringify({ version: 1, total: 0, matched: 0, offset: 0, rows: [], index: null }));
    });
    const deps = httpDeps('secret', { fetcher: fetcher as typeof fetch, store: new ArtworkStore(fetcher, 0) });
    const { list, index } = await deps.view({ sort: 'topPlayed', query: 'a b', around: 7, reload: false });
    expect([list.count, list.sort, list.query, index]).toEqual([0, 'topPlayed', 'a b', null]);
    expect(fetcher.mock.calls[0]![0]).toBe('/api/view?sort=topPlayed&q=a+b&offset=0&limit=100&around=7');
    await expect(deps.saveRating({ trackId: 1, stars: 9, opinion: '', updatedAt: 1 })).rejects.toThrow(
      'stars must be between 1 and 5',
    );
    const init = fetcher.mock.calls[1]![1]!;
    expect(new Headers(init.headers).get('X-Tracker-Token')).toBe('secret');
    expect(init.body).toBe(JSON.stringify({ trackId: 1, stars: 9, opinion: '', updatedAt: 1 }));

    // A reload re-reads the library first, with the token.
    await deps.view({ sort: 'recentDesc', query: '', around: 0, reload: true });
    expect(fetcher.mock.calls[2]![0]).toBe('/api/reload');
    expect(new Headers(fetcher.mock.calls[2]![1]!.headers).get('X-Tracker-Token')).toBe('secret');
    expect(fetcher.mock.calls[3]![0]).toBe('/api/view?sort=recentDesc&q=&offset=0&limit=100');
  });
});
