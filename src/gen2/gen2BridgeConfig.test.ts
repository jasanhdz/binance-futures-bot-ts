import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emergencyDenyActive,
  readConfigExecutionEnabled,
  readConfigSymbols,
  resolveConfigPath,
} from './gen2BridgeConfig';

// Regression coverage for the "eliminate the fixed ADA/DOGE allowlist" change:
// the bridge's executable symbols must come ONLY from gen2_config.yaml `symbols`
// (the same 11-symbol universe Aegis analyzes/ranks), with fail-closed behavior
// on any missing/invalid config.
const ELEVEN_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'SUIUSDT',
  'LTCUSDT',
  'LINKUSDT',
];

let tmpDir: string | undefined;

function writeTmpYaml(content: string): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen2-config-test-'));
  const p = path.join(tmpDir, 'gen2_config.yaml');
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('readConfigSymbols', () => {
  it('reads all 11 symbols from the config, matching the Aegis analysis universe', () => {
    const configPath = writeTmpYaml(
      [
        'candidate_id: gen2-test',
        'symbols:',
        ...ELEVEN_SYMBOLS.map((s) => `  - ${s}`),
        'execution_enabled: true',
      ].join('\n'),
    );
    expect(readConfigSymbols(configPath)).toEqual(ELEVEN_SYMBOLS);
  });

  it('normalizes case and surrounding whitespace', () => {
    const configPath = writeTmpYaml(['symbols:', '  - "  adausdt  "', '  - DOGEusdt'].join('\n'));
    expect(readConfigSymbols(configPath)).toEqual(['ADAUSDT', 'DOGEUSDT']);
  });

  it('fails closed to an empty list when the config file is missing', () => {
    expect(readConfigSymbols('/nonexistent/path/gen2_config.yaml')).toEqual([]);
  });

  it('fails closed to an empty list when symbols is not an array', () => {
    const configPath = writeTmpYaml(['symbols: ADAUSDT', 'execution_enabled: true'].join('\n'));
    expect(readConfigSymbols(configPath)).toEqual([]);
  });

  it('fails closed to an empty list when symbols is absent entirely', () => {
    const configPath = writeTmpYaml(['candidate_id: gen2-test', 'execution_enabled: true'].join('\n'));
    expect(readConfigSymbols(configPath)).toEqual([]);
  });

  it('fails closed to an empty list on malformed YAML', () => {
    const configPath = writeTmpYaml('symbols: [ADAUSDT, "unterminated');
    expect(readConfigSymbols(configPath)).toEqual([]);
  });
});

describe('readConfigExecutionEnabled', () => {
  it('is enabled only when execution_enabled is exactly boolean true', () => {
    const configPath = writeTmpYaml('execution_enabled: true');
    const result = readConfigExecutionEnabled(configPath);
    expect(result).toEqual({ enabled: true, valid: true, reason: 'OK' });
  });

  it('fails closed on missing config', () => {
    const result = readConfigExecutionEnabled('/nonexistent/path/gen2_config.yaml');
    expect(result.enabled).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('CONFIG_MISSING');
  });
});

describe('emergencyDenyActive', () => {
  it('is inactive when the env var is unset', () => {
    expect(emergencyDenyActive({})).toBe(false);
  });

  it('is active for recognized deny values', () => {
    expect(emergencyDenyActive({ GEN2_EXECUTION_ENABLED: 'false' })).toBe(true);
    expect(emergencyDenyActive({ GEN2_EXECUTION_ENABLED: 'OFF' })).toBe(true);
  });

  it('cannot be forced ON via env — only recognized deny tokens flip it, anything else is a no-op', () => {
    expect(emergencyDenyActive({ GEN2_EXECUTION_ENABLED: 'true' })).toBe(false);
  });
});

describe('resolveConfigPath', () => {
  it('an explicit override always wins over the computed default', () => {
    expect(resolveConfigPath('/repo/root', '/custom/gen2_config.yaml')).toBe('/custom/gen2_config.yaml');
  });

  it('computes two levels above repoRoot by default', () => {
    expect(resolveConfigPath('/home/jasan/Develop/trading_system/binance-futures-bot-ts')).toBe(
      '/home/jasan/Develop/aegis_gen2/gen2_config.yaml',
    );
  });
});
