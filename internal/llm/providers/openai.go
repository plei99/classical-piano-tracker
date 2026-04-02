package providers

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
	"github.com/plei99/classical-piano-tracker/internal/llm"
)

const (
	defaultOpenAIBaseURL = "https://api.openai.com/v1/responses"
	defaultOpenAIModel   = "gpt-5.4"
	defaultOpenAITimeout = 90 * time.Second
)

type openAIProvider struct {
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

// NewOpenAIFromConfig resolves credentials and endpoint settings from env
// overrides first, then falls back to the persisted config.
func NewOpenAIFromConfig(cfg config.OpenAIConfig) (llm.Provider, error) {
	apiKey := strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
	if apiKey == "" {
		apiKey = strings.TrimSpace(cfg.APIKey)
	}
	if apiKey == "" {
		return nil, errors.New("OpenAI API key is required; set OPENAI_API_KEY or configure openai.api_key")
	}

	model := strings.TrimSpace(os.Getenv("OPENAI_MODEL"))
	if model == "" {
		model = defaultOpenAIModel
	}

	baseURL := strings.TrimSpace(os.Getenv("OPENAI_BASE_URL"))
	if baseURL == "" {
		baseURL = defaultOpenAIBaseURL
	}

	return NewOpenAI(apiKey, model, baseURL, nil)
}

// NewOpenAI leaves the transport injectable so provider behavior can be tested
// without network calls.
func NewOpenAI(apiKey string, model string, baseURL string, httpClient *http.Client) (llm.Provider, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("OpenAI API key is required")
	}
	if strings.TrimSpace(model) == "" {
		model = defaultOpenAIModel
	}
	if strings.TrimSpace(baseURL) == "" {
		baseURL = defaultOpenAIBaseURL
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultOpenAITimeout}
	}

	return &openAIProvider{
		apiKey:     apiKey,
		model:      model,
		baseURL:    baseURL,
		httpClient: httpClient,
	}, nil
}

// Generate implements llm.Provider using the OpenAI Responses API.
func (p *openAIProvider) Generate(ctx context.Context, req llm.Request) (string, error) {
	payload, err := p.buildRequest(req)
	if err != nil {
		return "", err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL, bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("build OpenAI request: %w", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+p.apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := p.httpClient.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("call OpenAI Responses API: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read OpenAI response: %w", err)
	}

	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("OpenAI Responses API returned %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}

	var envelope responseEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		return "", fmt.Errorf("decode OpenAI response envelope: %w", err)
	}
	if envelope.Error != nil && strings.TrimSpace(envelope.Error.Message) != "" {
		return "", errors.New(envelope.Error.Message)
	}

	raw := strings.TrimSpace(envelope.OutputText)
	if raw == "" {
		raw = extractOutputText(envelope)
	}
	if raw == "" {
		return "", errors.New("OpenAI response did not include structured output text")
	}

	return raw, nil
}

func (p *openAIProvider) buildRequest(req llm.Request) ([]byte, error) {
	requestBody := map[string]any{
		"model": p.model,
		"input": []map[string]string{
			{
				"role":    "system",
				"content": req.SystemPrompt,
			},
			{
				"role":    "user",
				"content": req.UserPrompt,
			},
		},
	}

	if req.Schema != nil {
		requestBody["text"] = map[string]any{
			"format": map[string]any{
				"type":   "json_schema",
				"name":   req.Schema.Name,
				"schema": req.Schema.Schema,
				"strict": req.Schema.Strict,
			},
		}
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
