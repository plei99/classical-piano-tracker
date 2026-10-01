import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The SQL lives in ../internal/db, shared with the Go and Rust builds.
  server: { fs: { allow: ['..'] } },
  test: { include: ['src/**/*.test.{ts,tsx}'] },
});
