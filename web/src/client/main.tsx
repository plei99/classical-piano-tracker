/**
 * Browser entry point, bundled to /assets/app.js by build.mjs. The
 * server has already rendered the first screen; this attaches to it.
 */
import { hydrate } from 'preact';

import { artworkStore } from './artwork';
import { httpDeps, pageToken } from './deps';
import { initialModel, readInitialData } from './initial';
import { watchPresence } from './presence';
import { renderedTheme } from './theme';
import { WebRoot } from './WebApp';
import './styles.css';

const token = pageToken();
// First thing, so the server knows this tab is open as early as possible.
const presence = watchPresence(token);
const initial = readInitialData();
// The art the server sent with the first rows, as it rendered them.
if (initial.view !== null) {
  artworkStore.seed(initial.view.rows);
}
const deps = httpDeps(token);
const root = document.getElementById('root');
if (root !== null) {
  hydrate(
    <WebRoot
      store={artworkStore}
      deps={deps}
      initialModel={initialModel(initial, deps)}
      initialTheme={renderedTheme()}
      presence={presence}
    />,
    root,
  );
}
