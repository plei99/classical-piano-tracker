package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/plei99/classical-piano-tracker/internal/llm"
)

const (
	defaultAnthropicBaseURL = "https://api.anthropic.com/v1/messages"
	defaultAnthropicModel   = "claude-sonnet-4-5"
	anthropicVersion        = "2023-06-01"
	anthropicToolName       = "emit_recommendations"
)

type anthropicProvider struct {
	apiKey     string
	model      string
	baseURL    string
	httpClient *http.Client
}

type anthropicResponseEnvelope struct {
	Content []struct {
		Type  string         `json:"type"`
		Text  string         `json:"text"`
		Name  string         `json:"name"`
		Input map[string]any `json:"input"`
	} `json:"content"`
	Error *apiError `json:"error"`
}

// NewAnthropic constructs a native Anthropic provider adapter.
func NewAnthropic(apiKey string, model string, baseURL string, httpClient *http.Client) (llm.Provider, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("Anthropic API key is required")
	}
	if strings.TrimSpace(model) == "" {
		model = defaultAnthropicModel
	}
	if strings.TrimSpace(baseURL) == "" {
		baseURL = defaultAnthropicBaseURL
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}

	return &anthropicProvider{
		apiKey:     apiKey,
		model:      model,
		baseURL:    baseURL,
		httpClient: httpClient,
	}, nil
}

// Generate uses Anthropic's Messages API. When a schema is supplied, the
// provider forces a tool call so Claude returns JSON-shaped tool input instead
// of free-form text.
func (p *anthropicProvider) Generate(ctx context.Context, req llm.Request) (string, error) {
	payload, err := p.buildRequest(req)
	if err != nil {
		return "", err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL, bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("build Anthropic request: %w", err)
	}
	httpReq.Header.Set("x-api-key", p.apiKey)
	httpReq.Header.Set("anthropic-version", anthropicVersion)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := p.httpClient.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("call Anthropic Messages API: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read Anthropic response: %w", err)
	}

	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("Anthropic Messages API returned %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}

	var envelope anthropicResponseEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		return "", fmt.Errorf("decode Anthropic response envelope: %w", err)
	}
	if envelope.Error != nil && strings.TrimSpace(envelope.Error.Message) != "" {
		return "", errors.New(envelope.Error.Message)
	}

	for _, item := range envelope.Content {
		if item.Type == "tool_use" && len(item.Input) > 0 {
			data, err := json.Marshal(item.Input)
			if err != nil {
				return "", fmt.Errorf("marshal Anthropic tool result: %w", err)
			}
			return string(data), nil
		}
	}

	var parts []string
	for _, item := range envelope.Content {
		if strings.TrimSpace(item.Text) != "" {
			parts = append(parts, item.Text)
		}
	}
	raw := strings.TrimSpace(strings.Join(parts, "\n"))
	if raw == "" {
		return "", errors.New("Anthropic response did not include tool output or text content")
	}

	return raw, nil
}

func (p *anthropicProvider) buildRequest(req llm.Request) ([]byte, error) {
	requestBody := map[string]any{
		"model":      p.model,
		"max_tokens": max(req.MaxOutputTokens, 1024),
		"system":     req.SystemPrompt,
		"messages": []map[string]any{
			{
				"role": "user",
				"content": []map[string]string{
					{
						"type": "text",
						"text": req.UserPrompt,
					},
				},
			},
		},
	}

	if req.Temperature > 0 {
		requestBody["temperature"] = req.Temperature
	}

	if req.Schema != nil {
		requestBody["tools"] = []map[string]any{
			{
				"name":         anthropicToolName,
				"description":  "Return the final pianist recommendation result as structured JSON. The input must include both a non-empty summary and a non-empty recommendations array.",
				"input_schema": req.Schema.Schema,
			},
		}
		requestBody["tool_choice"] = map[string]any{
			"type": "tool",
			"name": anthropicToolName,
		}
	}

	data, err := json.Marshal(requestBody)
	if err != nil {
		return nil, fmt.Errorf("marshal Anthropic request: %w", err)
	}
	return data, nil
}
