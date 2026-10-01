// `?raw` imports inline a file's text: Vite handles them in tests, and the
// esbuild plugin in scripts/build.mjs does the same for the bundle.
declare module '*?raw' {
  const text: string;
  export default text;
}

// Injected by scripts/build.mjs; absent when running from source (tests).
declare const __TRACKER_BUILD__: { version: string; commit: string; date: string } | undefined;

// Stylesheets imported by the web client; esbuild emits them as app.css.
declare module '*.css';
