//! Lenient parsing of LLM discovery and taste-summary output.
//!
//! Providers routinely wrap JSON in markdown fences, rename keys, nest the
//! payload, or drop fields. These parsers accept all of that so the client's
//! repair and fallback flow only kicks in when content is truly missing.
//!
//! Strict decoding mirrors Go's `json.Unmarshal` into the result struct:
//! unknown keys are ignored, keys match case-insensitively, `null` leaves a
//! field at its zero value, and any type mismatch is an error.

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Map, Value};

use crate::{DiscoveryResult, SuggestedPianist};

const PREVIEW_MAX_LEN: usize = 240;
const NAME_KEYS: [&str; 4] = ["pianist_name", "name", "pianist", "artist"];
const REASON_KEYS: [&str; 3] = ["why_fit", "reason", "why"];

/// Accepts strict JSON output plus fenced JSON snippets so the app tolerates
/// minor response-wrapper differences from the model.
pub fn parse_discovery_result(raw: &str) -> Result<DiscoveryResult> {
    let (result, cleaned) = parse_partial_with_cleaned(raw);
    let mut result = result?;

    if result.summary.trim().is_empty() {
        bail!("LLM discovery response omitted summary: {}", preview_json(&cleaned));
    }
    if result.recommendations.is_empty() {
        bail!("LLM discovery response omitted recommendations: {}", preview_json(&cleaned));
    }
    normalize_recommendations(&mut result.recommendations)?;
    Ok(result)
}

/// Extracts a summary-only LLM response and tolerates fenced JSON or plain
/// text when a provider ignores the schema wrapper.
pub fn parse_taste_summary(raw: &str) -> Result<String> {
    let (result, _) = parse_partial_with_cleaned(raw);
    let decode_err = match result {
        Ok(result) if !result.summary.trim().is_empty() => return Ok(result.summary.trim().to_string()),
        Ok(_) => None,
        Err(err) => Some(err),
    };

    let cleaned = clean_llm_text(raw);
    if cleaned.is_empty() {
        bail!("LLM taste summary response omitted summary");
    }
    match decode_err {
        None => bail!("LLM taste summary response omitted summary: {}", preview_json(&cleaned)),
        Some(err) if cleaned.starts_with('{') || cleaned.starts_with('[') => {
            Err(err.context("decode LLM taste summary response"))
        }
        Some(_) => Ok(cleaned),
    }
}

/// Normalizes a provider response without requiring every field to be
/// present. The LLM client's repair logic uses it to salvage a summary.
pub fn parse_discovery_partial(raw: &str) -> Result<DiscoveryResult> {
    parse_partial_with_cleaned(raw).0
}

/// Normalizes a provider response when the client only asked for a
/// recommendation list.
pub fn parse_discovery_recommendations(raw: &str) -> Result<Vec<SuggestedPianist>> {
    let (result, cleaned) = parse_partial_with_cleaned(raw);
    let mut result = result?;
    if result.recommendations.is_empty() {
        bail!("LLM discovery response omitted recommendations: {}", preview_json(&cleaned));
    }
    normalize_recommendations(&mut result.recommendations)?;
    Ok(result.recommendations)
}

/// Parses the final fallback line format:
/// `Pianist Name || Why fit || Similar 1, Similar 2 || confidence`
pub fn parse_plaintext_recommendations(raw: &str) -> Result<Vec<SuggestedPianist>> {
    let lines: Vec<&str> = raw.trim().split('\n').collect();
    let mut recommendations = Vec::with_capacity(lines.len());

    for line in lines {
        let mut line = line.trim().trim_start_matches(['-', '*', ' ']).trim();
        if line.is_empty() {
            continue;
        }
        if let Some((prefix, rest)) = line.split_once(". ")
            && is_digits(prefix)
        {
            line = rest;
        }

        let parts: Vec<&str> = line.split("||").collect();
        if parts.len() < 4 {
            continue;
        }
        let pianist_name = parts[0].trim();
        let why_fit = parts[1].trim();
        let confidence = parts[3].trim();
        if pianist_name.is_empty() || why_fit.is_empty() {
            continue;
        }
        let similar_to =
            parts[2].split(',').map(str::trim).filter(|item| !item.is_empty()).map(str::to_string).collect();

        recommendations.push(SuggestedPianist {
            pianist_name: pianist_name.to_string(),
            why_fit: why_fit.to_string(),
            similar_to,
            confidence: confidence.to_string(),
        });
    }

    if recommendations.is_empty() {
        bail!("LLM plaintext recommendation fallback produced no parseable lines");
    }
    Ok(recommendations)
}

