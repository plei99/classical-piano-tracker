import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type Config,
  DEFAULT_LLM_MODEL,
  DEFAULT_PIANISTS_ALLOWLIST,
  ValidationError,
  addArtist,
  defaultLlmConfig,
  emptyConfig,
  emptyProfile,
  effectiveLlmConfig,
  ensureConfig,
  formatGoTime,
  loadConfig,
  mergeToken,
  parseConfig,
  removeArtist,
  saveConfig,
  serializeConfig,
  setDefaultLlmApiKey,
  setLlmProfile,
  tokenExpiryMs,
  validateConfig,
} from './config';

function tempConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'tracker-config-')), 'piano-tracker', 'config.json');
}

function sampleConfig(): Config {
  return {
    spotify: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      token: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        tokenType: 'Bearer',
        expiry: '2026-03-31T12:00:00Z',
      },
    },
    llm: {
      activeProfile: 'openai',
      profiles: { openai: emptyProfile({ provider: 'openai', model: 'gpt-5.4', apiKey: 'openai-key' }) },
    },
    openai: { apiKey: '' },
    pianistsAllowlist: ['Martha Argerich', 'Daniil Trifonov'],
    artistsBlocklist: ['Yiruma'],
  };
}

function problemsOf(fn: () => void): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ValidationError) return err.problems;
    throw err;
  }
  return [];
}

describe('config files', () => {
  it('saves and loads a round trip with private permissions', () => {
    const path = tempConfigPath();
    saveConfig(path, sampleConfig());
    expect(loadConfig(path)).toEqual(sampleConfig());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  });

  it('ensure creates the default template once', () => {
    const path = tempConfigPath();
    expect(ensureConfig(path)).toBe(true);
    const cfg = loadConfig(path);
    expect(cfg.pianistsAllowlist).toEqual(DEFAULT_PIANISTS_ALLOWLIST);
    expect(cfg.artistsBlocklist).toEqual([]);
    expect(cfg.llm).toEqual(defaultLlmConfig());
    expect(readFileSync(path, 'utf8')).not.toContain('"openai": {\n    "api_key"');
    expect(ensureConfig(path)).toBe(false);
  });

  it('reports a missing config actionably', () => {
    expect(() => loadConfig(tempConfigPath())).toThrow(/config file not found.*--config/);
  });

  it.each([
    '{"spotify":{"client_id":"x","client_secret":"y"},"extra":true}',
    '{"spotify":{"client_id":"x","mystery":"y"}}',
    '{"llm":{"profiles":{"openai":{"provider":"openai","bogus":1}}}}',
    '{"spotify":{}} {"spotify":{}}',
    '{"spotify":{"client_id":5}}',
  ])('rejects unknown fields and bad JSON: %s', (body) => {
    const path = tempConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    expect(() => loadConfig(path)).toThrow(/decode config/);
  });

  it('accepts hyphenated aliases and writes canonical names', () => {
    const path = tempConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      '{"llm":{"active_profile":"ollama","profiles":{"ollama":{"provider":" openai_compat ","model":"qwen","api-key":" k ","base-url":"http://localhost:11434/v1"}}},"openai":{"api-key":"legacy"},"pianists_allowlist":["A"],"artists_blocklist":[]}',
    );
    const cfg = loadConfig(path);
    expect(cfg.llm.profiles['ollama']).toEqual(
      emptyProfile({ provider: 'openai_compat', model: 'qwen', apiKey: 'k', baseUrl: 'http://localhost:11434/v1' }),
    );
    expect(cfg.openai.apiKey).toBe('legacy');
    saveConfig(path, cfg);
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('"api_key": "k"');
    expect(raw).toContain('"base_url"');
    expect(raw).not.toMatch(/api-key|base-url/);
  });

  it('round-trips a Go-written config byte for byte', () => {
    // Shape, escaping, and nanosecond local-offset time exactly as Go writes them.
    const goWritten = `{
  "spotify": {
    "client_id": "id",
    "client_secret": "secret",
    "token": {
      "access_token": "a\\u0026b",
      "refresh_token": "r",
      "token_type": "Bearer",
      "expiry": "2026-09-01T22:39:57.365323+08:00"
    }
  },
  "llm": {
    "active_profile": "claude_cli",
    "profiles": {
      "claude_cli": {
        "provider": "claude_cli",
        "model": "sonnet",
        "command": "/usr/local/bin/claude"
      },
      "anthropic": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6"
      }
    }
  },
  "pianists_allowlist": [
    "Martha Argerich"
  ],
  "artists_blocklist": []
}
`;
    const cfg = parseConfig(goWritten);
    expect(cfg.spotify.token?.accessToken).toBe('a&b');
    expect(tokenExpiryMs(cfg.spotify.token!)).toBe(Date.parse('2026-09-01T14:39:57.365Z'));
    validateConfig(cfg);
    // Go sorts map keys, so "anthropic" comes first when written back.
    const expected = goWritten.replace(
      /("profiles": \{\n)([\s\S]*?\n {6}\},\n)( {6}"anthropic": \{\n[\s\S]*?\n {6}\})\n/,
      (_, open: string, claude: string, anthropic: string) =>
        `${open}${anthropic},\n${claude.replace(/\},\n$/, '}\n')}`,
    );
    expect(serializeConfig(cfg)).toBe(expected);
  });

  it('treats the zero time as an unset expiry', () => {
    const cfg = parseConfig('{"spotify":{"token":{"access_token":"a","expiry":"0001-01-01T00:00:00Z"}}}');
    expect(tokenExpiryMs(cfg.spotify.token!)).toBeNull();
    expect(serializeConfig(cfg)).toContain('"expiry": "0001-01-01T00:00:00Z"');
  });
});

