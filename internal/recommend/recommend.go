package recommend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"

	"github.com/plei99/classical-piano-tracker/internal/db"
)

const (
	minRatingsForDiscovery = 3
	maxFavoritePianists    = 8
	maxLovedTracks         = 10
	maxDislikedTracks      = 5
	maxCommentedTracks     = 8
)

// PianistProfile is the deterministic per-pianist aggregate used by the local
// favorites command.
type PianistProfile struct {
	Name            string
	TrackCount      int
	RatedTrackCount int
	TotalPlayCount  int64
	AverageStars    float64
	FavoriteScore   float64
}

// TasteTrack is the reduced track shape passed into the recommendation layer
// and eventually summarized for the LLM.
type TasteTrack struct {
	TrackID       int64    `json:"track_id"`
	TrackName     string   `json:"track_name"`
	AlbumName     string   `json:"album_name"`
	Artists       []string `json:"artists"`
	PlayCount     int64    `json:"play_count"`
	LastPlayedAt  int64    `json:"last_played_at"`
	Stars         int64    `json:"stars"`
	Opinion       string   `json:"opinion,omitempty"`
	MatchedArtist string   `json:"matched_artist,omitempty"`
}

// FavoritePianist is the JSON-facing version of PianistProfile embedded inside
// the LLM taste summary.
type FavoritePianist struct {
	Name            string  `json:"name"`
	TrackCount      int     `json:"track_count"`
	RatedTrackCount int     `json:"rated_track_count"`
	TotalPlayCount  int64   `json:"total_play_count"`
	AverageStars    float64 `json:"average_stars"`
	FavoriteScore   float64 `json:"favorite_score"`
}

// TasteSummary is the compact corpus snapshot sent to the LLM. It is designed
// to be stable, explainable, and much smaller than dumping the whole database.
type TasteSummary struct {
	TotalTracks       int               `json:"total_tracks"`
	TotalRatings      int               `json:"total_ratings"`
	CommentCount      int               `json:"comment_count"`
	FavoritePianists  []FavoritePianist `json:"favorite_pianists"`
	LovedTracks       []TasteTrack      `json:"loved_tracks"`
	DislikedTracks    []TasteTrack      `json:"disliked_tracks"`
	CommentedTracks   []TasteTrack      `json:"commented_tracks"`
	KnownPianists     []string          `json:"known_pianists"`
	DiscoveryGuidance string            `json:"discovery_guidance"`
}

// SuggestedPianist is the raw structured output requested from the LLM.
type SuggestedPianist struct {
	PianistName string   `json:"pianist_name"`
	WhyFit      string   `json:"why_fit"`
	SimilarTo   []string `json:"similar_to"`
	Confidence  string   `json:"confidence"`
}

// DiscoveryResult wraps the model summary plus raw pianist suggestions.
type DiscoveryResult struct {
	Summary         string             `json:"summary"`
	Recommendations []SuggestedPianist `json:"recommendations"`
}

// ValidatedPianist is a suggestion that survived Spotify catalog validation.
type ValidatedPianist struct {
	SuggestedPianist
	SpotifyName string
	SpotifyID   string
	Popularity  int
	Genres      []string
}

// CatalogArtist is the minimal artist shape needed from the validation catalog.
type CatalogArtist struct {
	Name       string
	ID         string
	Popularity int
	Genres     []string
}

// ArtistSearcher abstracts catalog lookup so recommendation validation is
// decoupled from the Spotify client implementation.
type ArtistSearcher interface {
	SearchArtists(ctx context.Context, query string, limit int) ([]CatalogArtist, error)
}