/// Requires a name and reason on every recommendation and trims the text
/// fields the UI prints.
fn normalize_recommendations(recommendations: &mut [SuggestedPianist]) -> Result<()> {
    for (idx, rec) in recommendations.iter_mut().enumerate() {
        if rec.pianist_name.trim().is_empty() {
            bail!("recommendation {} omitted pianist_name", idx + 1);
        }
        if rec.why_fit.trim().is_empty() {
            bail!("recommendation {} omitted why_fit", idx + 1);
        }
        rec.pianist_name = rec.pianist_name.trim().to_string();
        rec.why_fit = rec.why_fit.trim().to_string();
        rec.confidence = rec.confidence.trim().to_string();
    }
    Ok(())
}

/// Returns the decoded result alongside the cleaned text used for error
/// previews.
fn parse_partial_with_cleaned(raw: &str) -> (Result<DiscoveryResult>, String) {
    let cleaned = clean_llm_text(raw);
    let result = decode_strict(&cleaned).context("decode LLM discovery response").map(|(mut result, value)| {
        if let Value::Object(payload) = &value
            && let Some(normalized) = parse_discovery_aliases_map(payload)
            && alias_result_is_better(&normalized, &result)
        {
            result = normalized;
        }
        result
    });
    (result, cleaned)
}

fn decode_strict(cleaned: &str) -> Result<(DiscoveryResult, Value)> {
    let value: Value = serde_json::from_str(cleaned)?;
    let result = decode_discovery_value(&value)?;
    Ok((result, value))
}

fn clean_llm_text(raw: &str) -> String {
    let cleaned = raw.trim();
    let cleaned = cleaned.strip_prefix("```json").unwrap_or(cleaned);
    let cleaned = cleaned.strip_prefix("```").unwrap_or(cleaned);
    let cleaned = cleaned.strip_suffix("```").unwrap_or(cleaned);
    cleaned.trim().to_string()
}

/// Collapses whitespace and caps the length so error messages stay readable.
fn preview_json(cleaned: &str) -> String {
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.len() <= PREVIEW_MAX_LEN {
        return collapsed;
    }
    // Go slices bytes; a split rune renders as U+FFFD either way.
    format!("{}...", String::from_utf8_lossy(&collapsed.as_bytes()[..PREVIEW_MAX_LEN]))
}

fn is_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
}

// ---------------------------------------------------------------------------
// Strict decoding with Go json.Unmarshal semantics.

/// The JSON type name Go uses in `UnmarshalTypeError` messages.
pub(crate) fn json_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn type_error(value: &Value, field: &str, go_type: &str) -> anyhow::Error {
    anyhow!("json: cannot unmarshal {} into Go struct field {field} of type {go_type}", json_kind(value))
}

/// Finds a struct field's key the way Go does: exact match first, then a
/// case-insensitive match.
fn lookup_field<'a>(map: &'a Map<String, Value>, name: &str) -> Option<&'a Value> {
    map.get(name).or_else(|| map.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value))
}

fn decode_string_field(map: &Map<String, Value>, name: &str, path: &str) -> Result<String> {
    match lookup_field(map, name) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(text)) => Ok(text.clone()),
        Some(other) => Err(type_error(other, &format!("{path}.{name}"), "string")),
    }
}

