//! Local taste analysis (favorite pianists, taste summaries) and parsing and
//! validation of LLM pianist suggestions.

mod gomath;
mod parse;

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracker_core::{ArtistSearcher, CatalogArtist, Rating, Track};

pub use parse::{
    parse_discovery_partial, parse_discovery_recommendations, parse_discovery_result, parse_plaintext_recommendations,
    parse_taste_summary,
};

const MIN_RATINGS_FOR_DISCOVERY: usize = 3;
const MAX_FAVORITE_PIANISTS: usize = 8;
const MAX_LOVED_TRACKS: usize = 10;
const MAX_DISLIKED_TRACKS: usize = 5;
const MAX_COMMENTED_TRACKS: usize = 8;
const DEFAULT_VALIDATION_LIMIT: usize = 5;

const DISCOVERY_GUIDANCE: &str = "Recommend real classical concert pianists not already present in the known pianist list. \
Use the ratings and comments to infer interpretive taste, then propose nearby but distinct pianists with substantial recording catalogs.";

/// Deterministic per-pianist aggregate used by `recommend favorites`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PianistProfile {
    pub name: String,
    pub track_count: usize,
    pub rated_track_count: usize,
    pub total_play_count: i64,
    pub average_stars: f64,
    pub favorite_score: f64,
}

/// The reduced track shape summarized for the LLM.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TasteTrack {
    pub track_id: i64,
    pub track_name: String,
    pub album_name: String,
    pub artists: Vec<String>,
    pub play_count: i64,
    pub last_played_at: i64,
    pub stars: i64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub opinion: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub matched_artist: String,
}

/// The JSON-facing version of [`PianistProfile`]; it deliberately omits the
/// favorite score so the LLM infers taste from ratings, not our heuristic.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FavoritePianist {
    pub name: String,
    pub track_count: usize,
    pub rated_track_count: usize,
    pub total_play_count: i64,
    pub average_stars: f64,
}

/// The taste snapshot sent to the LLM. It is designed to be stable,
/// explainable, and much smaller than dumping the whole database.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TasteSummary {
    pub total_tracks: usize,
    pub total_ratings: usize,
    pub comment_count: usize,
    pub favorite_pianists: Vec<FavoritePianist>,
    pub loved_tracks: Vec<TasteTrack>,
    pub disliked_tracks: Vec<TasteTrack>,
    pub commented_tracks: Vec<TasteTrack>,
    pub known_pianists: Vec<String>,
    pub discovery_guidance: String,
}

/// The raw structured output requested from the LLM.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuggestedPianist {
    pub pianist_name: String,
    pub why_fit: String,
    pub similar_to: Vec<String>,
    pub confidence: String,
}

/// The model summary plus raw pianist suggestions.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryResult {
    pub summary: String,
    pub recommendations: Vec<SuggestedPianist>,
}

/// A suggestion that survived Spotify catalog validation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ValidatedPianist {
    pub suggestion: SuggestedPianist,
    pub spotify_name: String,
    pub spotify_id: String,
    pub popularity: i64,
    pub genres: Vec<String>,
}

/// Normalized allowlist lookup. Matching is case- and whitespace-insensitive,
/// but output keeps the configured spelling.
struct Allowlist {
    canonical: HashMap<String, String>,
}

impl Allowlist {
    fn new(items: &[String]) -> Allowlist {
        let mut canonical = HashMap::with_capacity(items.len());
        for item in items {
            let trimmed = item.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Later duplicates win, as with the Go map assignment.
            canonical.insert(normalize_name(trimmed), trimmed.to_string());
        }
        Allowlist { canonical }
    }

    fn contains(&self, normalized: &str) -> bool {
        self.canonical.contains_key(normalized)
    }

    /// Keeps attribution limited to the curated pianist list instead of every
    /// artist string attached to a classical recording.
    fn matched_artists(&self, artists: &[String]) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut matched = Vec::with_capacity(artists.len());
        for artist in artists {
            let Some(name) = self.canonical.get(&normalize_name(artist)) else { continue };
            if seen.insert(name.clone()) {
                matched.push(name.clone());
            }
        }
        matched
    }
}

