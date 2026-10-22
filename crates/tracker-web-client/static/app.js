// Starts the WebAssembly client, whose start function hydrates the page. A file
// of its own because the page's CSP allows no inline scripts.
import init from './client.js';

init();
