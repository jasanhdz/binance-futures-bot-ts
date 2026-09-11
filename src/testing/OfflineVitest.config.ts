import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 15_000,
    setupFiles: ['./src/testing/OfflineTestSetup.ts'],
    maxWorkers: 1,
    fileParallelism: false,
    env: {
      DOTENV_CONFIG_PATH: '/dev/null',
      AEGIS_ENABLED: 'false',
      AEGIS_LIVE_ENABLED: '0',
      PHANTOM_MICRO_BURST_PROSPECTIVE_VALIDATION: 'false',
      PHANTOM_MICRO_BURST_MARKET_ARCHIVE: 'false',
    },
  },
});