/// Attributes local tracks and ratings to allowlisted pianists and computes
/// the deterministic favorite score used by the CLI.
pub fn build_pianist_profiles(
    tracks: &[Track],
    ratings: &[Rating],
    allowlist: &[String],
) -> Result<Vec<PianistProfile>> {
    #[derive(Default)]
    struct Aggregate {
        track_count: usize,
        rated_track_count: usize,
        total_play_count: i64,
        total_stars: i64,
    }

    let allowlist = Allowlist::new(allowlist);
    let rating_by_track_id = ratings_by_track_id(ratings);
    let mut aggregates: HashMap<String, Aggregate> = HashMap::new();

    for track in tracks {
        let artists =
            decode_artists(&track.artists).with_context(|| format!("decode artists for track {}", track.id))?;
        let matched = allowlist.matched_artists(&artists);
        if matched.is_empty() {
            continue;
        }

        let rating = rating_by_track_id.get(&track.id);
        for name in matched {
            let agg = aggregates.entry(name).or_default();
            agg.track_count += 1;
            agg.total_play_count += track.play_count;
            if let Some(rating) = rating {
                agg.rated_track_count += 1;
                agg.total_stars += rating.stars;
            }
        }
    }

    let mut profiles: Vec<PianistProfile> = aggregates
        .into_iter()
        .map(|(name, agg)| {
            let average_stars =
                if agg.rated_track_count > 0 { agg.total_stars as f64 / agg.rated_track_count as f64 } else { 0.0 };
            PianistProfile {
                name,
                track_count: agg.track_count,
                rated_track_count: agg.rated_track_count,
                total_play_count: agg.total_play_count,
                average_stars,
                favorite_score: favorite_score(average_stars, agg.rated_track_count, agg.total_play_count),
            }
        })
        .collect();

    profiles.sort_by(compare_profiles);
    Ok(profiles)
}

/// Reduces the local DB into a compact explanation of the user's taste for
/// the LLM-backed discovery flow.
pub fn build_taste_summary(tracks: &[Track], ratings: &[Rating], allowlist: &[String]) -> Result<TasteSummary> {
    let profiles = build_pianist_profiles(tracks, ratings, allowlist)?;
    let rating_by_track_id = ratings_by_track_id(ratings);
    let allowset = Allowlist::new(allowlist);

    let mut rated_tracks = Vec::with_capacity(ratings.len());
    let mut commented_tracks = Vec::with_capacity(ratings.len());
    for track in tracks {
        let Some(rating) = rating_by_track_id.get(&track.id) else { continue };
        let artists =
            decode_artists(&track.artists).with_context(|| format!("decode artists for track {}", track.id))?;
        let matched_artist = allowset.matched_artists(&artists).into_iter().next().unwrap_or_default();

        let entry = TasteTrack {
            track_id: track.id,
            track_name: track.track_name.clone(),
            album_name: track.album_name.clone(),
            artists,
            play_count: track.play_count,
            last_played_at: track.last_played_at,
            stars: rating.stars,
            opinion: rating.opinion.trim().to_string(),
            matched_artist,
        };
        if !entry.opinion.is_empty() {
            commented_tracks.push(entry.clone());
        }
        rated_tracks.push(entry);
    }

    let loved_tracks = filter_rated_tracks(&rated_tracks, |track| track.stars >= 4, MAX_LOVED_TRACKS);
    let disliked_tracks = filter_rated_tracks(&rated_tracks, |track| track.stars <= 2, MAX_DISLIKED_TRACKS);

    commented_tracks.sort_by(compare_taste_tracks);
    commented_tracks.truncate(MAX_COMMENTED_TRACKS);

    let favorite_pianists = profiles
        .iter()
        .take(MAX_FAVORITE_PIANISTS)
        .map(|profile| FavoritePianist {
            name: profile.name.clone(),
            track_count: profile.track_count,
            rated_track_count: profile.rated_track_count,
            total_play_count: profile.total_play_count,
            average_stars: round_to_two_decimals(profile.average_stars),
        })
        .collect();

    let known_pianists =
        allowlist.iter().map(|name| name.trim()).filter(|name| !name.is_empty()).map(str::to_string).collect();

    let comment_count = rated_tracks.iter().filter(|track| !track.opinion.is_empty()).count();

    Ok(TasteSummary {
        total_tracks: tracks.len(),
        total_ratings: ratings.len(),
        comment_count,
        favorite_pianists,
        loved_tracks,
        disliked_tracks,
        commented_tracks,
        known_pianists,
        discovery_guidance: DISCOVERY_GUIDANCE.to_string(),
    })
}

