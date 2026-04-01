# Provider-Agnostic LLM Plan

This document describes how to replace the current OpenAI-specific recommendation client with a provider-agnostic LLM layer that supports:

- OpenAI
- Anthropic
- Google
- Ollama
- Kimi
- DeepSeek

The product scope remains narrow:

- input: `recommend.TasteSummary`
- output: `recommend.DiscoveryResult`

The goal is not to build a general chatbot framework. The goal is to make the pianist recommendation workflow portable across providers while preserving the existing deterministic scoring, Spotify validation, and CLI behavior.

## Goals

- Keep `tracker recommend pianists` as the single user-facing recommendation command.
- Make provider choice configurable without rewriting the recommendation feature for each API.
- Preserve shared prompt construction, JSON parsing, and Spotify validation.
- Support both native providers and OpenAI-compatible providers.
- Keep the implementation testable with mocked HTTP servers.

## Non-Goals

- Building a general-purpose multi-provider chat abstraction for arbitrary tasks.
- Replacing the deterministic recommendation layer.
- Adding track-level generation or fully open-ended music recommendation.
- Requiring live network tests in the automated test suite.

## Design Principles

1. Keep domain logic separate from transport logic.
   - Prompt shaping, JSON parsing, and recommendation validation belong in one shared layer.
   - HTTP request/response handling belongs in provider adapters.

2. Keep the interface narrow.
   - The app only needs structured text generation for one task.
   - Avoid a broad abstraction with unused features.

3. Treat all provider output as untrusted.
   - Even when a provider supports structured outputs, still parse and validate locally.

4. Prefer one compatibility adapter where possible.
   - Ollama, Kimi, and DeepSeek should initially share one OpenAI-compatible transport path.

## Target Package Layout

Create a new `internal/llm/` package hierarchy:

- `internal/llm/doc.go`
- `internal/llm/types.go`
- `internal/llm/client.go`
- `internal/llm/factory.go`
- `internal/llm/discovery.go`
- `internal/llm/providers/openai.go`
- `internal/llm/providers/anthropic.go`
- `internal/llm/providers/google.go`
- `internal/llm/providers/openaicompat.go`

Retire or reduce `internal/openai/` after the migration is complete.

## Responsibilities By Layer

### 1. Discovery Layer

This layer is provider-agnostic. It should:

- accept a `recommend.TasteSummary`
- build the system prompt and user prompt
- define the expected JSON schema or JSON contract
- call the chosen provider
- parse the raw output with `recommend.ParseDiscoveryResult`
- return `recommend.DiscoveryResult`

This layer should not know:

- HTTP endpoints
- authentication header formats
- provider-specific request payload shapes

### 2. Provider Interface Layer

Define a minimal internal interface, for example:

```go
type Provider interface {
    Generate(ctx context.Context, req Request) (string, error)
}
```

Suggested `Request` fields:

- `SystemPrompt string`
- `UserPrompt string`
- `JSONSchema []byte` or `map[string]any`
- `Temperature float64`
- `MaxOutputTokens int`

Optional capability enum:

- `StructuredOutputModeStrict`
- `StructuredOutputModeJSON`
- `StructuredOutputModePromptOnly`

The interface should return raw generated text, not provider-specific envelopes.

### 3. Provider Adapters

Each adapter is responsible for:

- request serialization
- auth headers
- provider endpoint handling
- provider response extraction
- provider-specific error messages

Initial adapter mapping:

- native:
  - OpenAI
  - Anthropic
  - Google
- shared OpenAI-compatible:
  - Ollama
  - Kimi
  - DeepSeek

## Config Design

Replace the current single-provider `openai` config approach with an `llm` block.

Suggested shape:

```json
{
  "llm": {
    "active_profile": "openai",
    "profiles": {
      "openai": {
        "provider": "openai",
        "model": "gpt-5.4",
        "api_key": ""
      },
      "anthropic": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-5",
        "api_key": ""
      },
      "google": {
        "provider": "google",
        "model": "gemini-2.5-pro",
        "api_key": ""
      },
      "ollama": {
        "provider": "openai_compat",
        "model": "qwen2.5:latest",
        "base_url": "http://localhost:11434/v1"
      },
      "deepseek": {
        "provider": "openai_compat",
        "model": "deepseek-chat",
        "base_url": "https://api.deepseek.com/v1",
        "api_key": ""
      },
      "kimi": {
        "provider": "openai_compat",
        "model": "moonshot-v1-8k",
        "base_url": "https://api.moonshot.ai/v1",
        "api_key": ""
      }
    }
  }
}
```

Suggested typed config:

- `LLMConfig`
  - `ActiveProfile string`
  - `Profiles map[string]LLMProfile`
- `LLMProfile`
  - `Provider string`
  - `Model string`
  - `APIKey string`
  - `BaseURL string`

## Environment Variable Policy

Support both config-driven and quick-testing overrides.

Primary generic overrides:

