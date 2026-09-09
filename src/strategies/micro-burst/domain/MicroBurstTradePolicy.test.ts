import { describe, expect, it } from 'vitest';
import { createMicroBurstTradePolicy, isMicroBurstTradePolicy } from './MicroBurstTradePolicy';
import { selectLeverageTier } from './MicroBurstLeveragePolicy';
import { defaultMicroBurstConfig } from './MicroBurstTypes';
import type { StrategyIdentity } from '../../../core/strategy/StrategyIdentity';
import type { MicroBurstContextualRiskPolicy } from './MicroBurstContextualRiskPolicy';

const identity: StrategyIdentity = {
  strategyId: 'MICRO_BURST',
  strategyVersion: 'MICRO',
  freezeState: 'DRAFT',
  codeCommitSha: 'a'.repeat(40),
  configHash: `sha256:${'b'.repeat(64)}`,
};
const risk: MicroBurstContextualRiskPolicy = {
  sizingMode: 'MARGIN_FRACTION',
  marginFraction: 0.9,
  mediumLeverage: 20,
  highLeverage: 30,
  maxConsecutiveNetLosses: 3,
  resetMode: 'SIGNED_OPERATOR',
  feeReserveBps: 14,
  stopStressBps: 10,
};

describe('Micro immutable contextual trade policy', () => {
  it('round-trips a resolved snapshot and selects 20/30 from existing confirmation inputs', () => {
    const snapshot = createMicroBurstTradePolicy(identity, risk);
    expect(isMicroBurstTradePolicy(JSON.parse(JSON.stringify(snapshot)), identity)).toBe(true);
    expect(selectLeverageTier(0.5, snapshot.config)).toMatchObject({
      leverage: 20,
      positionFraction: 0.9,
    });
    expect(selectLeverageTier(0.7, snapshot.config)).toMatchObject({
      leverage: 30,
      positionFraction: 0.9,
    });
    expect(selectLeverageTier(0.3, snapshot.config).tier).toBe('NO_TRADE');
    expect(defaultMicroBurstConfig().leverageTiers.high.leverage).toBe(40);
  });
  it('copies inputs and binds stop/risk/config/source fields without granting authority', () => {
    const input = { ...risk };
    const snapshot = createMicroBurstTradePolicy(identity, input);
    input.marginFraction = 0.5;
    expect(snapshot.risk.marginFraction).toBe(0.9);
    expect(
      isMicroBurstTradePolicy(snapshot, { ...identity, configHash: `sha256:${'c'.repeat(64)}` }),
    ).toBe(false);
    expect(isMicroBurstTradePolicy(snapshot, { ...identity, codeCommitSha: 'c'.repeat(40) })).toBe(
      false,
    );
    snapshot.config.exitMaxHoldMs += 1;
    expect(isMicroBurstTradePolicy(snapshot, identity)).toBe(false);
    expect(identity.freezeState).toBe('DRAFT');
  });
  it('canonicalizes key order and rejects incomplete policy identities', () => {
    const snapshot = createMicroBurstTradePolicy(identity, risk);
    const reordered = Object.fromEntries(Object.entries(snapshot).reverse());
    expect(isMicroBurstTradePolicy(reordered, identity)).toBe(true);
    for (const value of [
      null,
      {},
      { ...snapshot, policyVersion: 'REACTION' },
      { ...snapshot, digest: 'unknown' },
    ])
      expect(isMicroBurstTradePolicy(value, identity)).toBe(false);
    expect(() =>
      createMicroBurstTradePolicy({ ...identity, codeCommitSha: 'UNKNOWN' }, risk),
    ).toThrow();
  });
});