// BuildPianistProfiles attributes local tracks and ratings to allowlisted
// pianists and computes the deterministic favorite score used by the CLI.
func BuildPianistProfiles(tracks []db.Track, ratings []db.Rating, allowlist []string) ([]PianistProfile, error) {
	allowset, canonicalNames := allowlistSet(allowlist)
	ratingByTrackID := make(map[int64]db.Rating, len(ratings))
	for _, rating := range ratings {
		ratingByTrackID[rating.TrackID] = rating
	}

	type aggregate struct {
		name            string
		trackCount      int
		ratedTrackCount int
		totalPlayCount  int64
		totalStars      int64
	}

	aggregates := map[string]*aggregate{}

	for _, track := range tracks {
		artists, err := decodeArtists(track.Artists)
		if err != nil {
			return nil, fmt.Errorf("decode artists for track %d: %w", track.ID, err)
		}

		matched := matchedAllowlistedArtists(artists, allowset, canonicalNames)
		if len(matched) == 0 {
			continue
		}

		rating, hasRating := ratingByTrackID[track.ID]
		for _, name := range matched {
			agg := aggregates[name]
			if agg == nil {
				agg = &aggregate{name: name}
				aggregates[name] = agg
			}
			agg.trackCount++
			agg.totalPlayCount += track.PlayCount
			if hasRating {
				agg.ratedTrackCount++
				agg.totalStars += rating.Stars
			}
		}
	}

	profiles := make([]PianistProfile, 0, len(aggregates))
	for _, agg := range aggregates {
		averageStars := 0.0
		if agg.ratedTrackCount > 0 {
			averageStars = float64(agg.totalStars) / float64(agg.ratedTrackCount)
		}

		profiles = append(profiles, PianistProfile{
			Name:            agg.name,
			TrackCount:      agg.trackCount,
			RatedTrackCount: agg.ratedTrackCount,
			TotalPlayCount:  agg.totalPlayCount,
			AverageStars:    averageStars,
			FavoriteScore:   favoriteScore(averageStars, agg.ratedTrackCount, agg.totalPlayCount),
		})
	}

	slices.SortFunc(profiles, compareProfiles)
	return profiles, nil
}

// BuildTasteSummary reduces the local DB into a compact explanation of the
// user's taste for use by the LLM-backed discovery flow.
func BuildTasteSummary(tracks []db.Track, ratings []db.Rating, allowlist []string) (TasteSummary, error) {
	profiles, err := BuildPianistProfiles(tracks, ratings, allowlist)
	if err != nil {
		return TasteSummary{}, err
	}

	ratingByTrackID := make(map[int64]db.Rating, len(ratings))
	for _, rating := range ratings {
		ratingByTrackID[rating.TrackID] = rating
	}

	allowset, canonicalNames := allowlistSet(allowlist)
	ratedTracks := make([]TasteTrack, 0, len(ratings))
	commentedTracks := make([]TasteTrack, 0, len(ratings))

	for _, track := range tracks {
		rating, ok := ratingByTrackID[track.ID]
		if !ok {
			continue
		}

		artists, err := decodeArtists(track.Artists)
		if err != nil {
			return TasteSummary{}, fmt.Errorf("decode artists for track %d: %w", track.ID, err)
		}

		matched := matchedAllowlistedArtists(artists, allowset, canonicalNames)
		matchedArtist := ""
		if len(matched) > 0 {
			matchedArtist = matched[0]
		}

		entry := TasteTrack{
			TrackID:       track.ID,
			TrackName:     track.TrackName,
			AlbumName:     track.AlbumName,
			Artists:       artists,
			PlayCount:     track.PlayCount,
			LastPlayedAt:  track.LastPlayedAt,
			Stars:         rating.Stars,
			Opinion:       strings.TrimSpace(rating.Opinion),
			MatchedArtist: matchedArtist,
		}

		ratedTracks = append(ratedTracks, entry)
		if entry.Opinion != "" {
			commentedTracks = append(commentedTracks, entry)
		}
	}

	lovedTracks := filterRatedTracks(ratedTracks, func(track TasteTrack) bool {
		return track.Stars >= 4
	}, maxLovedTracks)
	dislikedTracks := filterRatedTracks(ratedTracks, func(track TasteTrack) bool {
		return track.Stars <= 2
	}, maxDislikedTracks)

	slices.SortFunc(commentedTracks, compareTasteTracks)
	if len(commentedTracks) > maxCommentedTracks {
		commentedTracks = commentedTracks[:maxCommentedTracks]
	}

	favoritePianists := make([]FavoritePianist, 0, minInt(len(profiles), maxFavoritePianists))
	for _, profile := range profiles[:minInt(len(profiles), maxFavoritePianists)] {
		favoritePianists = append(favoritePianists, FavoritePianist{
			Name:            profile.Name,
			TrackCount:      profile.TrackCount,
			RatedTrackCount: profile.RatedTrackCount,
			TotalPlayCount:  profile.TotalPlayCount,
			AverageStars:    roundToTwoDecimals(profile.AverageStars),
			FavoriteScore:   roundToTwoDecimals(profile.FavoriteScore),
		})
	}

	knownPianists := make([]string, 0, len(allowlist))
	for _, name := range allowlist {
		trimmed := strings.TrimSpace(name)
		if trimmed == "" {
			continue
		}
		knownPianists = append(knownPianists, trimmed)
	}

	commentCount := 0
	for _, track := range ratedTracks {
		if track.Opinion != "" {
			commentCount++
		}
	}

	return TasteSummary{
		TotalTracks:      len(tracks),
		TotalRatings:     len(ratings),
		CommentCount:     commentCount,
		FavoritePianists: favoritePianists,
		LovedTracks:      lovedTracks,
		DislikedTracks:   dislikedTracks,
		CommentedTracks:  commentedTracks,
		KnownPianists:    knownPianists,
		DiscoveryGuidance: "Recommend real classical concert pianists not already present in the known pianist list. " +
			"Use the ratings and comments to infer interpretive taste, then propose nearby but distinct pianists with substantial recording catalogs.",
	}, nil
}