/// Enforces a minimum amount of local signal before the app spends
/// network/API budget on LLM recommendations.
pub fn validate_discovery_input(summary: &TasteSummary) -> Result<()> {
    if summary.total_ratings < MIN_RATINGS_FOR_DISCOVERY {
        bail!("need at least {MIN_RATINGS_FOR_DISCOVERY} rated tracks before generating pianist recommendations");
    }
    if summary.favorite_pianists.is_empty() {
        bail!("no favorite pianists could be derived from the current database and allowlist");
    }
    Ok(())
}

/// Removes duplicates and known pianists, then checks every remaining
/// suggestion against a real catalog search before surfacing it, so
/// hallucinated names never reach the user.
pub fn validate_suggested_pianists(
    searcher: &dyn ArtistSearcher,
    known_pianists: &[String],
    suggestions: &[SuggestedPianist],
    limit: usize,
) -> Result<Vec<ValidatedPianist>> {
    let limit = if limit < 1 { DEFAULT_VALIDATION_LIMIT } else { limit };
    let known = Allowlist::new(known_pianists);
    let mut seen = HashSet::new();
    let mut validated = Vec::with_capacity(suggestions.len());

    for suggestion in suggestions {
        let query = suggestion.pianist_name.trim();
        if query.is_empty() {
            continue;
        }
        let normalized = normalize_name(query);
        if !seen.insert(normalized.clone()) {
            continue;
        }
        if known.contains(&normalized) {
            continue;
        }

        let artists = searcher.search_artists(query, limit).with_context(|| format!("validate pianist {query:?}"))?;
        let Some(found) = pick_best_artist_match(query, &artists) else { continue };

        validated.push(ValidatedPianist {
            suggestion: suggestion.clone(),
            spotify_name: found.name.clone(),
            spotify_id: found.id.clone(),
            popularity: found.popularity,
            genres: found.genres.clone(),
        });
    }

    Ok(validated)
}

fn ratings_by_track_id(ratings: &[Rating]) -> HashMap<i64, &Rating> {
    // Later ratings for the same track win, as with the Go map assignment.
    ratings.iter().map(|rating| (rating.track_id, rating)).collect()
}

/// Deliberately favors explicit ratings over raw replay volume, with a small
/// penalty for tiny sample sizes.
fn favorite_score(average_stars: f64, rated_track_count: usize, total_play_count: i64) -> f64 {
    let rating_score = average_stars * 20.0;
    let sample_score = (rated_track_count as f64).min(5.0) * 5.0;
    let play_score = gomath::log1p(total_play_count as f64) * 8.0;
    let penalty = match rated_track_count {
        0 => 8.0,
        1 => 4.0,
        _ => 0.0,
    };
    rating_score + sample_score + play_score - penalty
}

fn compare_profiles(left: &PianistProfile, right: &PianistProfile) -> Ordering {
    // Descending on the numeric keys, then ascending by name. Scores are
    // never NaN, so partial_cmp always succeeds.
    right
        .favorite_score
        .partial_cmp(&left.favorite_score)
        .unwrap_or(Ordering::Equal)
        .then(right.rated_track_count.cmp(&left.rated_track_count))
        .then(right.total_play_count.cmp(&left.total_play_count))
        .then_with(|| left.name.cmp(&right.name))
}

fn compare_taste_tracks(left: &TasteTrack, right: &TasteTrack) -> Ordering {
    right
        .stars
        .cmp(&left.stars)
        .then(right.play_count.cmp(&left.play_count))
        .then(right.last_played_at.cmp(&left.last_played_at))
        .then_with(|| left.track_name.cmp(&right.track_name))
}

/// Keeps the summary payload small while still preserving the strongest
/// positive/negative examples for the model.
fn filter_rated_tracks(tracks: &[TasteTrack], keep: impl Fn(&TasteTrack) -> bool, limit: usize) -> Vec<TasteTrack> {
    let mut filtered: Vec<TasteTrack> = tracks.iter().filter(|track| keep(track)).cloned().collect();
    filtered.sort_by(compare_taste_tracks);
    filtered.truncate(limit);
    filtered
}

/// Decodes the artists column with Go's `json.Unmarshal` into `[]string`
/// semantics: `null` is an empty list and `null` elements become "".
fn decode_artists(raw: &str) -> Result<Vec<String>> {
    match serde_json::from_str::<Value>(raw)? {
        Value::Null => Ok(Vec::new()),
        Value::Array(items) => items
            .into_iter()
            .map(|item| match item {
                Value::String(text) => Ok(text),
                Value::Null => Ok(String::new()),
                other => {
                    Err(anyhow!("json: cannot unmarshal {} into Go value of type string", parse::json_kind(&other)))
                }
            })
            .collect(),
        other => Err(anyhow!("json: cannot unmarshal {} into Go value of type []string", parse::json_kind(&other))),
    }
}