fn decode_discovery_value(value: &Value) -> Result<DiscoveryResult> {
    let map = match value {
        Value::Null => return Ok(DiscoveryResult::default()),
        Value::Object(map) => map,
        other => bail!("json: cannot unmarshal {} into Go value of type recommend.DiscoveryResult", json_kind(other)),
    };

    let summary = decode_string_field(map, "summary", "DiscoveryResult")?;
    let recommendations = match lookup_field(map, "recommendations") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.iter().map(decode_suggestion_value).collect::<Result<Vec<_>>>()?,
        Some(other) => {
            return Err(type_error(other, "DiscoveryResult.recommendations", "[]recommend.SuggestedPianist"));
        }
    };
    Ok(DiscoveryResult { summary, recommendations })
}

fn decode_suggestion_value(value: &Value) -> Result<SuggestedPianist> {
    const PATH: &str = "DiscoveryResult.recommendations";
    let map = match value {
        Value::Null => return Ok(SuggestedPianist::default()),
        Value::Object(map) => map,
        other => return Err(type_error(other, PATH, "recommend.SuggestedPianist")),
    };
    let similar_to = match lookup_field(map, "similar_to") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::String(text) => Ok(text.clone()),
                Value::Null => Ok(String::new()),
                other => Err(type_error(other, &format!("{PATH}.similar_to"), "string")),
            })
            .collect::<Result<Vec<_>>>()?,
        Some(other) => return Err(type_error(other, &format!("{PATH}.similar_to"), "[]string")),
    };
    Ok(SuggestedPianist {
        pianist_name: decode_string_field(map, "pianist_name", PATH)?,
        why_fit: decode_string_field(map, "why_fit", PATH)?,
        similar_to,
        confidence: decode_string_field(map, "confidence", PATH)?,
    })
}

// ---------------------------------------------------------------------------
// Alias-tolerant decoding for providers that ignore the schema's key names.

fn parse_discovery_aliases_map(payload: &Map<String, Value>) -> Option<DiscoveryResult> {
    for wrapper in ["result", "data"] {
        if let Some(Value::Object(nested)) = payload.get(wrapper)
            && let Some(result) = parse_discovery_aliases_map(nested)
        {
            return Some(result);
        }
    }

    let summary =
        first_non_empty(&[as_str(payload.get("summary")), as_str(payload.get("overview"))]).trim().to_string();

    let source = first_array(payload, &["recommendations", "pianists", "suggestions", "candidates"])
        .or_else(|| find_recommendation_array(payload));
    let Some(source) = source else {
        return (!summary.is_empty()).then(|| DiscoveryResult { summary, recommendations: Vec::new() });
    };

    let recommendations = source
        .iter()
        .filter_map(Value::as_object)
        .map(|rec| SuggestedPianist {
            pianist_name: first_alias(rec, &NAME_KEYS).trim().to_string(),
            why_fit: first_alias(rec, &REASON_KEYS).trim().to_string(),
            similar_to: first_string_array(rec, &["similar_to", "similar"]),
            confidence: as_str(rec.get("confidence")).trim().to_string(),
        })
        .collect();
    Some(DiscoveryResult { summary, recommendations })
}

fn alias_result_is_better(candidate: &DiscoveryResult, current: &DiscoveryResult) -> bool {
    if candidate.recommendations.is_empty() {
        return false;
    }
    if current.recommendations.is_empty() {
        return true;
    }
    recommendation_completeness_score(&candidate.recommendations)
        > recommendation_completeness_score(&current.recommendations)
}

/// Weighs the required fields (name, reason) above the optional ones so a
/// decode that found the real content wins over one that found only keys.
fn recommendation_completeness_score(items: &[SuggestedPianist]) -> usize {
    items
        .iter()
        .map(|item| {
            let mut score = 0;
            if !item.pianist_name.trim().is_empty() {
                score += 2;
            }
            if !item.why_fit.trim().is_empty() {
                score += 2;
            }
            if !item.similar_to.is_empty() {
                score += 1;
            }
            if !item.confidence.trim().is_empty() {
                score += 1;
            }
            score
        })
        .sum()
}