// ValidateDiscoveryInput enforces a minimum amount of local signal before the
// app spends network/API budget on LLM recommendations.
func ValidateDiscoveryInput(summary TasteSummary) error {
	if summary.TotalRatings < minRatingsForDiscovery {
		return fmt.Errorf("need at least %d rated tracks before generating pianist recommendations", minRatingsForDiscovery)
	}
	if len(summary.FavoritePianists) == 0 {
		return errors.New("no favorite pianists could be derived from the current database and allowlist")
	}
	return nil
}

// ValidateSuggestedPianists removes duplicates and known pianists, then checks
// every remaining suggestion against a real catalog search before surfacing it.
func ValidateSuggestedPianists(ctx context.Context, searcher ArtistSearcher, knownPianists []string, suggestions []SuggestedPianist, limit int) ([]ValidatedPianist, error) {
	if searcher == nil {
		return nil, errors.New("artist searcher is required")
	}
	if limit < 1 {
		limit = 5
	}

	knownSet, _ := allowlistSet(knownPianists)
	seen := map[string]struct{}{}
	validated := make([]ValidatedPianist, 0, len(suggestions))

	for _, suggestion := range suggestions {
		query := strings.TrimSpace(suggestion.PianistName)
		if query == "" {
			continue
		}
		normalized := normalizeName(query)
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}

		if _, known := knownSet[normalized]; known {
			continue
		}

		artists, err := searcher.SearchArtists(ctx, query, limit)
		if err != nil {
			return nil, fmt.Errorf("validate pianist %q: %w", query, err)
		}
		match, ok := pickBestArtistMatch(query, artists)
		if !ok {
			continue
		}

		validated = append(validated, ValidatedPianist{
			SuggestedPianist: suggestion,
			SpotifyName:      match.Name,
			SpotifyID:        match.ID,
			Popularity:       match.Popularity,
			Genres:           append([]string(nil), match.Genres...),
		})
	}

	return validated, nil
}

