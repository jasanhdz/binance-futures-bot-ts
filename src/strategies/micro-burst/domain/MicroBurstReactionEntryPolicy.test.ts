import { describe, expect, it } from 'vitest';
import { evaluateMicroBurstReactionEntry } from './MicroBurstReactionEntryPolicy';
import { evaluateMicroBurstEntry } from './MicroBurstEntryPolicy';
import { evaluateMicroBurstContextualProposal } from './MicroBurstContextualProposal';
import { MicroBurstDuplicateSignalGuard } from './MicroBurstDuplicateSignalGuard';
import { MicroBurstStrategy, MicroBurstStrategyContext } from './MicroBurstStrategy';
import { createMicroBurstIdentity } from './MicroBurstIdentity';
import { StrategyRouter } from '../../../core/strategy/StrategyRouter';
import {
  makeMicroBurstContext,
  makeLevel,
  TEST_SNAPSHOT_AT_MS as now,
} from './MicroBurst.test-support';
import { defaultMicroBurstConfig, OrderBookSnapshot } from './MicroBurstTypes';

const config = defaultMicroBurstConfig();
function fixture(side: 'LONG' | 'SHORT' = 'LONG') {
  const ctx = makeMicroBurstContext();
  const mirror = (p: number) => (side === 'LONG' ? p : 200 - p);
  ctx.momentum.direction = side;
  ctx.levels.nearest.structuralPosition = side === 'LONG' ? 'near_support' : 'near_resistance';
  ctx.levels.nearest.support = makeLevel('support', side === 'LONG' ? 99.7 : 98);
  ctx.levels.nearest.resistance = makeLevel('resistance', side === 'LONG' ? 102 : 100.3);
  ctx.candles.candles1m = [
    {
      timestamp: now,
      openTime: now - 60_000,
      closeTime: now,
      open: mirror(99.8),
      high: side === 'LONG' ? 100.05 : 100.35,
      low: side === 'LONG' ? 99.65 : 99.95,
      close: 100,
      volume: 100,
      buyVolume: 50,
    },
  ];
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
  const book: OrderBookSnapshot = {
    observedAtMs: now,
    status: 'HEALTHY',
    bidDepth: [{ price: 99.99, qty: 100 }],
    askDepth: [{ price: 100.01, qty: 100 }],
  };
  return { ctx, book };
}
describe('Micro reaction entry policy', () => {
  it('composes a reaction with explicit risk and episode deduplication without execution authority', () => {
    const { ctx, book } = fixture();
    const proposal = evaluateMicroBurstContextualProposal({
      context: ctx,
      book,
      observedAtMs: now,
      config,
      risk: {
        marginBudget: 100,
        lossBudget: 2,
        approvedLeverageCap: 20,
        liquidationPrice: 95,
        stopStressBps: 10,
        residualCostBps: 14,
        stepSize: 0.001,
        qtyPrecision: 3,
        minNotional: 5,
      },
    });
    expect(proposal).toMatchObject({
      authority: 'OBSERVATION_ONLY',
      eligibleForResearchFill: true,
      entry: { leverage: 20 },
      sizing: { valid: true },
    });
    expect(proposal.sizing!.maxLoss).toBeLessThanOrEqual(2);
    const guard = new MicroBurstDuplicateSignalGuard({ now: () => now });
    const episode = String(proposal.entry.diagnostics.episodeId);
    const first = guard.check('MICRO_BURST', ctx.symbol, 'LONG', 0.12341, now, episode);
    const second = guard.check('MICRO_BURST', ctx.symbol, 'LONG', 0.12349, now + 60_000, episode);
    expect(second.duplicateSuppressed).toBe(true);
    expect(second.shadowSignalId).toBe(first.shadowSignalId);
    expect(
      guard.check('MICRO_BURST', ctx.symbol, 'SHORT', 0.12341, now, episode).duplicateSuppressed,
    ).toBe(false);
  });
  it.each(['LONG', 'SHORT'] as const)(
    'current Micro %s uses reaction clarity, not historical continuation/bias',
    (side) => {
      const { ctx, book } = fixture(side);
      ctx.structuralClarity = false;
      ctx.momentum.continuationScore = 0;
      const candidate = { ...config, contextualPolicyVersion: 'MICRO' as const };
      expect(evaluateMicroBurstReactionEntry(ctx, config, book, now).action).toBe('ENTRY_INTENT');
      expect(evaluateMicroBurstReactionEntry(ctx, candidate, book, now)).toMatchObject({
        action: 'ENTRY_INTENT',
        side,
      });
      ctx.bookPressure.anomalyFlag = true;
      expect(evaluateMicroBurstReactionEntry(ctx, candidate, book, now).reason).toBe(
        'BOOK_NOT_HEALTHY',
      );
    },
  );
  it('cannot enter LIVE without complete approved identity', () => {
    const { ctx, book } = fixture();
    const strategy = new MicroBurstStrategy(createMicroBurstIdentity('a'.repeat(40)), 'LIVE');
    expect(
      strategy.evaluate({
        ...ctx,
        entryPolicy: 'MICRO',
        executionBook: book,
        observedAtMs: now,
        config: { contextualPolicyVersion: 'MICRO' },
      }).reason,
    ).toBe('MICRO_CONTEXTUAL_LIVE_IDENTITY_REQUIRED');
  });
  it('separates sub-cent levels within the same visit without minute/cent rounding', () => {
    const { ctx, book } = fixture();
    const candidate = { ...config, contextualPolicyVersion: 'MICRO' as const };
    const first = evaluateMicroBurstReactionEntry(ctx, candidate, book, now);
    ctx.levels.nearest.support!.price += 0.0001;
    const second = evaluateMicroBurstReactionEntry(ctx, candidate, book, now);
    expect(first.action).toBe('ENTRY_INTENT');
    expect(second.action).toBe('ENTRY_INTENT');
    expect(first.diagnostics.episodeId).not.toBe(second.diagnostics.episodeId);
  });
  it.each(['LONG', 'SHORT'] as const)(
    'routes exactly the selected LIVE %s geometry',
    async (side) => {
      const { ctx, book } = fixture(side);
      const router = new StrategyRouter<MicroBurstStrategyContext>();
      router.register(
        new MicroBurstStrategy(createMicroBurstIdentity('a'.repeat(40), 'b'.repeat(64)), 'LIVE'),
      );
      const expected = evaluateMicroBurstReactionEntry(
        ctx,
        { ...config, contextualPolicyVersion: 'MICRO' },
        book,
        now,
      );
      const selected = await router.evaluate('MICRO_BURST', {
        ...ctx,
        entryPolicy: 'MICRO',
        executionBook: book,
        observedAtMs: now,
      });
      expect(selected).toMatchObject({
        mode: 'LIVE',
        decision: 'ENTRY_INTENT',
        side,
        structuralInvalidation: expected.stopInvalidationPrice,
        destinationPrice: expected.targetPrice,
        diagnostics: {
          policy: 'MICRO',
          leverage: 30,
          positionFraction: expected.positionFraction,
        },
      });
      ctx.candles.candles1m[0][side === 'LONG' ? 'low' : 'high'] = side === 'LONG' ? 99.8 : 100.2;
      ctx.levels.nearest.structuralPosition = side === 'LONG' ? 'near_support' : 'near_resistance';
      expect(
        (await router.evaluate('MICRO_BURST', { ...ctx, entryPolicy: 'MICRO' })).decision,
      ).toBe('NO_TRADE');
      expect(
        (
          await router.evaluate('MICRO_BURST', {
            ...ctx,
            entryPolicy: 'MICRO',
            executionBook: book,
            observedAtMs: now,
          })
        ).decision,
      ).toBe('NO_TRADE');
    },
  );
  it.each(['LONG', 'SHORT'] as const)(
    'qualifies mirrored %s reclaim without support priority',
    (side) => {
      const { ctx, book } = fixture(side);
      const result = evaluateMicroBurstReactionEntry(ctx, config, book, now);
      expect(result).toMatchObject({
        action: 'ENTRY_INTENT',
        side,
        diagnostics: {
          setup: 'RECLAIM_REVERSAL',
          independentVisits: 1,
          quantityCoverage: 'TOP_OF_BOOK_ONLY',
        },
      });
      expect(Object.keys(result.diagnostics.sides as object)).toEqual(['LONG', 'SHORT']);
    },
  );
  it('does not count adjacent touching candles as independent visits', () => {
    const { ctx, book } = fixture();
    const candle = ctx.candles.candles1m[0];
    ctx.candles.candles1m.unshift({
      ...candle,
      openTime: candle.openTime - 60_000,
      closeTime: candle.closeTime - 60_000,
    });
    expect(
      evaluateMicroBurstReactionEntry(ctx, config, book, now).diagnostics.independentVisits,
    ).toBe(1);
  });
  it('rejects proximity without a fresh reclaim or trend retest', () => {
    const { ctx, book } = fixture();
    ctx.candles.candles1m[0].low = 99.8;
    expect(evaluateMicroBurstEntry(ctx, config).action).toBe('ENTRY_INTENT');
    expect(evaluateMicroBurstReactionEntry(ctx, config, book, now).action).toBe('NO_TRADE');
  });
  it('labels a held trend retest separately from a reclaim', () => {
    const { ctx, book } = fixture();
    ctx.microRegime = 'TRENDING_UP';
    const candle = ctx.candles.candles1m[0];
    candle.low = 99.75;
    ctx.candles.candles1m.unshift({ ...candle, openTime: now - 120_000, closeTime: now - 60_000 });
    expect(evaluateMicroBurstReactionEntry(ctx, config, book, now).diagnostics.setup).toBe(
      'TREND_RETEST_CONTINUATION',
    );
  });
  it('rejects gross opportunities that fail net RR after friction', () => {
    const { ctx, book } = fixture();
    ctx.levels.nearest.resistance = makeLevel('resistance', 100.8);
    expect(evaluateMicroBurstEntry(ctx, config).action).toBe('ENTRY_INTENT');
    const result = evaluateMicroBurstReactionEntry(ctx, config, book, now);
    expect(result.action).toBe('NO_TRADE');
    expect(result.diagnostics.sides).toMatchObject({
      LONG: { reason: 'REACTION_NET_ROOM_INSUFFICIENT' },
    });
  });
  it('evaluates SHORT when both boundaries are near rather than favoring support', () => {
    const { ctx, book } = fixture('SHORT');
    expect(evaluateMicroBurstEntry(ctx, { ...config, nearLevelThresholdBps: 250 }).action).toBe(
      'ENTRY_INTENT',
    );
    expect(
      evaluateMicroBurstReactionEntry(ctx, { ...config, nearLevelThresholdBps: 250 }, book, now)
        .side,
    ).toBe('SHORT');
  });
  it('requires an earlier confirmed breakout for a role-reversed continuation', () => {
    const { ctx, book } = fixture();
    ctx.microRegime = 'TRENDING_UP';
    ctx.levels.nearest.support = makeLevel('support', 99);
    const broken = makeLevel('resistance', 99.7);
    ctx.levels.levels = [broken];
    const candle = ctx.candles.candles1m[0];
    ctx.candles.candles1m.unshift({
      ...candle,
      openTime: now - 180_000,
      closeTime: now - 120_000,
      open: 99.6,
      low: 99.5,
      close: 100,
    });
    expect(evaluateMicroBurstReactionEntry(ctx, config, book, now).diagnostics.setup).toBe(
      'BREAKOUT_RETEST_CONTINUATION',
    );
    broken.availableAtMs = now - 60_000;
    expect(evaluateMicroBurstReactionEntry(ctx, config, book, now).action).toBe('NO_TRADE');
  });
  it('rejects weakening rejection on a new independent visit', () => {
    const { ctx, book } = fixture();
    const candle = ctx.candles.candles1m[0];
    ctx.candles.candles1m.unshift(
      { ...candle, openTime: now - 180_000, closeTime: now - 120_000, close: 100.2, high: 100.3 },
      {
        ...candle,
        openTime: now - 120_000,
        closeTime: now - 60_000,
        open: 100.1,
        low: 100,
        close: 100.1,
        high: 100.2,
      },
    );
    expect(evaluateMicroBurstReactionEntry(ctx, config, book, now).diagnostics.sides).toMatchObject(
      { LONG: { reason: 'REACTION_DEFENSE_DEGRADING' } },
    );
  });
  it('preserves target and stop anti-lookahead', () => {
    for (const type of ['support', 'resistance'] as const) {
      const { ctx, book } = fixture();
      ctx.levels.nearest[type]!.availableAtMs = now;
      expect(evaluateMicroBurstReactionEntry(ctx, config, book, now).action).toBe('NO_TRADE');
    }
  });
  it('ignores future candles and keeps episode identity deterministic', () => {
    const { ctx, book } = fixture();
    const before = evaluateMicroBurstReactionEntry(ctx, config, book, now);
    ctx.candles.candles1m.push({ ...ctx.candles.candles1m[0], closeTime: now + 60_000, close: 50 });
    expect(evaluateMicroBurstReactionEntry(ctx, config, book, now)).toEqual(before);
  });
  it('requires complete signed flow, fresh book and snapshot', () => {
    const { ctx, book } = fixture();
    expect(evaluateMicroBurstReactionEntry(ctx, config, undefined, now).reason).toBe(
      'REACTION_BOOK_NOT_FRESH',
    );
    expect(
      evaluateMicroBurstReactionEntry(ctx, config, book, now + config.bookFreshnessMaxMs + 1)
        .reason,
    ).toBe('REACTION_SNAPSHOT_EXPIRED');
    ctx.aggTradeFlow!.gapFree = false;
    expect(evaluateMicroBurstReactionEntry(ctx, config, book, now).reason).toBe(
      'REACTION_FLOW_UNAVAILABLE',
    );
  });
});
