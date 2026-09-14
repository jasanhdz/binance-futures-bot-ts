import { describe, expect, it } from 'vitest';
import type { Candle, Side } from '../../core/types';
import {
  makeLevel,
  makeMicroBurstContext,
  TEST_SNAPSHOT_AT_MS as now,
} from '../../strategies/micro-burst/domain/MicroBurst.test-support';
import { defaultMicroBurstConfig } from '../../strategies/micro-burst/domain/MicroBurstTypes';
import type { MicroBurstStrategyContext as MicroBurstContext } from '../../strategies/micro-burst/domain/MicroBurstStrategy';
import {
  captureMicroBurstReplay,
  encodeMicroReplay,
} from '../../strategies/micro-burst/domain/MicroBurstExactReplay';
import { evaluateMicroBurstReactionEntry } from '../../strategies/micro-burst/domain/MicroBurstReactionEntryPolicy';
import { MicroBurstPatternEpisodes, type MicroResearchPattern } from './MicroBurstPatternEpisodes';
import { compileOfflineReaction, MicroBurstPatternEvaluator } from './MicroBurstPatternEvaluator';
import {
  decodeValidatedPatternReplay,
  historicalDecisionAgrees,
} from './MicroBurstPatternComparison';
import type { StrategyDecisionEvidenceV2 } from '../../core/blackbox/StrategyDecisionBlackBox';

