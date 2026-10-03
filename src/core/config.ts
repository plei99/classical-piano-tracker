/**
 * The JSON config file. The on-disk format is shared with the Go build, so
 * field names, aliases, omission rules, and validation messages must match.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { quote, wrap } from './errors';
import { goJSONStringify, sortedRecord } from './gojson';

export const DEFAULT_LLM_PROFILE_NAME = 'openai';
export const DEFAULT_LLM_PROVIDER = 'openai';
export const DEFAULT_LLM_MODEL = 'gpt-5.4';

/** Go's zero `time.Time`, which Go writes for an unset token expiry. */
export const ZERO_TIME = '0001-01-01T00:00:00Z';

export const DEFAULT_PIANISTS_ALLOWLIST: readonly string[] = [
  'Martha Argerich',
  'Vladimir Horowitz',
  'Arthur Rubinstein',
  'Sviatoslav Richter',
  'Emil Gilels',
  'Glenn Gould',
  'Alfred Brendel',
  'Maurizio Pollini',
  'Krystian Zimerman',
  'Evgeny Kissin',
  'Daniil Trifonov',
  'Murray Perahia',
  'Maria Joao Pires',
  'Piotr Anderszewski',
  'Radu Lupu',
  'Claudio Arrau',
  'Wilhelm Kempff',
  'Arturo Benedetti Michelangeli',
  'Alfred Cortot',
  'Dinu Lipatti',
  'Josef Hofmann',
  'Ignaz Friedman',
  'Benno Moiseiwitsch',
  'Walter Gieseking',
  'Myra Hess',
  'Annie Fischer',
  'Alicia de Larrocha',
  'Clara Haskil',
  'Leon Fleisher',
  'Van Cliburn',
  'Byron Janis',
  'Earl Wild',
  'Garrick Ohlsson',
  'Jorge Bolet',
  'Gyorgy Cziffra',
  'Grigory Sokolov',
  'Arcadi Volodos',
  'Nikolai Lugansky',
  'Leif Ove Andsnes',
  'Mitsuko Uchida',
  'Andras Schiff',
  'Stephen Hough',
  'Marc-Andre Hamelin',
  'Igor Levit',
  'Yuja Wang',
  'Seong-Jin Cho',
  'Yunchan Lim',
  'Beatrice Rana',
  'Alexandre Kantorow',
  'Jan Lisiecki',
  'Boris Berezovsky',
  'Denis Matsuev',
  'Paul Lewis',
  'Pierre-Laurent Aimard',
  'Lars Vogt',
  'Jean-Efflam Bavouzet',
  'Wilhelm Backhaus',
  'Samson Francois',
  'Arthur Schnabel',
  'Edwin Fischer',
  'Geza Anda',
  'Lazar Berman',
  'Shura Cherkassky',
  'Josef Lhevinne',
  'Nelson Freire',
  'Nelson Goerner',
  'Angela Hewitt',
  'Behzod Abduraimov',
  'Kirill Gerstein',
  'Emanuel Ax',
  'Barry Douglas',
  'Menahem Pressler',
  'Idil Biret',
  "Fou Ts'ong",
  'Abbey Simon',
  'Pascal Roge',
  'Vladimir Ashkenazy',
  'Yefim Bronfman',
  'Víkingur Ólafsson',
  'Stephen Kovacevich',
  'Lang Lang',
  'Khatia Buniatishvili',
  'Alice Sara Ott',
  'Ivo Pogorelich',
];

/** Persisted OAuth token state. */
export interface Token {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  /**
   * RFC 3339 text exactly as stored (Go writes local-offset nanosecond
   * times), kept verbatim so an unchanged token round-trips byte for byte.
   * {@link ZERO_TIME} means unset.
   */
  expiry: string;
}

export interface SpotifyConfig {
  clientId: string;
  clientSecret: string;
  token: Token | null;
}

