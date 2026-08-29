import { describe, expect, it } from 'vitest';
import { AegisShortGate, AegisShortGateConfig } from './AegisShortGate';

const config: AegisShortGateConfig = {
  enabled: true,
  mode: 'PREMIUM_ONLY',
  position_fraction_multiplier: 1,
  max_leverage: 10,
  block_symbols: [],
};

describe('AegisShortGate current-brain contract', () => {
  it('does not affect LONG entries', () => {
    const decision = AegisShortGate.evaluate({
      symbol: 'BTCUSDT',
      side: 'LONG',
      leverage: 15,
      positionFraction: 0.08,
      config,
    });

    expect(decision).toMatchObject({
      allowed: true,
      reason: 'not_short',
      adjustedLeverage: 15,
      adjustedPositionFraction: 0.08,
    });
  });

  it('fails closed when SHORT lacks canonical authorization', () => {
    const decision = AegisShortGate.evaluate({
      symbol: 'BTCUSDT',
      side: 'SHORT',
      leverage: 15,
      positionFraction: 0.08,
      config,
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: 'short_canonical_decision_required',
    });
  });

  it('accepts one real directional estimator when the canonical decision is authorized', () => {
    const decision = AegisShortGate.evaluate({
      symbol: 'BTCUSDT',
      side: 'SHORT',
      canonicalDecisionAuthorized: true,
      leverage: 15,
      positionFraction: 0.08,
      config,
    });

    expect(decision).toMatchObject({
      allowed: true,
      reason: 'short_allowed_current_brain_canonical',
      adjustedLeverage: 10,
      adjustedPositionFraction: 0.08,
    });
  });

  it('still blocks an explicitly blocked symbol', () => {
    const decision = AegisShortGate.evaluate({
      symbol: 'DOGEUSDT',
      side: 'SHORT',
      canonicalDecisionAuthorized: true,
      leverage: 10,
      positionFraction: 0.08,
      config: { ...config, block_symbols: ['DOGEUSDT'] },
    });

    expect(decision).toMatchObject({ allowed: false, reason: 'short_symbol_blocked' });
  });

  it('preserves the configured position multiplier and leverage cap', () => {
    const decision = AegisShortGate.evaluate({
      symbol: 'BTCUSDT',
      side: 'SHORT',
      canonicalDecisionAuthorized: true,
      leverage: 20,
      positionFraction: 0.08,
      config: { ...config, position_fraction_multiplier: 0.5 },
    });

    expect(decision).toMatchObject({
      allowed: true,
      adjustedLeverage: 10,
      adjustedPositionFraction: 0.04,
    });
  });
});
