/**
 * The first screen as the server renders it into `#root`: the client's own
 * components for the page's initial data, before any script runs. This is
 * the reference for the Rust renderer (crates/tracker-web/src/page.rs): the
 * golden files in `test/pages/` are generated from it, and the Rust tests
 * render the same fixtures and compare. Not part of the browser bundle.
 */
import { render } from 'preact-render-to-string';

import type { InitialData } from '../api';
import { ArtworkStore } from './artwork';
import { initialModel } from './initial';
import type { ThemeChoice } from './theme';
import { WebRoot } from './WebApp';

const noFetch: typeof fetch = () => Promise.reject(new Error('the server never fetches artwork for a page'));

export function renderApp(initial: InitialData, theme: ThemeChoice): string {
  // A store holding exactly the art sent with the page's rows.
  const store = new ArtworkStore(noFetch);
  if (initial.view !== null) {
    store.seed(initial.view.rows);
  }
  return render(<WebRoot store={store} deps={{}} initialModel={initialModel(initial, {})} initialTheme={theme} />);
}
