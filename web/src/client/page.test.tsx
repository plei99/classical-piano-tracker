/**
 * The server's render of the first screen and the client's must match (the
 * client adopts the server's markup as it is). The goldens in test/pages
 * are the client components' render of each fixture; the Rust renderer's
 * tests (crates/tracker-web/src/page.rs) check it renders the same
 * fixtures to the same goldens. UPDATE_PAGES=1 rewrites them.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { InitialData } from '../api';
import { renderApp } from './page';
import type { ThemeChoice } from './theme';

const DIR = join(process.cwd(), 'test/pages');
const fixtures = readdirSync(DIR)
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.slice(0, -'.json'.length));

describe('the first screen', () => {
  it('has fixtures', () => {
    expect(fixtures.length).toBeGreaterThan(5);
  });

  for (const name of fixtures) {
    it(`renders ${name} as its golden`, () => {
      const { theme, initial } = JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as {
        theme: ThemeChoice;
        initial: InitialData;
      };
      const html = `${renderApp(initial, theme)}\n`;
      const golden = join(DIR, `${name}.html`);
      if (process.env['UPDATE_PAGES'] === '1') writeFileSync(golden, html);
      expect(html).toBe(readFileSync(golden, 'utf8'));
    });
  }
});
