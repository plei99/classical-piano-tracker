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

	return Request{
		SystemPrompt: "You are a classical piano recommendation assistant. Recommend real classical concert pianists, not tracks. Ground every recommendation in the supplied ratings and comments. Do not recommend pianists already listed in known_pianists.",
		UserPrompt:   fmt.Sprintf("Use this taste profile JSON to recommend %d new pianists.\n\n%s", limit, string(summaryJSON)),
		OutputMode:   StructuredOutputModeStrict,
		Schema: &JSONSchema{
			Name: "pianist_discovery",
			Schema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"summary": map[string]any{
						"type": "string",
					},
					"recommendations": map[string]any{
						"type":     "array",
						"maxItems": limit,
						"items": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"pianist_name": map[string]any{"type": "string"},
								"why_fit":      map[string]any{"type": "string"},
								"similar_to": map[string]any{
									"type":  "array",
									"items": map[string]any{"type": "string"},
								},
								"confidence": map[string]any{"type": "string"},
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
