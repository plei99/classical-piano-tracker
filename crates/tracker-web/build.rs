//! Builds the browser client (`crates/tracker-web-client`) for
//! wasm32-unknown-unknown and embeds it, so `cargo build --release` stays the
//! only build command and the binary carries the whole web UI.
//!
//! Steps: a nested `cargo rustc` of the client as a cdylib with its
//! `hydrate` feature and a wasm-capable rustc (into `<target>/web-client`,
//! so it is incremental and never contends with the outer build),
//! `wasm-bindgen --target web`, then `wasm-opt -Oz` when it is installed.
//! Every asset but the page template is then compressed (gzip and brotli,
//! at their highest settings) so the server can send the smaller copy. Cargo
//! reruns this script only when the client or the crates it compiles change.
//!
//! Requirements: a rustc with the wasm32-unknown-unknown target (this
//! build's, a rustup toolchain, or `TRACKER_WASM_TOOLCHAIN`), and the
//! `wasm-bindgen` CLI at the version the client pins. `TRACKER_WEB_CLIENT_DIR`
//! skips all of it and embeds an existing wasm-bindgen output directory.

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;

const CLIENT_CRATE: &str = "tracker-web-client";
const WASM_TARGET: &str = "wasm32-unknown-unknown";
const WASM_PROFILE: &str = "wasm-release";
/// The wasm-bindgen output name: `client.js` and `client_bg.wasm`.
const OUT_NAME: &str = "client";

