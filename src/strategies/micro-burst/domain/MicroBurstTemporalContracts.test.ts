import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeLevel,
  makeMicroBurstContext,
  TEST_SNAPSHOT_AT_MS as now,
} from './MicroBurst.test-support';
import { defaultMicroBurstConfig, type OrderBookSnapshot } from './MicroBurstTypes';
import { evaluateMicroBurstReactionEntry as evaluate } from './MicroBurstReactionEntryPolicy';
import { detectSupportResistance } from './MicroBurstSupportResistance';
import { MicroBurstStrategy, type MicroBurstStrategyContext } from './MicroBurstStrategy';
import { createMicroBurstIdentity } from './MicroBurstIdentity';
import { StrategyRouter } from '../../../core/strategy/StrategyRouter';
import {
  captureMicroBurstReplay,
  encodeMicroReplay,
  replayMicroBurstExact,
} from './MicroBurstExactReplay';
import { createMicroBurstBlackBoxObservation } from '../application/MicroBurstBlackBoxObservation';

const config = defaultMicroBurstConfig();
const commit = 'a'.repeat(40);
export function temporalFixture(side: 'LONG' | 'SHORT' = 'LONG'): MicroBurstStrategyContext {
  const ctx = makeMicroBurstContext();
  const support = makeLevel('support', side === 'LONG' ? 99.7 : 98);
  const resistance = makeLevel('resistance', side === 'LONG' ? 102 : 100.3);
  ctx.levels = {
    ...ctx.levels,
    levels: [support, resistance],
    nearest: { ...ctx.levels.nearest, support, resistance },
  };
  ctx.momentum.direction = side;
  ctx.candles.candles1m = [
    {
      timestamp: now - 60_000,
      openTime: now - 60_000,
      closeTime: now,
      open: side === 'LONG' ? 99.8 : 100.2,
      high: side === 'LONG' ? 100.05 : 100.35,
      low: side === 'LONG' ? 99.65 : 99.95,
      close: 100,
      volume: 100,
      buyVolume: 50,
    },
  ];
  ctx.aggTradeFlow = {
    buyTakerVolume: side === 'LONG' ? 60 : 40,
    sellTakerVolume: side === 'LONG' ? 40 : 60,
    netTakerFlow: side === 'LONG' ? 20 : -20,
    tradeCount: 20,
    requestedWindowMs: 5000,
    observedWindowMs: 5000,
    observedSampleCount: 20,
    eventWatermarkMs: now,
    capacityTruncated: false,
    coverageStartedAtMs: now - 5000,
    windowComplete: true,
    gapFree: true,
  };
  const executionBook: OrderBookSnapshot = {
    observedAtMs: now,
    status: 'HEALTHY',
    bidDepth: [{ price: 99.99, qty: 100 }],
    askDepth: [{ price: 100.01, qty: 100 }],
  };
  return { ...ctx, executionBook, observedAtMs: now, exchangeObservedAtMs: now };
}
const run = (ctx: MicroBurstStrategyContext) =>
  evaluate(ctx, config, ctx.executionBook, ctx.observedAtMs!, ctx.exchangeObservedAtMs!);
afterEach(() => vi.restoreAllMocks());

