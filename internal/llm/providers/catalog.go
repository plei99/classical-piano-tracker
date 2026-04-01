package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/plei99/classical-piano-tracker/internal/config"
)

const defaultModelListTimeout = 30 * time.Second

// ListModels returns onboarding-friendly model identifiers for a configured
// profile. Dynamic providers use their listing APIs; DeepSeek and Kimi use the
// fixed options we agreed on.
func ListModels(ctx context.Context, profileName string, profile config.LLMProfile) ([]string, error) {
	switch strings.ToLower(strings.TrimSpace(profile.Provider)) {
	case "openai":
		return listOpenAIModels(ctx, profile)
	case "anthropic":
		return listAnthropicModels(ctx, profile)
	case "google":
		return listGoogleModels(ctx, profile)
	case "openai_compat":
		switch strings.ToLower(strings.TrimSpace(profileName)) {
		case "ollama":
			return listOllamaModels(ctx, profile)
		case "deepseek":
			return []string{"deepseek-chat", "deepseek-reasoner"}, nil
		case "kimi":
			return []string{"kimi-k2.5"}, nil
		default:
			return nil, fmt.Errorf("model listing is not implemented for openai_compat profile %q", profileName)
		}
	default:
		return nil, fmt.Errorf("model listing is not implemented for provider %q", profile.Provider)
	}
}

type openAIModelsEnvelope struct {
	Data []struct {
		ID string `json:"id"`
	} `json:"data"`
}

func listOpenAIModels(ctx context.Context, profile config.LLMProfile) ([]string, error) {
	if strings.TrimSpace(profile.APIKey) == "" {
		return nil, fmt.Errorf("OpenAI API key is required to list models")
	}

	baseURL := strings.TrimSpace(profile.BaseURL)
	if baseURL == "" {
		baseURL = defaultOpenAIBaseURL
	}
	endpoint, err := siblingEndpoint(baseURL, "models")
	if err != nil {
		return nil, err
	}

	var envelope openAIModelsEnvelope
	if err := getJSON(ctx, endpoint, map[string]string{
		"Authorization": "Bearer " + profile.APIKey,
	}, &envelope); err != nil {
		return nil, fmt.Errorf("list OpenAI models: %w", err)
	}

	models := make([]string, 0, len(envelope.Data))
	for _, item := range envelope.Data {
		id := strings.TrimSpace(item.ID)
		if id == "" || strings.HasPrefix(id, "text-embedding") || strings.Contains(id, "moderation") {
			continue
		}
		models = append(models, id)
	}
	slices.Sort(models)
	return models, nil
}

type anthropicModelsEnvelope struct {
	Data []struct {
		ID string `json:"id"`
	} `json:"data"`
}

func listAnthropicModels(ctx context.Context, profile config.LLMProfile) ([]string, error) {
	if strings.TrimSpace(profile.APIKey) == "" {
		return nil, fmt.Errorf("Anthropic API key is required to list models")
	}

	baseURL := strings.TrimSpace(profile.BaseURL)
	if baseURL == "" {
		baseURL = defaultAnthropicBaseURL
	}
	endpoint, err := siblingEndpoint(baseURL, "models")
	if err != nil {
		return nil, err
	}

	var envelope anthropicModelsEnvelope
	if err := getJSON(ctx, endpoint, map[string]string{
		"x-api-key":         profile.APIKey,
		"anthropic-version": anthropicVersion,
	}, &envelope); err != nil {
		return nil, fmt.Errorf("list Anthropic models: %w", err)
	}

	models := make([]string, 0, len(envelope.Data))
	for _, item := range envelope.Data {
		if id := strings.TrimSpace(item.ID); id != "" {
			models = append(models, id)
		}
	}
	slices.Sort(models)
	return models, nil
}

type googleModelsEnvelope struct {
	Models []struct {
		Name                       string   `json:"name"`
		BaseModelID                string   `json:"baseModelId"`
		SupportedGenerationMethods []string `json:"supportedGenerationMethods"`
	} `json:"models"`
}

