//! The shared prompts and JSON contracts for discovery and taste summaries.
//!
//! Prompt text and the embedded taste-summary JSON must stay identical to the
//! Go build so both produce the same model behavior.

use anyhow::{Context, Result};
use serde_json::{Value, json};
use tracker_recommend::TasteSummary;

use crate::{JsonSchema, Request, StructuredOutputMode, gojson};

const DEFAULT_LIMIT: usize = 5;

/// Owns the shared prompt and JSON contract for pianist discovery.
pub(crate) fn build_discovery_request(summary: &TasteSummary, limit: usize) -> Result<Request> {
    let summary_json = marshal_summary(summary)?;
    let min_recommendations = minimum_discovery_recommendations(limit);

    Ok(Request {
        system_prompt: "You are a classical piano recommendation assistant. Recommend real classical concert pianists, not tracks. Ground every recommendation in the supplied ratings and comments. Do not recommend pianists already listed in known_pianists. A valid answer must include both a non-empty summary and a non-empty recommendations list.".to_string(),
        user_prompt: format!(
            "Use this taste profile JSON to recommend {limit} new pianists.\nReturn a complete JSON object with a summary and a recommendations array. The recommendations array must contain at least {min_recommendations} and at most {limit} pianist objects.\n\n{summary_json}"
        ),
        output_mode: StructuredOutputMode::Strict,
        schema: Some(discovery_schema(min_recommendations, limit)),
        temperature: 0.0,
        max_output_tokens: 0,
    })
}

/// Asks the provider to rewrite an incomplete first pass into a complete
/// object that matches the original discovery schema.
pub(crate) fn build_discovery_repair_request(raw: &str, limit: usize, attempt: usize) -> Request {
    let limit = if limit < 1 { DEFAULT_LIMIT } else { limit };
    let min_recommendations = minimum_discovery_recommendations(limit);

    // Same contract as the original discovery request; only the prompts change.
    Request {
        system_prompt: "You repair incomplete JSON responses for a classical piano recommendation task. Return only a complete JSON object that matches the required schema.".to_string(),
        user_prompt: format!(
            "Repair attempt {attempt}.\nThe previous response was incomplete or malformed, and often omits the recommendations array entirely.\nRewrite it into a valid JSON object with a non-empty summary and a recommendations array containing at least {min_recommendations} and at most {limit} items.\nDo not return a summary-only object. Do not add markdown fences.\n\nPrevious response:\n{raw}"
        ),
        output_mode: StructuredOutputMode::Strict,
        schema: Some(discovery_schema(min_recommendations, limit)),
        temperature: 0.0,
        max_output_tokens: 0,
    }
}

fn discovery_schema(min_recommendations: usize, limit: usize) -> JsonSchema {
    JsonSchema {
        name: "pianist_discovery".to_string(),
        schema: json!({
            "additionalProperties": false,
            "properties": {
                "recommendations": recommendations_schema(min_recommendations, limit),
                "summary": {"minLength": 1, "type": "string"},
            },
            "required": ["summary", "recommendations"],
            "type": "object",
        }),
        strict: true,
    }
}

/// Asks for only the missing recommendation objects when a full-object
/// response keeps collapsing into summary-only JSON.
pub(crate) fn build_discovery_recommendations_only_request(summary: &TasteSummary, limit: usize) -> Result<Request> {
    let limit = if limit < 1 { DEFAULT_LIMIT } else { limit };
    let min_recommendations = minimum_discovery_recommendations(limit);
    let summary_json = marshal_summary(summary)?;

    Ok(Request {
        system_prompt: "You are a classical piano recommendation assistant. Return only recommendation objects for real classical concert pianists not already listed in known_pianists.".to_string(),
        user_prompt: format!(
            "Using this taste profile JSON, return only a JSON object with a recommendations array containing at least {min_recommendations} and at most {limit} pianist objects. Do not include a summary field.\n\n{summary_json}"
        ),
        output_mode: StructuredOutputMode::Strict,
        schema: Some(JsonSchema {
            name: "pianist_recommendations_only".to_string(),
            schema: json!({
                "additionalProperties": false,
                "properties": {
                    "recommendations": recommendations_schema(min_recommendations, limit),
                },
                "required": ["recommendations"],
                "type": "object",
            }),
            strict: true,
        }),
        temperature: 0.0,
        max_output_tokens: 0,
    })
}

