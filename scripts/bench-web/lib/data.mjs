// Benchmark datasets: a snapshot of the sandbox ("real") and a synthetic
// 25,000-track library ("large"), each with an artwork cache that covers every
// track so no build ever asks Spotify for album art.
import { backup, DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const SCHEMA_PATH = new URL('../../../internal/db/schema.sql', import.meta.url).pathname;
const FILES = ['config.json', 'tracker.db', 'artwork-cache.json'];

export function sandboxPath() {
  return execFileSync('tracker-sandbox', ['path'], { encoding: 'utf8' }).trim();
}

/** Copies a prepared dataset into a fresh directory for one server. */
export function freshCopy(masterDir, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const f of FILES) copyFileSync(join(masterDir, f), join(dest, f));
  return { config: join(dest, 'config.json'), db: join(dest, 'tracker.db'), dir: dest };
}

function trackIds(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const ids = db
    .prepare('SELECT spotify_id FROM tracks')
    .all()
    .map((r) => r.spotify_id);
  const count = ids.length;
  db.close();
  return { ids, count };
}

/**
 * Snapshot of the sandbox, taken once per benchmark (SQLite online backup, so a
 * concurrent writer cannot tear it). The sandbox itself is only read. Tracks
 * the sandbox's artwork cache does not cover get placeholder art URLs (which the
 * browser never fetches: every non-local request is blocked), so servers never
 * look art up on Spotify during a run.
 */
export async function prepareReal(dest) {
  const S = sandboxPath();
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const src = new DatabaseSync(join(S, 'tracker.db'), { readOnly: true });
  await backup(src, join(dest, 'tracker.db'));
  src.close();
  copyFileSync(join(S, 'config.json'), join(dest, 'config.json'));
  let cache = { version: 1, artwork: {} };
  try {
    cache = JSON.parse(readFileSync(join(S, 'artwork-cache.json'), 'utf8'));
  } catch {}
  const { ids, count } = trackIds(join(dest, 'tracker.db'));
  let seeded = 0;
  for (const id of ids) {
    if (!(id in cache.artwork)) {
      cache.artwork[id] = placeholderArt(id);
      seeded++;
    }
  }
  writeFileSync(join(dest, 'artwork-cache.json'), JSON.stringify(cache), { mode: 0o600 });
  return { tracks: count, artworkCached: count - seeded, artworkSeeded: seeded };
}

function placeholderArt(key) {
  const h = hashHex(key, 40);
  return {
    small: `https://i.scdn.co/image/ab67616d00004851${h}`,
    medium: `https://i.scdn.co/image/ab67616d00001e02${h}`,
    large: `https://i.scdn.co/image/ab67616d0000b273${h}`,
  };
}

function hashHex(s, len) {
  // FNV-1a, extended; only needs to look like an image hash.
  let out = '';
  let h = 0x811c9dc5;
  while (out.length < len) {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    h = Math.imul(h ^ out.length, 16777619) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, len);
}

// ---- Synthetic library ----