describe('Micro temporal diagnostic regressions', () => {
  it.each(['LONG', 'SHORT'] as const)(
    'B1 %s considers a valid nearby alternative after a late primary',
    (side) => {
      const ctx = temporalFixture(side);
      const late = makeLevel(
        side === 'LONG' ? 'support' : 'resistance',
        side === 'LONG' ? 99.9 : 100.1,
      );
      late.availableAtMs = now;
      ctx.levels.levels.push(late);
      ctx.levels.nearest[late.type] = late;
      expect(run(ctx).action).toBe('ENTRY_INTENT');
      ctx.levels.levels.forEach((level) => {
        if (level.type === late.type) level.availableAtMs = now;
      });
      expect(run(ctx).action).toBe('NO_TRADE');
    },
  );
  it.each(['LONG', 'SHORT'] as const)(
    'B2 %s reorients a crossed target without skipping the closest obstacle',
    (side) => {
      const ctx = temporalFixture(side);
      const type = side === 'LONG' ? 'resistance' : 'support';
      const crossed = makeLevel(type, 100);
      ctx.levels.nearest[type] = crossed;
      ctx.levels.levels.push(crossed);
      expect(run(ctx).action).toBe('ENTRY_INTENT');
      const obstacle = makeLevel(type, side === 'LONG' ? 100.2 : 99.8);
      ctx.levels.levels.push(obstacle);
      expect(run(ctx).action).toBe('NO_TRADE');
      expect(run(ctx).diagnostics.sides).toMatchObject({ [side]: { reason: 'INSUFFICIENT_ROOM' } });
      obstacle.availableAtMs = now;
      expect(run(ctx).diagnostics.sides).toMatchObject({
        [side]: { detail: 'CLOSEST_TARGET_UNAVAILABLE_BEFORE_TRIGGER' },
      });
    },
  );
  it.each(['LONG', 'SHORT'] as const)(
    '%s evaluates only valid nearby defenses and records only visited checks',
    (side) => {
      const ctx = temporalFixture(side);
      const type = side === 'LONG' ? 'support' : 'resistance';
      const wrong = makeLevel(type, side === 'LONG' ? 100.1 : 99.9);
      const far = makeLevel(type, side === 'LONG' ? 90 : 110);
      ctx.levels.levels.push(wrong, far);
      ctx.levels.nearest[type] = wrong;
      const result = run(ctx);
      expect(result.action).toBe('ENTRY_INTENT');
      const attempts = (result.diagnostics.sides as any)[side].candidatesVisited;
      expect(attempts[0]).toMatchObject({ detail: 'WRONG_SIDE_OR_EQUAL' });
      expect(attempts[0].stagesVisited).not.toContain('TRIGGER');
      ctx.levels.levels = [
        wrong,
        far,
        ctx.levels.nearest[side === 'LONG' ? 'resistance' : 'support']!,
      ];
      expect(run(ctx).action).toBe('NO_TRADE');
      expect((run(ctx).diagnostics.sides as any)[side].detail).toBe('TOO_FAR');
    },
  );
  it('B3 uses measured elapsed monotonic time after an awaited observer without renewing old inputs', async () => {
    const ctx = temporalFixture();
    let mono = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => mono);
    const router = new StrategyRouter<MicroBurstStrategyContext>({
      beforeEvaluation: async () => {
        mono += 90_000;
        return null;
      },
      afterEvaluation: async () => {},
    });
    router.register(
      new MicroBurstStrategy(createMicroBurstIdentity(commit, 'b'.repeat(64)), 'SHADOW'),
    );
    expect(run(ctx).action).toBe('ENTRY_INTENT');
    const result = await router.evaluate('MICRO_BURST', ctx);
    expect(result.decision).toBe('NO_TRADE');
    expect(ctx.timestamp).toBe(now);
    expect(ctx.executionBook!.observedAtMs).toBe(now);
  });
  it('B4 retains full historical cluster state, not a backdated strengthened cluster', () => {
    const start = now - 600_000;
    const candles = [100, 102, 100, 100, 102.1, 100].map((high, i) => ({
      timestamp: start + i * 60_000,
      openTime: start + i * 60_000,
      closeTime: start + (i + 1) * 60_000 - 1,
      open: 99,
      high,
      low: 98,
      close: 99,
      volume: i < 3 ? 1 : 100,
      buyVolume: 0,
    }));
    const opts = { pivotLeftBars: 1, pivotRightBars: 1, lookbackBars: 20 };
    const early = detectSupportResistance(candles.slice(0, 3), opts);
    const later = detectSupportResistance(candles, opts);
    expect(later.history![0]).toEqual(early.history![0]);
    expect(later.levels[0].price).toBeGreaterThan(early.levels[0].price);
    expect(later.levels[0].availableAtMs).toBeGreaterThan(early.levels[0].availableAtMs);
    expect(Object.isFrozen(later.history![0].levels[0])).toBe(true);
    expect(later.history![0].levels[0].volumeAtLevel).toBe(1);
  });
  it.each(['duplicate', 'reverse', 'gap'])(
    'rejects %s closed candle sequences explicitly',
    (kind) => {
      const a = temporalFixture().candles.candles1m[0];
      const b = { ...a, openTime: a.openTime + 60_001, closeTime: a.closeTime + 60_001 };
      const candles =
        kind === 'duplicate'
          ? [a, a]
          : kind === 'reverse'
            ? [b, a]
            : [a, { ...b, openTime: b.openTime + 60_000, closeTime: b.closeTime + 60_000 }];
      const result = detectSupportResistance(candles);
      expect(result.levels).toEqual([]);
      expect(result.invalidReasons?.length).toBeGreaterThan(0);
    },
  );
  it('replays complete serialized inputs deterministically and rejects legacy or incomplete evidence', () => {
    const ctx = temporalFixture();
    const captured = captureMicroBurstReplay(ctx, config, commit);
    const wire = encodeMicroReplay(captured);
    expect(replayMicroBurstExact(wire, commit)).toEqual(run(ctx));
    ctx.executionBook!.askDepth[0].price = 200;
    expect(replayMicroBurstExact(wire, commit)).toEqual(replayMicroBurstExact(wire, commit));
    expect(replayMicroBurstExact(wire, commit).action).toBe('ENTRY_INTENT');
    expect(() => replayMicroBurstExact({ schemaVersion: 2, diagnostics: {} }, commit)).toThrow(
      'MICRO_REPLAY_INCOMPLETE',
    );
    const incomplete = structuredClone(wire) as any;
    delete incomplete.context.candles.candles3m;
    expect(() => replayMicroBurstExact(incomplete, commit)).toThrow(
      'MICRO_REPLAY_INCOMPLETE:candles',
    );
    expect(() => replayMicroBurstExact(wire, 'b'.repeat(40))).toThrow(
      'MICRO_REPLAY_CODE_REVISION_MISMATCH',
    );
  });
  it('evaluates without awaiting REST capture or a blocked writer and freezes original evidence', async () => {
    const ctx = temporalFixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const records: any[] = [];
    const snapshots: any[] = [];
    const getSeries = vi.fn(async () => {
      throw new Error('Unexpected observational REST');
    });
    const observer = createMicroBurstBlackBoxObservation({
      clock: { now: () => now },
      candles: { getSeries } as any,
      orderBookFor: vi.fn(),
      aggTradeFor: vi.fn(),
      marketSnapshotSink: {
        append: async (snapshot) => {
          snapshots.push(snapshot);
          await blocked;
          return { snapshotId: snapshot.snapshotId, stored: true, contentHash: 'synthetic' };
        },
      },
      decisionSink: {
        append: async (record) => {
          records.push(record);
        },
      },
    });
    const router = new StrategyRouter<MicroBurstStrategyContext>(observer);
    router.register(
      new MicroBurstStrategy(createMicroBurstIdentity(commit, 'b'.repeat(64)), 'SHADOW'),
    );
    const result = await router.evaluate('MICRO_BURST', ctx);
    expect(result.decision).toBe('ENTRY_INTENT');
    expect(getSeries).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
    ctx.executionBook!.askDepth[0].price = 999;
    release();
    await router.closeObservation();
    expect(records).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      provenance: { derivation: { kind: 'POST_EVALUATION_FROM_EXACT_INPUTS' } },
      primary: {
        quote: { sourceTimestampMs: now, sourceTimestampDomain: 'LOCAL_CAPTURE' },
        aggTrade: { sourceTimestampMs: now, sourceTimestampDomain: 'EVENT_TIME' },
      },
    });
    expect(snapshots[0].primary.quote.value.spreadBps).toBeCloseTo(2);
    const replay = records[0].diagnostics.strategyInputReplay;
    expect(replay.context.executionBook.askDepth[0].price).toBe(100.01);
    expect(replayMicroBurstExact(replay, commit).action).toBe('ENTRY_INTENT');
  });
  it('a full observational queue never bypasses a required minimal durable acknowledgement', async () => {
    const ctx = temporalFixture();
    const acknowledge = vi.fn(async () => {
      throw new Error('required sink unavailable');
    });
    const enqueue = vi.fn();
    const observer = createMicroBurstBlackBoxObservation({
      clock: { now: () => now },
      candles: {} as any,
      orderBookFor: vi.fn(),
      aggTradeFor: vi.fn(),
      marketSnapshotSink: {
        append: async (snapshot) => ({
          snapshotId: snapshot.snapshotId,
          stored: true,
          contentHash: 'synthetic',
        }),
      },
      decisionSink: { append: async () => {} },
    });
    // A sealed queue produces the same observational drop as capacity overflow.
    await observer.close?.();
    const router = new StrategyRouter<MicroBurstStrategyContext>({
      ...observer,
      requiredAudit: { acknowledge },
      enqueueExactDecision(snapshot, decision) {
        enqueue();
        observer.enqueueExactDecision!(snapshot, decision);
      },
    });
    router.register(
      new MicroBurstStrategy(createMicroBurstIdentity(commit, 'b'.repeat(64)), 'SHADOW'),
    );
    const result = await router.evaluate('MICRO_BURST', ctx);
    expect(result).toMatchObject({
      decision: 'NO_TRADE',
      reason: 'REQUIRED_DECISION_AUDIT_FAILED',
    });
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(observer.observationHealth!().dropped).toBe(1);
  });
});