// ParseDiscoveryResult accepts strict JSON output plus fenced JSON snippets so
// the app tolerates minor response-wrapper differences from the model.
func ParseDiscoveryResult(raw string) (DiscoveryResult, error) {
	result, cleaned, err := parseDiscoveryPartial(raw)
	if err != nil {
		return DiscoveryResult{}, err
	}

	if strings.TrimSpace(result.Summary) == "" {
		return DiscoveryResult{}, fmt.Errorf("LLM discovery response omitted summary: %s", previewJSON(cleaned))
	}
	if len(result.Recommendations) == 0 {
		return DiscoveryResult{}, fmt.Errorf("LLM discovery response omitted recommendations: %s", previewJSON(cleaned))
	}

	for idx, rec := range result.Recommendations {
		if strings.TrimSpace(rec.PianistName) == "" {
			return DiscoveryResult{}, fmt.Errorf("recommendation %d omitted pianist_name", idx+1)
		}
		if strings.TrimSpace(rec.WhyFit) == "" {
			return DiscoveryResult{}, fmt.Errorf("recommendation %d omitted why_fit", idx+1)
		}
		result.Recommendations[idx].PianistName = strings.TrimSpace(rec.PianistName)
		result.Recommendations[idx].WhyFit = strings.TrimSpace(rec.WhyFit)
		result.Recommendations[idx].Confidence = strings.TrimSpace(rec.Confidence)
	}

	return result, nil
}

// ParseTasteSummary extracts a summary-only LLM response and tolerates fenced
// JSON or plain text when a provider ignores the schema wrapper.
func ParseTasteSummary(raw string) (string, error) {
	result, cleaned, err := parseDiscoveryPartial(raw)
	if err == nil && strings.TrimSpace(result.Summary) != "" {
		return strings.TrimSpace(result.Summary), nil
	}

	cleaned = cleanLLMText(raw)
	if cleaned == "" {
		return "", errors.New("LLM taste summary response omitted summary")
	}
	if err == nil {
		return "", fmt.Errorf("LLM taste summary response omitted summary: %s", previewJSON(cleaned))
	}
	if strings.HasPrefix(cleaned, "{") || strings.HasPrefix(cleaned, "[") {
		return "", fmt.Errorf("decode LLM taste summary response: %w", err)
	}

	return cleaned, nil
}

// ParseDiscoveryPartial normalizes a provider response without requiring every
// field to be present. It is used internally by the LLM client's repair logic.
func ParseDiscoveryPartial(raw string) (DiscoveryResult, error) {
	result, _, err := parseDiscoveryPartial(raw)
	return result, err
}

// ParseDiscoveryRecommendations normalizes a provider response when the client
// only asked for a recommendation list.
func ParseDiscoveryRecommendations(raw string) ([]SuggestedPianist, error) {
	result, cleaned, err := parseDiscoveryPartial(raw)
	if err != nil {
		return nil, err
	}
	if len(result.Recommendations) == 0 {
		return nil, fmt.Errorf("LLM discovery response omitted recommendations: %s", previewJSON(cleaned))
	}
	for idx, rec := range result.Recommendations {
		if strings.TrimSpace(rec.PianistName) == "" {
			return nil, fmt.Errorf("recommendation %d omitted pianist_name", idx+1)
		}
		if strings.TrimSpace(rec.WhyFit) == "" {
			return nil, fmt.Errorf("recommendation %d omitted why_fit", idx+1)
		}
		result.Recommendations[idx].PianistName = strings.TrimSpace(rec.PianistName)
		result.Recommendations[idx].WhyFit = strings.TrimSpace(rec.WhyFit)
		result.Recommendations[idx].Confidence = strings.TrimSpace(rec.Confidence)
	}
	return result.Recommendations, nil
}

