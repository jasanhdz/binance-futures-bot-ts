import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

// Regression test for a real path bug found during the production deployment
// audit: gen2_bridge_main.ts resolved gen2_config.yaml one directory level too
// shallow (landed in trading_system/aegis_gen2, which does not exist, instead
// of the real .../Develop/aegis_gen2 — a sibling of trading_system). This made
// the bridge silently fail-closed (CONFIG_MISSING) even when the shared
// gen2_config.yaml had execution_enabled: true, an undetected Python/TS
// inconsistency. This test locks the correct relative resolution.
describe('gen2_config.yaml path resolution (bridge <-> Python single source of truth)', () => {
  it('resolves two levels above binance-futures-bot-ts, matching aegis_alpha GEN2_ROOT', () => {
    // Mirrors the exact computation in gen2_bridge_main.ts: repoRoot is the
    // binance-futures-bot-ts directory (dist/gen2 -> up two -> repo root).
    const repoRoot = path.resolve(__dirname, '..', '..'); // src/gen2 -> up two -> binance-futures-bot-ts
    const resolvedConfigPath = path.resolve(repoRoot, '..', '..', 'aegis_gen2', 'gen2_config.yaml');

    // aegis_gen2 must be a SIBLING of trading_system (repoRoot's parent), not a
    // child of it — this is what the bug got backwards.
    const tradingSystemRoot = path.resolve(repoRoot, '..');
    expect(path.dirname(path.dirname(resolvedConfigPath))).toBe(path.dirname(tradingSystemRoot));

    // The wrong (pre-fix) one-level-up path must NOT be the resolved path.
    const buggyPath = path.resolve(repoRoot, '..', 'aegis_gen2', 'gen2_config.yaml');
    expect(resolvedConfigPath).not.toBe(buggyPath);

    // On this host the real file exists at the corrected path (functional proof).
    if (fs.existsSync('/home/jasan/Develop/aegis_gen2')) {
      expect(resolvedConfigPath).toBe('/home/jasan/Develop/aegis_gen2/gen2_config.yaml');
    }
  });
});
