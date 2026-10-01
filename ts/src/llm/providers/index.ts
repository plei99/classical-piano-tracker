/**
 * Concrete LLM providers, the factory that picks one from config, and the
 * onboarding model catalog.
 */
import { CLAUDE_CLI_MODELS } from './claudecli';

export { fromConfig } from './factory';
export { listModels } from './catalog';
export { AnthropicProvider } from './anthropic';
export { ClaudeCLIProvider } from './claudecli';
export { CodexProvider } from './codex';
export { GoogleProvider } from './google';
export { OpenAIProvider, newOpenAIFromConfig } from './openai';
export { OpenAICompatProvider } from './openaicompat';
export type { CommandInvocation, CommandResult, CommandRunner } from './command';
export type { HttpOptions } from './http';

/** Fixed model choices for the claude_cli provider (a fresh copy). */
export function claudeCliModels(): string[] {
  return [...CLAUDE_CLI_MODELS];
}