/// Prefers exact normalized-name matches before falling back to substring
/// matches from the validation catalog.
fn pick_best_artist_match<'a>(query: &str, artists: &'a [CatalogArtist]) -> Option<&'a CatalogArtist> {
    let normalized_query = normalize_name(query);
    artists
        .iter()
        .find(|artist| normalize_name(&artist.name) == normalized_query)
        .or_else(|| artists.iter().find(|artist| normalize_name(&artist.name).contains(&normalized_query)))
}

fn normalize_name(name: &str) -> String {
    go_to_lower(&name.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// Go's `strings.ToLower` maps each rune independently with simple case
/// mapping. Rust's `str::to_lowercase` is context-sensitive (final sigma) and
/// expands U+0130, so lower per char and keep only the first mapped char.
fn go_to_lower(text: &str) -> String {
    text.chars().map(|ch| ch.to_lowercase().next().unwrap_or(ch)).collect()
}

fn round_to_two_decimals(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn track(id: i64, name: &str, album: &str, artists: &str, play_count: i64, last_played_at: i64) -> Track {
        Track {
            id,
            track_name: name.into(),
            album_name: album.into(),
            artists: artists.into(),
            play_count,
            last_played_at,
            ..Track::default()
        }
    }

    fn rating(track_id: i64, stars: i64, opinion: &str) -> Rating {
        Rating { track_id, stars, opinion: opinion.into(), updated_at: 0 }
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn build_pianist_profiles_uses_allowlist_and_sorts_by_score() {
        let tracks = vec![
            track(1, "Track One", "", r#"["Martha Argerich","London Symphony Orchestra"]"#, 6, 0),
            track(2, "Track Two", "", r#"["Martha Argerich"]"#, 3, 0),
            track(3, "Track Three", "", r#"["Daniil Trifonov"]"#, 2, 0),
            track(4, "Track Four", "", r#"["Unknown Artist"]"#, 20, 0),
        ];
        let ratings = vec![rating(1, 5, ""), rating(2, 4, ""), rating(3, 5, "")];
        let allowlist = strings(&["Martha Argerich", "Daniil Trifonov"]);

        let profiles = build_pianist_profiles(&tracks, &ratings, &allowlist).unwrap();
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0].name, "Martha Argerich");
        assert_eq!(profiles[0].rated_track_count, 2);
        assert_eq!(profiles[0].total_play_count, 9);
        assert_eq!(profiles[1].name, "Daniil Trifonov");
    }

    #[test]
    fn build_pianist_profiles_matches_case_insensitively_and_keeps_configured_name() {
        let tracks = vec![
            track(1, "A", "", r#"["  martha   ARGERICH ","Martha Argerich"]"#, 1, 0),
            track(2, "B", "", "null", 1, 0),
        ];
        let profiles = build_pianist_profiles(&tracks, &[], &strings(&["Martha Argerich", " "])).unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].name, "Martha Argerich");
        assert_eq!(profiles[0].track_count, 1, "duplicate attribution within one track counts once");
        assert_eq!(profiles[0].average_stars, 0.0);

        let err = build_pianist_profiles(&[track(7, "C", "", "not json", 1, 0)], &[], &strings(&["X"])).unwrap_err();
        assert!(format!("{err:#}").starts_with("decode artists for track 7: "), "{err:#}");
    }

    #[test]
    fn favorite_score_matches_go_bit_for_bit() {
        // Golden values produced by the Go implementation (math.Log1p).
        let cases: &[(f64, usize, i64, u64)] = &[
            (5.0, 2, 9, 0x40600d763776aaa3),
            (4.5, 2, 9, 0x405d9aec6eed5546),
            (0.0, 0, 0, 0xc020000000000000),
            (3.0, 1, 1, 0x4050a2e42fefa39f),
            (11.0 / 3.0, 3, 3, 0x4058db1db5349c93),
            (4.2, 7, 123456789, 0x407020d1c5f98f0a),
        ];
        for &(average, rated, plays, bits) in cases {
            let score = favorite_score(average, rated, plays);
            assert_eq!(score.to_bits(), bits, "avg={average} rated={rated} plays={plays} got={score}");
        }
    }

    #[test]
    fn build_taste_summary_collects_comments_and_favorites() {
        let tracks = vec![
            track(1, "Concerto", "Album A", r#"["Martha Argerich"]"#, 4, 30),
            track(2, "Sonata", "Album B", r#"["Daniil Trifonov"]"#, 2, 20),
            track(3, "Ballade", "Album C", r#"["Martha Argerich"]"#, 1, 10),
        ];
        let ratings = vec![rating(1, 5, "Explosive and clear"), rating(2, 2, "Too heavy"), rating(3, 4, "")];

        let summary =
            build_taste_summary(&tracks, &ratings, &strings(&["Martha Argerich", "Daniil Trifonov"])).unwrap();
        assert_eq!(summary.total_ratings, 3);
        assert_eq!(summary.comment_count, 2);
        assert_eq!(summary.favorite_pianists.first().map(|p| p.name.as_str()), Some("Martha Argerich"));
        assert_eq!(summary.loved_tracks.len(), 2);
        assert_eq!(summary.disliked_tracks.len(), 1);
        assert_eq!(summary.disliked_tracks[0].track_name, "Sonata");
        assert_eq!(summary.commented_tracks.len(), 2);
        assert_eq!(summary.known_pianists, vec!["Martha Argerich", "Daniil Trifonov"]);

        let data = serde_json::to_string(&summary).unwrap();
        assert!(!data.contains("favorite_score"), "summary JSON = {data}, did not expect favorite_score");
    }

    #[test]
    fn build_taste_summary_applies_limits_sorting_and_rounding() {
        let mut tracks = Vec::new();
        let mut ratings = Vec::new();
        for id in 1..=12 {
            tracks.push(track(id, &format!("T{id:02}"), "", r#"["A"]"#, id % 3, id));
            ratings.push(rating(id, 5, if id % 2 == 0 { " note " } else { "" }));
        }
        for id in 13..=19 {
            tracks.push(track(id, &format!("D{id}"), "", r#"["B"]"#, 1, 100));
            ratings.push(rating(id, 1, "meh"));
        }
        tracks.push(track(20, "Third", "", r#"["C"]"#, 1, 1));
        ratings.push(rating(20, 3, ""));
        tracks.push(track(21, "Third2", "", r#"["C"]"#, 1, 1));
        ratings.push(rating(21, 4, ""));
        tracks.push(track(22, "Third3", "", r#"["C"]"#, 1, 1));
        ratings.push(rating(22, 4, ""));
        for (id, name) in (23..).zip(["D", "E", "F", "G", "H", "I", "J", "K"]) {
            tracks.push(track(id, name, "", &format!(r#"["{name}"]"#), 1, 1));
        }

        let allowlist = strings(&["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"]);
        let summary = build_taste_summary(&tracks, &ratings, &allowlist).unwrap();

        assert_eq!(summary.total_tracks, tracks.len());
        assert_eq!(summary.loved_tracks.len(), MAX_LOVED_TRACKS);
        assert_eq!(summary.disliked_tracks.len(), MAX_DISLIKED_TRACKS);
        assert_eq!(summary.commented_tracks.len(), MAX_COMMENTED_TRACKS);
        assert_eq!(summary.favorite_pianists.len(), MAX_FAVORITE_PIANISTS);
        assert_eq!(summary.comment_count, 6 + 7);
        assert_eq!(summary.commented_tracks[0].opinion, "note", "opinions are trimmed");

        // Loved: 5 stars first, then play count desc, last_played desc, name.
        let loved: Vec<_> = summary.loved_tracks.iter().map(|t| t.track_name.as_str()).collect();
        assert_eq!(loved, vec!["T11", "T08", "T05", "T02", "T10", "T07", "T04", "T01", "T12", "T09"]);
        // Equal disliked tracks fall back to name order.
        let disliked: Vec<_> = summary.disliked_tracks.iter().map(|t| t.track_name.as_str()).collect();
        assert_eq!(disliked, vec!["D13", "D14", "D15", "D16", "D17"]);
        assert_eq!(summary.disliked_tracks[0].matched_artist, "B");

        let c = summary.favorite_pianists.iter().find(|p| p.name == "C").unwrap();
        assert_eq!(c.average_stars, 3.67);
        assert_eq!(summary.favorite_pianists[0].name, "A");
        // Unrated pianists tie on score, rated count, and plays; names break it.
        let unrated: Vec<_> = summary.favorite_pianists[3..].iter().map(|p| p.name.as_str()).collect();
        assert_eq!(unrated, vec!["D", "E", "F", "G", "H"]);
    }

    #[test]
    fn validate_discovery_input_requires_enough_ratings() {
        let summary = TasteSummary {
            total_ratings: 2,
            favorite_pianists: vec![FavoritePianist { name: "Martha Argerich".into(), ..Default::default() }],
            ..Default::default()
        };
        let err = validate_discovery_input(&summary).unwrap_err();
        assert_eq!(err.to_string(), "need at least 3 rated tracks before generating pianist recommendations");

        let err = validate_discovery_input(&TasteSummary { total_ratings: 3, ..Default::default() }).unwrap_err();
        assert_eq!(err.to_string(), "no favorite pianists could be derived from the current database and allowlist");
    }

    struct FakeArtistSearcher {
        results: HashMap<String, Vec<CatalogArtist>>,
        queries: RefCell<Vec<(String, usize)>>,
    }

    impl ArtistSearcher for FakeArtistSearcher {
        fn search_artists(&self, query: &str, limit: usize) -> Result<Vec<CatalogArtist>> {
            self.queries.borrow_mut().push((query.to_string(), limit));
            if query == "Broken" {
                bail!("boom");
            }
            Ok(self.results.get(query).cloned().unwrap_or_default())
        }
    }

    fn artist(name: &str, id: &str, popularity: i64) -> CatalogArtist {
        CatalogArtist { name: name.into(), id: id.into(), popularity, genres: vec!["classical".into()] }
    }

    fn suggestion(name: &str, why: &str) -> SuggestedPianist {
        SuggestedPianist { pianist_name: name.into(), why_fit: why.into(), ..Default::default() }
    }

    #[test]
    fn validate_suggested_pianists_filters_known_names_and_requires_catalog_match() {
        let searcher = FakeArtistSearcher {
            results: HashMap::from([
                ("Radu Lupu".to_string(), vec![artist("Radu Lupu", "artist-1", 55)]),
                ("Martha Argerich".to_string(), vec![artist("Martha Argerich", "artist-2", 80)]),
                ("Invented Pianist".to_string(), vec![artist("Completely Different", "artist-3", 10)]),
            ]),
            queries: RefCell::default(),
        };

        let validated = validate_suggested_pianists(
            &searcher,
            &strings(&["Martha Argerich"]),
            &[
                suggestion("Radu Lupu", "poetic"),
                suggestion("Martha Argerich", "known already"),
                suggestion("Invented Pianist", "hallucinated"),
            ],
            5,
        )
        .unwrap();
        assert_eq!(validated.len(), 1);
        assert_eq!(validated[0].spotify_name, "Radu Lupu");
        assert_eq!(validated[0].spotify_id, "artist-1");
        assert_eq!(validated[0].popularity, 55);
        assert_eq!(validated[0].suggestion.why_fit, "poetic");
    }

    #[test]
    fn validate_suggested_pianists_dedupes_defaults_limit_and_prefers_exact_match() {
        let searcher = FakeArtistSearcher {
            results: HashMap::from([(
                "radu lupu".to_string(),
                vec![artist("Radu Lupu Tribute", "sub", 1), artist("RADU  LUPU", "exact", 2)],
            )]),
            queries: RefCell::default(),
        };
        let validated = validate_suggested_pianists(
            &searcher,
            &[],
            &[suggestion("  ", "blank"), suggestion(" radu lupu ", "first"), suggestion("Radu  Lupu", "dupe")],
            0,
        )
        .unwrap();
        assert_eq!(validated.len(), 1);
        assert_eq!(validated[0].spotify_id, "exact");
        assert_eq!(*searcher.queries.borrow(), vec![("radu lupu".to_string(), 5)]);

        let substring = [artist("Radu Lupu Tribute", "sub", 1)];
        assert_eq!(pick_best_artist_match("radu lupu", &substring).map(|a| a.id.as_str()), Some("sub"));

        let err = validate_suggested_pianists(&searcher, &[], &[suggestion("Broken", "x")], 5).unwrap_err();
        assert_eq!(format!("{err:#}"), "validate pianist \"Broken\": boom");
    }

    #[test]
    fn normalize_name_uses_go_lowercasing() {
        assert_eq!(normalize_name("  Víkingur   ÓLAFSSON \t"), "víkingur ólafsson");
        assert_eq!(normalize_name("ΣΑΣ"), "σασ", "no final-sigma context mapping");
        assert_eq!(normalize_name("İ"), "i");
    }
}
