/**
 * The page's starting state, built the same way on the server (to render
 * GET /) and in the browser (to hydrate it), so both render identically.
 */
import { makeModel, type Deps, type Model } from '../app/model';
import { INITIAL_DATA_ID, type InitialData, type ViewResponse } from '../api';
import { chunkOf } from './deps';
import { RemoteTrackList } from './remoteList';

/**
 * The first screen shows the default state: newest first, no search, the
 * first track selected. A page the server rendered while it was still
 * reading the library starts loading, and fetches the list itself.
 */
export function initialModel(initial: InitialData, deps: Partial<Deps>): Model {
  const { view, error } = initial;
  if (view !== null) {
    return makeModel({
      deps,
      list: RemoteTrackList.fromChunk(chunkOf(view, 'recentDesc', '')),
      selectedIndex: view.index ?? 0,
    });
  }
  if (error != null) {
    return makeModel({ deps, list: RemoteTrackList.empty(), err: new Error(error) });
  }
  return makeModel({ deps, list: RemoteTrackList.empty(), loadingTracks: true });
}

/** Reads the data the server rendered the page from. */
export function readInitialData(doc: Document = document): InitialData {
  const text = doc.getElementById(INITIAL_DATA_ID)?.textContent ?? '';
  try {
    const data: unknown = JSON.parse(text);
    if (typeof data === 'object' && data !== null && 'view' in data) {
      const { view, error } = data as { view: unknown; error?: unknown };
      if (typeof view === 'object' && view !== null) {
        return { view: view as ViewResponse };
      }
      if (view === null) {
        return typeof error === 'string' ? { view: null, error } : { view: null };
      }
    }
  } catch {
    // Reported below.
  }
  return { view: null, error: 'The page is missing its initial data. Reload it.' };
}

/**
 * JSON safe to embed in a `<script type="application/json">` element: no
 * `</script>`, comment openers, or line separators can end it early.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}
