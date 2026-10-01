import type { Model, Msg } from '../../app/model';
import { hints, status, type Hint } from '../../app/presenter';

/** Keys the web UI adds for its extra actions; shown only while browsing. */
export const WEB_HINTS: readonly Hint[] = [
  { keys: 'p', label: 'play', key: 'p' },
  { keys: 'a', label: 'open in Spotify', key: 'a' },
];

export function Footer({ model, dispatch }: { model: Model; dispatch: (msg: Msg) => void }) {
  const line = status(model);
  const browsing = !model.editingRating && !model.searching;
  const shown = [...hints(model).filter((hint) => hint.terminalOnly !== true), ...(browsing ? WEB_HINTS : [])];
  return (
    <footer className="footer">
      <p className={line?.isError === true ? 'status status--error' : 'status'} role="status" aria-live="polite">
        {line?.text ?? ''}
      </p>
      <ul className="hints" aria-label="Keyboard shortcuts">
        {shown.map((hint) => (
          <li key={`${hint.keys}-${hint.label}`}>
            {hint.key === undefined ? (
              <span className="hint">
                <kbd className="keycap">{hint.keys}</kbd> {hint.label}
              </span>
            ) : (
              <button
                type="button"
                className="hint hint--action"
                onClick={() => dispatch({ type: 'key', key: hint.key ?? '', text: '' })}
              >
                <kbd className="keycap">{hint.keys}</kbd> {hint.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </footer>
  );
}
