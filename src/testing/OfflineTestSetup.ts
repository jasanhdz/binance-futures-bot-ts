import { vi } from 'vitest';

// Both direct dotenv.config({ override: true }) and side-effect imports are isolated.
vi.mock('dotenv', () => ({
  config: () => ({ parsed: {} }),
  configDotenv: () => ({ parsed: {} }),
  default: { config: () => ({ parsed: {} }), configDotenv: () => ({ parsed: {} }) },
}));
vi.mock('dotenv/config', () => ({}));

process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.AEGIS_ENABLED = 'false';
delete process.env.BINANCE_API_KEY;
delete process.env.BINANCE_API_SECRET;
