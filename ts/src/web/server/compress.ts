/**
 * Response compression. Static assets arrive compressed from the build
 * (scripts/build.mjs, at maximum quality); JSON and HTML are compressed per
 * response at a quality that costs about a millisecond for a typical page.
 */
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

export type Encoding = 'br' | 'gzip';

/** Smaller bodies are sent as they are: compression would barely shrink them. */
export const COMPRESS_MIN_BYTES = 1024;

/**
 * The encoding to answer with: brotli, then gzip, among those the
 * Accept-Encoding header allows (a q=0 refuses one; `*` allows any).
 */
export function pickEncoding(header: string | string[] | undefined): Encoding | null {
  if (header === undefined) {
    return null;
  }
  const accepted = new Map<string, number>();
  for (const part of (Array.isArray(header) ? header.join(',') : header).split(',')) {
    const [name = '', ...params] = part.trim().toLowerCase().split(';');
    if (name === '') continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key === 'q' && value !== undefined) {
        const parsed = Number(value);
        q = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    accepted.set(name, q);
  }
  const allows = (name: string): boolean => {
    const q = accepted.get(name) ?? accepted.get('*');
    return q !== undefined && q > 0;
  };
  if (allows('br')) return 'br';
  if (allows('gzip')) return 'gzip';
  return null;
}

/** Fast settings for per-response compression. */
export function compress(body: Buffer, encoding: Encoding): Buffer {
  if (encoding === 'br') {
    return brotliCompressSync(body, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 5,
        [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    });
  }
  return gzipSync(body, { level: 6 });
}
