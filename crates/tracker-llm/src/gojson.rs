//! JSON encoding that reproduces Go's `encoding/json` output byte for byte.
//!
//! Prompts embed `json.MarshalIndent` output and the CLI providers pass
//! `json.Marshal`ed schemas, so matching Go keeps prompts identical across
//! builds. Two differences from serde_json matter:
//!
//! - Go escapes `<`, `>`, `&`, U+2028, and U+2029 inside strings (as
//!   `<` etc.) so JSON is safe to embed in HTML.
//! - Go prints floats in the shortest form without a trailing `.0`
//!   (`5`, not `5.0`) and uses exponents only outside [1e-6, 1e21).
//!
//! Object keys come out sorted because `serde_json::Map` is a `BTreeMap`
//! (the `preserve_order` feature is not enabled), matching Go's map encoding.

use std::io::{self, Write};

use serde::Serialize;
use serde_json::ser::{CharEscape, CompactFormatter, Formatter, PrettyFormatter};

/// Equivalent of Go's `json.Marshal`.
pub(crate) fn to_string<T: Serialize + ?Sized>(value: &T) -> serde_json::Result<String> {
    encode(value, CompactFormatter)
}

/// Equivalent of Go's `json.MarshalIndent(v, "", "  ")`.
pub(crate) fn to_string_pretty<T: Serialize + ?Sized>(value: &T) -> serde_json::Result<String> {
    encode(value, PrettyFormatter::with_indent(b"  "))
}

fn encode<T: Serialize + ?Sized, F: Formatter>(value: &T, inner: F) -> serde_json::Result<String> {
    let mut out = Vec::new();
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, GoFormatter { inner });
    value.serialize(&mut serializer)?;
    // The formatter only ever writes valid UTF-8.
    Ok(String::from_utf8_lossy(&out).into_owned())
}

struct GoFormatter<F> {
    inner: F,
}

impl<F: Formatter> Formatter for GoFormatter<F> {
    fn write_f64<W: ?Sized + Write>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        writer.write_all(go_float(value).as_bytes())
    }

    fn write_f32<W: ?Sized + Write>(&mut self, writer: &mut W, value: f32) -> io::Result<()> {
        self.write_f64(writer, f64::from(value))
    }

    fn write_string_fragment<W: ?Sized + Write>(&mut self, writer: &mut W, fragment: &str) -> io::Result<()> {
        let mut start = 0;
        for (idx, ch) in fragment.char_indices() {
            let escape = match ch {
                '<' => "\\u003c",
                '>' => "\\u003e",
                '&' => "\\u0026",
                '\u{2028}' => "\\u2028",
                '\u{2029}' => "\\u2029",
                _ => continue,
            };
            writer.write_all(&fragment.as_bytes()[start..idx])?;
            writer.write_all(escape.as_bytes())?;
            start = idx + ch.len_utf8();
        }
        writer.write_all(&fragment.as_bytes()[start..])
    }

    fn write_char_escape<W: ?Sized + Write>(&mut self, writer: &mut W, escape: CharEscape) -> io::Result<()> {
        self.inner.write_char_escape(writer, escape)
    }

    fn begin_array<W: ?Sized + Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.inner.begin_array(writer)
    }

    fn end_array<W: ?Sized + Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.inner.end_array(writer)
    }

    fn begin_array_value<W: ?Sized + Write>(&mut self, writer: &mut W, first: bool) -> io::Result<()> {
        self.inner.begin_array_value(writer, first)
    }

    fn end_array_value<W: ?Sized + Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.inner.end_array_value(writer)
    }

    fn begin_object<W: ?Sized + Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.inner.begin_object(writer)
    }

    fn end_object<W: ?Sized + Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.inner.end_object(writer)
    }

    fn begin_object_key<W: ?Sized + Write>(&mut self, writer: &mut W, first: bool) -> io::Result<()> {
        self.inner.begin_object_key(writer, first)
    }

    fn end_object_key<W: ?Sized + Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.inner.end_object_key(writer)
    }

    fn begin_object_value<W: ?Sized + Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.inner.begin_object_value(writer)
    }

    fn end_object_value<W: ?Sized + Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.inner.end_object_value(writer)
    }
}

/// Formats a float like Go's encoding/json: shortest round-trip digits, plain
/// notation within [1e-6, 1e21), otherwise `1e+21` / `1e-7` exponents.
fn go_float(value: f64) -> String {
    let abs = value.abs();
    if abs == 0.0 || (1e-6..1e21).contains(&abs) {
        return format!("{value}");
    }
    let formatted = format!("{value:e}");
    match formatted.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => format!("{mantissa}e+{exponent}"),
        _ => formatted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn floats_match_go() {
        let cases = [
            (5.0, "5"),
            (4.33, "4.33"),
            (0.0, "0"),
            (-0.0, "-0"),
            (1e-7, "1e-7"),
            (1.5e-10, "1.5e-10"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (0.000001, "0.000001"),
        ];
        for (value, want) in cases {
            assert_eq!(go_float(value), want, "{value}");
        }
    }

    #[test]
    fn compact_matches_go_marshal_of_decoded_map() {
        // Go: json.Marshal of a map decoded from
        // {"summary":"a<b & c>","n":1.0,"big":1e21,"small":0.0000001,"i":3,"recommendations":[]}
        let value: serde_json::Value = serde_json::from_str(
            r#"{"summary":"a<b & c>","n":1.0,"big":1e21,"small":0.0000001,"i":3,"recommendations":[]}"#,
        )
        .unwrap();
        assert_eq!(
            to_string(&value).unwrap(),
            r#"{"big":1e+21,"i":3,"n":1,"recommendations":[],"small":1e-7,"summary":"a\u003cb \u0026 c\u003e"}"#
        );
    }

    #[test]
    fn pretty_escapes_like_go() {
        let value = json!({"t": "T\u{2028}\u{2029}\u{1}\u{8}\u{c}\t\n\r\"\\/é😀", "empty": [], "obj": {}});
        assert_eq!(
            to_string_pretty(&value).unwrap(),
            "{\n  \"empty\": [],\n  \"obj\": {},\n  \"t\": \"T\\u2028\\u2029\\u0001\\b\\f\\t\\n\\r\\\"\\\\/é😀\"\n}"
        );
    }
}
