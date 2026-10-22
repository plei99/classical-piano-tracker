/**
 * Plain data the web API carries. The types are generated from the Rust
 * definitions (crates/tracker-core/src/model.rs), so the client is checked
 * against what the server sends.
 */
import type { SyncStats } from '../generated/SyncStats';

export type { Rating } from '../generated/Rating';
export type { SyncStats } from '../generated/SyncStats';
export type { Track } from '../generated/Track';
export type { UpsertRatingParams } from '../generated/UpsertRatingParams';

export function emptySyncStats(): SyncStats {
  return { fetched: 0, blocked: 0, skipped: 0, accepted: 0, inserted: 0, updated: 0, alreadySynced: 0 };
}
