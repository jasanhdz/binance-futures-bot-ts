import { describe, expect, it } from 'vitest';
import { evaluateMicroBurstEntry } from './MicroBurstEntryPolicy';
import { makeLevel, makeMicroBurstContext } from './MicroBurst.test-support';
import { defaultMicroBurstConfig } from './MicroBurstTypes';

const config = defaultMicroBurstConfig();

function contextFor(
  position: 'near_support' | 'near_resistance',
  momentumDirection: 'LONG' | 'SHORT' | 'NEUTRAL',
) {
  const support = makeLevel('support', position === 'near_support' ? 99.7 : 98);
  const resistance = makeLevel('resistance', position === 'near_resistance' ? 100.3 : 102);
  return makeMicroBurstContext({
    levels: {
      levels: [support, resistance],
      nearest: {
        support,
        resistance,
        distanceToSupportBps: 200,
        distanceToResistanceBps: 200,
        corridorWidthBps: 400,
        structuralPosition: position,
      },
    },
    momentum: {
      ...makeMicroBurstContext().momentum,
      direction: momentumDirection,
    },
  });
}

describe('MicroBurstEntryPolicy correctness', () => {
  it('fails closed for invalid context', () => {
    const context = makeMicroBurstContext({
      dataQuality: {
        ...makeMicroBurstContext().dataQuality,
        contextValid: false,
        invalidReasons: ['stale_5m_candles'],
      },
    });
    expect(evaluateMicroBurstEntry(context, config).reason).toContain('CONTEXT_INVALID');
  });

  it('fails closed when BTC is unavailable', () => {
    const decision = evaluateMicroBurstEntry(makeMicroBurstContext({ btcContext: null }), config);
    expect(decision).toMatchObject({ action: 'NO_TRADE', reason: 'BTC_UNAVAILABLE' });
  });

  it('fails closed for anomalous book even if fixture dataQuality is inconsistent', () => {
    const decision = evaluateMicroBurstEntry(
      makeMicroBurstContext({
        bookPressure: {
          ...makeMicroBurstContext().bookPressure,
          status: 'ANOMALOUS',
          anomalyFlag: true,
        },
      }),
      config,
    );
    expect(decision).toMatchObject({ action: 'NO_TRADE', reason: 'BOOK_NOT_HEALTHY' });
  });

  it.each([
    ['near_support', 'LONG', 'ENTRY_INTENT'],
    ['near_support', 'SHORT', 'NO_TRADE'],
    ['near_support', 'NEUTRAL', 'NO_TRADE'],
    ['near_resistance', 'SHORT', 'ENTRY_INTENT'],
    ['near_resistance', 'LONG', 'NO_TRADE'],
    ['near_resistance', 'NEUTRAL', 'NO_TRADE'],
  ] as const)('%s plus %s momentum produces %s', (position, direction, expected) => {
    const decision = evaluateMicroBurstEntry(contextFor(position, direction), config);
    expect(decision.action).toBe(expected);
    if (expected === 'NO_TRADE') expect(decision.reason).toBe('MOMENTUM_DIRECTION_MISMATCH');
  });

  it('stores room and risk as true basis points and exposes reward/risk', () => {
    const decision = evaluateMicroBurstEntry(makeMicroBurstContext(), config);
    expect(decision.action).toBe('ENTRY_INTENT');
    expect(decision.roomToTargetBps).toBeGreaterThan(190);
    expect(decision.riskToInvalidationBps).toBeGreaterThan(40);
    expect(decision.rewardRisk).toBeCloseTo(
      decision.roomToTargetBps! / decision.riskToInvalidationBps!,
    );
  });

  it('rejects insufficient reward/risk', () => {
    const context = makeMicroBurstContext({
      levels: {
        levels: [makeLevel('support', 98), makeLevel('resistance', 100.4)],
        nearest: {
          support: makeLevel('support', 98),
          resistance: makeLevel('resistance', 100.4),
          distanceToSupportBps: 200,
          distanceToResistanceBps: 40,
          corridorWidthBps: 240,
          structuralPosition: 'near_support',
        },
      },
    });
    const decision = evaluateMicroBurstEntry(context, { ...config, minRoomBps: 1 });
    expect(decision).toMatchObject({
      action: 'NO_TRADE',
      reason: 'INSUFFICIENT_REWARD_RISK',
    });
  });

  it('rejects non-finite reward/risk', () => {
    const context = makeMicroBurstContext({ currentPrice: Number.NaN });
    const decision = evaluateMicroBurstEntry(context, config);
    expect(decision.action).toBe('NO_TRADE');
    expect(['INVALID_STRUCTURAL_GEOMETRY', 'INSUFFICIENT_ROOM', 'INVALID_REWARD_RISK']).toContain(
      decision.reason,
    );
  });

  it('rejects zero structural risk instead of producing infinite reward/risk', () => {
    const zeroRiskSupport = makeLevel('support', 100 / (1 - 20 / 10_000));
    const resistance = makeLevel('resistance', 102);
    const context = makeMicroBurstContext({
      levels: {
        levels: [zeroRiskSupport, resistance],
        nearest: {
          ...makeMicroBurstContext().levels.nearest,
          support: zeroRiskSupport,
          resistance,
        },
      },
    });
    expect(evaluateMicroBurstEntry(context, config)).toMatchObject({
      action: 'NO_TRADE',
      reason: 'INVALID_STRUCTURAL_GEOMETRY',
    });
  });

  it('is deterministic for the same context', () => {
    const context = makeMicroBurstContext();
    expect(evaluateMicroBurstEntry(context, config)).toEqual(
      evaluateMicroBurstEntry(context, config),
    );
  });
});
