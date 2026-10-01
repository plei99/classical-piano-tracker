import type { Model, Msg } from '../../app/model';
import { details, formatTime } from '../../app/presenter';
import { useArtworkStore } from './artwork';
import { Cover } from './Cover';
import type { Player } from './player';
import { RatingEditor } from './RatingEditor';

function Stars({ stars }: { stars: number }) {
  return (
    <span className="stars" aria-label={`${stars} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((value) => (
        <span key={value} className={value <= stars ? 'star star--on' : 'star'} aria-hidden="true">
          ★
        </span>
      ))}
    </span>
  );
}

export function TrackDetails({
  model,
  dispatch,
  player,
}: {
  model: Model;
  dispatch: (msg: Msg) => void;
  player: Player;
}) {
  const store = useArtworkStore();
  const shown = details(model);
  if (shown === null) {
    return (
      <section className="pane pane--detail" aria-label="Track details">
        <h2>Track Details</h2>
        <p className="muted">No track selected.</p>
      </section>
    );
  }
  const { track, artists, fields, rating } = shown;
  const playing = player.loadedId === track.spotifyId && !player.isPaused;

  return (
    <section className="pane pane--detail" aria-label="Track details">
      <div className="hero">
        <Cover art={store.get(track.spotifyId)} size="large" albumName={track.albumName} className="hero__cover" />
        <div className="hero__text">
          <h2 className="hero__title">{track.trackName}</h2>
          <p className="hero__artists">{artists}</p>
          <p className="hero__album">{track.albumName}</p>
          <div className="hero__actions">
            <button
              type="button"
              className="button button--primary"
              aria-pressed={playing}
              onClick={() => player.play(track.spotifyId)}
            >
              {playing ? 'Pause' : 'Play'}
            </button>
            <a className="button" href={`spotify:track:${track.spotifyId}`}>
              Open in Spotify
            </a>
            {!model.editingRating && (
              <button type="button" className="button" onClick={() => dispatch({ type: 'key', key: 'e', text: 'e' })}>
                {rating !== null && rating !== 'saving' ? 'Edit rating' : 'Rate'}
              </button>
            )}
          </div>
          {player.error !== null && <p className="error small">{player.error}</p>}
        </div>
      </div>

      {model.editingRating ? (
        <RatingEditor model={model} dispatch={dispatch} />
      ) : (
        <>
          <section className="rating" aria-label="Rating">
            {rating === 'saving' && <p className="muted">Rating: saving...</p>}
            {rating === null && <p className="muted">Rating: none</p>}
            {rating !== null && rating !== 'saving' && (
              <>
                <p className="rating__stars">
                  <Stars stars={rating.stars} /> <span>{rating.stars}/5</span>
                </p>
                {rating.opinion !== '' && <blockquote className="rating__opinion">{rating.opinion}</blockquote>}
                <p className="muted small">Updated: {formatTime(rating.updatedAt, model.timeZone)}</p>
              </>
            )}
          </section>
          <dl className="facts">
            {fields.map(({ label, value }) => (
              <div key={label} className="facts__row">
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}
