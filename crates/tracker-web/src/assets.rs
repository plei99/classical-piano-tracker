//! The browser client, built and embedded by `build.rs`: the page template
//! (the server renders the app into it), the stylesheet (the TypeScript
//! build's, verbatim), a two-line boot module, and wasm-bindgen's output,
//! each with gzip and brotli copies made at build time.

use axum::body::Bytes;

use crate::server::{Asset, Assets};

/// A file `build.rs` embedded; `gzip` and `brotli` are empty when
/// compressing it was not worth it.
pub(crate) struct Embedded {
    url: &'static str,
    content_type: &'static str,
    body: &'static [u8],
    gzip: &'static [u8],
    brotli: &'static [u8],
}

include!(concat!(env!("OUT_DIR"), "/assets.rs"));

/// The embedded client keyed by URL path.
pub fn embedded() -> Assets {
    let copy = |data: &'static [u8]| (!data.is_empty()).then(|| Bytes::from_static(data));
    FILES
        .iter()
        .map(|file| {
            let asset = Asset {
                content_type: file.content_type,
                body: Bytes::from_static(file.body),
                gzip: copy(file.gzip),
                brotli: copy(file.brotli),
            };
            (file.url.to_string(), asset)
        })
        .collect()
}

/// Serves the files of a directory instead (development, or another
/// build's client): `index.html` at `/`, everything else under `/assets/`.
pub fn from_dir(dir: &std::path::Path) -> std::io::Result<Assets> {
    let mut assets = Assets::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(current) = pending.pop() {
        for entry in std::fs::read_dir(&current)? {
            let path = entry?.path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            let relative = path.strip_prefix(dir).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            let url = if relative == "index.html" { "/".to_string() } else { format!("/assets/{relative}") };
            let content_type = match path.extension().and_then(|extension| extension.to_str()) {
                Some("html") => "text/html; charset=utf-8",
                Some("js") => "text/javascript; charset=utf-8",
                Some("css") => "text/css; charset=utf-8",
                Some("wasm") => "application/wasm",
                _ => "application/octet-stream",
            };
            assets.insert(url, Asset::new(content_type, Bytes::from(std::fs::read(&path)?)));
        }
    }
    Ok(assets)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embeds_the_page_styles_and_client() {
        let assets = embedded();
        let page = String::from_utf8_lossy(&assets["/"].body).into_owned();
        assert!(page.contains(r#"<meta name="tracker-token" content="%TRACKER_TOKEN%" />"#), "{page}");
        assert!(page.contains(r#"<html lang="en" data-theme="%TRACKER_THEME%">"#), "{page}");
        assert!(!page.contains("<script>"), "no inline scripts: the CSP forbids them");
        assert_eq!(assets["/"].content_type, "text/html; charset=utf-8");
        assert_eq!(assets["/assets/app.css"].content_type, "text/css; charset=utf-8");
        assert_eq!(assets["/assets/client_bg.wasm"].content_type, "application/wasm");
        assert!(assets["/assets/client_bg.wasm"].body.starts_with(b"\0asm"));
        // Every script the page and the boot module load is embedded.
        for url in ["/assets/app.js", "/assets/client.js"] {
            assert_eq!(assets[url].content_type, "text/javascript; charset=utf-8", "{url}");
        }
        let boot = String::from_utf8_lossy(&assets["/assets/app.js"].body).into_owned();
        assert!(boot.contains("from './client.js'"), "{boot}");
    }
}
