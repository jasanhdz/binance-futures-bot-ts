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
  createMicroBurstIdentity,
  hasMicroBurstLiveAuthority,
  MICRO_BURST_CONFIG_SHA256,
} from '../../strategies/micro-burst/domain/MicroBurstIdentity';

describe('Micro effective configuration authority', () => {
  it('matches the approved effective Micro config and rejects representation drift', () => {
    const parsed = parseMicroBurstConfig(
      load(readFileSync(resolve('regime_config.live.yaml'), 'utf8')),
    );
    const service = new TradingRuntimeConfigService({ getMicroBurstConfig: () => parsed } as never);
    const merged = mergeMicroBurstConfigs(parsed, {});
    const parsedHash = service.getMicroBurstProvenance(parsed).configHash;
    const mergedHash = service.getMicroBurstProvenance(merged).configHash;
    expect(mergedHash).toBe('132879584379e97474309df05d99552a6b835fecdcbe38d3b586b7bfb76633e1');
    expect(parsedHash).toBe(MICRO_BURST_CONFIG_SHA256);
    expect(mergedHash).toBe(MICRO_BURST_CONFIG_SHA256);
    const identity = createMicroBurstIdentity('a'.repeat(40), mergedHash);
    expect(hasMicroBurstLiveAuthority(identity, mergedHash, identity.codeCommitSha)).toBe(true);
    expect(hasMicroBurstLiveAuthority(identity, mergedHash, 'b'.repeat(40))).toBe(false);
    expect(
      hasMicroBurstLiveAuthority(identity, MICRO_BURST_CONFIG_SHA256, identity.codeCommitSha),
    ).toBe(true);
    expect(hasMicroBurstLiveAuthority(identity, parsedHash, identity.codeCommitSha)).toBe(true);
    // Preserve the existing persisted provenance representation.
    expect(parsed.exitPolicy).toEqual({ contextualPolicyVersion: 'MICRO' });
    expect(merged.exitPolicy).toEqual({ contextualPolicyVersion: 'MICRO' });
    for (const config of [parsed, merged]) {
      expect(
        service.getMicroBurstProvenance(JSON.parse(JSON.stringify(config))).configHash,
      ).not.toBe(MICRO_BURST_CONFIG_SHA256);
    }
  });

  it('hashes effective risk overrides and is independent of object insertion order', () => {
    const service = new TradingRuntimeConfigService({} as never);
    const base = parseMicroBurstConfig({
      micro_burst: { enabled: true, mode: 'SHADOW', symbols: { ETHUSDT: { enabled: true } } },
    });
    const hash = (config: typeof base) => service.getMicroBurstProvenance(config).configHash;
    expect(hash(base)).toBe(
      hash(Object.fromEntries(Object.entries(base).reverse()) as typeof base),
    );
    expect(hash(base)).not.toBe(hash({ ...base, exitPolicy: { exitMaxHoldMs: 1_000 } }));
    expect(hash(base)).not.toBe(hash({ ...base, symbols: { ETHUSDT: { enabled: false } } }));
  });
});
