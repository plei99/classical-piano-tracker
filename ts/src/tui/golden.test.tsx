/**
 * Frames rendered through Ink, compared with output captured from the Go
 * build (`testdata/go_*.txt`, rendered with TZ=UTC).
 */
import { describe, expect, it } from 'vitest';

import bigMid from './testdata/go_big_mid.txt?raw';
import editorOpinion from './testdata/go_editor_opinion.txt?raw';
import narrowMid from './testdata/go_narrow_mid.txt?raw';
import searching from './testdata/go_searching.txt?raw';
import statusErr from './testdata/go_status_err.txt?raw';
import statusLong from './testdata/go_status_long.txt?raw';
import tiny from './testdata/go_tiny.txt?raw';
import wideMid from './testdata/go_wide_mid.txt?raw';
import wideRated from './testdata/go_wide_rated.txt?raw';
import { startRatingEditor, type Model } from './model';
import { goldenModel, renderText, typeText } from './testkit';

function expectMatchesGo(m: Model, golden: string): void {
  const got = renderText(m).replace(/\n+$/, '');
  const want = golden
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n+$/, '');
  expect(got).toBe(want);
}

describe('frames match the Go build', () => {
  it('wide layout', () => {
    const m = goldenModel(120, 28, 30, false);
    expectMatchesGo({ ...m, selectedIndex: 15 }, wideMid);
    expectMatchesGo({ ...m, selectedIndex: 2 }, wideRated);
  });

  it('narrow and tiny layouts', () => {
    expectMatchesGo({ ...goldenModel(70, 24, 30, true), selectedIndex: 10 }, narrowMid);
    expectMatchesGo(goldenModel(30, 10, 5, false), tiny);
  });

  it('large list', () => {
    expectMatchesGo({ ...goldenModel(160, 48, 300, true), selectedIndex: 150 }, bigMid);
  });

  it('editor, search, and status', () => {
    let m = startRatingEditor(goldenModel(120, 28, 5, false));
    m = typeText({ ...m, draftOpinion: 'Op. 10' }, '4');
    expectMatchesGo(m, editorOpinion);

    m = typeText({ ...goldenModel(120, 28, 5, false), searching: true }, 'track 3');
    expectMatchesGo(m, searching);

    m = { ...goldenModel(100, 30, 5, false), statusMessage: 'Sync failed: bad token', statusIsError: true };
    expectMatchesGo(m, statusErr);
  });

  it('long status wraps like Go', () => {
    const m: Model = {
      ...goldenModel(70, 24, 30, false),
      statusMessage:
        'Sync failed: spotify: HTTP 503: upstream connect error or disconnect/reset before headers. reset reason: ' +
        'connection_termination_and_a_very_long_unbroken_token_that_must_split',
      statusIsError: true,
    };
    expectMatchesGo(m, statusLong);
  });
});