/** Settings for one named LLM provider profile. */
export interface LlmProfile {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  /** Executable for the codex and claude_cli providers; empty means look it up on PATH. */
  command: string;
}

export interface LlmConfig {
  activeProfile: string;
  profiles: Record<string, LlmProfile>;
}

/** Local application state and curation filters. */
export interface Config {
  spotify: SpotifyConfig;
  llm: LlmConfig;
  /** Legacy single-key block; only written back when it still holds a key. */
  openai: { apiKey: string };
  pianistsAllowlist: string[];
  artistsBlocklist: string[];
}

/** One or more config validation failures, joined with "; " like Go. */
export class ValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
    this.name = 'ValidationError';
  }
}

export function emptyProfile(overrides: Partial<LlmProfile> = {}): LlmProfile {
  return { provider: '', model: '', apiKey: '', baseUrl: '', command: '', ...overrides };
}

export function emptyConfig(): Config {
  return {
    spotify: { clientId: '', clientSecret: '', token: null },
    llm: { activeProfile: '', profiles: {} },
    openai: { apiKey: '' },
    pianistsAllowlist: [],
    artistsBlocklist: [],
  };
}

export function defaultLlmConfig(): LlmConfig {
  return {
    activeProfile: DEFAULT_LLM_PROFILE_NAME,
    profiles: {
      [DEFAULT_LLM_PROFILE_NAME]: emptyProfile({ provider: DEFAULT_LLM_PROVIDER, model: DEFAULT_LLM_MODEL }),
    },
  };
}

/** The first-run config template written when no file exists yet. */
export function defaultConfig(): Config {
  return { ...emptyConfig(), llm: defaultLlmConfig(), pianistsAllowlist: [...DEFAULT_PIANISTS_ALLOWLIST] };
}

function cloneLlmConfig(cfg: LlmConfig): LlmConfig {
  const profiles: Record<string, LlmProfile> = {};
  for (const [name, profile] of Object.entries(cfg.profiles)) {
    profiles[name] = { ...profile };
  }
  return { activeProfile: cfg.activeProfile, profiles };
}

/**
 * The active provider-agnostic config, synthesizing an OpenAI profile from
 * the legacy openai block when no profiles exist.
 */
export function effectiveLlmConfig(cfg: Config | null): LlmConfig {
  if (cfg === null) {
    return defaultLlmConfig();
  }
  if (Object.keys(cfg.llm.profiles).length > 0) {
    return cloneLlmConfig(cfg.llm);
  }
  const llm = defaultLlmConfig();
  const legacyKey = cfg.openai.apiKey.trim();
  if (legacyKey !== '') {
    llm.profiles[DEFAULT_LLM_PROFILE_NAME]!.apiKey = legacyKey;
  }
  return llm;
}

/** Stores the key on the default OpenAI profile and clears the legacy block. */
export function setDefaultLlmApiKey(cfg: Config, apiKey: string): void {
  const llm = effectiveLlmConfig(cfg);
  const profile = llm.profiles[DEFAULT_LLM_PROFILE_NAME] ?? emptyProfile();
  profile.provider = DEFAULT_LLM_PROVIDER;
  if (profile.model.trim() === '') {
    profile.model = DEFAULT_LLM_MODEL;
  }
  profile.apiKey = apiKey.trim();
  llm.profiles[DEFAULT_LLM_PROFILE_NAME] = profile;
  llm.activeProfile = DEFAULT_LLM_PROFILE_NAME;
  cfg.llm = llm;
  cfg.openai = { apiKey: '' };
}

/** Stores one LLM profile and marks it active. */
export function setLlmProfile(cfg: Config, name: string, profile: LlmProfile): void {
  const trimmed = name.trim();
  if (trimmed === '') {
    return;
  }
  const llm = effectiveLlmConfig(cfg);
  llm.activeProfile = trimmed;
  llm.profiles[trimmed] = profile;
  cfg.llm = llm;
  cfg.openai = { apiKey: '' };
}

