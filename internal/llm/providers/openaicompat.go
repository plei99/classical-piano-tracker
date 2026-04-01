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
	defaultOpenAICompatBaseURL = "http://localhost:11434/v1"
	defaultOpenAICompatTimeout = 90 * time.Second
)

type openAICompatProvider struct {
	apiKey     string
	model      string
	baseURL    string
	httpClient *http.Client
}

type chatCompletionsEnvelope struct {
	Choices []struct {
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Error *apiError `json:"error"`
}

// NewOpenAICompat constructs a chat-completions-based provider adapter that
// works with OpenAI-compatible APIs such as Ollama, Kimi, and DeepSeek.
func NewOpenAICompat(apiKey string, model string, baseURL string, httpClient *http.Client) (llm.Provider, error) {
	if strings.TrimSpace(model) == "" {
		return nil, errors.New("OpenAI-compatible model is required")
	}
	if strings.TrimSpace(baseURL) == "" {
		baseURL = defaultOpenAICompatBaseURL
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultOpenAICompatTimeout}
	}

	return &openAICompatProvider{
		apiKey:     strings.TrimSpace(apiKey),
		model:      strings.TrimSpace(model),
		baseURL:    strings.TrimRight(baseURL, "/"),
		httpClient: httpClient,
	}, nil
}

// Generate uses the widely supported Chat Completions wire format and relies on
// the shared discovery repair/fallback logic instead of provider-specific JSON
// features that many OpenAI-compatible backends only partially implement.
func (p *openAICompatProvider) Generate(ctx context.Context, req llm.Request) (string, error) {
	payload, err := p.buildRequest(req)
	if err != nil {
		return "", err
	}

	endpoint := p.baseURL
	if !strings.HasSuffix(endpoint, "/chat/completions") {
		endpoint += "/chat/completions"
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("build OpenAI-compatible request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if p.apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+p.apiKey)
	}

	resp, err := p.httpClient.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("call OpenAI-compatible chat completions API: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read OpenAI-compatible response: %w", err)
	}

	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("OpenAI-compatible chat completions API returned %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}

	var envelope chatCompletionsEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		return "", fmt.Errorf("decode OpenAI-compatible response envelope: %w", err)
	}
	if envelope.Error != nil && strings.TrimSpace(envelope.Error.Message) != "" {
		return "", errors.New(envelope.Error.Message)
	}

	for _, choice := range envelope.Choices {
		raw := strings.TrimSpace(extractChatMessageContent(choice.Message.Content))
		if raw != "" {
			return raw, nil
		}
	}

	return "", errors.New("OpenAI-compatible response did not include message content")
}

func (p *openAICompatProvider) buildRequest(req llm.Request) ([]byte, error) {
	requestBody := map[string]any{
		"model": p.model,
		"messages": []map[string]string{
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

	if req.Temperature > 0 {
		requestBody["temperature"] = req.Temperature
	}
	if req.MaxOutputTokens > 0 {
		requestBody["max_tokens"] = req.MaxOutputTokens
	}

	data, err := json.Marshal(requestBody)
	if err != nil {
		return nil, fmt.Errorf("marshal OpenAI-compatible request: %w", err)
	}
	return data, nil
}

func extractChatMessageContent(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}

	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return asString
	}

	var asParts []struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &asParts); err == nil {
		var parts []string
		for _, part := range asParts {
			if strings.TrimSpace(part.Text) != "" {
				parts = append(parts, part.Text)
			}
		}
		return strings.Join(parts, "\n")
	}

	return ""
}