// ParsePlaintextRecommendations parses the final fallback line format:
// Pianist Name || Why fit || Similar 1, Similar 2 || confidence
func ParsePlaintextRecommendations(raw string) ([]SuggestedPianist, error) {
	lines := strings.Split(strings.TrimSpace(raw), "\n")
	recommendations := make([]SuggestedPianist, 0, len(lines))

	for _, line := range lines {
		line = strings.TrimSpace(line)
		line = strings.TrimLeft(line, "-* ")
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if prefix, rest, ok := strings.Cut(line, ". "); ok && isDigits(prefix) {
			line = rest
		}

		parts := strings.Split(line, "||")
		if len(parts) < 4 {
			continue
		}

		pianistName := strings.TrimSpace(parts[0])
		whyFit := strings.TrimSpace(parts[1])
		confidence := strings.TrimSpace(parts[3])
		if pianistName == "" || whyFit == "" {
			continue
		}

		similarTo := make([]string, 0)
		for _, item := range strings.Split(parts[2], ",") {
			if trimmed := strings.TrimSpace(item); trimmed != "" {
				similarTo = append(similarTo, trimmed)
			}
		}

		recommendations = append(recommendations, SuggestedPianist{
			PianistName: pianistName,
			WhyFit:      whyFit,
			SimilarTo:   similarTo,
			Confidence:  confidence,
		})
	}

	if len(recommendations) == 0 {
		return nil, errors.New("LLM plaintext recommendation fallback produced no parseable lines")
	}
	return recommendations, nil
}

func parseDiscoveryPartial(raw string) (DiscoveryResult, string, error) {
	cleaned := cleanLLMText(raw)

	var result DiscoveryResult
	if err := json.Unmarshal([]byte(cleaned), &result); err != nil {
		return DiscoveryResult{}, cleaned, fmt.Errorf("decode LLM discovery response: %w", err)
	}

	if normalized, ok := parseDiscoveryAliases(cleaned); ok && aliasResultIsBetter(normalized, result) {
		result = normalized
	}

	return result, cleaned, nil
}

func cleanLLMText(raw string) string {
	cleaned := strings.TrimSpace(raw)
	cleaned = strings.TrimPrefix(cleaned, "```json")
	cleaned = strings.TrimPrefix(cleaned, "```")
	cleaned = strings.TrimSuffix(cleaned, "```")
	return strings.TrimSpace(cleaned)
}

func parseDiscoveryAliases(cleaned string) (DiscoveryResult, bool) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(cleaned), &payload); err != nil {
		return DiscoveryResult{}, false
	}
	return parseDiscoveryAliasesMap(payload)
}

func parseDiscoveryAliasesMap(payload map[string]any) (DiscoveryResult, bool) {
	if nested, ok := payload["result"].(map[string]any); ok {
		if result, ok := parseDiscoveryAliasesMap(nested); ok {
			return result, true
		}
	}
	if nested, ok := payload["data"].(map[string]any); ok {
		if result, ok := parseDiscoveryAliasesMap(nested); ok {
			return result, true
		}
	}

	result := DiscoveryResult{
		Summary: strings.TrimSpace(firstNonEmpty(asString(payload["summary"]), asString(payload["overview"]))),
	}

	source := firstArray(payload, "recommendations", "pianists", "suggestions", "candidates")
	if len(source) == 0 {
		source = findRecommendationArray(payload)
	}
	if len(source) == 0 {
		return result, result.Summary != ""
	}

	result.Recommendations = make([]SuggestedPianist, 0, len(source))
	for _, item := range source {
		rec, ok := item.(map[string]any)
		if !ok {
			continue
		}
		result.Recommendations = append(result.Recommendations, SuggestedPianist{
			PianistName: strings.TrimSpace(firstNonEmpty(
				asString(rec["pianist_name"]),
				asString(rec["name"]),
				asString(rec["pianist"]),
				asString(rec["artist"]),
			)),
			WhyFit: strings.TrimSpace(firstNonEmpty(
				asString(rec["why_fit"]),
				asString(rec["reason"]),
				asString(rec["why"]),
			)),
			SimilarTo:  firstStringArray(rec, "similar_to", "similar"),
			Confidence: strings.TrimSpace(asString(rec["confidence"])),
		})
	}

	return result, true
}

