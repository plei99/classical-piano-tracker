/**
 * Browser entry point, bundled to /assets/app.js by scripts/build.mjs. The
 * server has already rendered the first screen; this attaches to it.
 */
import { StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';

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
if ('view' in initial) {
  artworkStore.seed(initial.view.rows);
}
const deps = httpDeps(token);
const root = document.getElementById('root');
if (root !== null) {
  hydrateRoot(
    root,
    <StrictMode>
      <WebRoot
        store={artworkStore}
        deps={deps}
        initialModel={initialModel(initial, deps)}
        initialTheme={renderedTheme()}
        presence={presence}
      />
    </StrictMode>,
  );
}