/// The last-resort fallback for providers that keep ignoring every
/// structured-output contract. It requests a rigid line format that can
/// still be parsed locally.
pub(crate) fn build_discovery_plaintext_recommendations_request(
    summary: &TasteSummary,
    limit: usize,
) -> Result<Request> {
    let limit = if limit < 1 { DEFAULT_LIMIT } else { limit };
    let min_recommendations = minimum_discovery_recommendations(limit);
    let summary_json = marshal_summary(summary)?;

    Ok(Request {
        system_prompt: "You are a classical piano recommendation assistant. Recommend real classical concert pianists not already listed in known_pianists. Return no prose outside the requested line format.".to_string(),
        user_prompt: format!(
            "Using this taste profile JSON, return between {min_recommendations} and {limit} recommendation lines.\nEach line must follow exactly this format:\nPianist Name || Why fit sentence || Similar pianist 1, Similar pianist 2 || confidence\nNo heading, no markdown, no numbering.\n\n{summary_json}"
        ),
        output_mode: StructuredOutputMode::PromptOnly,
        schema: None,
        temperature: 0.0,
        max_output_tokens: 0,
    })
}

/// Asks for a prose description of the user's current listening and rating
/// profile, not for recommendations.
pub(crate) fn build_taste_summary_request(summary: &TasteSummary) -> Result<Request> {
    // The discovery guidance would steer the model toward recommendations.
    let summary = TasteSummary { discovery_guidance: String::new(), ..summary.clone() };
    let summary_json = marshal_summary(&summary)?;

    Ok(Request {
        system_prompt: "You are a classical piano listening analyst. Summarize the user's listening taste from the supplied ratings, comments, and favorite-pianist aggregates. Do not recommend new pianists or tracks. Return one concise but specific prose summary grounded only in the supplied JSON.".to_string(),
        user_prompt: format!(
            "Summarize this user taste profile in one paragraph. Describe repertoire, interpretive style, and pianist preferences when those signals are present. Return a JSON object with a single non-empty summary string.\n\n{summary_json}"
        ),
        output_mode: StructuredOutputMode::Strict,
        schema: Some(JsonSchema {
            name: "taste_summary".to_string(),
            schema: json!({
                "additionalProperties": false,
                "properties": {
                    "summary": {"minLength": 1, "type": "string"},
                },
                "required": ["summary"],
                "type": "object",
            }),
            strict: true,
        }),
        temperature: 0.0,
        max_output_tokens: 0,
    })
}

/// Keys are written in sorted order so the schema serializes identically
/// to Go's map encoding even if serde_json's `preserve_order` gets enabled.
fn recommendations_schema(min_recommendations: usize, limit: usize) -> Value {
    json!({
        "items": {
            "additionalProperties": false,
            "properties": {
                "confidence": {"minLength": 1, "type": "string"},
                "pianist_name": {"minLength": 1, "type": "string"},
                "similar_to": {
                    "items": {"type": "string"},
                    "type": "array",
                },
                "why_fit": {"minLength": 1, "type": "string"},
            },
            "required": ["pianist_name", "why_fit", "similar_to", "confidence"],
            "type": "object",
        },
        "maxItems": limit,
        "minItems": min_recommendations,
        "type": "array",
    })
}

fn marshal_summary(summary: &TasteSummary) -> Result<String> {
    gojson::to_string_pretty(summary).context("marshal taste summary")
}

