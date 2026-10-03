/**
 * Provider-agnostic LLM access for taste summaries and pianist discovery.
 */

/** How strongly the provider is expected to honor the supplied JSON contract. */
export type StructuredOutputMode = 'strict' | 'json' | 'prompt_only';

/** Structured output contract requested from a model. */
export interface JSONSchema {
  name: string;
  /** A Go `map[string]any`: providers encode it with sorted keys. */
  schema: Record<string, unknown>;
  strict: boolean;
}

/** The provider-agnostic generation request used by the discovery layer. */
export interface Request {
  systemPrompt: string;
  userPrompt: string;
  outputMode: StructuredOutputMode;
  schema: JSONSchema | null;
  /** 0 means "provider default", as with Go's zero value. */
  temperature: number;
  /** 0 means "provider default", as with Go's zero value. */
  maxOutputTokens: number;
}

/** Minimal generation surface needed by discovery. */
export interface Provider {
  generate(req: Request, signal?: AbortSignal): Promise<string>;
}

export { Client } from './client';
export { CanceledError, DeadlineExceededError, contextError } from './context';
