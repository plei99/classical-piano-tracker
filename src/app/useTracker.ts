/**
 * Runs the shared state machine inside React: holds the model, feeds it
 * messages, and runs the commands `update` returns, dispatching their
 * results back. Both the Ink TUI and the web UI are thin views over this
 * hook, so loading, syncing, and saving behave identically in both.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { init, newModel, quit, update, type Deps, type Model, type Msg } from './model';

export interface TrackerOptions {
  /** Starting model; defaults to a loading model with `fields` applied. */
  initialModel?: Model;
  fields?: Partial<Model>;
  /** Called once when the model asks to quit (the TUI exits; the web UI ignores it). */
  onQuit?: () => void;
}

export function useTracker(
  deps: Partial<Deps>,
  options: TrackerOptions = {},
): { model: Model; dispatch: (msg: Msg) => void } {
  const [model, setModel] = useState<Model>(() => options.initialModel ?? newModel(deps, options.fields));
  // Messages can arrive between renders, so update always reads the latest
  // model here rather than the one captured by the last render.
  const latest = useRef(model);
  const started = useRef(false);
  const exited = useRef(false);
  const onQuit = useRef(options.onQuit);
  onQuit.current = options.onQuit;

  const dispatch = useCallback((msg: Msg): void => {
    if (exited.current) {
      return;
    }
    if (msg.type === 'quit') {
      exited.current = true;
      onQuit.current?.();
      return;
    }
    const [next, cmd] = update(latest.current, msg);
    if (next !== latest.current) {
      latest.current = next;
      setModel(next);
    }
    if (cmd === quit) {
      if (onQuit.current !== undefined) {
        exited.current = true;
        onQuit.current();
      }
    } else if (cmd !== null) {
      // Commands resolve (never reject) to their result message.
      void cmd().then(dispatch);
    }
  }, []);

  // Start the initial load once, on mount, like Bubble Tea's Init.
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      const [next, cmd] = init(latest.current);
      if (next !== latest.current) {
        latest.current = next;
        setModel(next);
      }
      if (cmd !== null) {
        void cmd().then(dispatch);
      }
    }
  }, [dispatch]);

  return { model, dispatch };
}