const start = now - 180_000;
const config = defaultMicroBurstConfig();
function fixture(side: Side = 'LONG') {
  const mirror = (p: number): number => (side === 'LONG' ? p : 200 - p);
  const ctx: MicroBurstContext = makeMicroBurstContext();
  const defense = makeLevel(side === 'LONG' ? 'support' : 'resistance', mirror(99.7));
  const target = makeLevel(side === 'LONG' ? 'resistance' : 'support', mirror(102));
  ctx.levels.levels = [defense, target];
  ctx.levels.history = [{ asOfMs: start - 60_000, levels: [defense, target] }];
  ctx.levels.nearest.support = side === 'LONG' ? defense : target;
  ctx.levels.nearest.resistance = side === 'LONG' ? target : defense;
  ctx.momentum.direction = side;
  ctx.aggTradeFlow = {
    buyTakerVolume: 60,
    sellTakerVolume: 40,
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
  ctx.executionBook = {
    observedAtMs: now,
    status: 'HEALTHY',
    bidDepth: [{ price: 99.99, qty: 100 }],
    askDepth: [{ price: 100.01, qty: 100 }],
  };
  const candle = (index: number, close: number, low = 99.69, high = 99.85): Candle => ({
    timestamp: start + index * 60_000,
    openTime: start + index * 60_000,
    closeTime: start + (index + 1) * 60_000,
    open: mirror(close),
    close: mirror(close),
    low: mirror(side === 'LONG' ? low : high),
    high: mirror(side === 'LONG' ? high : low),
    volume: 100,
    buyVolume: 50,
  });
  return { ctx, candle };
}
function advance(
  tracker: MicroBurstPatternEpisodes,
  ctx: MicroBurstContext,
  candles: Candle[],
  tolerance = 10,
) {
  ctx.candles.candles1m = candles;
  ctx.timestamp = candles.slice(-1)[0].closeTime;
  return tracker.advance(ctx, tolerance, ctx.timestamp, ctx.timestamp);
}
function episode(
  tracker: MicroBurstPatternEpisodes,
  pattern: MicroResearchPattern = 'MULTI_CANDLE_RECLAIM',
) {
  return tracker.episodes.find((e) => e.pattern === pattern)!;
}

describe.each(['LONG', 'SHORT'] as const)('offline %s episodes', (side) => {
  it('requires penetration, later recovery, and a distinct improving confirmation; emits once', () => {
    const { ctx, candle } = fixture(side);
    const tracker = new MicroBurstPatternEpisodes();
    const candles = [candle(0, 99.72)];
    expect(advance(tracker, ctx, candles)).toEqual([]);
    candles.push(candle(1, 99.74));
    expect(advance(tracker, ctx, candles)).toEqual([]);
    expect(episode(tracker).recoveryAtMs).toBe(candles[1].closeTime);
    candles.push(candle(2, 99.8));
    expect(advance(tracker, ctx, candles).map((e) => e.pattern)).toContain('MULTI_CANDLE_RECLAIM');
    expect(episode(tracker).confirmedAtMs).toBe(now);
    expect(advance(tracker, ctx, candles)).toEqual([]);
  });
  it('zone needs only a touch then a subsequent beyond-zone close', () => {
    const { ctx, candle } = fixture(side);
    const tracker = new MicroBurstPatternEpisodes();
    advance(tracker, ctx, [candle(0, 99.76, 99.75)]);
    expect(episode(tracker)).toBeUndefined();
    const result = advance(tracker, ctx, [candle(1, 99.9, 99.85, 99.95)]);
    expect(result.map((e) => e.pattern)).toEqual(['CONFIRMED_ZONE_DEFENSE']);
  });
  it('allows confirmation at close3, expires there otherwise, and never accepts close4', () => {
    for (const confirms of [true, false]) {
      const { ctx, candle } = fixture(side);
      const tracker = new MicroBurstPatternEpisodes();
      advance(tracker, ctx, [
        candle(0, 99.7),
        candle(1, 99.7),
        candle(2, 99.74),
        candle(3, confirms ? 99.78 : 99.74),
      ]);
      expect(episode(tracker).status).toBe(confirms ? 'CONFIRMED' : 'EXPIRED');
      expect(episode(tracker).events.slice(-1)[0].atMs).toBe(start + 240_000);
      expect(advance(tracker, ctx, [candle(4, 99.82)])).toEqual([]);
    }
  });
  it('adverse edge invalidates first, including initiation and the deadline', () => {
    const { ctx, candle } = fixture(side);
    const tracker = new MicroBurstPatternEpisodes();
    advance(tracker, ctx, [
      candle(0, 99.7),
      candle(1, 99.74),
      candle(2, 99.73),
      candle(3, 99.5, 99.4),
    ]);
    expect(episode(tracker).events.slice(-1)[0].reason).toBe('ADVERSE_EDGE_CLOSE');
    const immediate = new MicroBurstPatternEpisodes();
    advance(immediate, ctx, [candle(0, 99.5, 99.4)]);
    expect(episode(immediate).status).toBe('INVALIDATED');
  });
  it('treats an exact adverse edge as invalid and an exact favorable edge as unconfirmed', () => {
    const { ctx, candle } = fixture(side);
    const tracker = new MicroBurstPatternEpisodes();
    advance(tracker, ctx, [candle(0, 99.7)]);
    const ep = episode(tracker);
    const sign = side === 'LONG' ? 1 : -1;
    const edge = candle(1, 99.8, 99.4, 100);
    edge.close = edge.open = ep.level.price + sign * ep.tolerancePrice;
    advance(tracker, ctx, [edge]);
    expect(episode(tracker, 'CONFIRMED_ZONE_DEFENSE').status).toBe('STARTED');
    const adverse = candle(2, 99.5, 99.4, 100);
    adverse.close = adverse.open = ep.level.price - sign * ep.tolerancePrice;
    advance(tracker, ctx, [adverse]);
    expect(ep.status).toBe('INVALIDATED');
  });
  it('zone permits close3 and expires without it; late backfill cannot restart an expired episode', () => {
    const { ctx, candle } = fixture(side);
    const tracker = new MicroBurstPatternEpisodes();
    advance(tracker, ctx, [
      candle(0, 99.7),
      candle(1, 99.7),
      candle(2, 99.7),
      candle(3, 99.9, 99.85, 99.95),
    ]);
    expect(episode(tracker, 'CONFIRMED_ZONE_DEFENSE').confirmedAtMs).toBe(start + 240_000);
    const missing = new MicroBurstPatternEpisodes();
    advance(missing, ctx, [candle(0, 99.7)]);
    ctx.timestamp = start + 240_000;
    missing.advance(ctx, 10, ctx.timestamp, ctx.timestamp);
    ctx.candles.candles1m = [candle(1, 99.9, 99.85, 99.95), candle(2, 99.7), candle(3, 99.7)];
    missing.advance(ctx, 10, ctx.timestamp, ctx.timestamp);
    expect(missing.episodes).toHaveLength(2);
    expect(missing.episodes.every((e) => e.status === 'EXPIRED')).toBe(true);
  });
  it('missing continuity cannot confirm and absent close3 still expires on deadline', () => {
    const { ctx, candle } = fixture(side);
    const tracker = new MicroBurstPatternEpisodes();
    advance(tracker, ctx, [candle(0, 99.7), candle(1, 99.74), candle(3, 99.8)]);
    expect(episode(tracker).events.slice(-1)[0].reason).toBe('MISSING_CANDLE_CONTINUITY');
    const missing = new MicroBurstPatternEpisodes();
    advance(missing, ctx, [candle(0, 99.7)]);
    ctx.timestamp = start + 240_000;
    expect(missing.advance(ctx, 10, ctx.timestamp, ctx.timestamp)).toEqual([]);
    expect(episode(missing).expiredAtMs).toBe(ctx.timestamp);
  });
  it('freezes exact temporal level version and tolerance despite later versions', () => {
    const { ctx, candle } = fixture(side);
    const tracker = new MicroBurstPatternEpisodes();
    advance(tracker, ctx, [candle(0, 99.7)]);
    const first = episode(tracker);
    const frozen = structuredClone(first.level);
    const tolerance = first.tolerancePrice;
    ctx.levels.history = [
      ...ctx.levels.history!,
      { asOfMs: start + 60_000, levels: [{ ...ctx.levels.levels[0], price: 105 }] },
    ];
    advance(tracker, ctx, [candle(1, 99.74), candle(2, 99.78)], 100);
    expect(first.level).toEqual(frozen);
    expect(first.tolerancePrice).toBe(tolerance);
    expect(first.levelVersionAsOfMs).toBe(start - 60_000);
    expect(first.status).toBe('CONFIRMED');
  });
  it('rejects revisions and nonmonotonic evaluation clocks', () => {
    const { ctx, candle } = fixture(side);
    const tracker = new MicroBurstPatternEpisodes();
    advance(tracker, ctx, [candle(0, 99.7)]);
    expect(() => advance(tracker, ctx, [candle(0, 99.71)])).toThrow('CLOSED_CANDLE_REVISION');
    ctx.timestamp--;
    expect(() => tracker.advance(ctx, 10, ctx.timestamp, ctx.timestamp)).toThrow(
      'NONMONOTONIC_CLOCK',
    );
  });
  it('rejects lookahead and missing temporal history; open candles cannot initiate', () => {
    const { ctx, candle } = fixture(side);
    const tracker = new MicroBurstPatternEpisodes();
    ctx.levels.history = [{ asOfMs: start + 1, levels: ctx.levels.levels }];
    advance(tracker, ctx, [candle(0, 99.7)]);
    expect(tracker.episodes).toEqual([]);
    ctx.levels.history = [
      {
        asOfMs: start - 1,
        levels: ctx.levels.levels.map((l) => ({ ...l, availableAtMs: start + 1 })),
      },
    ];
    expect(advance(new MicroBurstPatternEpisodes(), ctx, [candle(0, 99.7)])).toEqual([]);
    ctx.levels.history = undefined;
    expect(() => advance(new MicroBurstPatternEpisodes(), ctx, [candle(0, 99.7)])).toThrow(
      'TEMPORAL_LEVEL_HISTORY_REQUIRED',
    );
    const fresh = fixture(side).ctx;
    fresh.timestamp = start + 30_000;
    fresh.candles.candles1m = [candle(0, 99.7)];
    const open = new MicroBurstPatternEpisodes();
    open.advance(fresh, 10, fresh.timestamp, fresh.timestamp);
    expect(open.episodes).toEqual([]);
  });
  it('does not renew inside the zone; restart needs a post-terminal outside close then later touch', () => {
    const { ctx, candle } = fixture(side);
    const tracker = new MicroBurstPatternEpisodes();
    advance(tracker, ctx, [candle(0, 99.7), candle(1, 99.74), candle(2, 99.9, 99.69, 99.95)]);
    const firstId = episode(tracker).id;
    advance(tracker, ctx, [candle(3, 99.7), candle(4, 99.7)]);
    expect(tracker.episodes.filter((e) => e.pattern === 'MULTI_CANDLE_RECLAIM')).toHaveLength(1);
    advance(tracker, ctx, [candle(5, 99.9, 99.85, 99.95)]);
    advance(tracker, ctx, [candle(6, 99.7)]);
    const multi = tracker.episodes.filter((e) => e.pattern === 'MULTI_CANDLE_RECLAIM');
    expect(multi).toHaveLength(2);
    expect(multi[1].id).not.toBe(firstId);
    expect(multi[1].startedAtMs).toBe(start + 360_000);
  });
});

describe('offline downstream integration', () => {
  const evaluator = new MicroBurstPatternEvaluator();
  function confirmed(side: Side = 'LONG', pattern: MicroResearchPattern = 'MULTI_CANDLE_RECLAIM') {
    const { ctx, candle } = fixture(side);
    const tracker = new MicroBurstPatternEpisodes();
    advance(
      tracker,
      ctx,
      [
        candle(0, 99.72),
        candle(1, 99.74),
        candle(2, pattern === 'MULTI_CANDLE_RECLAIM' ? 99.8 : 99.9, 99.69, 99.95),
      ],
      config.srClusterToleranceBps,
    );
    return { ctx, ep: episode(tracker, pattern) };
  }
  it.each([
    ['LONG', 'MULTI_CANDLE_RECLAIM'],
    ['SHORT', 'MULTI_CANDLE_RECLAIM'],
    ['LONG', 'CONFIRMED_ZONE_DEFENSE'],
    ['SHORT', 'CONFIRMED_ZONE_DEFENSE'],
  ] as const)(
    'uses actual post-confirmation executable %s %s quote and CURRENT alignment',
    (side, pattern) => {
      const { ctx, ep } = confirmed(side, pattern);
      const decision = evaluator.evaluateConfirmation(ep, ctx, config, ctx.executionBook, now, now);
      expect(evaluateMicroBurstReactionEntry(ctx, config, ctx.executionBook, now, now).action).toBe(
        'NO_TRADE',
      );
      expect(decision.action).toBe('ENTRY_INTENT');
      expect(decision.diagnostics.executablePrice).toBe(side === 'LONG' ? 100.01 : 99.99);
      expect(decision.diagnostics.executablePrice).not.toBe(
        ctx.candles.candles1m.slice(-1)[0].close,
      );
      ctx.momentum.direction = side === 'LONG' ? 'SHORT' : 'LONG';
      expect(
        evaluator.evaluateConfirmation(ep, ctx, config, ctx.executionBook, now, now).diagnostics
          .sides,
      ).toMatchObject({ [side]: { reason: 'REACTION_DIRECTION_NOT_CONFIRMED' } });
      ctx.momentum.direction = side;
      ctx.aggTradeFlow!.netTakerFlow *= -1;
      expect(
        evaluator.evaluateConfirmation(ep, ctx, config, ctx.executionBook, now, now).action,
      ).toBe('NO_TRADE');
    },
  );
  it.each([
    [
      'book freshness',
      (ctx: MicroBurstContext) => {
        ctx.executionBook!.observedAtMs -= 100_000;
      },
    ],
    [
      'BTC freshness',
      (ctx: MicroBurstContext) => {
        ctx.btcContext!.observedAtMs -= 100_000;
      },
    ],
    [
      'BTC conflict',
      (ctx: MicroBurstContext) => {
        ctx.btcContext!.direction = 'SHORT';
        ctx.btcContext!.ret3m = -0.01;
      },
    ],
    [
      'flow continuity',
      (ctx: MicroBurstContext) => {
        ctx.aggTradeFlow!.gapFree = false;
      },
    ],
    [
      'context quality',
      (ctx: MicroBurstContext) => {
        ctx.dataQuality.contextValid = false;
      },
    ],
    [
      'executable geometry',
      (ctx: MicroBurstContext) => {
        ctx.executionBook!.askDepth[0].price = 103;
        ctx.executionBook!.bidDepth[0].price = 102.99;
      },
    ],
    [
      'risk/reward',
      (ctx: MicroBurstContext) => {
        ctx.levels.levels[1].price = 100.1;
      },
    ],
    [
      'confirmation strength',
      (ctx: MicroBurstContext) => {
        ctx.momentum.strength = 0;
      },
    ],
  ] as const)('preserves %s block', (_name, change) => {
    const { ctx, ep } = confirmed();
    change(ctx);
    expect(
      evaluator.evaluateConfirmation(ep, ctx, config, ctx.executionBook, now, now).action,
    ).toBe('NO_TRADE');
  });
  it('preserves residual costs and rejects historical/future confirmation reuse', () => {
    const { ctx, ep } = confirmed();
    expect(
      evaluator.evaluateConfirmation(
        ep,
        ctx,
        { ...config, exitEstimatedRoundTripCostBps: 1000 },
        ctx.executionBook,
        now,
        now,
      ).action,
    ).toBe('NO_TRADE');
    expect(() =>
      evaluator.evaluateConfirmation(ep, ctx, config, ctx.executionBook, now, now - 1),
    ).toThrow('CAUSAL_CONFIRMATION');
    ep.confirmedAtMs! -= 60_000;
    expect(() =>
      evaluator.evaluateConfirmation(ep, ctx, config, ctx.executionBook, now, now),
    ).toThrow('CAUSAL_CONFIRMATION');
  });
  it('preserves snapshot and closed-candle freshness at post-confirmation evaluation', () => {
    const { ctx, ep } = confirmed();
    ctx.btcContext!.observedAtMs = now + 100_000;
    expect(
      evaluator.evaluateConfirmation(ep, ctx, config, ctx.executionBook, now, now + 100_000).reason,
    ).toBe('REACTION_SNAPSHOT_EXPIRED');
    ctx.timestamp = now + 2000;
    ctx.btcContext!.observedAtMs = ctx.timestamp;
    ctx.aggTradeFlow!.eventWatermarkMs = ctx.timestamp;
    expect(
      evaluator.evaluateConfirmation(
        ep,
        ctx,
        { ...config, candleFreshness1mMaxMs: 1 },
        ctx.executionBook,
        now,
        ctx.timestamp,
      ).reason,
    ).toBe('REACTION_CANDLE_UNAVAILABLE');
  });
  it('uninstrumented compiler exactly matches CURRENT and source drift fails closed', () => {
    const { ctx, ep } = confirmed();
    expect(
      compileOfflineReaction(evaluator.source)(ctx, config, ctx.executionBook, now, now),
    ).toEqual(evaluateMicroBurstReactionEntry(ctx, config, ctx.executionBook, now, now, 'CURRENT'));
    expect(() =>
      compileOfflineReaction(evaluator.source.replace('const candidates =', 'const renamed ='), ep),
    ).toThrow('SOURCE_DRIFT');
  });
  it('requires exact replay revision, finite explicit clocks and valid number tags', () => {
    const { ctx } = confirmed();
    const commit = 'a'.repeat(40);
    const wire = encodeMicroReplay(
      captureMicroBurstReplay(
        { ...ctx, observedAtMs: now, exchangeObservedAtMs: now },
        config,
        commit,
      ),
    ) as Record<string, any>;
    expect(decodeValidatedPatternReplay(wire, commit).current).toBeDefined();
    expect(() =>
      decodeValidatedPatternReplay({ ...wire, evaluatorRevision: 'old' }, commit),
    ).toThrow('REVISION_MISMATCH');
    const missing = structuredClone(wire);
    delete missing.context.exchangeObservedAtMs;
    expect(() => decodeValidatedPatternReplay(missing, commit)).toThrow();
    const tagged = structuredClone(wire);
    tagged.context.timestamp = { microNumber: '123' };
    expect(() => decodeValidatedPatternReplay(tagged, commit)).toThrow('INVALID_NUMBER_TAG');
  });
  it('normalizes only BlackBox JSON nonfinite confidence while retaining real mismatches', () => {
    const { ctx } = confirmed();
    ctx.dataQuality.contextValid = false;
    ctx.momentum.strength = NaN;
    const decision = evaluateMicroBurstReactionEntry(ctx, config, ctx.executionBook, now, now);
    const record = JSON.parse(
      JSON.stringify({
        decision: decision.action,
        reason: decision.reason,
        confidence: decision.confirmationStrength,
        diagnostics: decision.diagnostics,
      }),
    ) as StrategyDecisionEvidenceV2;
    expect(historicalDecisionAgrees(record, decision)).toBe(true);
    expect(historicalDecisionAgrees({ ...record, reason: 'OTHER' }, decision)).toBe(false);
    expect(historicalDecisionAgrees({ ...record, confidence: 0 }, decision)).toBe(false);
    expect(historicalDecisionAgrees({ ...record, diagnostics: {} }, decision)).toBe(false);
  });
});
