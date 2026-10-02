/**
 * The list pane. Rows are windowed (only those near the viewport exist in
 * the DOM) so a 25,000-track library scrolls as smoothly as a 500-track one,
 * the same reason the TUI only formats its visible rows. The list itself
 * lives on the server; `useListFill` fetches rows ahead of the selection and
 * the scroll position, and a row that has not arrived yet is drawn as a
 * placeholder of the same height.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { ListRow, Model, Msg } from '../../app/model';
import { trackListSummary } from '../../app/presenter';
import { useArtworkStore } from './artwork';
import { Cover } from './Cover';
import { useListFill, type RowsFetcher } from './fill';

const ROW_HEIGHT = 60;
const OVERSCAN = 6;
/** The viewport height assumed until it is measured; the server renders with it too. */
const INITIAL_HEIGHT = 600;

const Row = memo(function Row({
  row,
  selected,
  top,
  onSelect,
  onOpen,
}: {
  row: ListRow;
  selected: boolean;
  top: number;
  onSelect: (id: number) => void;
  onOpen: (id: number) => void;
}) {
  const store = useArtworkStore();
  const { track } = row;
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
      <span className="row__artists">{row.artists}</span>
    </li>
  );
});

function Placeholder({ selected, top }: { selected: boolean; top: number }) {
  return (
    <li
      role="option"
      aria-selected={selected}
      aria-busy="true"
      aria-label="Loading"
      className="row row--placeholder"
      style={{ transform: `translateY(${top}px)` }}
    >
      <div className="cover cover--small cover--empty" aria-hidden="true" />
    </li>
  );
}

export function TrackList({
  model,
  dispatch,
  searchRef,
  rows,
}: {
  model: Model;
  dispatch: (msg: Msg) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  /** Fetches rows of a remote list; without it, only the rows already there are shown. */
  rows?: RowsFetcher;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const store = useArtworkStore();
  const { list, selectedIndex } = model;
  const { count } = list;

  useLayoutEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    setHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  // Keep the selection in view, the way the TUI's window follows it. Rows
  // arriving do not count: they must not pull a scrolled list back.
  useLayoutEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    const rowTop = selectedIndex * ROW_HEIGHT;
    if (rowTop < element.scrollTop) {
      element.scrollTop = rowTop;
    } else if (rowTop + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = rowTop + ROW_HEIGHT - element.clientHeight;
    }
  }, [selectedIndex, list.sort, list.query, count]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(count, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const indexes: number[] = [];
  for (let index = first; index < last; index++) {
    indexes.push(index);
  }
  // The selection is always in the DOM: after a jump it shows (and is the
  // listbox's active descendant) before the scroll event moves the window.
  if (selectedIndex < count && (selectedIndex < first || selectedIndex >= last)) {
    indexes.push(selectedIndex);
  }
  const shown = indexes.map((index) => list.row(index));

  useListFill(model, first, last, rows, dispatch);

  useEffect(() => {
    store.request(shown.flatMap((row) => (row === null ? [] : [row.track.spotifyId])));
  });

  const onSelect = (id: number) => dispatch({ type: 'select', trackId: id });
  const onOpen = (id: number) => {
    dispatch({ type: 'select', trackId: id });
    dispatch({ type: 'key', key: 'e', text: 'e' });
  };
  const searchVisible = model.searching || model.searchQuery !== '';
  const selectedRow = list.row(selectedIndex);

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
          aria-activedescendant={selectedRow === null ? undefined : `track-${selectedRow.track.id}`}
          style={{ height: count * ROW_HEIGHT }}
        >
          {shown.map((row, position) => {
            const index = indexes[position] ?? 0;
            return row === null ? (
              <Placeholder key={`placeholder-${index}`} selected={index === selectedIndex} top={index * ROW_HEIGHT} />
            ) : (
              <Row
                key={row.track.id}
                row={row}
                selected={index === selectedIndex}
                top={index * ROW_HEIGHT}
                onSelect={onSelect}
                onOpen={onOpen}
              />
            );
          })}
        </ul>
      </div>
    </section>
  );
}
