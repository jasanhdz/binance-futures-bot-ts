import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED,
  MICRO_BURST_V1_SHADOW_AUTHORITY_ENABLED,
} from './MicroBurstIdentity';
import { strategyLifecyclePolicy } from '../../strategy/StrategyLifecyclePolicy';

const strategyDir = resolve(__dirname);

describe('Micro Burst architecture boundaries', () => {
  it('keeps shadow and live authority disabled', () => {
    expect(MICRO_BURST_V1_SHADOW_AUTHORITY_ENABLED).toBe(false);
    expect(MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED).toBe(false);
  });

  it('disables legacy ProfitGuardian, break-even and trailing lifecycle mechanics', () => {
    expect(strategyLifecyclePolicy('MICRO_BURST_V1')).toEqual({
      strategyId: 'MICRO_BURST_V1',
      useLegacyProfitGuardian: false,
      useBreakEven: false,
      useTrailing: false,
      requireStopBracket: true,
      requireTakeProfitBracket: false,
      closeIfBracketFails: true,
      allowManualQuantityReconciliation: false,
    });
  });

  it('keeps domain production imports isolated from other strategies and legacy guardians', () => {
    const imports = readdirSync(strategyDir)
      .filter((name) => name.endsWith('.ts') && !name.includes('.test'))
      .map((name) => readFileSync(resolve(strategyDir, name), 'utf8'))
      .flatMap((source) => source.split('\n').filter((line) => line.startsWith('import ')))
      .join('\n');
    for (const forbidden of [
      'Aegis',
      'CurrentBrain',
      'E4',
      'ExitEye',
      'MomentumRide',
      'ProfitGuardian',
    ]) {
      expect(imports).not.toContain(forbidden);
    }
  });

  it('keeps causal domain logic free of wall-clock reads and index-to-epoch comparisons', () => {
    const productionSource = readdirSync(strategyDir)
      .filter((name) => name.endsWith('.ts') && !name.includes('.test'))
      .map((name) => readFileSync(resolve(strategyDir, name), 'utf8'))
      .join('\n');
    const contextBuilder = readFileSync(resolve(strategyDir, 'MicroBurstContextBuilder.ts'), 'utf8');
    expect(productionSource).not.toContain('Date.now()');
    expect(contextBuilder).not.toContain('availableAtCandleIndex');
  });
});
