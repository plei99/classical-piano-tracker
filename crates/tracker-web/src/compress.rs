//! Response compression. Static assets are compressed at build time (the
//! build script embeds gzip and brotli copies); JSON and HTML responses are
//! compressed here as they are sent. The presence stream never is.

use std::io::Write;

use axum::http::HeaderValue;

/// Responses smaller than this go out as they are: compressing them saves
/// too little to matter.
pub const MIN_SIZE: usize = 1024;

/// Fast settings: on-the-fly responses are small, and every key that
/// fetches rows waits for this.
const BROTLI_QUALITY: u32 = 5;
const BROTLI_WINDOW: u32 = 22;
const GZIP_LEVEL: u32 = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Brotli,
    Gzip,
}

impl Encoding {
    pub fn header(self) -> HeaderValue {
        HeaderValue::from_static(match self {
            Encoding::Brotli => "br",
            Encoding::Gzip => "gzip",
        })
    }
}

/// The best encoding an `Accept-Encoding` header allows: brotli, then gzip,
/// or `None` for the body as is.
pub fn negotiate(accept: &str) -> Option<Encoding> {
    let (mut brotli, mut gzip, mut any) = (None, None, None);
    for item in accept.split(',') {
        let mut parts = item.split(';');
        let coding = parts.next().unwrap_or_default().trim().to_ascii_lowercase();
        let quality = parts
            .filter_map(|param| param.trim().strip_prefix("q=").or_else(|| param.trim().strip_prefix("Q=")))
            .find_map(|q| q.trim().parse::<f32>().ok())
            .unwrap_or(1.0);
        let accepted = Some(quality > 0.0);
        match coding.as_str() {
            "br" => brotli = accepted,
            "gzip" | "x-gzip" => gzip = accepted,
            "*" => any = accepted,
            _ => {}
        }
    }
    if brotli.or(any).unwrap_or(false) {
        Some(Encoding::Brotli)
    } else if gzip.or(any).unwrap_or(false) {
        Some(Encoding::Gzip)
    } else {
        None
    }
}

/// Whether a response of this type is worth compressing.
pub fn compressible(content_type: &str) -> bool {
    let mime = content_type.split(';').next().unwrap_or_default().trim();
    (mime.starts_with("text/") && mime != "text/event-stream")
        || matches!(mime, "application/json" | "application/javascript" | "application/wasm" | "image/svg+xml")
}

pub fn compress(data: &[u8], encoding: Encoding) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() / 4 + 64);
    match encoding {
        Encoding::Brotli => {
            let mut writer = brotli::CompressorWriter::new(&mut out, 4096, BROTLI_QUALITY, BROTLI_WINDOW);
            // Writing to a Vec cannot fail.
            let _ = writer.write_all(data);
        }
        Encoding::Gzip => {
            let mut writer = flate2::write::GzEncoder::new(&mut out, flate2::Compression::new(GZIP_LEVEL));
            let _ = writer.write_all(data);
            let _ = writer.finish();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;

    #[test]
    fn prefers_brotli_then_gzip_and_honors_q_0() {
        assert_eq!(negotiate("gzip, deflate, br, zstd"), Some(Encoding::Brotli));
        assert_eq!(negotiate("gzip, deflate"), Some(Encoding::Gzip));
        assert_eq!(negotiate("br;q=0, gzip;q=0.5"), Some(Encoding::Gzip));
        assert_eq!(negotiate("GZIP"), Some(Encoding::Gzip));
        assert_eq!(negotiate("*"), Some(Encoding::Brotli));
        assert_eq!(negotiate("*;q=0, gzip"), Some(Encoding::Gzip));
        assert_eq!(negotiate("identity"), None);
        assert_eq!(negotiate(""), None);
        assert_eq!(negotiate("gzip;q=0"), None);
    }

    #[test]
    fn compresses_text_but_not_the_event_stream() {
        for content_type in
            ["application/json; charset=utf-8", "text/html; charset=utf-8", "text/javascript", "application/wasm"]
        {
            assert!(compressible(content_type), "{content_type}");
        }
        assert!(!compressible("text/event-stream"));
        assert!(!compressible("image/png"));
    }

    #[test]
    fn round_trips() {
        let data = "{\"rows\":[]}".repeat(500);
        let mut gzip = String::new();
        flate2::read::GzDecoder::new(&compress(data.as_bytes(), Encoding::Gzip)[..]).read_to_string(&mut gzip).unwrap();
        assert_eq!(gzip, data);
        let mut brotli = String::new();
        brotli::Decompressor::new(&compress(data.as_bytes(), Encoding::Brotli)[..], 4096)
            .read_to_string(&mut brotli)
            .unwrap();
        assert_eq!(brotli, data);
    }
}
