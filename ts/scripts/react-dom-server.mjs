// The server renders pages with renderToString only; this keeps React's
// streaming renderer (as large again) out of the bundle. Tests import
// react-dom/server itself.
export { renderToString } from '../node_modules/react-dom/cjs/react-dom-server-legacy.node.production.js';