fn first_array<'a>(payload: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Vec<Value>> {
    keys.iter().find_map(|key| match payload.get(*key) {
        Some(Value::Array(items)) if !items.is_empty() => Some(items),
        _ => None,
    })
}

fn first_string_array(payload: &Map<String, Value>, keys: &[&str]) -> Vec<String> {
    for key in keys {
        let Some(Value::Array(values)) = payload.get(*key) else { continue };
        let result: Vec<String> = values
            .iter()
            .map(|value| as_str(Some(value)).trim())
            .filter(|text| !text.is_empty())
            .map(str::to_string)
            .collect();
        if !result.is_empty() {
            return result;
        }
    }
    Vec::new()
}

fn as_str(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

fn first_alias<'a>(payload: &'a Map<String, Value>, keys: &[&str]) -> &'a str {
    let values: Vec<&str> = keys.iter().map(|key| as_str(payload.get(*key))).collect();
    first_non_empty(&values)
}

/// Searches every value for something shaped like a recommendation list.
/// Go walks its map in random order; here keys are visited in sorted order,
/// which makes the choice deterministic when several arrays qualify.
fn find_recommendation_array(payload: &Map<String, Value>) -> Option<&Vec<Value>> {
    payload.values().find_map(recommendation_array_from_value)
}

fn recommendation_array_from_value(value: &Value) -> Option<&Vec<Value>> {
    let looks_like =
        |items: &Vec<Value>| items.first().and_then(Value::as_object).is_some_and(looks_like_recommendation_object);
    match value {
        Value::Array(items) if looks_like(items) => Some(items),
        Value::Object(map) => {
            ["items", "entries", "results", "recommendations", "pianists", "suggestions", "candidates"].iter().find_map(
                |key| match map.get(*key) {
                    Some(Value::Array(items)) if looks_like(items) => Some(items),
                    _ => None,
                },
            )
        }
        _ => None,
    }
}

fn looks_like_recommendation_object(payload: &Map<String, Value>) -> bool {
    !first_alias(payload, &NAME_KEYS).trim().is_empty() && !first_alias(payload, &REASON_KEYS).trim().is_empty()
}