fn main() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("cargo sets OUT_DIR"));
    let workspace = manifest_dir.join("../..").canonicalize().expect("the workspace root exists");
    let client_dir = workspace.join("crates").join(CLIENT_CRATE);

    for env in ["TRACKER_WEB_CLIENT_DIR", "TRACKER_WASM_TOOLCHAIN", "WASM_BINDGEN", "WASM_OPT", "CARGO_TARGET_DIR"] {
        println!("cargo:rerun-if-env-changed={env}");
    }
    // Everything the client compiles from this workspace.
    for path in [
        client_dir.clone(),
        workspace.join("crates/tracker-app"),
        workspace.join("crates/tracker-core/src"),
        workspace.join("crates/tracker-core/Cargo.toml"),
        workspace.join("Cargo.toml"),
        workspace.join("Cargo.lock"),
    ] {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    let bindgen_dir = match env::var_os("TRACKER_WEB_CLIENT_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => {
            let dir = out_dir.join("client");
            if let Err(err) = build_client(&workspace, &dir) {
                panic!("\n\nbuilding the tracker web client failed: {err}\n\n");
            }
            dir
        }
    };

    let mut files = vec![
        ("/".to_string(), client_dir.join("static/index.html")),
        ("/assets/app.css".to_string(), client_dir.join("static/styles.css")),
        ("/assets/app.js".to_string(), client_dir.join("static/app.js")),
    ];
    collect(&bindgen_dir, "/assets", &mut files);
    for name in [format!("{OUT_NAME}.js"), format!("{OUT_NAME}_bg.wasm")] {
        assert!(bindgen_dir.join(&name).is_file(), "{name} is missing from {}", bindgen_dir.display());
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

/// Adds every file under `dir` (wasm-bindgen also emits `snippets/`).
fn collect(dir: &Path, url: &str, files: &mut Vec<(String, PathBuf)>) {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .unwrap_or_else(|err| panic!("read {}: {err}", dir.display()))
        .map(|entry| entry.expect("directory entry").path())
        .collect();
    entries.sort();
    for path in entries {
        let name = path.file_name().expect("file name").to_string_lossy().into_owned();
        if path.is_dir() {
            collect(&path, &format!("{url}/{name}"), files);
        } else {
            files.push((format!("{url}/{name}"), path));
        }
    }
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn build_client(workspace: &Path, out: &Path) -> Result<(), String> {
    let rustc = wasm_rustc()?;
    let cargo = env::var_os("CARGO").map_or_else(|| PathBuf::from("cargo"), PathBuf::from);
    let target_dir = env::var_os("CARGO_TARGET_DIR").map_or_else(|| workspace.join("target"), PathBuf::from);
    let target_dir = target_dir.join("web-client");

    let mut build = Command::new(&cargo);
    isolate(&mut build);
    build
        .args(["rustc", "--lib", "-p", CLIENT_CRATE, "--target", WASM_TARGET, "--profile", WASM_PROFILE])
        .args(["--features", "hydrate", "--crate-type", "cdylib"])
        .arg("--manifest-path")
        .arg(workspace.join("Cargo.toml"))
        .arg("--target-dir")
        .arg(&target_dir)
        .env("RUSTC", &rustc.path);
    if cfg!(target_os = "macos") {
        // Some rustup layouts ship rust-lld without an rpath to the
        // toolchain's libLLVM.dylib.
        build.env("DYLD_FALLBACK_LIBRARY_PATH", rustc.sysroot.join("lib"));
    }
    run(&mut build)?;
    let wasm = target_dir.join(WASM_TARGET).join(WASM_PROFILE).join("tracker_web_client.wasm");

    let bindgen = env::var_os("WASM_BINDGEN").map_or_else(|| PathBuf::from("wasm-bindgen"), PathBuf::from);
    let version = output(Command::new(&bindgen).arg("--version")).map_err(|err| {
        format!("{err}\ninstall the wasm-bindgen CLI {} (e.g. `brew install wasm-bindgen`)", pinned_bindgen(workspace))
    })?;
    let pinned = pinned_bindgen(workspace);
    if version.split_whitespace().nth(1) != Some(pinned.as_str()) {
        return Err(format!("{bindgen:?} is `{}`, but the client pins wasm-bindgen {pinned}", version.trim()));
    }
    let _ = fs::remove_dir_all(out);
    run(Command::new(&bindgen)
        .args(["--target", "web", "--no-typescript", "--out-name", OUT_NAME, "--out-dir"])
        .arg(out)
        .arg(&wasm))?;

    let module = out.join(format!("{OUT_NAME}_bg.wasm"));
    let opt = env::var_os("WASM_OPT").map_or_else(|| PathBuf::from("wasm-opt"), PathBuf::from);
    match Command::new(&opt).arg("-Oz").arg(&module).arg("-o").arg(&module).status() {
        Ok(status) if status.success() => {}
        Ok(status) => return Err(format!("{opt:?} failed: {status}")),
        Err(_) => {
            println!("cargo:warning=wasm-opt not found; the web client is embedded unoptimized (about 5x larger)")
        }
    }
    Ok(())
}

/// Drops the outer build's settings (target, flags, wrappers such as
/// clippy-driver) so the nested build is a plain one.
fn isolate(command: &mut Command) {
    const KEEP: [&str; 5] = ["CARGO_HOME", "CARGO_NET_", "CARGO_HTTP_", "CARGO_REGISTRIES_", "CARGO_REGISTRY_"];
    const DROP: [&str; 15] = [
        "CARGO",
        "RUSTC",
        "RUSTC_WRAPPER",
        "RUSTC_WORKSPACE_WRAPPER",
        "RUSTC_LINKER",
        "RUSTFLAGS",
        "RUSTDOC",
        "RUSTDOCFLAGS",
        "TARGET",
        "HOST",
        "OUT_DIR",
        "OPT_LEVEL",
        "PROFILE",
        "DEBUG",
        "NUM_JOBS",
    ];
    for (name, _) in env::vars_os() {
        let name = name.to_string_lossy();
        let cargo_setting = name.starts_with("CARGO_") && !KEEP.iter().any(|keep| name.starts_with(keep));
        if cargo_setting || name.starts_with("__CARGO") || name.starts_with("DEP_") || DROP.contains(&name.as_ref()) {
            command.env_remove(name.as_ref());
        }
    }
    command.env_remove("MAKEFLAGS").env_remove("MFLAGS").env_remove("CLIPPY_ARGS");
}

struct Rustc {
    path: PathBuf,
    sysroot: PathBuf,
}

/// A rustc that can target wasm32: `TRACKER_WASM_TOOLCHAIN`, this build's,
/// or a rustup toolchain (the same release as this build's first).
fn wasm_rustc() -> Result<Rustc, String> {
    let mut candidates = Vec::new();
    if let Some(dir) = env::var_os("TRACKER_WASM_TOOLCHAIN") {
        let dir = PathBuf::from(dir);
        let bin = if dir.join("bin").is_dir() { dir.join("bin") } else { dir };
        candidates.push(bin.join("rustc"));
    }
    let host_rustc = env::var_os("RUSTC").map_or_else(|| PathBuf::from("rustc"), PathBuf::from);
    candidates.push(host_rustc.clone());
    let release = output(Command::new(&host_rustc).arg("--version"))
        .ok()
        .and_then(|version| version.split_whitespace().nth(1).map(str::to_string))
        .unwrap_or_default();
    let rustup_home = env::var_os("RUSTUP_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".rustup")));
    if let Some(Ok(entries)) = rustup_home.map(|home| fs::read_dir(home.join("toolchains"))) {
        let mut toolchains: Vec<PathBuf> = entries.filter_map(|entry| Some(entry.ok()?.path())).collect();
        // Same release first, then newest name first.
        toolchains.sort_by_key(|path| {
            let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
            (!name.starts_with(&format!("{release}-")), std::cmp::Reverse(name))
        });
        candidates.extend(toolchains.into_iter().map(|toolchain| toolchain.join("bin/rustc")));
    }

    for path in &candidates {
        let Ok(sysroot) = output(Command::new(path).args(["--print", "sysroot"])) else { continue };
        let sysroot = PathBuf::from(sysroot.trim());
        if sysroot.join("lib/rustlib").join(WASM_TARGET).join("lib").is_dir() {
            return Ok(Rustc { path: path.clone(), sysroot });
        }
    }
    Err(format!(
        "no rustc with the {WASM_TARGET} target found (tried {candidates:?}); \
         install it (`rustup target add {WASM_TARGET}`) or set TRACKER_WASM_TOOLCHAIN to a toolchain that has it"
    ))
}

/// The exact wasm-bindgen version the client's manifest pins (`=x.y.z`).
fn pinned_bindgen(workspace: &Path) -> String {
    let manifest =
        fs::read_to_string(workspace.join("crates").join(CLIENT_CRATE).join("Cargo.toml")).unwrap_or_default();
    manifest
        .lines()
        .find_map(|line| line.strip_prefix("wasm-bindgen = \"="))
        .and_then(|rest| rest.split('"').next())
        .unwrap_or("?")
        .to_string()
}

fn output(command: &mut Command) -> Result<String, String> {
    let output = command.output().map_err(|err| format!("run {:?}: {err}", command.get_program()))?;
    if !output.status.success() {
        return Err(format!("{:?} failed: {}", command.get_program(), String::from_utf8_lossy(&output.stderr)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn run(command: &mut Command) -> Result<(), String> {
    let status = command.status().map_err(|err| format!("run {:?}: {err}", command.get_program()))?;
    if status.success() { Ok(()) } else { Err(format!("{command:?} failed: {status}")) }
}
