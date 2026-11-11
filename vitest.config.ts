import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Frozen collector artifacts are evidence copies, not additional project test suites.
    exclude: [...configDefaults.exclude, 'data/micro-burst/collector-*/**'],
    testTimeout: 15000,
  },
});
