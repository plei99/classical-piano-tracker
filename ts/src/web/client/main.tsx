/** Browser entry point, bundled to /assets/app.js by scripts/build.mjs. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { httpDeps, pageToken } from './deps';
import { watchPresence } from './presence';
import { WebApp } from './WebApp';
import './styles.css';

const token = pageToken();
// First thing, ahead of the first render and so of the library request.
const presence = watchPresence(token);
const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <WebApp deps={httpDeps(token)} presence={presence} />
    </StrictMode>,
  );
}
