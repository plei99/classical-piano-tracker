/**
 * In-page playback through Spotify's iFrame embed API. The embed plays full
 * tracks when the browser is signed in to a Spotify Premium account, and
 * 30-second previews otherwise; it needs no extra OAuth scopes, unlike the
 * Web Playback SDK.
 *
 * One embed is created on first use and kept for the life of the page, so
 * music keeps playing while you browse; playing another track loads it into
 * the same embed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export const IFRAME_API_URL = 'https://open.spotify.com/embed/iframe-api/v1';

interface PlaybackUpdate {
  data: { isPaused: boolean; isBuffering: boolean; duration: number; position: number };
}

export interface EmbedController {
  loadUri(uri: string): void;
  play(): void;
  togglePlay(): void;
  addListener(event: 'ready', listener: () => void): void;
  addListener(event: 'playback_update', listener: (update: PlaybackUpdate) => void): void;
}

export interface IFrameAPI {
  createController(
    element: HTMLElement,
    options: { uri: string; width?: string | number; height?: string | number },
    callback: (controller: EmbedController) => void,
  ): void;
}

declare global {
  interface Window {
    onSpotifyIframeApiReady?: (api: IFrameAPI) => void;
  }
}

let apiPromise: Promise<IFrameAPI> | null = null;

const LOAD_ERROR = 'Could not load the Spotify player. Check your internet connection and try again.';

/**
 * Loads Spotify's embed script once per page. The loader fetches more code
 * from Spotify's CDN, and a failure there never reaches this script's
 * onerror, so a timeout turns a silent stall into a visible error.
 */
export function loadIFrameAPI(doc: Document = document, timeoutMs = 10_000): Promise<IFrameAPI> {
  apiPromise ??= new Promise<IFrameAPI>((resolve, reject) => {
    const fail = () => {
      apiPromise = null;
      reject(new Error(LOAD_ERROR));
    };
    const timer = setTimeout(fail, timeoutMs);
    window.onSpotifyIframeApiReady = (api) => {
      clearTimeout(timer);
      resolve(api);
    };
    const script = doc.createElement('script');
    script.src = IFRAME_API_URL;
    script.async = true;
    script.onerror = () => {
      clearTimeout(timer);
      fail();
    };
    doc.head.appendChild(script);
  });
  return apiPromise;
}

export function trackUri(spotifyId: string): string {
  return `spotify:track:${spotifyId}`;
}

export interface PlayerState {
  /** The Spotify ID loaded in the embed, if any. */
  loadedId: string | null;
  isPaused: boolean;
  error: string | null;
}

export interface Player extends PlayerState {
  /** Where the embed lives; attach to an element that stays mounted. */
  slotRef: (element: HTMLDivElement | null) => void;
  /** Plays a track, or toggles pause when it is already loaded. */
  play(spotifyId: string): void;
}

export function usePlayer(loadApi: () => Promise<IFrameAPI> = loadIFrameAPI): Player {
  const slot = useRef<HTMLDivElement | null>(null);
  const controller = useRef<EmbedController | null>(null);
  // Play once the embed reports ready: calling play() before a freshly
  // loaded track is ready is silently ignored by the embed.
  const playWhenReady = useRef(false);
  const [state, setState] = useState<PlayerState>({ loadedId: null, isPaused: true, error: null });
  const loadedId = useRef<string | null>(null);

  const slotRef = useCallback((element: HTMLDivElement | null) => {
    slot.current = element;
  }, []);

  const play = useCallback(
    (spotifyId: string) => {
      if (controller.current !== null) {
        if (loadedId.current === spotifyId) {
          controller.current.togglePlay();
          return;
        }
        loadedId.current = spotifyId;
        playWhenReady.current = true;
        setState((current) => ({ ...current, loadedId: spotifyId, error: null }));
        controller.current.loadUri(trackUri(spotifyId));
        return;
      }
      const element = slot.current;
      if (element === null) {
        return;
      }
      loadedId.current = spotifyId;
      playWhenReady.current = true;
      setState((current) => ({ ...current, loadedId: spotifyId, error: null }));
      // The API replaces the element it is given, so hand it a child and keep
      // the slot React owns intact.
      const host = document.createElement('div');
      element.replaceChildren(host);
      loadApi().then(
        (api) =>
          api.createController(host, { uri: trackUri(spotifyId), width: '100%', height: 152 }, (created) => {
            controller.current = created;
            created.addListener('ready', () => {
              if (playWhenReady.current) {
                playWhenReady.current = false;
                created.play();
              }
            });
            created.addListener('playback_update', ({ data }) =>
              setState((current) =>
                current.isPaused === data.isPaused ? current : { ...current, isPaused: data.isPaused },
              ),
            );
          }),
        (err: unknown) =>
          setState((current) => ({ ...current, error: err instanceof Error ? err.message : String(err) })),
      );
    },
    [loadApi],
  );

  useEffect(() => () => void (playWhenReady.current = false), []);

  return { ...state, slotRef, play };
}
