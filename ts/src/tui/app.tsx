/**
 * The Ink program: owns the model, feeds it keys, pastes, and resizes, and
 * runs the commands `update` returns, dispatching their results back as
 * messages. Nothing here blocks a render on I/O.
 */
import { render, useApp, useInput, usePaste, useWindowSize, type RenderOptions } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { FrameView } from './frame';
import { keyMessages } from './keys';
import { init, newModel, quit, update, type Deps, type Model, type Msg } from './model';
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
  const [model, setModel] = useState<Model>(() => initialModel ?? newModel(deps, { width: columns, height: rows }));
  // Messages can arrive between renders, so update always reads the latest
  // model here rather than the one captured by the last render.
  const latest = useRef(model);
  const started = useRef(false);
  const exited = useRef(false);

  const dispatch = useCallback(
    (msg: Msg): void => {
      if (exited.current) {
        return;
      }
      if (msg.type === 'quit') {
        exited.current = true;
        exit();
        return;
      }
      const [next, cmd] = update(latest.current, msg);
      if (next !== latest.current) {
        latest.current = next;
        setModel(next);
      }
      if (cmd === quit) {
        exited.current = true;
        exit();
      } else if (cmd !== null) {
        // Commands resolve (never reject) to their result message.
        void cmd().then(dispatch);
      }
    },
    [exit],
  );

  // Start the initial load once, on mount, like Bubble Tea's Init.
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      void init(latest.current)().then(dispatch);
    }
  }, [dispatch]);

  useEffect(() => {
    if (latest.current.width !== columns || latest.current.height !== rows) {
      dispatch({ type: 'resize', width: columns, height: rows });
    }
  }, [columns, rows, dispatch]);

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
