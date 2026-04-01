package llm

import "context"

// StructuredOutputMode captures how strongly the provider is expected to honor
// the supplied JSON contract.
type StructuredOutputMode string

const (
	StructuredOutputModeStrict     StructuredOutputMode = "strict"
	StructuredOutputModeJSON       StructuredOutputMode = "json"
	StructuredOutputModePromptOnly StructuredOutputMode = "prompt_only"
)

// JSONSchema describes the structured output contract requested from a model.
type JSONSchema struct {
	Name   string
	Schema map[string]any
	Strict bool
}

// Request is the provider-agnostic generation request used by the discovery layer.
type Request struct {
	SystemPrompt    string
	UserPrompt      string
	OutputMode      StructuredOutputMode
	Schema          *JSONSchema
	Temperature     float64
	MaxOutputTokens int
}

// Provider is the minimal generation surface needed by pianist discovery.
type Provider interface {
	Generate(ctx context.Context, req Request) (string, error)
}
