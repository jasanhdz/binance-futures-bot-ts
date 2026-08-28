import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');
const genericFiles = [
  'src/infra/logging/StrategyHistoryLogger.ts',
  'src/domain/services/ConsecutiveLossTracker.ts',
  'src/infra/state/StrategyLossStateStore.ts',
];
const legacyAdapters = [
  'src/infra/logging/AegisTurboHistoryLogger.ts',
  'src/domain/services/AegisConsecutiveLossTracker.ts',
  'src/infra/state/AegisConsecutiveLossStateStore.ts',
];

describe('Phase 2 architecture contracts', () => {
  it('keeps generic implementations free of Aegis policy and adapters', () => {
    for (const relativePath of genericFiles) {
      const source = readFileSync(resolve(repoRoot, relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(/Aegis|aegis/);
    }
  });

  it('keeps legacy compatibility adapters dependent on generic cores', () => {
    for (const relativePath of legacyAdapters) {
      const source = readFileSync(resolve(repoRoot, relativePath), 'utf8');
      expect(source, relativePath).toMatch(
        /StrategyHistoryLogger|ConsecutiveLossTracker|StrategyLossStateStore/,
      );
    }
  });
});
