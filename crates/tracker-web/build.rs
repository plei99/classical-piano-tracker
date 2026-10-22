//! Builds the browser client (`web/`, TypeScript and Preact) and embeds it,
//! so `cargo build --release` stays the only build command and the binary
//! carries the whole web UI.
//!
//! Steps: `node web/build.mjs` bundles the client with esbuild (into
//! `$OUT_DIR/client`: `app.js` and `app.css`), then every asset but the page
//! template (`web/index.html`) is compressed with gzip and brotli at their
//! highest settings, so the server can send the smaller copy. Cargo reruns
//! this script only when the client changes.
//!
//! Requirements: Node 24 or later, and the client's dependencies
//! (`npm ci --prefix web`, which `make build` runs).
//! `TRACKER_WEB_CLIENT_DIR` skips the bundling and embeds an existing
//! directory with `app.js` and `app.css`.

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("cargo sets OUT_DIR"));
    let workspace = manifest_dir.join("../..").canonicalize().expect("the workspace root exists");
    let web = workspace.join("web");

    for env in ["TRACKER_WEB_CLIENT_DIR", "TRACKER_MINIFY", "NODE"] {
        println!("cargo:rerun-if-env-changed={env}");
    }
    for path in ["src", "index.html", "build.mjs", "package.json", "package-lock.json"] {
        println!("cargo:rerun-if-changed={}", web.join(path).display());
    }

    let client_dir = match env::var_os("TRACKER_WEB_CLIENT_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => {
            let dir = out_dir.join("client");
            if let Err(err) = build_client(&web, &dir) {
                panic!("\n\nbuilding the tracker web client failed: {err}\n\n");
            }
            dir
        }
    };

    let mut files = vec![("/".to_string(), web.join("index.html"))];
    for name in ["app.js", "app.css"] {
        let path = client_dir.join(name);
        assert!(path.is_file(), "{name} is missing from {}", client_dir.display());
        files.push((format!("/assets/{name}"), path));
    }

    let compressed_dir = out_dir.join("compressed");
    let _ = fs::remove_dir_all(&compressed_dir);
    fs::create_dir_all(&compressed_dir).expect("create the compressed assets directory");
    let mut source = String::from("/// Every embedded file.\n");
    source.push_str("pub(crate) const FILES: &[Embedded] = &[\n");
    for (number, (url, path)) in files.iter().enumerate() {
        let path = path.canonicalize().unwrap_or_else(|err| panic!("{}: {err}", path.display()));
        // The page is a template, filled in per request.
        let (gzip, brotli) = if url == "/" {
            (None, None)
        } else {
            let data = fs::read(&path).unwrap_or_else(|err| panic!("{}: {err}", path.display()));
            let write = |extension: &str, compressed: Option<Vec<u8>>| {
                let compressed = compressed?;
                let file = compressed_dir.join(format!("{number}.{extension}"));
                fs::write(&file, compressed).expect("write a compressed asset");
                Some(file)
            };
            (write("gz", gzip(&data)), write("br", brotli(&data)))
        };
        let include = |file: Option<PathBuf>| {
            file.map_or_else(|| "&[]".to_string(), |file| format!("include_bytes!({:?})", file.display()))
        };
        writeln!(
            source,
            "    Embedded {{ url: {url:?}, content_type: {:?}, body: include_bytes!({:?}), gzip: {}, brotli: {} }},",
            content_type(&path),
            path.display(),
            include(gzip),
            include(brotli)
        )
        .unwrap();
    }
    source.push_str("];\n");
    fs::write(out_dir.join("assets.rs"), source).expect("write assets.rs");
}

/// Bundles the client with its own esbuild into `out`.
fn build_client(web: &Path, out: &Path) -> Result<(), String> {
    if !web.join("node_modules/esbuild").is_dir() {
        return Err(format!("the client's dependencies are not installed; run `npm ci --prefix {}`", web.display()));
    }
    let node = env::var_os("NODE").map_or_else(|| PathBuf::from("node"), PathBuf::from);
    let _ = fs::remove_dir_all(out);
    let status = Command::new(&node)
        .arg(web.join("build.mjs"))
        .arg(out)
        .current_dir(web)
        .status()
        .map_err(|err| format!("run {node:?}: {err} (the web client needs Node 24 or later)"))?;
    if status.success() { Ok(()) } else { Err(format!("{node:?} build.mjs failed: {status}")) }
}

/// Below this, compression saves too little to be worth a second copy.
const MIN_COMPRESS: usize = 1024;

fn gzip(data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < MIN_COMPRESS {
        return None;
    }
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    encoder.write_all(data).expect("gzip in memory");
    let compressed = encoder.finish().expect("gzip in memory");
    (compressed.len() < data.len()).then_some(compressed)
}

fn brotli(data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < MIN_COMPRESS {
        return None;
    }
    let mut compressed = Vec::new();
    {
        let mut writer = brotli::CompressorWriter::new(&mut compressed, 4096, 11, 22);
        writer.write_all(data).expect("brotli in memory");
    }
    (compressed.len() < data.len()).then_some(compressed)
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        _ => "application/octet-stream",
    }
}
