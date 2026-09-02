import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('Phase 1 architecture boundaries', () => {
  it('keeps legacy execution outside runtime imports and removes archived research code', () => {
    const runtimeFiles = [
      'src/main.ts',
      'src/app/services/TradingService.ts',
      'src/app/execution/SharedStrategyExecutionService.ts',
      'src/app/strategy/OwnedPositionManagers.ts',
      'src/strategies/aegis/domain/entry/AegisEntryGuardOrchestrator.ts',
      'src/strategies/momentum/domain/MomentumRideStrategy.ts',
    ];

    for (const path of runtimeFiles) {
      expect(source(path), path).not.toContain('tooling/research');
      expect(source(path), path).not.toContain('tooling/legacy-execution');
    }

    expect(existsSync(resolve(repoRoot, 'src/tooling/research'))).toBe(false);
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
    const momentumImports = source('src/strategies/momentum/domain/MomentumRideStrategy.ts')
      .split('\n')
      .filter((line) => line.startsWith('import '))
      .join('\n');
    for (const forbidden of [
      'CurrentBrain',
      'CleanEntry',
      'EntryQuality',
      'DecisionBrain',
      'E4TailRisk',
    ]) {
      expect(momentumImports, forbidden).not.toContain(forbidden);
    }
  });

  it('grants Micro Burst execution only through application-owned ports', () => {
    const tradingService = source('src/app/services/TradingService.ts');
    const runtime = source('src/strategies/micro-burst/application/MicroBurstRuntime.ts');

    expect(tradingService).toContain('microBurstLiveTrading');
    expect(tradingService).toContain('createMicroBurstExecutionIntent');
    for (const mutation of [
      'marketOpen(',
      'placeStopClose(',
      'placeTpClose(',
      'closeSideMarketSafe(',
    ]) {
      expect(runtime, mutation).not.toContain(mutation);
    }
  });
});