/// Asks for a full list (up to five) while letting small limits through.
fn minimum_discovery_recommendations(limit: usize) -> usize {
    match limit {
        0 => 1,
        1..5 => limit,
        _ => 5,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracker_recommend::{FavoritePianist, TasteTrack};

    /// The exact output of Go's json.MarshalIndent for [`golden_summary`].
    const GO_SUMMARY_JSON: &str = r#"{
  "total_tracks": 3,
  "total_ratings": 2,
  "comment_count": 1,
  "favorite_pianists": [
    {
      "name": "A \u003cb\u003e \u0026 c",
      "track_count": 2,
      "rated_track_count": 1,
      "total_play_count": 9,
      "average_stars": 5
    },
    {
      "name": "x",
      "track_count": 0,
      "rated_track_count": 0,
      "total_play_count": 0,
      "average_stars": 4.33
    }
  ],
  "loved_tracks": [
    {
      "track_id": 1,
      "track_name": "T\u2028\u2029\u0001\b\f\t\n\r\"\\/é😀",
      "album_name": "",
      "artists": [],
      "play_count": 0,
      "last_played_at": 0,
      "stars": 5,
      "opinion": "op"
    }
  ],
  "disliked_tracks": [],
  "commented_tracks": [],
  "known_pianists": [
    "K"
  ],
  "discovery_guidance": "g"
}"#;

    fn golden_summary() -> TasteSummary {
        TasteSummary {
            total_tracks: 3,
            total_ratings: 2,
            comment_count: 1,
            favorite_pianists: vec![
                FavoritePianist {
                    name: "A <b> & c".into(),
                    track_count: 2,
                    rated_track_count: 1,
                    total_play_count: 9,
                    average_stars: 5.0,
                },
                FavoritePianist { name: "x".into(), average_stars: 4.33, ..Default::default() },
            ],
            loved_tracks: vec![TasteTrack {
                track_id: 1,
                track_name: "T\u{2028}\u{2029}\u{1}\u{8}\u{c}\t\n\r\"\\/é😀".into(),
                stars: 5,
                opinion: "op".into(),
                ..Default::default()
            }],
            known_pianists: vec!["K".into()],
            discovery_guidance: "g".into(),
            ..Default::default()
        }
    }

    #[test]
    fn summary_json_matches_go_marshal_indent() {
        assert_eq!(marshal_summary(&golden_summary()).unwrap(), GO_SUMMARY_JSON);
    }

    #[test]
    fn discovery_request_embeds_summary_and_schema() {
        let req = build_discovery_request(&golden_summary(), 7).unwrap();
        assert_eq!(
            req.user_prompt,
            format!(
                "Use this taste profile JSON to recommend 7 new pianists.\nReturn a complete JSON object with a summary and a recommendations array. The recommendations array must contain at least 5 and at most 7 pianist objects.\n\n{GO_SUMMARY_JSON}"
            )
        );
        // Go: json.Marshal of the schema map for limit=7.
        assert_eq!(
            gojson::to_string(&req.schema.unwrap().schema).unwrap(),
            r#"{"additionalProperties":false,"properties":{"recommendations":{"items":{"additionalProperties":false,"properties":{"confidence":{"minLength":1,"type":"string"},"pianist_name":{"minLength":1,"type":"string"},"similar_to":{"items":{"type":"string"},"type":"array"},"why_fit":{"minLength":1,"type":"string"}},"required":["pianist_name","why_fit","similar_to","confidence"],"type":"object"},"maxItems":7,"minItems":5,"type":"array"},"summary":{"minLength":1,"type":"string"}},"required":["summary","recommendations"],"type":"object"}"#
        );
        assert_eq!(req.output_mode, StructuredOutputMode::Strict);
        assert_eq!(req.temperature, 0.0);
        assert_eq!(req.max_output_tokens, 0);
    }

    #[test]
    fn repair_and_fallback_requests() {
        let repair = build_discovery_repair_request("{}", 0, 2);
        assert_eq!(repair.schema.as_ref().map(|s| s.name.as_str()), Some("pianist_discovery"));
        assert!(repair.user_prompt.contains("at least 5 and at most 5 items"));

        let only = build_discovery_recommendations_only_request(&golden_summary(), 3).unwrap();
        let schema = &only.schema.as_ref().unwrap().schema;
        assert_eq!(schema["properties"]["recommendations"]["minItems"], 3);
        assert_eq!(schema["required"], json!(["recommendations"]));
        assert!(only.user_prompt.ends_with(GO_SUMMARY_JSON));

        let plain = build_discovery_plaintext_recommendations_request(&golden_summary(), 2).unwrap();
        assert!(plain.schema.is_none());
        assert!(
            plain
                .user_prompt
                .starts_with("Using this taste profile JSON, return between 2 and 2 recommendation lines.")
        );
    }

    #[test]
    fn taste_summary_request_drops_discovery_guidance() {
        let req = build_taste_summary_request(&golden_summary()).unwrap();
        assert!(req.user_prompt.ends_with("  \"discovery_guidance\": \"\"\n}"), "{}", req.user_prompt);
        assert_eq!(req.schema.unwrap().name, "taste_summary");
    }

    #[test]
    fn minimum_recommendations() {
        assert_eq!(minimum_discovery_recommendations(0), 1);
        assert_eq!(minimum_discovery_recommendations(3), 3);
        assert_eq!(minimum_discovery_recommendations(5), 5);
        assert_eq!(minimum_discovery_recommendations(9), 5);
    }
}
