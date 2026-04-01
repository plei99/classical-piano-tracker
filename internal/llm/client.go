package llm

import (
	"context"
	"errors"
	"fmt"

	"github.com/plei99/classical-piano-tracker/internal/recommend"
)

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

	result, err := recommend.ParseDiscoveryResult(raw)
	if err != nil {
		return recommend.DiscoveryResult{}, fmt.Errorf("parse LLM discovery response: %w", err)
	}
	if len(result.Recommendations) > limit {
		result.Recommendations = result.Recommendations[:limit]
	}

	return result, nil
}
