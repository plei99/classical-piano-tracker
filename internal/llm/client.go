package llm

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/plei99/classical-piano-tracker/internal/recommend"
)

const maxDiscoveryRepairAttempts = 3

// Client wraps a single provider and exposes the app's recommendation task API.
type Client struct {
	provider Provider
}

// NewClient constructs a provider-agnostic recommendation client.
func NewClient(provider Provider) (*Client, error) {
	if provider == nil {
		return nil, errors.New("LLM provider is required")
	}

	return &Client{provider: provider}, nil
}

// SuggestNewPianists builds the shared discovery request, calls the provider,
// and parses the result back into recommendation-domain types.
func (c *Client) SuggestNewPianists(ctx context.Context, summary recommend.TasteSummary, limit int) (recommend.DiscoveryResult, error) {
	if err := recommend.ValidateDiscoveryInput(summary); err != nil {
		return recommend.DiscoveryResult{}, err
	}
	if limit < 1 {
		limit = 5
	}

	req, err := buildDiscoveryRequest(summary, limit)
	if err != nil {
		return recommend.DiscoveryResult{}, err
	}

	raw, err := c.provider.Generate(ctx, req)
	if err != nil {
		return recommend.DiscoveryResult{}, err
	}

	lastSummary := ""
	result, err := recommend.ParseDiscoveryResult(raw)
	if partial, partialErr := recommend.ParseDiscoveryPartial(raw); partialErr == nil && strings.TrimSpace(partial.Summary) != "" {
		lastSummary = partial.Summary
	}
	for attempt := 0; err != nil && shouldRepairDiscoveryResponse(err) && attempt < maxDiscoveryRepairAttempts; attempt++ {
		repairedRaw, repairErr := c.provider.Generate(ctx, buildDiscoveryRepairRequest(raw, limit, attempt+1))
		if repairErr != nil {
			break
		}
		raw = repairedRaw
		result, err = recommend.ParseDiscoveryResult(raw)
		if partial, partialErr := recommend.ParseDiscoveryPartial(raw); partialErr == nil && strings.TrimSpace(partial.Summary) != "" {
			lastSummary = partial.Summary
		}
	}
	if err != nil && shouldFallbackRecommendationRecovery(err) {
		partial, partialErr := recommend.ParseDiscoveryPartial(raw)
		summaryText := lastSummary
		if partialErr == nil && strings.TrimSpace(partial.Summary) != "" {
			summaryText = partial.Summary
		}
		if strings.TrimSpace(summaryText) != "" {
			supplementReq, buildErr := buildDiscoveryRecommendationsOnlyRequest(summary, limit)
			if buildErr == nil {
				supplementRaw, supplementErr := c.provider.Generate(ctx, supplementReq)
				if supplementErr == nil {
					recommendations, parseSupplementErr := recommend.ParseDiscoveryRecommendations(supplementRaw)
					if parseSupplementErr == nil {
						result = recommend.DiscoveryResult{
							Summary:         summaryText,
							Recommendations: recommendations,
						}
						err = nil
					}
				}
			}
			if err != nil {
				plainReq, buildPlainErr := buildDiscoveryPlaintextRecommendationsRequest(summary, limit)
				if buildPlainErr == nil {
					plainRaw, plainErr := c.provider.Generate(ctx, plainReq)
					if plainErr == nil {
						recommendations, parsePlainErr := recommend.ParsePlaintextRecommendations(plainRaw)
						if parsePlainErr == nil {
							result = recommend.DiscoveryResult{
								Summary:         summaryText,
								Recommendations: recommendations,
							}
							err = nil
						}
					}
				}
			}
		}
	}
	if err != nil {
		return recommend.DiscoveryResult{}, fmt.Errorf("parse LLM discovery response: %w", err)
	}
	if len(result.Recommendations) > limit {
		result.Recommendations = result.Recommendations[:limit]
	}

	return result, nil
}

// SummarizeTaste asks the active provider for a summary-only description of
// the current taste profile.
func (c *Client) SummarizeTaste(ctx context.Context, summary recommend.TasteSummary) (string, error) {
	req, err := buildTasteSummaryRequest(summary)
	if err != nil {
		return "", err
	}

	raw, err := c.provider.Generate(ctx, req)
	if err != nil {
		return "", err
	}

	text, err := recommend.ParseTasteSummary(raw)
	if err != nil {
		return "", fmt.Errorf("parse LLM taste summary response: %w", err)
	}
	return text, nil
}

func shouldRepairDiscoveryResponse(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "omitted summary") ||
		strings.Contains(message, "omitted recommendations") ||
		strings.Contains(message, "omitted pianist_name") ||
		strings.Contains(message, "omitted why_fit")
}

func shouldFallbackRecommendationRecovery(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "omitted recommendations") ||
		strings.Contains(message, "omitted pianist_name") ||
		strings.Contains(message, "omitted why_fit")
}
