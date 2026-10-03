/**
 * The `tracker web` backend: the HTTP server and the artwork service it
 * delegates album-art lookups to.
 */
export {
  ARTWORK_CACHE_FILE,
  type ArtworkApi,
  artworkCachePath,
  type ArtworkLookup,
  ArtworkService,
  type ArtworkServiceOptions,
  configArtworkApi,
  isSpotifyId,
  OEMBED_BASE_URL,
} from './artwork';
export { Library } from './library';
export type { PageOptions, PageRenderer } from './page';
export {
  CONTENT_SECURITY_POLICY,
  MAX_BODY_BYTES,
  PRESENCE_GRACE_MS,
  startWebServer,
  type WebAssets,
  type WebServer,
  type WebServerOptions,
} from './server';
