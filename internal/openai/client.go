package openai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/plei99/classical-piano-tracker/internal/config"
	"github.com/plei99/classical-piano-tracker/internal/recommend"
)

const (
	defaultBaseURL = "https://api.openai.com/v1/responses"
	defaultModel   = "gpt-5.4"
)

type Client struct {
	apiKey     string
	model      string
	baseURL    string
	httpClient *http.Client
}

type apiError struct {
	Message string `json:"message"`
}

type responseEnvelope struct {
	OutputText string `json:"output_text"`
	Output     []struct {
		Type    string `json:"type"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	} `json:"output"`
	Error *apiError `json:"error"`
}

func FromEnv() (*Client, error) {
	return FromConfig(config.OpenAIConfig{})
}

func FromConfig(cfg config.OpenAIConfig) (*Client, error) {
	apiKey := strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
	if apiKey == "" {
		apiKey = strings.TrimSpace(cfg.APIKey)
	}
	if apiKey == "" {
		return nil, errors.New("OpenAI API key is required; set OPENAI_API_KEY or configure openai.api_key")
	}

	model := strings.TrimSpace(os.Getenv("OPENAI_MODEL"))
	if model == "" {
		model = defaultModel
	}

	baseURL := strings.TrimSpace(os.Getenv("OPENAI_BASE_URL"))
	if baseURL == "" {
		baseURL = defaultBaseURL
	}

	return NewClient(apiKey, model, baseURL, nil)
}

func NewClient(apiKey string, model string, baseURL string, httpClient *http.Client) (*Client, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("OpenAI API key is required")
	}
	if strings.TrimSpace(model) == "" {
		model = defaultModel
	}
	if strings.TrimSpace(baseURL) == "" {
		baseURL = defaultBaseURL
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}

	return &Client{
		apiKey:     apiKey,
		model:      model,
		baseURL:    baseURL,
		httpClient: httpClient,
	}, nil
}

func (c *Client) SuggestNewPianists(ctx context.Context, summary recommend.TasteSummary, limit int) (recommend.DiscoveryResult, error) {
	if err := recommend.ValidateDiscoveryInput(summary); err != nil {
		return recommend.DiscoveryResult{}, err
	}
	if limit < 1 {
		limit = 5
	}

	payload, err := buildDiscoveryRequest(c.model, summary, limit)
	if err != nil {
		return recommend.DiscoveryResult{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL, bytes.NewReader(payload))
	if err != nil {
		return recommend.DiscoveryResult{}, fmt.Errorf("build OpenAI request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return recommend.DiscoveryResult{}, fmt.Errorf("call OpenAI Responses API: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return recommend.DiscoveryResult{}, fmt.Errorf("read OpenAI response: %w", err)
	}

	if resp.StatusCode >= 400 {
		return recommend.DiscoveryResult{}, fmt.Errorf("OpenAI Responses API returned %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}

	var envelope responseEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		return recommend.DiscoveryResult{}, fmt.Errorf("decode OpenAI response envelope: %w", err)
	}
	if envelope.Error != nil && strings.TrimSpace(envelope.Error.Message) != "" {
		return recommend.DiscoveryResult{}, errors.New(envelope.Error.Message)
	}

	raw := strings.TrimSpace(envelope.OutputText)
	if raw == "" {
		raw = extractOutputText(envelope)
	}
	if raw == "" {
		return recommend.DiscoveryResult{}, errors.New("OpenAI response did not include structured output text")
	}

	result, err := recommend.ParseDiscoveryResult(raw)
	if err != nil {
		return recommend.DiscoveryResult{}, err
	}
	if len(result.Recommendations) > limit {
		result.Recommendations = result.Recommendations[:limit]
	}

	return result, nil
}

func buildDiscoveryRequest(model string, summary recommend.TasteSummary, limit int) ([]byte, error) {
	summaryJSON, err := json.MarshalIndent(summary, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("marshal taste summary: %w", err)
	}

	requestBody := map[string]any{
		"model": model,
		"input": []map[string]string{
			{
				"role":    "system",
				"content": "You are a classical piano recommendation assistant. Recommend real classical concert pianists, not tracks. Ground every recommendation in the supplied ratings and comments. Do not recommend pianists already listed in known_pianists.",
			},
			{
				"role":    "user",
				"content": fmt.Sprintf("Use this taste profile JSON to recommend %d new pianists.\n\n%s", limit, string(summaryJSON)),
			},
		},
		"text": map[string]any{
			"format": map[string]any{
				"type": "json_schema",
				"name": "pianist_discovery",
				"schema": map[string]any{
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
				"strict": true,
			},
		},
	}

	data, err := json.Marshal(requestBody)
	if err != nil {
		return nil, fmt.Errorf("marshal OpenAI request: %w", err)
	}
	return data, nil
}

func extractOutputText(envelope responseEnvelope) string {
	var parts []string
	for _, item := range envelope.Output {
		for _, content := range item.Content {
			if strings.TrimSpace(content.Text) != "" {
				parts = append(parts, content.Text)
			}
		}
	}
	return strings.Join(parts, "\n")
}
