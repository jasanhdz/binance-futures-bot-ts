import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('Phase 1 architecture boundaries', () => {
  it('keeps archived research and legacy execution outside runtime imports', () => {
    const runtimeFiles = [
      'src/main.ts',
      'src/app/services/TradingService.ts',
      'src/app/execution/SharedStrategyExecutionService.ts',
      'src/app/strategy/OwnedPositionManagers.ts',
      'src/domain/services/aegis-entry/AegisEntryGuardOrchestrator.ts',
      'src/domain/strategies/momentum-ride/MomentumRideStrategy.ts',
    ];

    for (const path of runtimeFiles) {
      expect(source(path), path).not.toContain('tooling/research/archived');
      expect(source(path), path).not.toContain('tooling/legacy-execution');
    }
  });

  it('removes superseded active-looking source entry points', () => {
    for (const path of [
      'src/audit/binance-usdm-readonly-audit.ts',
      'src/backtest/adapters/MockExchange.ts',
      'src/brain/client.ts',
      'src/challengers/V17ExecutionCompatibility.ts',
      'src/execution-durable/DurableExecutionLifecycle.ts',
      'src/prospective/shadow-service.ts',
      'src/tools/analyzeAegisTurboHistory.ts',
    ]) {
      expect(existsSync(resolve(repoRoot, path)), path).toBe(false);
    }
  });

  it('keeps Momentum independent from Aegis scientific authority', () => {
    const momentumImports = source('src/domain/strategies/momentum-ride/MomentumRideStrategy.ts')
      .split('\n')
      .filter((line) => line.startsWith('import '))
      .join('\n');
    for (const forbidden of ['CurrentBrain', 'CleanEntry', 'EntryQuality', 'DecisionBrain', 'E4TailRisk']) {
      expect(momentumImports, forbidden).not.toContain(forbidden);
    }
  });

  it('keeps Micro Burst reserved without runtime registration or execution authority', () => {
    const authoritySurfaces = [
      'src/main.ts',
      'src/app/services/TradingService.ts',
      'src/app/strategy/StrategyRouter.ts',
      'src/app/strategy/PositionManagerRouter.ts',
      'src/infra/config/ConfigLoader.ts',
    ];

    for (const path of authoritySurfaces) {
      expect(source(path), path).not.toContain('MICRO_BURST_V1');
    }
  });
});
