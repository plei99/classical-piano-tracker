/**
 * GET /: the page, rendered on the server. The first screen arrives as
 * HTML (the browser shows rows before any script runs) along with the data
 * it was rendered from, which the client hydrates with the same components
 * and the same starting model (client/initial.ts), so the two renders match.
 */
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';

import { TITLE } from '../../app/presenter';
import { INITIAL_DATA_ID, TOKEN_META, type InitialData } from '../api';
import { ArtworkStore } from '../client/artwork';
import { initialModel, scriptJson } from '../client/initial';
import type { ThemeChoice } from '../client/theme';
import { WebRoot } from '../client/WebApp';

const noFetch: typeof fetch = () => Promise.reject(new Error('the server never fetches artwork for a page'));

export interface PageOptions {
  /** The per-launch token (hex). */
  token: string;
  theme: ThemeChoice;
  initial: InitialData;
}

export type PageRenderer = (options: PageOptions) => string;

export function renderPage({ token, theme, initial }: PageOptions): string {
  // A store per page, holding exactly the art sent with this page's rows.
  const store = new ArtworkStore(noFetch);
  if ('view' in initial) {
    store.seed(initial.view.rows);
  }
  const app = renderToString(
    <StrictMode>
      <WebRoot store={store} deps={{}} initialModel={initialModel(initial, {})} initialTheme={theme} />
    </StrictMode>,
  );
  const themeAttribute = theme === 'auto' ? '' : ` data-theme="${theme}"`;
  return `<!doctype html>
<html lang="en"${themeAttribute}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="${TOKEN_META}" content="${token}" />
    <title>${TITLE}</title>
    <link rel="stylesheet" href="/assets/app.css" />
    <script type="module" src="/assets/app.js"></script>
  </head>
  <body>
    <div id="root">${app}</div>
    <script type="application/json" id="${INITIAL_DATA_ID}">${scriptJson(initial)}</script>
  </body>
</html>
`;
}
