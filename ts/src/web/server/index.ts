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
export {
  CONTENT_SECURITY_POLICY,
  MAX_BODY_BYTES,
  PRESENCE_GRACE_MS,
  startWebServer,
  TOKEN_PLACEHOLDER,
  type WebAssets,
  type WebServer,
  type WebServerOptions,
} from './server';
