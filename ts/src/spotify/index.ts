/**
 * Spotify OAuth, the Web API client, and the sync pipeline that filters
 * recent plays into the local database.
 */
export { authenticator, DEFAULT_REDIRECT_URL, login, type LoginOptions, SCOPES } from './auth';
export {
  API_BASE_URL,
  type Artist,
  artistNames,
  Client,
  type ClientOptions,
  type RecentTrack,
  SpotifyApiError,
  type TokenPersister,
} from './client';
export { ACCOUNTS_BASE_URL, RetrieveError } from './oauth';
export { decide, type Decision, runSync, type TrackSource } from './syncer';
export { dateFromNs, parseRfc3339Ns, unixSeconds } from './time';
