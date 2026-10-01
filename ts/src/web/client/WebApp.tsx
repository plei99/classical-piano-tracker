/**
 * The web UI root: the same state machine as the TUI (via the shared
 * `useTracker` hook), drawn with DOM elements instead of a character grid.
 * Keys reach the model exactly as they do in the terminal; clicks and form
 * fields send the pointer messages the model defines for them.
 */
import { useCallback, useEffect, useRef } from 'react';

import { selectedTrack, type Deps, type Msg } from '../../app/model';
import { LOADING_TEXT, NO_TRACKS_TEXT, SUBTITLE, TITLE, errorText, noMatchText, screen } from '../../app/presenter';
import { useTracker } from '../../app/useTracker';
import { useArtworkStore } from './artwork';
import { Footer } from './Footer';
import { keyMessage } from './keys';
import { usePlayer, type IFrameAPI } from './player';
import { ThemeSwitch } from './ThemeSwitch';
import { useTheme } from './theme';
import { TrackDetails } from './TrackDetails';
import { TrackList } from './TrackList';

/** Keys the model handles in each mode; anything else keeps its browser meaning (Tab, Space on a button, ...). */
const browsingKeys = new Set([
  'j',
  'k',
  'up',
  'down',
  'g',
  'G',
  'home',
  'end',
  'o',
  's',
  'e',
  'enter',
  'r',
  '/',
  'esc',
]);
const fieldKeys = new Set(['enter', 'esc', 'tab', 'shift+tab', 'ctrl+u']);
const ARROWS = new Set(['up', 'down', 'left', 'right']);
/** Elements that take typed text; radios and buttons don't, so the model's keys still work on them. */
const TEXT_ENTRY =
  'textarea, select, input:not([type="radio"]):not([type="checkbox"]):not([type="button"]):not([type="submit"])';

export interface WebAppProps {
  deps: Partial<Deps>;
  /** Injected in tests; defaults to Spotify's real embed script. */
  loadPlayer?: () => Promise<IFrameAPI>;
  /** Injected in tests; opens a spotify: URI in the desktop app. */
  openUri?: (uri: string) => void;
}

const openInApp = (uri: string) => {
  window.location.href = uri;
};

export function WebApp({ deps, loadPlayer, openUri = openInApp }: WebAppProps) {
  const { model, dispatch } = useTracker(deps);
  const player = usePlayer(...(loadPlayer === undefined ? [] : [loadPlayer]));
  const [theme, setTheme] = useTheme();
  const searchRef = useRef<HTMLInputElement>(null);
  const store = useArtworkStore();
  const current = screen(model);
  const selected = selectedTrack(model);

  // Web-only actions ride on keys the model doesn't use ('p', 'a'); every
  // other message goes to the shared state machine.
  const send = useCallback(
    (msg: Msg) => {
      if (msg.type === 'key' && !model.editingRating && !model.searching && selected !== null) {
        if (msg.key === 'p') {
          player.play(selected.spotifyId);
          return;
        }
        if (msg.key === 'a') {
          openUri(`spotify:track:${selected.spotifyId}`);
          return;
        }
      }
      dispatch(msg);
    },
    [dispatch, model.editingRating, model.searching, openUri, player, selected],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const msg = keyMessage(event);
      if (msg === null) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(TEXT_ENTRY) != null) {
        // Text fields keep their typing; only the model's commands leave them.
        if (!fieldKeys.has(msg.key) || (msg.key === 'ctrl+u' && !model.editingRating)) return;
        if (msg.key.endsWith('tab') && !model.editingRating) return;
      } else if (
        target?.closest('button, a, [role="radio"], input') != null &&
        (msg.key === 'enter' || msg.key === 'space')
      ) {
        // Let a focused control activate natively.
        return;
      } else if (target?.matches('input[type="radio"]') === true && ARROWS.has(msg.key)) {
        // Arrow keys move between the theme choices.
        return;
      } else if (model.searching) {
        if (!fieldKeys.has(msg.key)) return;
      } else if (!model.editingRating && !browsingKeys.has(msg.key) && msg.key !== 'p' && msg.key !== 'a') {
        return;
      }
      event.preventDefault();
      send(msg);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [model.editingRating, model.searching, send]);

  // '/' opens search in the model; give the field focus to match. Enter or
  // Esc closes it; hand focus back to the page so j/k work again.
  useEffect(() => {
    const input = searchRef.current;
    if (input === null) return;
    if (model.searching && document.activeElement !== input) {
      input.focus();
    } else if (!model.searching && document.activeElement === input) {
      input.blur();
    }
  }, [model.searching]);

  // The selected track's art, ahead of the list's own requests.
  useEffect(() => {
    if (selected !== null) store.request([selected.spotifyId]);
  }, [selected, store]);

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1>{TITLE}</h1>
          <p className="muted">{SUBTITLE}</p>
        </div>
        <ThemeSwitch value={theme} onChange={setTheme} />
      </header>

      <main className="body">
        {current === 'loading' && <p className="notice">{LOADING_TEXT}</p>}
        {current === 'error' && (
          <div className="notice">
            <p className="error">{errorText(model)}</p>
            <button type="button" className="button" onClick={() => send({ type: 'key', key: 'r', text: 'r' })}>
              Retry
            </button>
          </div>
        )}
        {current === 'empty' && <p className="notice muted">{NO_TRACKS_TEXT}</p>}
        {(current === 'browse' || current === 'noMatch') && (
          <div className="panes">
            <TrackList model={model} dispatch={send} searchRef={searchRef} />
            {current === 'browse' ? (
              <TrackDetails model={model} dispatch={send} player={player} />
            ) : (
              <section className="pane pane--detail">
                <p className="muted">{noMatchText(model)}</p>
              </section>
            )}
          </div>
        )}
        {/* Mounted once and never moved, so playback survives browsing. */}
        <div className={player.loadedId === null ? 'player player--idle' : 'player'} aria-label="Spotify player">
          <div ref={player.slotRef} />
        </div>
      </main>

      {current !== 'loading' && current !== 'error' && <Footer model={model} dispatch={send} />}
    </div>
  );
}