/** Milliseconds since the epoch, or null for an unset (zero) expiry. */
export function tokenExpiryMs(token: Token): number | null {
  if (token.expiry === '' || isZeroTime(token.expiry)) {
    return null;
  }
  const ms = Date.parse(token.expiry);
  return Number.isNaN(ms) ? null : ms;
}

function isZeroTime(value: string): boolean {
  return value.startsWith('0001-01-01T00:00:00') && Date.parse(value) === Date.parse(ZERO_TIME);
}

/**
 * Formats a time the way Go marshals `time.Now().Add(...)`: RFC 3339 with
 * the local UTC offset and trailing fractional zeros trimmed.
 */
export function formatGoTime(ms: number): string {
  const date = new Date(ms);
  const offsetMinutes = -date.getTimezoneOffset();
  const local = new Date(ms + offsetMinutes * 60_000);
  const base = local.toISOString().slice(0, 19);
  const millis = local.getUTCMilliseconds();
  const fraction = millis === 0 ? '' : `.${String(millis).padStart(3, '0').replace(/0+$/, '')}`;
  if (offsetMinutes === 0) {
    return `${base}${fraction}Z`;
  }
  const sign = offsetMinutes > 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${base}${fraction}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * Merges a freshly issued token into the persisted one (Go's
 * TokenFromOAuth): when the new token omits refresh data, the previous
 * values are retained.
 */
export function mergeToken(next: Token, previous: Token | null): Token {
  if (previous === null) {
    return { ...next };
  }
  return {
    accessToken: next.accessToken,
    refreshToken: next.refreshToken || previous.refreshToken,
    tokenType: next.tokenType || previous.tokenType,
    expiry: tokenExpiryMs(next) === null ? previous.expiry : next.expiry,
  };
}

// ---- Validation ----

function validateArtists(field: string, artists: string[]): string[] {
  return artists.flatMap((artist, index) => (artist.trim() === '' ? [`${field}[${index}] must not be blank`] : []));
}

function validateLlm(llm: LlmConfig): string[] {
  const names = Object.keys(llm.profiles);
  if (llm.activeProfile === '' && names.length === 0) {
    return [];
  }
  if (llm.activeProfile.trim() === '') {
    return ['llm.active_profile is required when llm.profiles is configured'];
  }
  const active = llm.profiles[llm.activeProfile];
  if (active === undefined) {
    return [`llm.active_profile ${quote(llm.activeProfile)} was not found in llm.profiles`];
  }
  const problems: string[] = [];
  if (active.provider.trim() === '') {
    problems.push(`llm.profiles.${llm.activeProfile}.provider is required`);
  }
  // CLI-backed profiles can defer model selection to the installed CLI.
  const provider = active.provider.trim().toLowerCase();
  if (active.model.trim() === '' && provider !== 'codex' && provider !== 'claude_cli') {
    problems.push(`llm.profiles.${llm.activeProfile}.model is required`);
  }
  // Go ranges over a map here, so its order is random; sorted is deterministic.
  for (const name of [...names].sort()) {
    if (name.trim() === '') {
      problems.push('llm.profiles must not contain blank profile names');
      continue;
    }
    if (llm.profiles[name]!.provider.trim() === '') {
      problems.push(`llm.profiles.${name}.provider is required`);
    }
  }
  return problems;
}

/** Checks required config values; throws a {@link ValidationError}. */
export function validateConfig(cfg: Config): void {
  const problems: string[] = [];
  if (cfg.spotify.clientId.trim() === '') {
    problems.push('spotify.client_id is required');
  }
  if (cfg.spotify.clientSecret.trim() === '') {
    problems.push('spotify.client_secret is required');
  }
  if (cfg.pianistsAllowlist.length === 0) {
    problems.push('pianists_allowlist must contain at least one artist');
  }
  problems.push(...validateArtists('pianists_allowlist', cfg.pianistsAllowlist));
  problems.push(...validateArtists('artists_blocklist', cfg.artistsBlocklist));
  problems.push(...validateLlm(effectiveLlmConfig(cfg)));
  const token = cfg.spotify.token;
  if (token !== null) {
    if (token.accessToken.trim() === '') {
      problems.push('spotify.token.access_token is required when spotify.token is present');
    }
    if (tokenExpiryMs(token) === null) {
      problems.push('spotify.token.expiry is required when spotify.token is present');
    }
  }
  if (problems.length > 0) {
    throw new ValidationError(problems);
  }
}

/** Checks only the Spotify credentials required to start OAuth. */
export function validateClientCredentials(spotify: SpotifyConfig): void {
  const problems: string[] = [];
  if (spotify.clientId.trim() === '') {
    problems.push('spotify.client_id is required');
  }
  if (spotify.clientSecret.trim() === '') {
    problems.push('spotify.client_secret is required');
  }
  if (problems.length > 0) {
    throw new ValidationError(problems);
  }
}

/** Checks the persisted token fields needed to create an authenticated client. */
export function validateStoredToken(spotify: SpotifyConfig): void {
  const token = spotify.token;
  if (token === null) {
    throw new ValidationError(['spotify.token is required']);
  }
  const problems: string[] = [];
  if (token.accessToken.trim() === '') {
    problems.push('spotify.token.access_token is required');
  }
  if (tokenExpiryMs(token) === null) {
    problems.push('spotify.token.expiry is required');
  }
  if (problems.length > 0) {
    throw new ValidationError(problems);
  }
}

// ---- Decoding (mirrors Go's strict json.Decoder with DisallowUnknownFields) ----

type JSONObject = Record<string, unknown>;

class Decoder {
  constructor(private readonly path: string) {}

  object(value: unknown, where: string, allowed: readonly string[]): JSONObject | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`json: cannot unmarshal ${jsonKind(value)} into Go value of type ${where}`);
    }
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        throw new Error(`json: unknown field ${quote(key)}`);
      }
    }
    return value as JSONObject;
  }

  string(obj: JSONObject | null, key: string, where: string): string {
    const value = obj?.[key];
    if (value === undefined || value === null) {
      return '';
    }
    if (typeof value !== 'string') {
      throw new Error(`json: cannot unmarshal ${jsonKind(value)} into Go struct field ${where}.${key} of type string`);
    }
    return value;
  }

  strings(obj: JSONObject, key: string): string[] {
    const value = obj[key];
    if (value === undefined || value === null) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new Error(`json: cannot unmarshal ${jsonKind(value)} into Go struct field Config.${key} of type []string`);
    }
    return value.map((item) => {
      if (typeof item !== 'string') {
        throw new Error(`json: cannot unmarshal ${jsonKind(item)} into Go struct field Config.${key} of type string`);
      }
      return item;
    });
  }

  get file(): string {
    return this.path;
  }
}

