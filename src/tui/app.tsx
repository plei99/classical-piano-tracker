/**
 * The Ink program: the shared `useTracker` hook owns the model and runs its
 * commands; this file feeds it keys, pastes, and resizes and draws frames
 * on the character grid. Nothing here blocks a render on I/O.
 */
import { render, useApp, useInput, usePaste, useWindowSize, type RenderOptions } from 'ink';
import { useEffect, useMemo } from 'react';

import { FrameView } from './frame';
import { keyMessages } from './keys';
import type { Deps, Model } from '../app/model';
import { useTracker } from '../app/useTracker';
import { view } from './view';

/**
 * Ink's default 30 fps cap adds ~20 ms between a keypress and its frame; a
 * high cap removes that wait. Incremental rendering rewrites only changed
 * lines (~4 KB per keypress instead of ~7 KB at 160x48). Ctrl+C is a key
 * the model handles, as in Go.
 */
export function inkOptions(): RenderOptions {
  return { alternateScreen: true, exitOnCtrlC: false, maxFps: 1000, incrementalRendering: true };
}

export interface AppProps {
  deps: Partial<Deps>;
  /** Starting model; defaults to a loading model sized to the terminal. */
  initialModel?: Model;
}

export function App({ deps, initialModel }: AppProps) {
  const { exit } = useApp();
  // Ink's own measure (it follows stdout 'resize' and falls back the same
  // way Ink's layout does when the stream reports no size), so the model
  // always lays out for the width Ink draws into.
  const { columns, rows } = useWindowSize();
  const { model, dispatch } = useTracker(deps, {
    ...(initialModel !== undefined && { initialModel }),
    fields: { width: columns, height: rows },
    onQuit: exit,
  });

  useEffect(() => {
    if (model.width !== columns || model.height !== rows) {
      dispatch({ type: 'resize', width: columns, height: rows });
    }
  }, [columns, rows, model.width, model.height, dispatch]);

  useInput((input, key) => {
    for (const msg of keyMessages(input, key)) {
      dispatch(msg);
    }
  });
  // Enables bracketed paste, so a paste arrives whole instead of as keys.
  usePaste((text) => dispatch({ type: 'paste', text }));

  const frame = useMemo(() => view(model), [model]);
  return <FrameView frame={frame} />;
}

/** Takes over the terminal (alternate screen, raw input) until the user quits. */
export async function runTui(deps: Deps): Promise<void> {
  const instance = render(<App deps={deps} />, inkOptions());
  await instance.waitUntilExit();
}
