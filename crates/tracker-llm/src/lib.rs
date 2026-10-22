//! Provider-agnostic LLM access for taste summaries and pianist discovery.

mod discovery;
mod gojson;
pub mod providers;

use anyhow::{Context, Result};
use tracker_recommend::{
    DiscoveryResult, TasteSummary, parse_discovery_partial, parse_discovery_recommendations, parse_discovery_result,
    parse_plaintext_recommendations, parse_taste_summary, validate_discovery_input,
};

use discovery::{
    build_discovery_plaintext_recommendations_request, build_discovery_recommendations_only_request,
    build_discovery_repair_request, build_discovery_request, build_taste_summary_request,
};

const MAX_DISCOVERY_REPAIR_ATTEMPTS: usize = 3;
const DEFAULT_DISCOVERY_LIMIT: usize = 5;

/// How strongly the provider is expected to honor the supplied JSON contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StructuredOutputMode {
    Strict,
    Json,
    PromptOnly,
}

/// Structured output contract requested from a model.
#[derive(Debug, Clone, PartialEq)]
pub struct JsonSchema {
    pub name: String,
    pub schema: serde_json::Value,
    pub strict: bool,
}

/// The provider-agnostic generation request used by the discovery layer.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub system_prompt: String,
    pub user_prompt: String,
    pub output_mode: StructuredOutputMode,
    pub schema: Option<JsonSchema>,
    pub temperature: f64,
    pub max_output_tokens: usize,
}

/// Minimal generation surface needed by discovery.
pub trait Provider: Send + Sync {
    fn generate(&self, req: &Request) -> Result<String>;
}

/// Wraps one provider and exposes the app's recommendation tasks.
pub struct Client {
    provider: Box<dyn Provider>,
}

impl Client {
    pub fn new(provider: Box<dyn Provider>) -> Client {
        Client { provider }
    }

    /// Builds the shared discovery request, calls the provider, and parses the
    /// result back into recommendation types.
    ///
    /// Models often return a summary but drop or mangle the recommendations,
    /// so an incomplete answer goes through up to three repair passes, then a
    /// recommendations-only request, then a plaintext line-format request.
    pub fn suggest_new_pianists(&self, summary: &TasteSummary, limit: usize) -> Result<DiscoveryResult> {
        validate_discovery_input(summary)?;
        let limit = if limit < 1 { DEFAULT_DISCOVERY_LIMIT } else { limit };

        let req = build_discovery_request(summary, limit)?;
        let mut raw = self.provider.generate(&req)?;

        let mut last_summary = String::new();
        let mut outcome = parse_discovery_result(&raw);
        remember_summary(&raw, &mut last_summary);

        let mut attempt = 0;
        while attempt < MAX_DISCOVERY_REPAIR_ATTEMPTS && outcome.as_ref().is_err_and(should_repair_discovery_response) {
            let Ok(repaired) = self.provider.generate(&build_discovery_repair_request(&raw, limit, attempt + 1)) else {
                break;
            };
            raw = repaired;
            outcome = parse_discovery_result(&raw);
            remember_summary(&raw, &mut last_summary);
            attempt += 1;
        }

        if outcome.as_ref().is_err_and(should_fallback_recommendation_recovery) {
            let summary_text = match parse_discovery_partial(&raw) {
                Ok(partial) if !partial.summary.trim().is_empty() => partial.summary,
                _ => last_summary,
            };
            if !summary_text.trim().is_empty()
                && let Some(recommendations) = self.recover_recommendations(summary, limit)
            {
                outcome = Ok(DiscoveryResult { summary: summary_text, recommendations });
            }
        }

        let mut result = outcome.context("parse LLM discovery response")?;
        result.recommendations.truncate(limit);
        Ok(result)
    }

    /// Asks for a summary-only description of the current taste profile.
    pub fn summarize_taste(&self, summary: &TasteSummary) -> Result<String> {
        let req = build_taste_summary_request(summary)?;
        let raw = self.provider.generate(&req)?;
        parse_taste_summary(&raw).context("parse LLM taste summary response")
    }