function jsonKind(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value === 'object' ? 'object' : typeof value;
}

function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value.trim() !== '') ?? '';
}

/** Parses config JSON text. Exported for tests; use {@link loadConfig}. */
export function parseConfig(text: string, path = 'config.json'): Config {
  const d = new Decoder(path);
  const root = d.object(JSON.parse(text), 'config.Config', [
    'spotify',
    'llm',
    'openai',
    'pianists_allowlist',
    'artists_blocklist',
  ]);
  const cfg = emptyConfig();
  if (root === null) {
    return cfg;
  }

  const spotify = d.object(root['spotify'], 'config.SpotifyConfig', ['client_id', 'client_secret', 'token']);
  cfg.spotify.clientId = d.string(spotify, 'client_id', 'Config.spotify');
  cfg.spotify.clientSecret = d.string(spotify, 'client_secret', 'Config.spotify');
  const token = d.object(spotify?.['token'], 'config.Token', ['access_token', 'refresh_token', 'token_type', 'expiry']);
  if (token !== null) {
    const expiry = d.string(token, 'expiry', 'Config.spotify.token');
    if (expiry !== '' && Number.isNaN(Date.parse(expiry))) {
      throw new Error(`parsing time ${quote(expiry)} as "2006-01-02T15:04:05Z07:00": cannot parse`);
    }
    cfg.spotify.token = {
      accessToken: d.string(token, 'access_token', 'Config.spotify.token'),
      refreshToken: d.string(token, 'refresh_token', 'Config.spotify.token'),
      tokenType: d.string(token, 'token_type', 'Config.spotify.token'),
      expiry: expiry === '' ? ZERO_TIME : expiry,
    };
  }

  const llm = d.object(root['llm'], 'config.LLMConfig', ['active_profile', 'profiles']);
  cfg.llm.activeProfile = d.string(llm, 'active_profile', 'Config.llm');
  const profiles = d.object(llm?.['profiles'], 'map[string]config.LLMProfile', Object.keys(llm?.['profiles'] ?? {}));
  for (const [name, raw] of Object.entries(profiles ?? {})) {
    // Hand-edited configs sometimes use api-key/base-url; accept both.
    const p = d.object(raw, 'config.LLMProfile', [
      'provider',
      'model',
      'api_key',
      'api-key',
      'base_url',
      'base-url',
      'command',
    ]);
    const where = 'profileJSON';
    cfg.llm.profiles[name] = {
      provider: d.string(p, 'provider', where).trim(),
      model: d.string(p, 'model', where).trim(),
      apiKey: firstNonEmpty(d.string(p, 'api_key', where), d.string(p, 'api-key', where)).trim(),
      baseUrl: firstNonEmpty(d.string(p, 'base_url', where), d.string(p, 'base-url', where)).trim(),
      command: d.string(p, 'command', where).trim(),
    };
  }

  const openai = d.object(root['openai'], 'config.OpenAIConfig', ['api_key', 'api-key']);
  cfg.openai.apiKey = firstNonEmpty(
    d.string(openai, 'api_key', 'profileJSON'),
    d.string(openai, 'api-key', 'profileJSON'),
  ).trim();

  cfg.pianistsAllowlist = d.strings(root, 'pianists_allowlist');
  cfg.artistsBlocklist = d.strings(root, 'artists_blocklist');
  return cfg;
}

