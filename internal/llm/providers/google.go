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
	defaultGoogleBaseURL = "https://generativelanguage.googleapis.com/v1beta/models"
	defaultGoogleModel   = "gemini-2.5-pro"
	defaultGoogleTimeout = 90 * time.Second
)

type googleProvider struct {
	apiKey     string
	model      string
	baseURL    string
	httpClient *http.Client
}

type googleResponseEnvelope struct {
	Candidates []struct {
		Content struct {
			Parts []struct {
				Text string `json:"text"`
			} `json:"parts"`
		} `json:"content"`
	} `json:"candidates"`
	Error *struct {
		Message string `json:"message"`
		Status  string `json:"status"`
	} `json:"error"`
}

// NewGoogle constructs a native Gemini provider adapter.
func NewGoogle(apiKey string, model string, baseURL string, httpClient *http.Client) (llm.Provider, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("Google API key is required")
	}
	if strings.TrimSpace(model) == "" {
		model = defaultGoogleModel
	}
	if strings.TrimSpace(baseURL) == "" {
		baseURL = defaultGoogleBaseURL
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultGoogleTimeout}
	}

	return &googleProvider{
		apiKey:     apiKey,
		model:      model,
		baseURL:    strings.TrimRight(baseURL, "/"),
		httpClient: httpClient,
	}, nil
}

// Generate uses Gemini's generateContent endpoint and requests JSON output when
// the discovery layer provides a schema.
func (p *googleProvider) Generate(ctx context.Context, req llm.Request) (string, error) {
	payload, err := p.buildRequest(req)
	if err != nil {
		return "", err
	}

	endpoint := p.baseURL + "/" + p.model + ":generateContent"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("build Google request: %w", err)
	}
	httpReq.Header.Set("x-goog-api-key", p.apiKey)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := p.httpClient.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("call Gemini generateContent API: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read Google response: %w", err)
	}

	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("Gemini generateContent API returned %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}

	var envelope googleResponseEnvelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		return "", fmt.Errorf("decode Google response envelope: %w", err)
	}
	if envelope.Error != nil && strings.TrimSpace(envelope.Error.Message) != "" {
		return "", errors.New(envelope.Error.Message)
	}

	for _, candidate := range envelope.Candidates {
		for _, part := range candidate.Content.Parts {
			if raw := strings.TrimSpace(part.Text); raw != "" {
				return raw, nil
			}
		}
	}

	return "", errors.New("Gemini response did not include generated text")
}

func (p *googleProvider) buildRequest(req llm.Request) ([]byte, error) {
	requestBody := map[string]any{
		"contents": []map[string]any{
			{
				"role": "user",
				"parts": []map[string]string{
					{"text": req.UserPrompt},
				},
			},
		},
	}

	if strings.TrimSpace(req.SystemPrompt) != "" {
		requestBody["systemInstruction"] = map[string]any{
			"parts": []map[string]string{
				{"text": req.SystemPrompt},
			},
		}
	}

	generationConfig := map[string]any{}
	if req.Temperature > 0 {
		generationConfig["temperature"] = req.Temperature
	}
	if req.MaxOutputTokens > 0 {
		generationConfig["maxOutputTokens"] = req.MaxOutputTokens
	}
	if req.Schema != nil {
		generationConfig["responseMimeType"] = "application/json"
		generationConfig["responseJsonSchema"] = req.Schema.Schema
	}
	if len(generationConfig) > 0 {
		requestBody["generationConfig"] = generationConfig
	}

	data, err := json.Marshal(requestBody)
	if err != nil {
		return nil, fmt.Errorf("marshal Google request: %w", err)
	}
	return data, nil
}
