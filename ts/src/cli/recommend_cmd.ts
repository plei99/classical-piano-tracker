/**
 * `tracker recommend`: the deterministic favorites/profile views and the
 * LLM-backed summary and discovery flows, kept under one namespace without
 * mixing their implementation details. The recommend, llm, and spotify
 * modules load lazily, so other commands never pay for them.
 */
import { type Config, ensureLoadedConfig } from '../core/config';
import { quote, wrap } from '../core/errors';
import type { Rating, Track } from '../core/model';
import type { Client as LlmClient } from '../llm';
import type { TasteSummary } from '../recommend';
import { type Context, createdConfigError, spotifyClient, validateSyncConfig, withDb } from './context';
import {
  outputWidth,
  printFavoritePianists,
  printTasteProfile,
  printValidatedPianists,
  printWrappedField,
} from './format';

export async function runRecommendFavorites(ctx: Context, limit: number): Promise<void> {
  if (limit < 1) {
    throw new Error(`limit must be at least 1, got ${limit}`);
  }
  const cfg = loadRecommendationConfig(ctx);
  if (cfg.pianistsAllowlist.length === 0) {
    throw new Error('config has an empty pianists_allowlist');
  }

  const { tracks, ratings } = await loadRecommendationData(ctx);
  const { buildPianistProfiles } = await import('../recommend');
  const profiles = buildPianistProfiles(tracks, ratings, cfg.pianistsAllowlist);
  if (profiles.length === 0) {
    ctx.out.write('no favorite pianists could be derived from the local database\n');
    return;
  }
  printFavoritePianists(ctx.out, profiles.slice(0, limit));
}

export async function runRecommendProfile(ctx: Context): Promise<void> {
  const { summary } = await loadTasteSummary(ctx);
  printTasteProfile(ctx.out, summary);
}

export async function runRecommendSummary(ctx: Context): Promise<void> {
  const { cfg, summary } = await loadTasteSummary(ctx);
  const { validateDiscoveryInput } = await import('../recommend');
  try {
    validateDiscoveryInput(summary);
  } catch (err) {
    throw wrap('not enough local rating data for taste summary generation yet', err);
  }

  const llm = await newRecommendationLlmClient(cfg);
  const text = await llm.summarizeTaste(summary);
  printWrappedField(ctx.out, 'Summary: ', '', text, outputWidth(ctx.out));
}

export async function runRecommendPianists(ctx: Context, limit: number): Promise<void> {
  if (limit < 1) {
    throw new Error(`limit must be at least 1, got ${limit}`);
  }

  const configPath = ctx.opts.resolveConfigPath();
  const { cfg, created } = ensureLoadedConfig(configPath);
  if (created) {
    throw createdConfigError(
      configPath,
      `set spotify.client_id and spotify.client_secret, run \`tracker --config ${quote(configPath)} spotify login\`, then rerun this command`,
    );
  }
  if (cfg.pianistsAllowlist.length === 0) {
    throw new Error(`config ${quote(configPath)} has an empty pianists_allowlist`);
  }
  validateSyncConfig(cfg, configPath);

  const { tracks, ratings } = await loadRecommendationData(ctx);
  const recommend = await import('../recommend');
  const summary = recommend.buildTasteSummary(tracks, ratings, cfg.pianistsAllowlist);
  try {
    recommend.validateDiscoveryInput(summary);
  } catch (err) {
    throw wrap('not enough local rating data for pianist recommendations yet', err);
  }

  const llm = await newRecommendationLlmClient(cfg);
  const discovery = await llm.suggestNewPianists(summary, discoveryRequestLimit(limit));

  const spotify = await spotifyClient(cfg, configPath);
  const validated = (
    await recommend.validateSuggestedPianists(
      spotify,
      summary.knownPianists,
      discovery.recommendations,
      discoverySearchLimit(limit),
    )
  ).slice(0, limit);

  if (validated.length === 0) {
    ctx.out.write(`Summary: ${discovery.summary}\n`);
    ctx.out.write('No validated pianist recommendations were found.\n');
    return;
  }
  printValidatedPianists(ctx.out, discovery.summary, validated);
}

/** Keeps the recommendation commands on the same first-run semantics as the rest of the CLI. */
function loadRecommendationConfig(ctx: Context): Config {
  return ensureLoadedConfig(ctx.opts.resolveConfigPath()).cfg;
}

/**
 * Reads the complete local corpus: recommendation scoring needs every track
 * and rating, not a paginated subset.
 */
async function loadRecommendationData(ctx: Context): Promise<{ tracks: Track[]; ratings: Rating[] }> {
  return withDb(ctx.opts.resolveDbPath(), (db) => {
    let tracks: Track[];
    try {
      tracks = db.listAllTracks();
    } catch (err) {
      throw wrap('list all tracks', err);
    }
    let ratings: Rating[];
    try {
      ratings = db.listAllRatings();
    } catch (err) {
      throw wrap('list all ratings', err);
    }
    return { tracks, ratings };
  });
}

async function loadTasteSummary(ctx: Context): Promise<{ cfg: Config; summary: TasteSummary }> {
  const cfg = loadRecommendationConfig(ctx);
  if (cfg.pianistsAllowlist.length === 0) {
    throw new Error('config has an empty pianists_allowlist');
  }
  const { tracks, ratings } = await loadRecommendationData(ctx);
  const { buildTasteSummary } = await import('../recommend');
  return { cfg, summary: buildTasteSummary(tracks, ratings, cfg.pianistsAllowlist) };
}

async function newRecommendationLlmClient(cfg: Config): Promise<LlmClient> {
  const [{ Client }, { fromConfig }] = await Promise.all([import('../llm'), import('../llm/providers')]);
  return new Client(fromConfig(cfg));
}

/** Over-requests suggestions, leaving headroom for ones Spotify validation drops. */
export function discoveryRequestLimit(limit: number): number {
  if (limit < 5) {
    return 10;
  }
  return limit * 2;
}

export function discoverySearchLimit(limit: number): number {
  return limit < 5 ? 5 : limit;
}
