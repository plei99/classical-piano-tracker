import { describe, expect, it } from 'vitest';

import { decodeArtists, encodeArtists, formatArtists } from './artists';
import { goJSONStringify, sortedRecord } from './gojson';
import { configPathFromConfigDir, dataDirForOS } from './paths';

describe('artists', () => {
  it.each([
    '["Frédéric Chopin","Martha Argerich"]',
    '["Solo"]',
    '["Quote \\"Inside\\"","Back\\\\slash"]',
    '[ "Spaced" , "Out" ]',
    '["A","B"] trailing',
    '[]',
    'not json',
    '',
    '["",""]',
    '["a\\u00e9"]',
  ])('format matches JSON decoding for %s', (raw) => {
    let want = raw;
    try {
      const artists = JSON.parse(raw) as string[];
      if (Array.isArray(artists) && artists.length > 0) want = artists.join(', ');
    } catch {
      // keep raw
    }
    expect(formatArtists(raw)).toBe(want);
  });

  it('encodes like Go json.Marshal and round-trips', () => {
    expect(encodeArtists(['A', 'B'])).toBe('["A","B"]');
    expect(encodeArtists(['Tom & Jerry <3'])).toBe('["Tom \\u0026 Jerry \\u003c3"]');
    const names = ['Víkingur Ólafsson', 'Quote "x"'];
    expect(decodeArtists(encodeArtists(names))).toEqual(names);
  });
});

describe('gojson', () => {
  it('escapes HTML-sensitive characters like Go', () => {
    expect(goJSONStringify({ a: '<b>&\u2028' })).toBe('{"a":"\\u003cb\\u003e\\u0026\\u2028"}');
  });

  it('sorts keys bytewise like Go maps', () => {
    expect(Object.keys(sortedRecord({ b: 1, a: 2, Z: 3, é: 4 }))).toEqual(['Z', 'a', 'b', 'é']);
  });
});

describe('paths', () => {
  it('chooses the data dir per platform', () => {
    const env = (pairs: Record<string, string>) => (key: string) => pairs[key];
    expect(dataDirForOS('darwin', '/h', env({}))).toBe('/h/Library/Application Support/piano-tracker');
    expect(dataDirForOS('linux', '/h', env({ XDG_DATA_HOME: '/xdg' }))).toBe('/xdg/piano-tracker');
    expect(dataDirForOS('linux', '/h', env({}))).toBe('/h/.local/share/piano-tracker');
    expect(dataDirForOS('win32', '/h', env({ LOCALAPPDATA: 'C:/Local' }))).toBe('C:/Local/piano-tracker');
    expect(dataDirForOS('win32', '/h', env({ APPDATA: 'C:/Roaming' }))).toBe('C:/Roaming/piano-tracker');
    expect(configPathFromConfigDir('/tmp/c')).toBe('/tmp/c/piano-tracker/config.json');
  });
});