/**
 * Serializes like Go's MarshalIndent: struct field order, sorted profile
 * names, omitted empty fields, the llm block only when set, and the legacy
 * openai block only when it holds a key.
 */
export function serializeConfig(cfg: Config): string {
  const out: Record<string, unknown> = {};
  const spotify: Record<string, unknown> = {
    client_id: cfg.spotify.clientId,
    client_secret: cfg.spotify.clientSecret,
  };
  if (cfg.spotify.token !== null) {
    const token = cfg.spotify.token;
    spotify['token'] = {
      access_token: token.accessToken,
      ...(token.refreshToken !== '' && { refresh_token: token.refreshToken }),
      ...(token.tokenType !== '' && { token_type: token.tokenType }),
      expiry: token.expiry === '' ? ZERO_TIME : token.expiry,
    };
  }
  out['spotify'] = spotify;

  const profileNames = Object.keys(cfg.llm.profiles);
  if (cfg.llm.activeProfile !== '' || profileNames.length > 0) {
    const llm: Record<string, unknown> = {};
    if (cfg.llm.activeProfile !== '') {
      llm['active_profile'] = cfg.llm.activeProfile;
    }
    if (profileNames.length > 0) {
      const profiles: Record<string, unknown> = {};
      for (const [name, p] of Object.entries(cfg.llm.profiles)) {
        profiles[name] = {
          provider: p.provider,
          ...(p.model !== '' && { model: p.model }),
          ...(p.apiKey !== '' && { api_key: p.apiKey }),
          ...(p.baseUrl !== '' && { base_url: p.baseUrl }),
          ...(p.command !== '' && { command: p.command }),
        };
      }
      llm['profiles'] = sortedRecord(profiles);
    }
    out['llm'] = llm;
  }
  if (cfg.openai.apiKey.trim() !== '') {
    out['openai'] = { api_key: cfg.openai.apiKey };
  }
  out['pianists_allowlist'] = cfg.pianistsAllowlist;
  out['artists_blocklist'] = cfg.artistsBlocklist;
  return `${goJSONStringify(out, '  ')}\n`;
}

