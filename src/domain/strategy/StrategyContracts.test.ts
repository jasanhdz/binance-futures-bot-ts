import { describe, expect, it } from 'vitest';
import { StrategyRiskLedger } from '../risk/StrategyRiskLedger';
import { defaultStrategyExecutionAuthority, RiskLedgerContract } from './StrategyContracts';
import { StrategyIdentity } from './StrategyIdentity';

describe('StrategyContracts', () => {
  it('adapts the existing live-authority predicate without changing its semantics', () => {
    const identity: StrategyIdentity = {
      strategyId: 'AEGIS_TURBO',
      strategyVersion: 'v1',
      freezeState: 'FROZEN_LIVE',
      strategyHash: `sha256:${'a'.repeat(64)}`,
      configHash: `sha256:${'b'.repeat(64)}`,
      codeCommitSha: 'commit',
    };

    expect(defaultStrategyExecutionAuthority(identity, 'LIVE')).toBe(true);
    expect(defaultStrategyExecutionAuthority(identity, 'SHADOW')).toBe(false);
  });

  it('exposes the existing risk ledger through a strategy-neutral contract', () => {
    const ledger: RiskLedgerContract = new StrategyRiskLedger();
    expect(ledger.snapshot('MOMENTUM_RIDE').consecutiveLosses).toBe(0);
    expect(ledger.recordOpen('MOMENTUM_RIDE', 100).tradesToday).toBe(1);
  });
});