func aliasResultIsBetter(candidate DiscoveryResult, current DiscoveryResult) bool {
	if len(candidate.Recommendations) == 0 {
		return false
	}
	if len(current.Recommendations) == 0 {
		return true
	}

	candidateScore := recommendationCompletenessScore(candidate.Recommendations)
	currentScore := recommendationCompletenessScore(current.Recommendations)
	return candidateScore > currentScore
}

func recommendationCompletenessScore(items []SuggestedPianist) int {
	score := 0
	for _, item := range items {
		if strings.TrimSpace(item.PianistName) != "" {
			score += 2
		}
		if strings.TrimSpace(item.WhyFit) != "" {
			score += 2
		}
		if len(item.SimilarTo) > 0 {
			score++
		}
		if strings.TrimSpace(item.Confidence) != "" {
			score++
		}
	}
	return score
}

func previewJSON(cleaned string) string {
	const maxLen = 240
	cleaned = strings.Join(strings.Fields(cleaned), " ")
	if len(cleaned) <= maxLen {
		return cleaned
	}
	return cleaned[:maxLen] + "..."
}

func firstArray(payload map[string]any, keys ...string) []any {
	for _, key := range keys {
		items, ok := payload[key].([]any)
		if ok && len(items) > 0 {
			return items
		}
	}
	return nil
}

func firstStringArray(payload map[string]any, keys ...string) []string {
	for _, key := range keys {
		values, ok := payload[key].([]any)
		if !ok || len(values) == 0 {
			continue
		}
		result := make([]string, 0, len(values))
		for _, value := range values {
			if trimmed := strings.TrimSpace(asString(value)); trimmed != "" {
				result = append(result, trimmed)
			}
		}
		if len(result) > 0 {
			return result
		}
	}
	return nil
}

func asString(value any) string {
	text, _ := value.(string)
	return text
}

func findRecommendationArray(payload map[string]any) []any {
	for _, value := range payload {
		if items := recommendationArrayFromValue(value); len(items) > 0 {
			return items
		}
	}
	return nil
}

func recommendationArrayFromValue(value any) []any {
	switch typed := value.(type) {
	case []any:
		if len(typed) == 0 {
			return nil
		}
		first, ok := typed[0].(map[string]any)
		if ok && looksLikeRecommendationObject(first) {
			return typed
		}
	case map[string]any:
		for _, key := range []string{"items", "entries", "results", "recommendations", "pianists", "suggestions", "candidates"} {
			if items, ok := typed[key].([]any); ok && len(items) > 0 {
				first, ok := items[0].(map[string]any)
				if ok && looksLikeRecommendationObject(first) {
					return items
				}
			}
		}
	}
	return nil
}

