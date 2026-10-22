//! Build and VCS metadata exposed by the CLI. Values are baked in by
//! `build.rs`, which follows the Go Makefile's ldflags conventions.

pub const VERSION: &str = env!("TRACKER_BUILDINFO_VERSION");
pub const COMMIT: &str = env!("TRACKER_BUILDINFO_COMMIT");
pub const DATE: &str = env!("TRACKER_BUILDINFO_DATE");
