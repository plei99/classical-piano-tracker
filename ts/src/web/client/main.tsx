/** Browser entry point, bundled to /assets/app.js by scripts/build.mjs. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { httpDeps, pageToken } from './deps';
import { WebApp } from './WebApp';
import './styles.css';

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <WebApp deps={httpDeps(pageToken())} />
    </StrictMode>,
  );
}