describe('validation', () => {
  it('rejects missing required fields', () => {
    expect(problemsOf(() => validateConfig(emptyConfig()))).toEqual([
      'spotify.client_id is required',
      'spotify.client_secret is required',
      'pianists_allowlist must contain at least one artist',
    ]);
  });

  it('rejects an invalid token and blank artists', () => {
    const cfg = sampleConfig();
    cfg.spotify.token = { accessToken: '', refreshToken: '', tokenType: '', expiry: '0001-01-01T00:00:00Z' };
    cfg.pianistsAllowlist.push('  ');
    cfg.artistsBlocklist.push('');
    expect(problemsOf(() => validateConfig(cfg))).toEqual([
      'pianists_allowlist[2] must not be blank',
      'artists_blocklist[1] must not be blank',
      'spotify.token.access_token is required when spotify.token is present',
      'spotify.token.expiry is required when spotify.token is present',
    ]);
  });

  it('lets CLI-backed profiles defer the model', () => {
    for (const provider of ['codex', 'claude_cli']) {
      const cfg = sampleConfig();
      setLlmProfile(cfg, provider, emptyProfile({ provider }));
      validateConfig(cfg);
    }
    const cfg = sampleConfig();
    setLlmProfile(cfg, 'anthropic', emptyProfile({ provider: 'anthropic' }));
    expect(problemsOf(() => validateConfig(cfg))).toEqual(['llm.profiles.anthropic.model is required']);
  });
});

describe('LLM config helpers', () => {
  it('synthesizes a profile from the legacy openai block', () => {
    const cfg = emptyConfig();
    cfg.openai.apiKey = ' legacy ';
    const llm = effectiveLlmConfig(cfg);
    expect(llm.activeProfile).toBe('openai');
    expect(llm.profiles['openai']?.apiKey).toBe('legacy');
    expect(llm.profiles['openai']?.model).toBe(DEFAULT_LLM_MODEL);
  });

  it('setDefaultLlmApiKey writes llm and clears the legacy block', () => {
    const cfg = emptyConfig();
    cfg.openai.apiKey = 'old';
    setDefaultLlmApiKey(cfg, ' new ');
    expect(cfg.llm.profiles['openai']?.apiKey).toBe('new');
    expect(cfg.openai.apiKey).toBe('');
    expect(serializeConfig(cfg)).not.toContain('"openai": {\n    "api_key"');
  });
});

describe('tokens', () => {
  it('merging keeps refresh data the new token omits', () => {
    const previous = {
      accessToken: 'old',
      refreshToken: 'refresh',
      tokenType: 'Bearer',
      expiry: '2026-01-01T00:00:00Z',
    };
    expect(mergeToken({ accessToken: 'new', refreshToken: '', tokenType: '', expiry: '' }, previous)).toEqual({
      ...previous,
      accessToken: 'new',
    });
  });

  it('formats times like Go: local offset, trimmed fraction', () => {
    const formatted = formatGoTime(Date.parse('2026-09-01T14:39:57.360Z'));
    expect(Date.parse(formatted)).toBe(Date.parse('2026-09-01T14:39:57.360Z'));
    expect(formatted).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:57\.36(Z|[+-]\d\d:\d\d)$/);
  });
});

describe('artist lists', () => {
  it('adds with trimming and case-insensitive dedupe', () => {
    expect(addArtist(['Martha Argerich'], '  martha   ARGERICH ')).toEqual({
      artists: ['Martha Argerich'],
      added: false,
    });
    expect(addArtist(['Martha Argerich'], ' Igor Levit ')).toEqual({
      artists: ['Martha Argerich', 'Igor Levit'],
      added: true,
    });
    expect(() => addArtist([], '   ')).toThrow('artist name must not be blank');
  });

  it('removes every case-insensitive match', () => {
    const artists = ['Martha Argerich', 'Igor Levit', 'martha argerich'];
    expect(removeArtist(artists, 'MARTHA  argerich')).toEqual({ artists: ['Igor Levit'], removed: true });
    expect(removeArtist(artists, 'Nobody').removed).toBe(false);
  });
});