// ---- Files ----

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** Reads and decodes a config file from disk. */
export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) {
      throw wrap(
        `config file not found at ${quote(path)}; create it manually for now, or use --config to point to an existing file`,
        'open ' + path + ': no such file or directory',
      );
    }
    throw wrap(`read config ${quote(path)}`, err);
  }
  try {
    return parseConfig(text, path);
  } catch (err) {
    throw wrap(`decode config ${quote(path)}`, err);
  }
}

/** Reads a config file and validates its required fields. */
export function loadAndValidateConfig(path: string): Config {
  const cfg = loadConfig(path);
  try {
    validateConfig(cfg);
  } catch (err) {
    throw wrap(`invalid config ${quote(path)}`, err);
  }
  return cfg;
}

/** Writes the config with an atomic replace and owner-only permissions. */
export function saveConfig(path: string, cfg: Config): void {
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw wrap(`create config directory ${quote(dir)}`, err);
  }
  const data = serializeConfig(cfg);
  const tempPath = join(dir, `.config-${randomBytes(6).toString('hex')}.json`);
  try {
    writeFileSync(tempPath, data, { mode: 0o600, flag: 'wx' });
    renameSync(tempPath, path);
  } catch (err) {
    rmSync(tempPath, { force: true });
    throw wrap(`replace config file ${quote(path)}`, err);
  }
}

/** Creates a default config when none exists. Reports whether one was created. */
export function ensureConfig(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (err) {
    if (!isNotFound(err)) {
      throw wrap(`stat config ${quote(path)}`, err);
    }
  }
  try {
    saveConfig(path, defaultConfig());
  } catch (err) {
    throw wrap(`create default config ${quote(path)}`, err);
  }
  return true;
}

/**
 * The common first-run path (Go's ensureLoadedConfig): writes the default
 * template if missing, then loads. `created` tells callers to stop and ask
 * the user to fill it in.
 */
export function ensureLoadedConfig(path: string): { cfg: Config; created: boolean } {
  const created = ensureConfig(path);
  return { cfg: loadConfig(path), created };
}

// ---- Allowlist/blocklist editing ----

function normalizeArtistName(name: string): string {
  return name.trim().split(/\s+/).join(' ').toLowerCase();
}

/** Appends an artist unless already present (case- and whitespace-insensitive). */
export function addArtist(artists: string[], artist: string): { artists: string[]; added: boolean } {
  const trimmed = artist.trim();
  if (trimmed === '') {
    throw new Error('artist name must not be blank');
  }
  const normalized = normalizeArtistName(trimmed);
  if (artists.some((existing) => normalizeArtistName(existing) === normalized)) {
    return { artists: [...artists], added: false };
  }
  return { artists: [...artists, trimmed], added: true };
}

/** Removes every matching artist (case- and whitespace-insensitive). */
export function removeArtist(artists: string[], artist: string): { artists: string[]; removed: boolean } {
  const trimmed = artist.trim();
  if (trimmed === '') {
    throw new Error('artist name must not be blank');
  }
  const normalized = normalizeArtistName(trimmed);
  const kept = artists.filter((existing) => normalizeArtistName(existing) !== normalized);
  return { artists: kept, removed: kept.length !== artists.length };
}
