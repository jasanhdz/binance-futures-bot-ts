import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');
const genericFiles = [
  'src/infra/logging/StrategyHistoryLogger.ts',
  'src/domain/services/ConsecutiveLossTracker.ts',
  'src/infra/state/StrategyLossStateStore.ts',
];
const strategyAdapters = [
  'src/infra/logging/AegisTurboHistoryLogger.ts',
  'src/strategies/aegis/domain/services/AegisConsecutiveLossTracker.ts',
];

describe('Phase 2 architecture contracts', () => {
  it('keeps generic implementations free of Aegis policy and adapters', () => {
    for (const relativePath of genericFiles) {
      const source = readFileSync(resolve(repoRoot, relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(/Aegis|aegis/);
    }
  });

  it('keeps canonical strategy adapters dependent on generic cores', () => {
    for (const relativePath of strategyAdapters) {
      const source = readFileSync(resolve(repoRoot, relativePath), 'utf8');
      expect(source, relativePath).toMatch(
        /StrategyHistoryLogger|ConsecutiveLossTracker|StrategyLossStateStore/,
      );
    }
  });
});