func listGoogleModels(ctx context.Context, profile config.LLMProfile) ([]string, error) {
	if strings.TrimSpace(profile.APIKey) == "" {
		return nil, fmt.Errorf("Google API key is required to list models")
	}

	baseURL := strings.TrimSpace(profile.BaseURL)
	if baseURL == "" {
		baseURL = defaultGoogleBaseURL
	}
	endpoint := strings.TrimRight(baseURL, "/")
	if !strings.HasSuffix(endpoint, "/models") {
		endpoint += "/models"
	}
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("parse Google model list URL %q: %w", endpoint, err)
	}
	query := u.Query()
	query.Set("key", profile.APIKey)
	u.RawQuery = query.Encode()

	var envelope googleModelsEnvelope
	if err := getJSON(ctx, u.String(), nil, &envelope); err != nil {
		return nil, fmt.Errorf("list Google models: %w", err)
	}

	models := make([]string, 0, len(envelope.Models))
	for _, item := range envelope.Models {
		if !supportsGenerationMethod(item.SupportedGenerationMethods, "generateContent") {
			continue
		}
		id := strings.TrimSpace(firstNonEmpty(item.BaseModelID, strings.TrimPrefix(item.Name, "models/")))
		if id != "" {
			models = append(models, id)
		}
	}
	slices.Sort(models)
	models = slices.Compact(models)
	return models, nil
}

type ollamaTagsEnvelope struct {
	Models []struct {
		Name  string `json:"name"`
		Model string `json:"model"`
	} `json:"models"`
}

func listOllamaModels(ctx context.Context, profile config.LLMProfile) ([]string, error) {
	baseURL := strings.TrimSpace(profile.BaseURL)
	if baseURL == "" {
		baseURL = defaultOpenAICompatBaseURL
	}

	endpoint, err := ollamaTagsEndpoint(baseURL)
	if err != nil {
		return nil, err
	}

	var envelope ollamaTagsEnvelope
	if err := getJSON(ctx, endpoint, nil, &envelope); err != nil {
		return nil, fmt.Errorf("list Ollama models: %w", err)
	}

	models := make([]string, 0, len(envelope.Models))
	for _, item := range envelope.Models {
		id := strings.TrimSpace(firstNonEmpty(item.Model, item.Name))
		if id != "" {
			models = append(models, id)
		}
	}
	slices.Sort(models)
	return models, nil
}

func getJSON(ctx context.Context, endpoint string, headers map[string]string, dest any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return fmt.Errorf("build request %q: %w", endpoint, err)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}

	client := &http.Client{Timeout: defaultModelListTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("request %q: %w", endpoint, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read response %q: %w", endpoint, err)
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("%s returned %s: %s", endpoint, resp.Status, strings.TrimSpace(string(body)))
	}
	if err := json.Unmarshal(body, dest); err != nil {
		return fmt.Errorf("decode response %q: %w", endpoint, err)
	}
	return nil
}

func siblingEndpoint(baseURL string, sibling string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return "", fmt.Errorf("parse base URL %q: %w", baseURL, err)
	}

	path := strings.TrimSuffix(u.Path, "/")
	trimmedKnownLeaf := false
	switch {
	case strings.HasSuffix(path, "/responses"):
		path = strings.TrimSuffix(path, "/responses")
		trimmedKnownLeaf = true
	case strings.HasSuffix(path, "/messages"):
		path = strings.TrimSuffix(path, "/messages")
		trimmedKnownLeaf = true
	}

	switch {
	case path == "":
		path = "/" + sibling
	case trimmedKnownLeaf:
		path = path + "/" + sibling
	default:
		parts := strings.Split(path, "/")
		parts[len(parts)-1] = sibling
		path = strings.Join(parts, "/")
	}
	u.Path = path
	u.RawQuery = ""
	return u.String(), nil
}

func ollamaTagsEndpoint(baseURL string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return "", fmt.Errorf("parse Ollama base URL %q: %w", baseURL, err)
	}
	u.RawQuery = ""
	u.Path = "/api/tags"
	return u.String(), nil
}

func supportsGenerationMethod(methods []string, target string) bool {
	for _, method := range methods {
		if strings.EqualFold(strings.TrimSpace(method), target) {
			return true
		}
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
