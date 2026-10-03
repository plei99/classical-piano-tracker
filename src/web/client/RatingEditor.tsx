/**
 * The rating editor, with the TUI's focus model: it opens on the stars
 * field, 1-5 sets stars and moves to the opinion, Tab switches fields, Enter
 * saves, Esc cancels. Clicks and the text field feed the same state machine.
 */
import { useEffect, useRef } from 'react';

import type { Model, Msg } from '../../app/model';
import { EDITOR_HELP, ratingDraftStarsLabel } from '../../app/presenter';

const STARS = [1, 2, 3, 4, 5];

export function RatingEditor({ model, dispatch }: { model: Model; dispatch: (msg: Msg) => void }) {
  const sectionRef = useRef<HTMLElement>(null);
  const starsRef = useRef<HTMLDivElement>(null);
  const opinionRef = useRef<HTMLTextAreaElement>(null);
  const key = (name: string) => dispatch({ type: 'key', key: name, text: '' });

  // The editor opens below the cover; bring all of it, buttons included, into view.
  useEffect(() => {
    sectionRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  // Mirror the model's focused field into DOM focus.
  useEffect(() => {
    const target = model.editingOpinion ? opinionRef.current : starsRef.current;
    if (target !== null && document.activeElement !== target) {
      target.focus({ preventScroll: true });
      if (target instanceof HTMLTextAreaElement) {
        target.setSelectionRange(target.value.length, target.value.length);
      }
    }
  }, [model.editingOpinion]);

  return (
    <section ref={sectionRef} className="editor" aria-label="Rating editor">
      <div className={model.editingOpinion ? 'field' : 'field field--focused'}>
        <span className="field__label" id="stars-label">
          Stars: {ratingDraftStarsLabel(model)}
        </span>
        <div
          ref={starsRef}
          className="stars stars--input"
          role="radiogroup"
          aria-labelledby="stars-label"
          tabIndex={0}
          onFocus={() => dispatch({ type: 'focusField', field: 'stars' })}
        >
          {STARS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={model.draftStars === value}
              aria-label={`${value} star${value === 1 ? '' : 's'}`}
              className={value <= model.draftStars ? 'star star--on' : 'star'}
              tabIndex={-1}
              onClick={() => dispatch({ type: 'setDraftStars', stars: value })}
            >
              ★
            </button>
          ))}
        </div>
      </div>
      <div className={model.editingOpinion ? 'field field--focused' : 'field'}>
        <label className="field__label" htmlFor="opinion">
          Opinion:
        </label>
        <textarea
          id="opinion"
          ref={opinionRef}
          rows={4}
          value={model.draftOpinion}
          placeholder="What stood out in this performance?"
          onFocus={() => dispatch({ type: 'focusField', field: 'opinion' })}
          onChange={(event) => dispatch({ type: 'setDraftOpinion', text: event.target.value })}
        />
      </div>
      <div className="editor__actions">
        <button type="button" className="button button--primary" onClick={() => key('enter')}>
          Save rating
        </button>
        <button type="button" className="button" onClick={() => key('esc')}>
          Cancel
        </button>
      </div>
      {EDITOR_HELP.map((line) => (
        <p key={line} className="muted small">
          {line}
        </p>
      ))}
    </section>
  );
}