    /// Fallbacks for a provider whose full-object answers keep collapsing into
    /// summary-only JSON: first a recommendations-only structured request,
    /// then a rigid plaintext line format. Failures are swallowed so the
    /// caller reports the original parse error.
    fn recover_recommendations(
        &self,
        summary: &TasteSummary,
        limit: usize,
    ) -> Option<Vec<tracker_recommend::SuggestedPianist>> {
        let structured = build_discovery_recommendations_only_request(summary, limit)
            .ok()
            .and_then(|req| self.provider.generate(&req).ok())
            .and_then(|raw| parse_discovery_recommendations(&raw).ok());
        structured.or_else(|| {
            build_discovery_plaintext_recommendations_request(summary, limit)
                .ok()
                .and_then(|req| self.provider.generate(&req).ok())
                .and_then(|raw| parse_plaintext_recommendations(&raw).ok())
        })
    }
}

/// Keeps the most recent non-blank summary so a later fallback can pair it
/// with recommendations fetched separately.
fn remember_summary(raw: &str, last_summary: &mut String) {
    if let Ok(partial) = parse_discovery_partial(raw)
        && !partial.summary.trim().is_empty()
    {
        *last_summary = partial.summary;
    }
}

fn should_repair_discovery_response(err: &anyhow::Error) -> bool {
    let message = format!("{err:#}");
    ["omitted summary", "omitted recommendations", "omitted pianist_name", "omitted why_fit"]
        .iter()
        .any(|needle| message.contains(needle))
}

