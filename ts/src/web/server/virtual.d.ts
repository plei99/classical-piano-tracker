// The built browser client, provided by scripts/build.mjs as a virtual
// module so the compiled binary carries its assets without a dist folder.
// It does not exist when running from source; tests inject assets instead.
declare module 'virtual:web-assets' {
  const assets: import('./server').WebAssets;
  export default assets;
}

// The page renderer (page.tsx and React's server renderer) as CommonJS
// source, evaluated by `tracker web` only; see scripts/build.mjs.
declare module 'virtual:web-page' {
  const code: string;
  export default code;
}
