import { describe, expect, it } from 'vitest';
import { externalLifecyclePolicy, strategyLifecyclePolicy } from './StrategyLifecyclePolicy';

describe('StrategyLifecyclePolicy', () => {
  it('keeps external positions protective without assigning Aegis authority', () => {
    expect(externalLifecyclePolicy()).toEqual({
      strategyId: 'EXTERNAL',
      useLegacyProfitGuardian: true,
      useBreakEven: true,
      useTrailing: true,
      requireStopBracket: true,
      requireTakeProfitBracket: true,
      closeIfBracketFails: true,
      allowManualQuantityReconciliation: false,
    });
  });

  it('keeps owned strategies on their explicit lifecycle identities', () => {
    expect(strategyLifecyclePolicy('AEGIS_TURBO').strategyId).toBe('AEGIS_TURBO');
    expect(strategyLifecyclePolicy('MOMENTUM_RIDE').strategyId).toBe('MOMENTUM_RIDE');
    expect(strategyLifecyclePolicy('MICRO_BURST_V1').strategyId).toBe('MICRO_BURST_V1');
  });
});
