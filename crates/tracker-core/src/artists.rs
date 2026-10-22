//! The `tracks.artists` column holds a JSON array of names. These helpers are
//! the single place that decodes it for display and attribution.

use anyhow::{Context, Result};

/// Decodes the stored JSON array of artist names.
pub fn decode(raw: &str) -> Result<Vec<String>> {
    serde_json::from_str(raw).with_context(|| format!("decode artists {raw:?}"))
}

/// Encodes artist names the way sync stores them (compact JSON).
pub fn encode(artists: &[String]) -> String {
    serde_json::to_string(artists).expect("a list of strings always encodes")
}

/// Joins artist names with ", " for display, falling back to the raw column
/// text when it is not a non-empty JSON array.
pub fn format(raw: &str) -> String {
    // Fast path for the compact form sync writes: with no escapes,
    // `["A","B"]` decodes to exactly the text between the quotes.
    if !raw.contains('\\')
        && let Some(inner) = raw.strip_prefix("[\"").and_then(|rest| rest.strip_suffix("\"]"))
        && !inner.is_empty()
    {
        let joined = inner.replace("\",\"", ", ");
        if !joined.contains('"') {
            return joined;
        }
    }

    match serde_json::from_str::<Vec<String>>(raw) {
        Ok(artists) if !artists.is_empty() => artists.join(", "),
        _ => raw.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_matches_json_decoding() {
        let cases = [
            r#"["Frédéric Chopin","Martha Argerich"]"#,
            r#"["Solo"]"#,
            r#"["Quote \"Inside\"","Back\\slash"]"#,
            r#"[ "Spaced" , "Out" ]"#,
            r#"["A","B"] trailing"#,
            r#"[]"#,
            "not json",
            "",
            r#"["",""]"#,
            r#"["a\u00e9"]"#,
        ];
        for raw in cases {
            let want = match serde_json::from_str::<Vec<String>>(raw) {
                Ok(artists) if !artists.is_empty() => artists.join(", "),
                _ => raw.to_string(),
            };
            assert_eq!(format(raw), want, "raw={raw:?}");
        }
    }

    #[test]
    fn encode_round_trips() {
        let names = vec!["Víkingur Ólafsson".to_string(), "Quote \"x\"".to_string()];
        assert_eq!(decode(&encode(&names)).unwrap(), names);
        assert_eq!(encode(&["A".into(), "B".into()]), r#"["A","B"]"#);
    }
}
