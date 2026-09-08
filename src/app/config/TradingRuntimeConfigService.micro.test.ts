import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { TradingRuntimeConfigService } from './TradingRuntimeConfigService';
import {
  parseMicroBurstConfig,
  mergeMicroBurstConfigs,
} from '../../strategies/micro-burst/application/MicroBurstConfigLoader';
import {
  createMicroBurstV1Identity,
  hasMicroBurstV1LiveAuthority,
  MICRO_BURST_V1_CONFIG_SHA256,
} from '../../strategies/micro-burst/domain/MicroBurstIdentity';

describe('Micro effective configuration authority', () => {
  it('rejects the checked-in configuration drift without manufacturing approval', () => {
    const parsed = parseMicroBurstConfig(
      load(readFileSync(resolve('regime_config.live.yaml'), 'utf8')),
    );
    const service = new TradingRuntimeConfigService({ getMicroBurstConfig: () => parsed } as never);
    const merged = mergeMicroBurstConfigs(parsed, {});
    const parsedHash = service.getMicroBurstProvenance(parsed).configHash;
    const mergedHash = service.getMicroBurstProvenance(merged).configHash;
    // Observed source checkpoint, deliberately NOT the approved deployment bundle.
    expect(mergedHash).toBe('957d53b90e8d57eb9233e468722e85786a42a9244dc88b6cd66fc485421aa3ba');
    expect(parsedHash).not.toBe(MICRO_BURST_V1_CONFIG_SHA256);
    expect(mergedHash).not.toBe(MICRO_BURST_V1_CONFIG_SHA256);
    const identity = createMicroBurstV1Identity('a'.repeat(40));
    expect(hasMicroBurstV1LiveAuthority(identity, mergedHash, identity.codeCommitSha)).toBe(false);
    expect(
      hasMicroBurstV1LiveAuthority(identity, MICRO_BURST_V1_CONFIG_SHA256, identity.codeCommitSha),
    ).toBe(true);
    expect(hasMicroBurstV1LiveAuthority(identity, parsedHash, identity.codeCommitSha)).toBe(false);
    // Preserve the existing persisted provenance representation.
    expect(parsed.exitPolicy).toBeUndefined();
    expect(merged.exitPolicy).toEqual({});
    for (const config of [parsed, merged]) {
      expect(
        service.getMicroBurstProvenance(JSON.parse(JSON.stringify(config))).configHash,
      ).not.toBe(MICRO_BURST_V1_CONFIG_SHA256);
    }
  });

  it('hashes effective risk overrides and is independent of object insertion order', () => {
    const service = new TradingRuntimeConfigService({} as never);
    const base = parseMicroBurstConfig({
      micro_burst: { enabled: true, mode: 'LIVE', symbols: { ETHUSDT: { enabled: true } } },
    });
    const hash = (config: typeof base) => service.getMicroBurstProvenance(config).configHash;
    expect(hash(base)).toBe(
      hash(Object.fromEntries(Object.entries(base).reverse()) as typeof base),
    );
    expect(hash(base)).not.toBe(hash({ ...base, exitPolicy: { exitMaxHoldMs: 1_000 } }));
    expect(hash(base)).not.toBe(hash({ ...base, symbols: { ETHUSDT: { enabled: false } } }));
  });
});
