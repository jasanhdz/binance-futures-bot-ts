import { describe, expect, it } from 'vitest';
import { defaultMicroBurstConfig } from './MicroBurstTypes';
import { selectLeverageTier } from './MicroBurstLeveragePolicy';

describe('MicroBurstLeveragePolicy', () => {
  const config = defaultMicroBurstConfig();

  it('returns HIGH_CONFIRMATION for strong confirmation', () => {
    const result = selectLeverageTier(0.8, config);
    expect(result.tier).toBe('HIGH_CONFIRMATION');
    expect(result.leverage).toBe(40);
    expect(result.positionFraction).toBe(0.09);
  });

  it('returns MEDIUM_CONFIRMATION for acceptable confirmation', () => {
    const result = selectLeverageTier(0.6, config);
    expect(result.tier).toBe('MEDIUM_CONFIRMATION');
    expect(result.leverage).toBe(20);
    expect(result.positionFraction).toBe(0.05);
  });

  it('returns NO_TRADE for insufficient confirmation', () => {
    const result = selectLeverageTier(0.3, config);
    expect(result.tier).toBe('NO_TRADE');
    expect(result.leverage).toBe(0);
    expect(result.positionFraction).toBe(0);
  });

  it('returns HIGH at exact boundary', () => {
    const result = selectLeverageTier(0.75, config);
    expect(result.tier).toBe('HIGH_CONFIRMATION');
  });

  it('returns MEDIUM at exact boundary', () => {
    const result = selectLeverageTier(0.50, config);
    expect(result.tier).toBe('MEDIUM_CONFIRMATION');
  });

  it('returns NO_TRADE just below MEDIUM boundary', () => {
    const result = selectLeverageTier(0.49, config);
    expect(result.tier).toBe('NO_TRADE');
  });
});
