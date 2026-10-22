import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Pages render times in the server's zone; the goldens are in UTC.
  test: { include: ['src/**/*.test.{ts,tsx}'], env: { TZ: 'UTC' } },
});
