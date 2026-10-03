import { wrap } from '../core/errors';
import {
  type DiscoveryResult,
  type SuggestedPianist,
  type TasteSummary,
  parseDiscoveryPartial,
  parseDiscoveryRecommendations,
  parseDiscoveryResult,
  parsePlaintextRecommendations,
  parseTasteSummary,
  validateDiscoveryInput,
} from '../recommend';
import { goTrimSpace } from '../recommend/gostrings';
import {
  buildDiscoveryPlaintextRecommendationsRequest,
  buildDiscoveryRecommendationsOnlyRequest,
  buildDiscoveryRepairRequest,
  buildDiscoveryRequest,
  buildTasteSummaryRequest,
} from './discovery';
import type { Provider } from './index';

const MAX_DISCOVERY_REPAIR_ATTEMPTS = 3;
const DEFAULT_DISCOVERY_LIMIT = 5;

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function attempt<T>(fn: () => T): Outcome<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

async function attemptAsync<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldRepairDiscoveryResponse(error: unknown): boolean {
  const message = messageOf(error);
  return ['omitted summary', 'omitted recommendations', 'omitted pianist_name', 'omitted why_fit'].some((needle) =>
    message.includes(needle),
  );
}

function shouldFallbackRecommendationRecovery(error: unknown): boolean {
  const message = messageOf(error);
  return ['omitted recommendations', 'omitted pianist_name', 'omitted why_fit'].some((needle) =>
    message.includes(needle),
  );
}

/** The summary of a partial parse, when it has a non-blank one. */
function partialSummary(raw: string): string | null {
  const partial = attempt(() => parseDiscoveryPartial(raw));
  return partial.ok && goTrimSpace(partial.value.summary) !== '' ? partial.value.summary : null;
}

/** Wraps one provider and exposes the app's recommendation tasks. */
export class Client {
  constructor(private readonly provider: Provider) {
    // Parity with Go's NewClient nil check for untyped callers.
    if ((provider as Provider | null | undefined) == null) {
      throw new Error('LLM provider is required');
    }
  }

  /**
   * Builds the shared discovery request, calls the provider, and parses the
   * result back into recommendation types.
   *
   * Models often return a summary but drop or mangle the recommendations,
   * so an incomplete answer goes through up to three repair passes, then a
   * recommendations-only request, then a plaintext line-format request.
   */
  async suggestNewPianists(summary: TasteSummary, limit: number, signal?: AbortSignal): Promise<DiscoveryResult> {
    validateDiscoveryInput(summary);
    if (limit < 1) {
      limit = DEFAULT_DISCOVERY_LIMIT;
    }

    const req = buildDiscoveryRequest(summary, limit);
    let raw = await this.provider.generate(req, signal);

    let lastSummary = '';
    let outcome = attempt(() => parseDiscoveryResult(raw));
    lastSummary = partialSummary(raw) ?? lastSummary;

    for (
      let pass = 0;
      !outcome.ok && shouldRepairDiscoveryResponse(outcome.error) && pass < MAX_DISCOVERY_REPAIR_ATTEMPTS;
      pass++
    ) {
      const repaired = await attemptAsync(() =>
        this.provider.generate(buildDiscoveryRepairRequest(raw, limit, pass + 1), signal),
      );
      if (!repaired.ok) {
        break;
      }
      raw = repaired.value;
      outcome = attempt(() => parseDiscoveryResult(raw));
      lastSummary = partialSummary(raw) ?? lastSummary;
    }

    if (!outcome.ok && shouldFallbackRecommendationRecovery(outcome.error)) {
      const summaryText = partialSummary(raw) ?? lastSummary;
      if (goTrimSpace(summaryText) !== '') {
        const recommendations = await this.recoverRecommendations(summary, limit, signal);
        if (recommendations !== null) {
          outcome = { ok: true, value: { summary: summaryText, recommendations } };
        }
      }
    }

    if (!outcome.ok) {
      throw wrap('parse LLM discovery response', outcome.error);
    }
    const result = outcome.value;
    if (result.recommendations.length > limit) {
      result.recommendations = result.recommendations.slice(0, limit);
    }
    return result;
  }

  /** Asks for a summary-only description of the current taste profile. */
  async summarizeTaste(summary: TasteSummary, signal?: AbortSignal): Promise<string> {
    const req = buildTasteSummaryRequest(summary);
    const raw = await this.provider.generate(req, signal);
    try {
      return parseTasteSummary(raw);
    } catch (err) {
      throw wrap('parse LLM taste summary response', err);
    }
  }

  /**
   * Fallbacks for a provider whose full-object answers keep collapsing into
   * summary-only JSON: first a recommendations-only structured request,
   * then a rigid plaintext line format. Failures are swallowed so the caller
   * reports the original parse error.
   */
  private async recoverRecommendations(
    summary: TasteSummary,
    limit: number,
    signal: AbortSignal | undefined,
  ): Promise<SuggestedPianist[] | null> {
    const structuredReq = attempt(() => buildDiscoveryRecommendationsOnlyRequest(summary, limit));
    if (structuredReq.ok) {
      const raw = await attemptAsync(() => this.provider.generate(structuredReq.value, signal));
      if (raw.ok) {
        const parsed = attempt(() => parseDiscoveryRecommendations(raw.value));
        if (parsed.ok) {
          return parsed.value;
        }
      }
    }

    const plainReq = attempt(() => buildDiscoveryPlaintextRecommendationsRequest(summary, limit));
    if (plainReq.ok) {
      const raw = await attemptAsync(() => this.provider.generate(plainReq.value, signal));
      if (raw.ok) {
        const parsed = attempt(() => parsePlaintextRecommendations(raw.value));
        if (parsed.ok) {
          return parsed.value;
        }
      }
    }
    return null;
  }
}