function rng(seed) {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIANISTS = [
  'Martha Argerich',
  'Daniil Trifonov',
  'Yuja Wang',
  'Seong-Jin Cho',
  'Yunchan Lim',
  'Krystian Zimerman',
  'Grigory Sokolov',
  'Igor Levit',
  'Beatrice Rana',
  'Alice Sara Ott',
  'Mikhail Pletnev',
  'András Schiff',
  'Murray Perahia',
  'Maurizio Pollini',
  'Evgeny Kissin',
  'Lang Lang',
  'Hélène Grimaud',
  'Mitsuko Uchida',
  'Benjamin Grosvenor',
  'Bruce Liu',
  'Kate Liu',
  'Eric Lu',
  'Rafał Blechacz',
  'Nobuyuki Tsujii',
  'Arcadi Volodos',
  'Marc-André Hamelin',
  'Stephen Hough',
  'Víkingur Ólafsson',
  'Khatia Buniatishvili',
  'Alexandre Kantorow',
  'Jan Lisiecki',
  'Behzod Abduraimov',
  'Denis Kozhukhin',
  'Lucas Debargue',
  'Kirill Gerstein',
  'Leif Ove Andsnes',
  'Piotr Anderszewski',
  'Paul Lewis',
  'Sviatoslav Richter',
  'Vladimir Horowitz',
  'Arturo Benedetti Michelangeli',
  'Emil Gilels',
  'Glenn Gould',
  'Dinu Lipatti',
];
const ORCHESTRAS = [
  ['Berliner Philharmoniker', 'Kirill Petrenko'],
  ['Mahler Chamber Orchestra', 'Claudio Abbado'],
  ['London Symphony Orchestra', 'Simon Rattle'],
  ['Royal Concertgebouw Orchestra', 'Riccardo Chailly'],
  ['Wiener Philharmoniker', 'Andris Nelsons'],
  ['Orchestre de Paris', 'Klaus Mäkelä'],
];
const KEYS = [
  'C Major',
  'C Minor',
  'C-Sharp Minor',
  'D-Flat Major',
  'D Major',
  'D Minor',
  'E-Flat Major',
  'E Minor',
  'E Major',
  'F Major',
  'F Minor',
  'F-Sharp Minor',
  'G Major',
  'G Minor',
  'A-Flat Major',
  'A Major',
  'A Minor',
  'B-Flat Major',
  'B-Flat Minor',
  'B Minor',
];
const TEMPI = [
  'Allegro',
  'Adagio',
  'Andante',
  'Presto',
  'Allegro con brio',
  'Largo',
  'Andante cantabile',
  'Allegretto',
  'Vivace',
  'Moderato',
  'Lento',
  'Scherzo. Allegro vivace',
  'Rondo. Allegro',
  'Allegro ma non troppo',
];
const COMPOSERS = [
  {
    name: 'Frédéric Chopin',
    short: 'Chopin',
    forms: [
      ['Nocturne', 21, 'Op.'],
      ['Étude', 27, 'Op.'],
      ['Mazurka', 58, 'Op.'],
      ['Ballade', 4, 'Op.'],
      ['Scherzo', 4, 'Op.'],
      ['Prelude', 24, 'Op. 28'],
      ['Waltz', 19, 'Op.'],
      ['Polonaise', 16, 'Op.'],
      ['Piano Sonata', 3, 'Op.', 4],
      ['Piano Concerto', 2, 'Op.', 3],
    ],
  },
  {
    name: 'Ludwig van Beethoven',
    short: 'Beethoven',
    forms: [
      ['Piano Sonata', 32, 'Op.', 3],
      ['Piano Concerto', 5, 'Op.', 3],
      ['Bagatelle', 24, 'Op.'],
      ['Variations', 6, 'WoO'],
    ],
  },
  {
    name: 'Franz Liszt',
    short: 'Liszt',
    forms: [
      ['Hungarian Rhapsody', 19, 'S. 244'],
      ['Transcendental Étude', 12, 'S. 139'],
      ['Consolation', 6, 'S. 172'],
      ['Années de pèlerinage', 26, 'S. 161'],
      ['Piano Sonata', 1, 'S. 178', 1],
    ],
  },
  {
    name: 'Johann Sebastian Bach',
    short: 'Bach, JS',
    forms: [
      ['Prelude and Fugue', 48, 'BWV', 2],
      ['Partita', 6, 'BWV', 7],
      ['English Suite', 6, 'BWV', 6],
      ['French Suite', 6, 'BWV', 7],
      ['Goldberg Variations: Variatio', 30, 'BWV 988'],
    ],
  },
  {
    name: 'Sergei Rachmaninoff',
    short: 'Rachmaninoff',
    forms: [
      ['Prelude', 24, 'Op.'],
      ['Étude-Tableau', 17, 'Op.'],
      ['Piano Concerto', 4, 'Op.', 3],
      ['Piano Sonata', 2, 'Op.', 3],
      ['Moment Musical', 6, 'Op. 16'],
    ],
  },
  {
    name: 'Robert Schumann',
    short: 'Schumann',
    forms: [
      ['Kinderszenen', 13, 'Op. 15'],
      ['Kreisleriana', 8, 'Op. 16'],
      ['Fantasie', 1, 'Op. 17', 3],
      ['Carnaval', 21, 'Op. 9'],
      ['Piano Concerto', 1, 'Op. 54', 3],
    ],
  },
  {
    name: 'Maurice Ravel',
    short: 'Ravel',
    forms: [
      ['Gaspard de la nuit', 1, 'M. 55', 3],
      ['Miroirs', 1, 'M. 43', 5],
      ['Le tombeau de Couperin', 1, 'M. 68', 6],
      ['Piano Concerto in G', 1, 'M. 83', 3],
    ],
  },
  {
    name: 'Claude Debussy',
    short: 'Debussy',
    forms: [
      ['Prélude', 24, 'L.'],
      ['Étude', 12, 'L. 136'],
      ['Images', 2, 'L.', 3],
      ['Suite bergamasque', 1, 'L. 75', 4],
    ],
  },
  {
    name: 'Wolfgang Amadeus Mozart',
    short: 'Mozart',
    forms: [
      ['Piano Sonata', 18, 'K.', 3],
      ['Piano Concerto', 27, 'K.', 3],
      ['Fantasia', 4, 'K.'],
    ],
  },
  {
    name: 'Franz Schubert',
    short: 'Schubert',
    forms: [
      ['Piano Sonata', 21, 'D.', 4],
      ['Impromptu', 8, 'D.'],
      ['Moment musical', 6, 'D. 780'],
    ],
  },
  {
    name: 'Johannes Brahms',
    short: 'Brahms',
    forms: [
      ['Intermezzo', 18, 'Op.'],
      ['Piano Concerto', 2, 'Op.', 3],
      ['Ballade', 4, 'Op. 10'],
      ['Piano Sonata', 3, 'Op.', 4],
    ],
  },
  {
    name: 'Sergei Prokofiev',
    short: 'Prokofiev',
    forms: [
      ['Piano Sonata', 9, 'Op.', 3],
      ['Piano Concerto', 5, 'Op.', 3],
      ['Visions fugitives', 20, 'Op. 22'],
    ],
  },
  {
    name: 'Alexander Scriabin',
    short: 'Scriabin',
    forms: [
      ['Prelude', 24, 'Op. 11'],
      ['Étude', 12, 'Op. 8'],
      ['Piano Sonata', 10, 'Op.', 2],
    ],
  },
];
const plural = (f) =>
  f.endsWith('y')
    ? `${f.slice(0, -1)}ies`
    : f.endsWith('s') ||
        (f.includes(' ') &&
          !/(Sonata|Concerto|Prelude|Étude|Nocturne|Waltz|Ballade|Scherzo|Mazurka|Impromptu|Intermezzo|Polonaise)$/.test(
            f,
          ))
      ? f
      : `${f}s`;
const ALBUM_STYLES = [
  (c, p, f) => `${c.short}: ${plural(f)}`,
  (c, p) => `${p} plays ${c.short}`,
  (c, p, f) => `${c.short}: Complete ${plural(f)}`,
  (c, p) => `Live at Carnegie Hall`,
  (c, p) => `${c.short} Recital (Live)`,
  (c, p) => `Winner of the International ${c.short} Competition (Live)`,
  (c, p) => `${p}: The Complete Recordings`,
  (c, p, f) => `${c.short}: ${plural(f)} & Other Works`,
];
const OPINIONS = [
  '',
  '',
  '',
  'very nice',
  'gorgeous voicing in the middle section',
  'too fast for my taste',
  'the best recording I know',
  'a bit dry',
  'maybe a bit too optimized for local rather than global coherence',
  'wonderful pedalling',
  'rushed coda',
  'live energy carries it',
  'not his strongest',
  'reference recording',
];

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Writes the synthetic dataset (deterministic for a given seed) into `dest`. */
export function generateSynthetic(dest, { tracks: total = 25000, seed = 42, ratedShare = 0.08 } = {}) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const dbPath = join(dest, 'tracker.db');
  const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  const insert = db.prepare(
    'INSERT INTO tracks (spotify_id, track_name, album_name, artists, play_count, last_played_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const rate = db.prepare('INSERT INTO ratings (track_id, stars, opinion, updated_at) VALUES (?, ?, ?, ?)');
  const end = Date.UTC(2026, 8, 30) / 1000; // fixed, so the data does not depend on today
  const span = 2 * 365 * 86400;
  const seenIds = new Set();
  const seenTitles = new Set();
  const albums = new Map(); // album name -> art key
  const artwork = {};
  db.exec('BEGIN');
  let n = 0;
  let rated = 0;
  while (n < total) {
    const c = pick(COMPOSERS);
    const [form, count, cat, movements = 0] = pick(c.forms);
    const no = 1 + Math.floor(rand() * count);
    const key = pick(KEYS);
    const opus = cat.includes(' ') ? cat : `${cat} ${1 + Math.floor(rand() * 120)}`;
    let title = count > 1 ? `${form} No. ${no} in ${key}, ${opus}` : `${form}, ${opus}`;
    if (movements > 0) {
      const m = 1 + Math.floor(rand() * movements);
      title += `: ${['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][m - 1]}. ${pick(TEMPI)}`;
    }
    const pianist = pick(PIANISTS);
    if (seenTitles.has(title + pianist)) continue;
    seenTitles.add(title + pianist);
    const artists = [c.name, pianist];
    if (form.includes('Concerto')) artists.push(...pick(ORCHESTRAS));
    const album = ALBUM_STYLES[Math.floor(rand() * ALBUM_STYLES.length)](c, pianist, form);
    let id;
    do {
      id = '';
      for (let i = 0; i < 22; i++) id += BASE62[Math.floor(rand() * 62)];
    } while (seenIds.has(id));
    seenIds.add(id);
    // Mostly single listens, a long tail of favourites.
    const plays = Math.min(250, 1 + Math.floor(-Math.log(1 - rand()) * (rand() < 0.15 ? 12 : 1.5)));
    const created = Math.floor(end - span * Math.pow(rand(), 0.7));
    const last = Math.min(end, created + Math.floor(rand() * (end - created)));
    const r = insert.run(id, title, album, JSON.stringify(artists), plays, last, created);
    if (rand() < ratedShare) {
      const stars = [1, 2, 3, 3, 4, 4, 4, 5, 5, 5][Math.floor(rand() * 10)];
      rate.run(Number(r.lastInsertRowid), stars, pick(OPINIONS), last + Math.floor(rand() * 86400));
      rated++;
    }
    const artKey = albums.get(album + pianist) ?? `${album}|${pianist}`;
    albums.set(album + pianist, artKey);
    artwork[id] = rand() < 0.02 ? null : placeholderArt(artKey);
    n++;
  }
  db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?)').run('recent_played_checkpoint', end * 1e9);
  db.exec('COMMIT');
  db.exec('VACUUM');
  db.close();
  writeFileSync(join(dest, 'artwork-cache.json'), JSON.stringify({ version: 1, artwork }), { mode: 0o600 });
  // No Spotify token: nothing in this run may reach Spotify. The allowlist is
  // the synthetic pianists (filters apply to syncs, not to the web UI).
  const config = {
    spotify: { client_id: 'bench-placeholder', client_secret: 'bench-placeholder' },
    llm: { active_profile: '', profiles: {} },
    pianists_allowlist: PIANISTS,
    artists_blocklist: [],
  };
  writeFileSync(join(dest, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
  return { tracks: n, rated, albums: albums.size, seed };
}

/** Generates once; later runs reuse the files when they match the requested size and seed. */
export function ensureSynthetic(dest, opts = {}) {
  const meta = join(dest, 'meta.json');
  const want = {
    tracks: opts.tracks ?? 25000,
    seed: opts.seed ?? 42,
    schema: readFileSync(SCHEMA_PATH, 'utf8').length,
  };
  if (!opts.regen && existsSync(meta)) {
    const have = JSON.parse(readFileSync(meta, 'utf8'));
    if (have.tracks === want.tracks && have.seed === want.seed && have.schema === want.schema) return have;
  }
  const info = generateSynthetic(dest, { tracks: want.tracks, seed: want.seed });
  const out = { ...info, ...want };
  writeFileSync(meta, JSON.stringify(out, null, 2));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dest = process.argv[2] ?? new URL('../results/data/large', import.meta.url).pathname;
  console.log(ensureSynthetic(dest, { regen: true }));
}