- `LLM_PROFILE`
- `LLM_PROVIDER`
- `LLM_MODEL`
- `LLM_BASE_URL`
- `LLM_API_KEY`

Provider-specific fallback env vars:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_API_KEY`
- `GEMINI_API_KEY`
- `DEEPSEEK_API_KEY`
- `KIMI_API_KEY`

Rules:

- generic `LLM_*` env vars override config
- provider-specific env vars are used when `LLM_API_KEY` is absent
- config is the default source of truth for normal usage

## CLI Design

Keep:

- `tracker recommend pianists`

Add optional flags later if useful:

- `--llm-profile`
- `--llm-model`

Do not create:

- `tracker recommend openai`
- `tracker recommend anthropic`
- provider-specific recommend subcommands

The command should continue to:

1. load config
2. load local tracks and ratings
3. build `TasteSummary`
4. validate data sufficiency
5. call the provider-agnostic discovery client
6. validate suggested pianists through Spotify
7. print validated recommendations

## Implementation Phases

### Phase 1: Introduce `internal/llm` With OpenAI Only

Tasks:

1. Add the provider-agnostic types and interface.
2. Move current OpenAI request-building logic behind the new interface.
3. Keep behavior identical to the current OpenAI path.
4. Update `tracker recommend pianists` to use `internal/llm` instead of `internal/openai`.

Exit criteria:

- current recommendation behavior is unchanged
- existing OpenAI tests still pass after migration

### Phase 2: Add Config Migration Path

Tasks:

1. Add `llm` config types.
2. Preserve backward compatibility with the current `openai` config for at least one migration window.
3. Resolve provider/model/key settings from:
   - CLI overrides
   - generic env vars
   - provider-specific env vars
   - config profiles
4. Update onboarding to optionally collect only the default provider key for now.

Exit criteria:

- existing users do not break immediately
- a new user can configure an LLM profile cleanly

### Phase 3: Add Anthropic and Google Native Adapters

Tasks:

1. Implement Anthropic request/response handling.
2. Implement Google request/response handling.
3. Map each provider’s structured output support into the shared request contract.
4. Reuse the same `DiscoveryResult` parsing path afterward.

Exit criteria:

- Anthropic and Google can both produce valid `DiscoveryResult` values through the same CLI command

### Phase 4: Add OpenAI-Compatible Adapter

Tasks:

1. Implement one OpenAI-compatible provider adapter.
2. Validate it against:
   - Ollama
   - Kimi
   - DeepSeek
3. Handle differences via configuration where possible:
   - base URL
   - model
   - auth requirements

Exit criteria:

- Ollama, Kimi, and DeepSeek work through the same adapter with config-only differences when possible

### Phase 5: Cleanup and Documentation

Tasks:

1. Decide whether `internal/openai/` should be deleted or kept only as a thin wrapper.
2. Update README configuration docs.
3. Add example configs for multiple providers.
4. Add troubleshooting guidance for:
   - malformed JSON output
   - unsupported structured output
   - missing API keys
   - base URL mistakes

Exit criteria:

- README reflects the provider-agnostic architecture
- code no longer implies OpenAI is the only supported backend

## Testing Strategy

### Unit Tests

- request-building tests for the discovery layer
- config resolution tests for profiles and env overrides
- parser tests using shared `recommend.ParseDiscoveryResult`

### Adapter Tests

Use `httptest` to validate:

- auth headers
- payload shape
- output extraction
- provider error handling

### Shared Conformance Tests

For each adapter, validate that:

- valid provider output becomes a valid `DiscoveryResult`
- invalid JSON is rejected cleanly
- empty recommendation arrays are rejected cleanly

### Manual Provider Testing

Manual real-provider validation should cover:

- OpenAI
- Anthropic
- Google
- Ollama
- Kimi
- DeepSeek

For each provider, test:

- successful recommendation generation
- malformed credentials
- unsupported or wrong model name
- empty or invalid output

## Risks and Mitigations

### Risk: Provider APIs differ too much

Mitigation:

- keep the provider interface narrow
- group Ollama/Kimi/DeepSeek behind one compatibility adapter
- normalize only the fields this app actually needs

### Risk: Structured output support varies

Mitigation:

- support strict schema when available
- fall back to JSON-only prompting when necessary
- always run local parsing and validation

### Risk: Config migration becomes messy

Mitigation:

- add profile-based config once
- keep backward compatibility with the old `openai` block temporarily
- document the migration clearly

### Risk: Recommendation quality becomes inconsistent across providers

Mitigation:

- keep one shared prompt contract
- keep Spotify validation unchanged
- compare providers using the same `TasteSummary` inputs during manual testing

## Success Criteria

This project is done when:

- `tracker recommend pianists` can run against all target providers through one architecture
- the provider can be switched through config or env overrides
- deterministic favorites and Spotify validation still work unchanged
- the code no longer treats OpenAI as the only LLM backend
