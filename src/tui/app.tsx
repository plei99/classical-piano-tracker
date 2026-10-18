/**
 * The Ink program: the shared `useTracker` hook owns the model and runs its
 * commands; Ink feeds it keys, pastes, and resizes and owns the terminal
 * (raw mode, the alternate screen, restoring both on exit). Frames are
 * drawn by `Screen`, which rewrites only the rows a message changed: laying
 * every pane and span out as Ink boxes cost several times more per
 * keypress. Nothing here blocks a render on I/O.
 */
import { render, useApp, useInput, usePaste, useStdout, useWindowSize, type RenderOptions } from 'ink';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { frameRows } from './grid';
import { keyMessages } from './keys';
import type { Deps, Model } from '../app/model';
import { useTracker } from '../app/useTracker';
import { Screen } from './screen';
import { view } from './view';

/** Ink draws nothing itself, so only the terminal handling options matter. Ctrl+C is a key the model handles, as in Go. */
export function inkOptions(): RenderOptions {
  return { alternateScreen: true, exitOnCtrlC: false };
}

export interface AppProps {
  deps: Partial<Deps>;
  /** Starting model; defaults to a loading model sized to the terminal. */
  initialModel?: Model;
}

export function App({ deps, initialModel }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  // Ink's own measure (it follows stdout 'resize'), so the model always lays
  // out for the window the frame is drawn into.
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

  const screen = useMemo(() => new Screen(stdout), [stdout]);
  const drawnSize = useRef('');
  const frame = useMemo(() => view(model), [model]);
  useLayoutEffect(() => {
    // A resized window may have moved or reflowed what was drawn: repaint it all.
    const size = `${columns}x${rows}`;
    if (drawnSize.current !== size) {
      drawnSize.current = size;
      screen.invalidate();
    }
    screen.draw(frameRows(frame, columns));
  }, [screen, frame, columns, rows]);
  return null;
}

/** Takes over the terminal (alternate screen, raw input) until the user quits. */
export async function runTui(deps: Deps): Promise<void> {
  const instance = render(<App deps={deps} />, inkOptions());
  await instance.waitUntilExit();
}