func looksLikeRecommendationObject(payload map[string]any) bool {
	hasName := strings.TrimSpace(firstNonEmpty(
		asString(payload["pianist_name"]),
		asString(payload["name"]),
		asString(payload["pianist"]),
		asString(payload["artist"]),
	)) != ""
	hasReason := strings.TrimSpace(firstNonEmpty(
		asString(payload["why_fit"]),
		asString(payload["reason"]),
		asString(payload["why"]),
	)) != ""
	return hasName && hasReason
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func isDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// favoriteScore deliberately favors explicit ratings over raw replay volume,
// with a small penalty for tiny sample sizes.
func favoriteScore(averageStars float64, ratedTrackCount int, totalPlayCount int64) float64 {
	ratingScore := averageStars * 20
	sampleScore := math.Min(float64(ratedTrackCount), 5) * 5
	playScore := math.Log1p(float64(totalPlayCount)) * 8

	penalty := 0.0
	switch ratedTrackCount {
	case 0:
		penalty = 8
	case 1:
		penalty = 4
	}

	return ratingScore + sampleScore + playScore - penalty
}

func compareProfiles(left PianistProfile, right PianistProfile) int {
	switch {
	case left.FavoriteScore > right.FavoriteScore:
		return -1
	case left.FavoriteScore < right.FavoriteScore:
		return 1
	case left.RatedTrackCount > right.RatedTrackCount:
		return -1
	case left.RatedTrackCount < right.RatedTrackCount:
		return 1
	case left.TotalPlayCount > right.TotalPlayCount:
		return -1
	case left.TotalPlayCount < right.TotalPlayCount:
		return 1
	default:
		return strings.Compare(left.Name, right.Name)
	}
}

func compareTasteTracks(left TasteTrack, right TasteTrack) int {
	switch {
	case left.Stars > right.Stars:
		return -1
	case left.Stars < right.Stars:
		return 1
	case left.PlayCount > right.PlayCount:
		return -1
	case left.PlayCount < right.PlayCount:
		return 1
	case left.LastPlayedAt > right.LastPlayedAt:
		return -1
	case left.LastPlayedAt < right.LastPlayedAt:
		return 1
	default:
		return strings.Compare(left.TrackName, right.TrackName)
	}
}

// filterRatedTracks keeps the summary payload small while still preserving the
// strongest positive/negative/commented examples for the model.
func filterRatedTracks(tracks []TasteTrack, keep func(TasteTrack) bool, limit int) []TasteTrack {
	filtered := make([]TasteTrack, 0, len(tracks))
	for _, track := range tracks {
		if keep(track) {
			filtered = append(filtered, track)
		}
	}
	slices.SortFunc(filtered, compareTasteTracks)
	if len(filtered) > limit {
		filtered = filtered[:limit]
	}
	return filtered
}

// matchedAllowlistedArtists keeps attribution limited to the curated pianist
// list instead of every artist string attached to a classical recording.
func matchedAllowlistedArtists(artists []string, allowset map[string]struct{}, canonicalNames map[string]string) []string {
	seen := map[string]struct{}{}
	matched := make([]string, 0, len(artists))
	for _, artist := range artists {
		normalized := normalizeName(artist)
		if _, ok := allowset[normalized]; !ok {
			continue
		}
		name := canonicalNames[normalized]
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		matched = append(matched, name)
	}
	return matched
}

func decodeArtists(raw string) ([]string, error) {
	var artists []string
	if err := json.Unmarshal([]byte(raw), &artists); err != nil {
		return nil, err
	}
	return artists, nil
}

// allowlistSet returns both a normalized lookup set and a canonical-name map so
// later stages can match case-insensitively but still print the configured name.
func allowlistSet(items []string) (map[string]struct{}, map[string]string) {
	set := make(map[string]struct{}, len(items))
	canonical := make(map[string]string, len(items))
	for _, item := range items {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" {
			continue
		}
		normalized := normalizeName(trimmed)
		set[normalized] = struct{}{}
		canonical[normalized] = trimmed
	}
	return set, canonical
}

// pickBestArtistMatch prefers exact normalized-name matches before falling back
// to substring matches from the validation catalog.
func pickBestArtistMatch(query string, artists []CatalogArtist) (CatalogArtist, bool) {
	normalizedQuery := normalizeName(query)
	for _, artist := range artists {
		if normalizeName(artist.Name) == normalizedQuery {
			return artist, true
		}
	}
	for _, artist := range artists {
		if strings.Contains(normalizeName(artist.Name), normalizedQuery) {
			return artist, true
		}
	}
	return CatalogArtist{}, false
}

func normalizeName(name string) string {
	return strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(name)), " "))
}

func roundToTwoDecimals(value float64) float64 {
	return math.Round(value*100) / 100
}

func minInt(a int, b int) int {
	if a < b {
		return a
	}
	return b
}