fn should_fallback_recommendation_recovery(err: &anyhow::Error) -> bool {
    let message = format!("{err:#}");
    ["omitted recommendations", "omitted pianist_name", "omitted why_fit"].iter().any(|needle| message.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tracker_recommend::FavoritePianist;

    #[derive(Default)]
    struct StubState {
        raws: Vec<String>,
        reqs: Vec<Request>,
    }

    /// Returns canned responses in order, then errors once exhausted.
    #[derive(Clone, Default)]
    struct StubProvider {
        state: Arc<Mutex<StubState>>,
    }

    impl StubProvider {
        fn new(raws: &[&str]) -> StubProvider {
            let state = StubState { raws: raws.iter().map(|raw| raw.to_string()).collect(), reqs: Vec::new() };
            StubProvider { state: Arc::new(Mutex::new(state)) }
        }

        fn reqs(&self) -> Vec<Request> {
            self.state.lock().unwrap().reqs.clone()
        }
    }

    impl Provider for StubProvider {
        fn generate(&self, req: &Request) -> Result<String> {
            let mut state = self.state.lock().unwrap();
            state.reqs.push(req.clone());
            if state.raws.is_empty() {
                anyhow::bail!("stub exhausted");
            }
            Ok(state.raws.remove(0))
        }
    }

    fn client(provider: &StubProvider) -> Client {
        Client::new(Box::new(provider.clone()))
    }

    fn summary() -> TasteSummary {
        TasteSummary {
            total_ratings: 3,
            favorite_pianists: vec![FavoritePianist { name: "Martha Argerich".into(), ..Default::default() }],
            known_pianists: vec!["Martha Argerich".into()],
            ..Default::default()
        }
    }

    fn schema_name(req: &Request) -> Option<&str> {
        req.schema.as_ref().map(|schema| schema.name.as_str())
    }

    const COMPLETE: &str = r#"{"summary":"You like vivid, high-energy pianists.","recommendations":[{"pianist_name":"Radu Lupu","why_fit":"lyrical contrast","similar_to":["Martha Argerich"],"confidence":"medium"}]}"#;

    #[test]
    fn suggest_new_pianists_builds_discovery_request_and_parses_result() {
        let provider = StubProvider::new(&[COMPLETE]);
        let result = client(&provider).suggest_new_pianists(&summary(), 1).unwrap();
        assert!(!result.summary.is_empty());
        assert_eq!(result.recommendations.len(), 1);

        let reqs = provider.reqs();
        assert_eq!(reqs.len(), 1);
        assert_eq!(schema_name(&reqs[0]), Some("pianist_discovery"));
        let schema = &reqs[0].schema.as_ref().unwrap().schema;
        assert_eq!(schema["properties"]["recommendations"]["minItems"], 1);
    }

    #[test]
    fn suggest_new_pianists_repairs_incomplete_structured_output() {
        let provider = StubProvider::new(&[r#"{"summary":"You like vivid, high-energy pianists."}"#, COMPLETE]);
        let result = client(&provider).suggest_new_pianists(&summary(), 1).unwrap();
        assert_eq!(result.recommendations.len(), 1);

        let reqs = provider.reqs();
        assert_eq!(reqs.len(), 2, "one repair request");
        assert_eq!(schema_name(&reqs[1]), Some("pianist_discovery"));
        assert!(reqs[1].user_prompt.starts_with("Repair attempt 1.\n"), "{}", reqs[1].user_prompt);
        assert!(
            reqs[1]
                .user_prompt
                .ends_with("Previous response:\n{\"summary\":\"You like vivid, high-energy pianists.\"}")
        );
    }

    #[test]
    fn suggest_new_pianists_retries_multiple_repair_passes() {
        let provider = StubProvider::new(&[
            r#"{"summary":"first partial"}"#,
            r#"{"summary":"second partial"}"#,
            r#"{"summary":"third partial"}"#,
            r#"{"summary":"final summary","recommendations":[{"pianist_name":"Radu Lupu","why_fit":"lyrical contrast","similar_to":["Martha Argerich"],"confidence":"medium"}]}"#,
        ]);
        let result = client(&provider).suggest_new_pianists(&summary(), 1).unwrap();
        assert_eq!(result.summary, "final summary");
        assert_eq!(result.recommendations.len(), 1);
        assert_eq!(provider.reqs().len(), 4);
    }

    #[test]
    fn suggest_new_pianists_falls_back_to_recommendations_only_repair() {
        let provider = StubProvider::new(&[
            r#"{"summary":"partial summary"}"#,
            r#"{"summary":"repair one"}"#,
            r#"{"summary":"repair two"}"#,
            r#"{"summary":"repair three"}"#,
            r#"{"recommendations":[{"pianist_name":"Radu Lupu","why_fit":"lyrical contrast","similar_to":["Martha Argerich"],"confidence":"medium"}]}"#,
        ]);
        let result = client(&provider).suggest_new_pianists(&summary(), 1).unwrap();
        assert_eq!(result.summary, "repair three");
        assert_eq!(result.recommendations.len(), 1);

        let reqs = provider.reqs();
        assert_eq!(reqs.len(), 5);
        assert_eq!(schema_name(&reqs[4]), Some("pianist_recommendations_only"));
    }

    #[test]
    fn suggest_new_pianists_falls_back_to_plaintext_recommendations() {
        let provider = StubProvider::new(&[
            r#"{"summary":"partial summary"}"#,
            r#"{"summary":"repair one"}"#,
            r#"{"summary":"repair two"}"#,
            r#"{"summary":"repair three"}"#,
            r#"{"summary":"still no recommendations"}"#,
            "Radu Lupu || lyrical contrast || Martha Argerich || medium",
        ]);
        let result = client(&provider).suggest_new_pianists(&summary(), 1).unwrap();
        assert_eq!(result.summary, "repair three");
        assert_eq!(result.recommendations.len(), 1);
        assert_eq!(result.recommendations[0].pianist_name, "Radu Lupu");

        let reqs = provider.reqs();
        assert_eq!(reqs.len(), 6);
        assert!(reqs[5].schema.is_none(), "plaintext fallback has no schema");
        assert_eq!(reqs[5].output_mode, StructuredOutputMode::PromptOnly);
    }

    #[test]
    fn suggest_new_pianists_recovers_from_missing_pianist_name() {
        let provider = StubProvider::new(&[
            r#"{"summary":"partial summary","recommendations":[{"why_fit":"missing name","similar_to":["Martha Argerich"],"confidence":"medium"}]}"#,
            r#"{"summary":"repair one","recommendations":[{"why_fit":"still missing name","similar_to":["Martha Argerich"],"confidence":"medium"}]}"#,
            r#"{"summary":"repair two","recommendations":[{"why_fit":"still missing name","similar_to":["Martha Argerich"],"confidence":"medium"}]}"#,
            r#"{"summary":"repair three","recommendations":[{"why_fit":"still missing name","similar_to":["Martha Argerich"],"confidence":"medium"}]}"#,
            r#"{"recommendations":[{"name":"Radu Lupu","reason":"lyrical contrast","similar":["Martha Argerich"],"confidence":"medium"}]}"#,
        ]);
        let result = client(&provider).suggest_new_pianists(&summary(), 1).unwrap();
        assert_eq!(result.summary, "repair three");
        assert_eq!(result.recommendations.len(), 1);
        assert_eq!(result.recommendations[0].pianist_name, "Radu Lupu");

        let reqs = provider.reqs();
        assert_eq!(reqs.len(), 5);
        assert_eq!(schema_name(&reqs[4]), Some("pianist_recommendations_only"));
    }

    #[test]
    fn suggest_new_pianists_requires_at_least_five_recommendations_when_limit_is_higher() {
        let provider = StubProvider::new(&[
            r#"{"summary":"summary","recommendations":[{"pianist_name":"Radu Lupu","why_fit":"lyrical contrast","similar_to":["Martha Argerich"],"confidence":"medium"},{"pianist_name":"Leif Ove Andsnes","why_fit":"clarity","similar_to":["Víkingur Ólafsson"],"confidence":"medium"},{"pianist_name":"Marc-Andre Hamelin","why_fit":"virtuosity","similar_to":["Yuja Wang"],"confidence":"medium"},{"pianist_name":"Jean-Yves Thibaudet","why_fit":"color","similar_to":["Alice Sara Ott"],"confidence":"medium"},{"pianist_name":"Khatia Buniatishvili","why_fit":"fire","similar_to":["Yuja Wang"],"confidence":"medium"}]}"#,
        ]);
        client(&provider).suggest_new_pianists(&summary(), 5).unwrap();
        let reqs = provider.reqs();
        let schema = &reqs[0].schema.as_ref().unwrap().schema;
        assert_eq!(schema["properties"]["recommendations"]["minItems"], 5);
    }

    #[test]
    fn suggest_new_pianists_truncates_to_limit_and_defaults_zero_limit() {
        let recs: Vec<String> = (0..7)
            .map(|idx| format!(r#"{{"pianist_name":"P{idx}","why_fit":"w","similar_to":[],"confidence":"c"}}"#))
            .collect();
        let raw = format!(r#"{{"summary":"s","recommendations":[{}]}}"#, recs.join(","));
        let provider = StubProvider::new(&[&raw]);
        let result = client(&provider).suggest_new_pianists(&summary(), 0).unwrap();
        assert_eq!(result.recommendations.len(), 5);
        let reqs = provider.reqs();
        let schema = &reqs[0].schema.as_ref().unwrap().schema;
        assert_eq!(schema["properties"]["recommendations"]["maxItems"], 5);
    }

    #[test]
    fn suggest_new_pianists_reports_parse_error_after_failed_recovery() {
        // A summary-less answer is repaired three times, then reported; the
        // summary-only fallback path does not apply.
        let provider = StubProvider::new(&[r#"{"recommendations":[]}"#; 4]);
        let err = client(&provider).suggest_new_pianists(&summary(), 1).unwrap_err();
        assert_eq!(
            format!("{err:#}"),
            r#"parse LLM discovery response: LLM discovery response omitted summary: {"recommendations":[]}"#
        );
        assert_eq!(provider.reqs().len(), 4);

        // A provider error during repair stops the loop; recovery calls fail
        // too (stub exhausted), so the last parse error surfaces.
        let provider = StubProvider::new(&[r#"{"summary":"s"}"#]);
        let err = client(&provider).suggest_new_pianists(&summary(), 1).unwrap_err();
        assert!(format!("{err:#}").contains("omitted recommendations"), "{err:#}");
        assert_eq!(provider.reqs().len(), 4, "initial, one failed repair, two failed fallbacks");

        // Provider errors on the first call propagate unchanged.
        let provider = StubProvider::new(&[]);
        let err = client(&provider).suggest_new_pianists(&summary(), 1).unwrap_err();
        assert_eq!(format!("{err:#}"), "stub exhausted");
    }

    #[test]
    fn suggest_new_pianists_rejects_discovery_input_without_enough_ratings() {
        let provider = StubProvider::new(&[]);
        let summary = TasteSummary { total_ratings: 1, ..summary() };
        assert!(client(&provider).suggest_new_pianists(&summary, 5).is_err());
        assert!(provider.reqs().is_empty());
    }

    #[test]
    fn summarize_taste_builds_summary_request_and_parses_result() {
        let provider = StubProvider::new(&[
            r#"{"summary":"You gravitate toward vivid, rhythmically incisive pianism with strong contrapuntal clarity."}"#,
        ]);
        let text = client(&provider).summarize_taste(&summary()).unwrap();
        assert_eq!(text, "You gravitate toward vivid, rhythmically incisive pianism with strong contrapuntal clarity.");
        let reqs = provider.reqs();
        assert_eq!(reqs.len(), 1);
        assert_eq!(schema_name(&reqs[0]), Some("taste_summary"));

        let provider = StubProvider::new(&[r#"{"summary":""}"#]);
        let err = client(&provider).summarize_taste(&summary()).unwrap_err();
        assert_eq!(
            format!("{err:#}"),
            r#"parse LLM taste summary response: LLM taste summary response omitted summary: {"summary":""}"#
        );
    }
}
