/**
 * The list pane. Rows are windowed (only those near the viewport exist in
 * the DOM) so a 25,000-track library scrolls as smoothly as a 500-track one,
 * the same reason the TUI only formats its visible rows.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { textFor, type Model, type Msg } from '../../app/model';
import { trackListSummary } from '../../app/presenter';
import type { Track } from '../../core/model';
import { useArtworkStore } from './artwork';
import { Cover } from './Cover';

const ROW_HEIGHT = 60;
const OVERSCAN = 6;

const Row = memo(function Row({
  track,
  artists,
  selected,
  top,
  onSelect,
  onOpen,
}: {
  track: Track;
  artists: string;
  selected: boolean;
  top: number;
  onSelect: (id: number) => void;
  onOpen: (id: number) => void;
}) {
  const store = useArtworkStore();
  return (
    <li
      id={`track-${track.id}`}
      role="option"
      aria-selected={selected}
      className={selected ? 'row row--selected' : 'row'}
      style={{ transform: `translateY(${top}px)` }}
      onClick={() => onSelect(track.id)}
      onDoubleClick={() => onOpen(track.id)}
    >
      <Cover art={store.get(track.spotifyId)} size="small" albumName={track.albumName} />
      <span className="row__id">{track.id}</span>
      <span className="row__title">{track.trackName}</span>
      <span className="row__artists">{artists}</span>
    </li>
  );
});

export function TrackList({
  model,
  dispatch,
  searchRef,
}: {
  model: Model;
  dispatch: (msg: Msg) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const store = useArtworkStore();
  const { tracks, selectedIndex } = model;

  useLayoutEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    setHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  // Keep the selection in view, the way the TUI's window follows it.
  useLayoutEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    const rowTop = selectedIndex * ROW_HEIGHT;
    if (rowTop < element.scrollTop) {
      element.scrollTop = rowTop;
    } else if (rowTop + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = rowTop + ROW_HEIGHT - element.clientHeight;
    }
  }, [selectedIndex, tracks]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(tracks.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const shown = tracks.slice(first, last);

  useEffect(() => {
    store.request(shown.map((track) => track.spotifyId));
  });

  const onSelect = (id: number) => dispatch({ type: 'select', trackId: id });
  const onOpen = (id: number) => {
    dispatch({ type: 'select', trackId: id });
    dispatch({ type: 'key', key: 'e', text: 'e' });
  };
  const searchVisible = model.searching || model.searchQuery !== '';

  return (
    <section className="pane pane--list" aria-labelledby="tracks-heading">
      <header className="pane__header">
        <h2 id="tracks-heading">Tracks</h2>
        <p className="muted">{trackListSummary(model)}</p>
        <label className={searchVisible ? 'search search--active' : 'search'}>
          <span className="keycap" aria-hidden="true">
            /
          </span>
          <input
            ref={searchRef}
            type="search"
            placeholder="Search titles, artists, albums"
            aria-label="Search tracks"
            value={model.searchQuery}
            onFocus={() => {
              if (!model.searching) dispatch({ type: 'key', key: '/', text: '/' });
            }}
            onBlur={() => {
              if (model.searching) dispatch({ type: 'key', key: 'enter', text: '' });
            }}
            onChange={(event) => dispatch({ type: 'setSearch', query: event.target.value })}
          />
        </label>
      </header>
      <div ref={viewport} className="list-viewport" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        <ul
          className="rows"
          role="listbox"
          aria-label="Tracks"
          aria-activedescendant={tracks[selectedIndex] === undefined ? undefined : `track-${tracks[selectedIndex].id}`}
          style={{ height: tracks.length * ROW_HEIGHT }}
        >
          {shown.map((track, offset) => (
            <Row
              key={track.id}
              track={track}
              artists={textFor(model, track).artists}
              selected={first + offset === selectedIndex}
              top={(first + offset) * ROW_HEIGHT}
              onSelect={onSelect}
              onOpen={onOpen}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}