fn first_non_empty<'a>(values: &[&'a str]) -> &'a str {
    values.iter().copied().find(|value| !value.trim().is_empty()).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_discovery_result_handles_fenced_json() {
        let raw = "```json\n{\"summary\":\"lyrical\",\"recommendations\":[{\"pianist_name\":\"Radu Lupu\",\"why_fit\":\"poetic touch\",\"similar_to\":[\"Martha Argerich\"],\"confidence\":\"medium\"}]}\n```";
        let result = parse_discovery_result(raw).unwrap();
        assert_eq!(result.summary, "lyrical");
        assert_eq!(result.recommendations.len(), 1);
    }

    #[test]
    fn parse_discovery_result_accepts_pianists_alias() {
        let raw = r#"{"summary":"lyrical","pianists":[{"name":"Radu Lupu","reason":"poetic touch","similar":["Martha Argerich"],"confidence":"medium"}]}"#;
        let result = parse_discovery_result(raw).unwrap();
        assert_eq!(result.recommendations.len(), 1);
        assert_eq!(result.recommendations[0].pianist_name, "Radu Lupu");
        assert_eq!(result.recommendations[0].why_fit, "poetic touch");
        assert_eq!(result.recommendations[0].similar_to, vec!["Martha Argerich"]);
    }

    #[test]
    fn parse_discovery_result_accepts_nested_result_alias() {
        let raw = r#"{"result":{"overview":"lyrical","suggestions":[{"pianist":"Radu Lupu","why":"poetic touch","similar_to":["Martha Argerich"],"confidence":"medium"}]}}"#;
        let result = parse_discovery_result(raw).unwrap();
        assert_eq!(result.summary, "lyrical");
        assert_eq!(result.recommendations.len(), 1);
        assert_eq!(result.recommendations[0].pianist_name, "Radu Lupu");
    }

    #[test]
    fn parse_discovery_result_finds_recommendation_shaped_arrays_anywhere() {
        let raw = r#"{"summary":"s","picks":{"items":[{"artist":"Radu Lupu","reason":"r"}]}}"#;
        let result = parse_discovery_result(raw).unwrap();
        assert_eq!(result.recommendations[0].pianist_name, "Radu Lupu");

        let raw = r#"{"summary":"s","list":[{"name":"Radu Lupu","why_fit":"r"}],"other":[{"unrelated":1}]}"#;
        assert_eq!(parse_discovery_result(raw).unwrap().recommendations.len(), 1);
    }

    #[test]
    fn alias_result_only_replaces_strict_result_when_more_complete() {
        // Strict keys win when the alias decode finds nothing better.
        let raw = r#"{"summary":"s","recommendations":[{"pianist_name":" A ","why_fit":" w ","similar_to":["x"],"confidence":" high "}]}"#;
        let result = parse_discovery_result(raw).unwrap();
        assert_eq!(result.recommendations[0].pianist_name, "A");
        assert_eq!(result.recommendations[0].confidence, "high");

        // Mixed keys: strict decode sees an empty name, aliases see the name.
        let raw = r#"{"summary":"s","recommendations":[{"name":"A","why_fit":"w"}]}"#;
        assert_eq!(parse_discovery_result(raw).unwrap().recommendations[0].pianist_name, "A");

        let items = [SuggestedPianist {
            pianist_name: "a".into(),
            why_fit: "b".into(),
            similar_to: vec!["c".into()],
            confidence: "d".into(),
        }];
        assert_eq!(recommendation_completeness_score(&items), 6);
    }

    #[test]
    fn strict_decode_follows_go_unmarshal_rules() {
        // Case-insensitive keys and nulls.
        let raw = r#"{"Summary":"s","RECOMMENDATIONS":[null,{"Pianist_Name":"A","why_fit":"w","similar_to":null}]}"#;
        let result = parse_discovery_partial(raw).unwrap();
        assert_eq!(result.summary, "s");
        assert_eq!(result.recommendations.len(), 2);
        assert_eq!(result.recommendations[1].pianist_name, "A");

        assert_eq!(parse_discovery_partial("null").unwrap(), DiscoveryResult::default());

        let err = parse_discovery_partial(r#"{"summary":5}"#).unwrap_err();
        assert_eq!(
            format!("{err:#}"),
            "decode LLM discovery response: json: cannot unmarshal number into Go struct field DiscoveryResult.summary of type string"
        );
        let err = parse_discovery_partial("[1]").unwrap_err();
        assert!(format!("{err:#}").contains("cannot unmarshal array into Go value of type recommend.DiscoveryResult"));
        assert!(parse_discovery_partial("not json").is_err());
        assert!(parse_discovery_partial(r#"{"summary":"a"} trailing"#).is_err());
    }

    #[test]
    fn parse_discovery_result_reports_missing_fields() {
        let err = parse_discovery_result(r#"{"recommendations":[]}"#).unwrap_err();
        assert_eq!(err.to_string(), r#"LLM discovery response omitted summary: {"recommendations":[]}"#);

        let err = parse_discovery_result("{\"summary\":\"s\",\n\n  \"recommendations\":[]}").unwrap_err();
        assert_eq!(
            err.to_string(),
            r#"LLM discovery response omitted recommendations: {"summary":"s", "recommendations":[]}"#
        );

        let err = parse_discovery_result(r#"{"summary":"s","recommendations":[{"pianist_name":"A"}]}"#).unwrap_err();
        assert_eq!(err.to_string(), "recommendation 1 omitted why_fit");

        let err = parse_discovery_result(r#"{"summary":"s","recommendations":[{"why_fit":"w"}]}"#).unwrap_err();
        assert_eq!(err.to_string(), "recommendation 1 omitted pianist_name");
    }

    #[test]
    fn preview_json_truncates_long_payloads() {
        let long = format!("{{\"summary\":\"{}\"}}", "x".repeat(500));
        let preview = preview_json(&long);
        assert_eq!(preview.len(), PREVIEW_MAX_LEN + 3);
        assert!(preview.ends_with("..."));
        assert_eq!(preview_json(" a \n\t b "), "a b");
    }

    #[test]
    fn parse_taste_summary_handles_json_plaintext_and_fences() {
        for raw in [
            r#"{"summary":"You prefer high-voltage precision with clear voicing."}"#,
            "```json\n{\"summary\":\"You prefer high-voltage precision with clear voicing.\"}\n```",
            "You prefer high-voltage precision with clear voicing.",
        ] {
            assert_eq!(
                parse_taste_summary(raw).unwrap(),
                "You prefer high-voltage precision with clear voicing.",
                "raw={raw:?}"
            );
        }
    }

    #[test]
    fn parse_taste_summary_errors() {
        assert_eq!(
            parse_taste_summary("  ```  ").unwrap_err().to_string(),
            "LLM taste summary response omitted summary"
        );
        assert_eq!(
            parse_taste_summary(r#"{"overview":""}"#).unwrap_err().to_string(),
            r#"LLM taste summary response omitted summary: {"overview":""}"#
        );
        let err = parse_taste_summary(r#"{"summary": "#).unwrap_err();
        assert!(
            format!("{err:#}").starts_with("decode LLM taste summary response: decode LLM discovery response: "),
            "{err:#}"
        );
        // Plain text that happens to be a JSON scalar is still prose.
        assert_eq!(parse_taste_summary("42").unwrap(), "42");
    }

    #[test]
    fn parse_discovery_recommendations_accepts_recommendations_only_payload() {
        let raw = r#"{"recommendations":[{"pianist_name":"Radu Lupu","why_fit":"poetic touch","similar_to":["Martha Argerich"],"confidence":"medium"}]}"#;
        let recommendations = parse_discovery_recommendations(raw).unwrap();
        assert_eq!(recommendations.len(), 1);
        assert_eq!(recommendations[0].pianist_name, "Radu Lupu");

        let err = parse_discovery_recommendations(r#"{"summary":"only"}"#).unwrap_err();
        assert_eq!(err.to_string(), r#"LLM discovery response omitted recommendations: {"summary":"only"}"#);
    }

    #[test]
    fn parse_plaintext_recommendations_parses_rigid_fallback_format() {
        let raw = "Radu Lupu || poetic touch || Martha Argerich, Daniil Trifonov || medium\nMarc-André Hamelin || virtuosity with brains || Yuja Wang || high";
        let recommendations = parse_plaintext_recommendations(raw).unwrap();
        assert_eq!(recommendations.len(), 2);
        assert_eq!(recommendations[0].pianist_name, "Radu Lupu");
        assert_eq!(recommendations[0].similar_to, vec!["Martha Argerich", "Daniil Trifonov"]);
        assert_eq!(recommendations[1].pianist_name, "Marc-André Hamelin");
    }

    #[test]
    fn parse_plaintext_recommendations_strips_bullets_and_numbering() {
        let raw =
            "Here you go:\n- 1. A || why || , || \n* B || why2 || X ,Y|| low\n12. C ||  || X || high\n2.D || w || || ";
        let recs = parse_plaintext_recommendations(raw).unwrap();
        let names: Vec<_> = recs.iter().map(|rec| rec.pianist_name.as_str()).collect();
        assert_eq!(names, vec!["A", "B", "2.D"]);
        assert!(recs[0].similar_to.is_empty());
        assert_eq!(recs[1].similar_to, vec!["X", "Y"]);
        assert_eq!(recs[1].confidence, "low");

        let err = parse_plaintext_recommendations("nothing here").unwrap_err();
        assert_eq!(err.to_string(), "LLM plaintext recommendation fallback produced no parseable lines");
    }
}
