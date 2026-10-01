/**
 * Build and VCS metadata exposed by `tracker version`. The bundler injects
 * `__TRACKER_BUILD__`; running from source (tests) falls back to the same
 * placeholders the Go build used without ldflags.
 */
export interface BuildInfo {
  version: string;
  commit: string;
  date: string;
}

export const buildInfo: BuildInfo =
  typeof __TRACKER_BUILD__ === 'undefined' ? { version: 'dev', commit: 'unknown', date: 'unknown' } : __TRACKER_BUILD__;

/** A short human-readable build description (Go's buildinfo.Summary). */
export function buildSummary(info: BuildInfo = buildInfo): string {
  return `${info.version} (commit ${info.commit}, built ${info.date})`;
}
