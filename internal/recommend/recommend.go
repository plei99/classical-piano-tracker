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

type PianistProfile struct {
	Name            string
	TrackCount      int
	RatedTrackCount int
	TotalPlayCount  int64
	AverageStars    float64
	FavoriteScore   float64
}

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

type FavoritePianist struct {
	Name            string  `json:"name"`
	TrackCount      int     `json:"track_count"`
	RatedTrackCount int     `json:"rated_track_count"`
	TotalPlayCount  int64   `json:"total_play_count"`
	AverageStars    float64 `json:"average_stars"`
	FavoriteScore   float64 `json:"favorite_score"`
}

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

type SuggestedPianist struct {
	PianistName string   `json:"pianist_name"`
	WhyFit      string   `json:"why_fit"`
	SimilarTo   []string `json:"similar_to"`
	Confidence  string   `json:"confidence"`
}

type DiscoveryResult struct {
	Summary         string             `json:"summary"`
	Recommendations []SuggestedPianist `json:"recommendations"`
}

type ValidatedPianist struct {
	SuggestedPianist
	SpotifyName string
	SpotifyID   string
	Popularity  int
	Genres      []string
}

type CatalogArtist struct {
	Name       string
	ID         string
	Popularity int
	Genres     []string
}

type ArtistSearcher interface {
	SearchArtists(ctx context.Context, query string, limit int) ([]CatalogArtist, error)
}

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

func ValidateDiscoveryInput(summary TasteSummary) error {
	if summary.TotalRatings < minRatingsForDiscovery {
		return fmt.Errorf("need at least %d rated tracks before generating pianist recommendations", minRatingsForDiscovery)
	}
	if len(summary.FavoritePianists) == 0 {
		return errors.New("no favorite pianists could be derived from the current database and allowlist")
	}
	return nil
}

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

func ParseDiscoveryResult(raw string) (DiscoveryResult, error) {
	cleaned := strings.TrimSpace(raw)
	cleaned = strings.TrimPrefix(cleaned, "```json")
	cleaned = strings.TrimPrefix(cleaned, "```")
	cleaned = strings.TrimSuffix(cleaned, "```")
	cleaned = strings.TrimSpace(cleaned)

	var result DiscoveryResult
	if err := json.Unmarshal([]byte(cleaned), &result); err != nil {
		return DiscoveryResult{}, fmt.Errorf("decode LLM discovery response: %w", err)
	}

	if strings.TrimSpace(result.Summary) == "" {
		return DiscoveryResult{}, errors.New("LLM discovery response omitted summary")
	}
	if len(result.Recommendations) == 0 {
		return DiscoveryResult{}, errors.New("LLM discovery response omitted recommendations")
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
