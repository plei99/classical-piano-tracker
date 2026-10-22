//! Bakes version metadata into the binary, mirroring what the Go Makefile
//! injected through `-ldflags`: `git describe --tags --always --dirty`
//! (ignoring the `archive/*` tags), the short commit, and a UTC build date. TRACKER_VERSION / TRACKER_COMMIT /
//! TRACKER_BUILD_DATE override each value (as `make VERSION=...` did), and
//! builds outside a git checkout fall back to dev/unknown.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));

    for key in ["TRACKER_VERSION", "TRACKER_COMMIT", "TRACKER_BUILD_DATE"] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    watch_git_state(&manifest_dir);

    let version = override_or("TRACKER_VERSION", || {
        git(&manifest_dir, &["describe", "--tags", "--always", "--dirty", "--exclude", "archive/*"])
    })
    .unwrap_or_else(|| "dev".to_string());
    let commit = override_or("TRACKER_COMMIT", || git(&manifest_dir, &["rev-parse", "--short", "HEAD"]))
        .unwrap_or_else(|| "unknown".to_string());
    let date =
        override_or("TRACKER_BUILD_DATE", || Some(jiff::Timestamp::now().strftime("%Y-%m-%dT%H:%M:%SZ").to_string()))
            .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=TRACKER_BUILDINFO_VERSION={version}");
    println!("cargo:rustc-env=TRACKER_BUILDINFO_COMMIT={commit}");
    println!("cargo:rustc-env=TRACKER_BUILDINFO_DATE={date}");
}

fn override_or(key: &str, fallback: impl FnOnce() -> Option<String>) -> Option<String> {
    env::var(key).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty()).or_else(fallback)
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git").arg("-C").arg(dir).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// Reruns the script when HEAD moves, the branch or tags change, or the index
/// changes (staging, commits). Unstaged edits elsewhere in the repo do not
/// rerun it, so `-dirty` reflects the tree as of the last script run; the
/// crate's own sources are watched too so local edits refresh it.
fn watch_git_state(dir: &Path) {
    println!("cargo:rerun-if-changed=src");
    let mut watched = vec!["HEAD".to_string(), "index".to_string(), "packed-refs".to_string(), "refs/tags".to_string()];
    if let Some(branch_ref) = git(dir, &["symbolic-ref", "-q", "HEAD"]) {
        watched.push(branch_ref);
    }
    for name in watched {
        if let Some(path) = git(dir, &["rev-parse", "--git-path", &name]) {
            let path = PathBuf::from(path);
            let path = if path.is_absolute() { path } else { dir.join(path) };
            if path.exists() {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
}
