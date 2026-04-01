package llm

import (
	"encoding/json"
	"fmt"

	"github.com/plei99/classical-piano-tracker/internal/recommend"
)

// buildDiscoveryRequest owns the shared prompt and JSON contract for pianist discovery.
func buildDiscoveryRequest(summary recommend.TasteSummary, limit int) (Request, error) {
	summaryJSON, err := json.MarshalIndent(summary, "", "  ")
	if err != nil {
		return Request{}, fmt.Errorf("marshal taste summary: %w", err)
	}
	minRecommendations := minimumDiscoveryRecommendations(limit)

	return Request{
		SystemPrompt: "You are a classical piano recommendation assistant. Recommend real classical concert pianists, not tracks. Ground every recommendation in the supplied ratings and comments. Do not recommend pianists already listed in known_pianists. A valid answer must include both a non-empty summary and a non-empty recommendations list.",
		UserPrompt:   fmt.Sprintf("Use this taste profile JSON to recommend %d new pianists.\nReturn a complete JSON object with a summary and a recommendations array. The recommendations array must contain at least %d and at most %d pianist objects.\n\n%s", limit, minRecommendations, limit, string(summaryJSON)),
		OutputMode:   StructuredOutputModeStrict,
		Schema: &JSONSchema{
			Name: "pianist_discovery",
			Schema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"summary": map[string]any{
						"type":      "string",
						"minLength": 1,
					},
					"recommendations": map[string]any{
						"type":     "array",
						"minItems": minRecommendations,
						"maxItems": limit,
						"items": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"pianist_name": map[string]any{"type": "string", "minLength": 1},
								"why_fit":      map[string]any{"type": "string", "minLength": 1},
								"similar_to": map[string]any{
									"type":  "array",
									"items": map[string]any{"type": "string"},
								},
								"confidence": map[string]any{"type": "string", "minLength": 1},
							},
							"required":             []string{"pianist_name", "why_fit", "similar_to", "confidence"},
							"additionalProperties": false,
						},
					},
				},
				"required":             []string{"summary", "recommendations"},
				"additionalProperties": false,
			},
			Strict: true,
		},
	}, nil
}

// buildDiscoveryRepairRequest asks the provider to rewrite an incomplete first
// pass into a complete object that matches the original discovery schema.
func buildDiscoveryRepairRequest(raw string, limit int, attempt int) Request {
	if limit < 1 {
		limit = 5
	}
	minRecommendations := minimumDiscoveryRecommendations(limit)

	req, _ := buildDiscoveryRequest(recommend.TasteSummary{}, limit)
	req.SystemPrompt = "You repair incomplete JSON responses for a classical piano recommendation task. Return only a complete JSON object that matches the required schema."
	req.UserPrompt = fmt.Sprintf("Repair attempt %d.\nThe previous response was incomplete or malformed, and often omits the recommendations array entirely.\nRewrite it into a valid JSON object with a non-empty summary and a recommendations array containing at least %d and at most %d items.\nDo not return a summary-only object. Do not add markdown fences.\n\nPrevious response:\n%s", attempt, minRecommendations, limit, raw)
	return req
}

// buildDiscoveryRecommendationsOnlyRequest asks the provider for only the
// missing recommendation objects when a full-object response keeps collapsing
// into summary-only JSON.
func buildDiscoveryRecommendationsOnlyRequest(summary recommend.TasteSummary, limit int) (Request, error) {
	if limit < 1 {
		limit = 5
	}
	minRecommendations := minimumDiscoveryRecommendations(limit)
	summaryJSON, err := json.MarshalIndent(summary, "", "  ")
	if err != nil {
		return Request{}, fmt.Errorf("marshal taste summary: %w", err)
	}

	return Request{
		SystemPrompt: "You are a classical piano recommendation assistant. Return only recommendation objects for real classical concert pianists not already listed in known_pianists.",
		UserPrompt:   fmt.Sprintf("Using this taste profile JSON, return only a JSON object with a recommendations array containing at least %d and at most %d pianist objects. Do not include a summary field.\n\n%s", minRecommendations, limit, string(summaryJSON)),
		OutputMode:   StructuredOutputModeStrict,
		Schema: &JSONSchema{
			Name: "pianist_recommendations_only",
			Schema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"recommendations": map[string]any{
						"type":     "array",
						"minItems": minRecommendations,
						"maxItems": limit,
						"items": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"pianist_name": map[string]any{"type": "string", "minLength": 1},
								"why_fit":      map[string]any{"type": "string", "minLength": 1},
								"similar_to": map[string]any{
									"type":  "array",
									"items": map[string]any{"type": "string"},
								},
								"confidence": map[string]any{"type": "string", "minLength": 1},
							},
							"required":             []string{"pianist_name", "why_fit", "similar_to", "confidence"},
							"additionalProperties": false,
						},
					},
				},
				"required":             []string{"recommendations"},
				"additionalProperties": false,
			},
			Strict: true,
		},
	}, nil
}

// buildDiscoveryPlaintextRecommendationsRequest is the last-resort fallback for
// providers that keep ignoring every structured-output contract. It requests a
// rigid line format that can still be parsed locally.
func buildDiscoveryPlaintextRecommendationsRequest(summary recommend.TasteSummary, limit int) (Request, error) {
	if limit < 1 {
		limit = 5
	}
	minRecommendations := minimumDiscoveryRecommendations(limit)
	summaryJSON, err := json.MarshalIndent(summary, "", "  ")
	if err != nil {
		return Request{}, fmt.Errorf("marshal taste summary: %w", err)
	}

	return Request{
		SystemPrompt: "You are a classical piano recommendation assistant. Recommend real classical concert pianists not already listed in known_pianists. Return no prose outside the requested line format.",
		UserPrompt: fmt.Sprintf(
			"Using this taste profile JSON, return between %d and %d recommendation lines.\nEach line must follow exactly this format:\nPianist Name || Why fit sentence || Similar pianist 1, Similar pianist 2 || confidence\nNo heading, no markdown, no numbering.\n\n%s",
			minRecommendations,
			limit,
			string(summaryJSON),
		),
		OutputMode: StructuredOutputModePromptOnly,
	}, nil
}

func minimumDiscoveryRecommendations(limit int) int {
	switch {
	case limit <= 0:
		return 1
	case limit < 5:
		return limit
	default:
		return 5
	}
}
