/**
 * The `tracker tui` browser: list, search, sort, sync, and rate tracks.
 *
 * `Deps` and `runTui` are the contract the CLI compiles against; `internals`
 * exposes the pure state machine and renderer for tests and benchmarks.
 */
export { runTui } from './app';
export type { Deps } from '../app/model';

import { App, inkOptions } from './app';
import { frameRows } from './grid';
import { keyMessages } from './keys';
import { makeModel, newModel, tracksLoadedMsg, update } from '../app/model';
import { footerView, layout, view, visibleTracks } from './view';

/** Not part of the CLI contract: hooks for tests and benchmarks. */
export const internals = {
  App,
  footerView,
  frameRows,
  inkOptions,
  keyMessages,
  layout,
  makeModel,
  newModel,
  tracksLoadedMsg,
  update,
  view,
  visibleTracks,
};
