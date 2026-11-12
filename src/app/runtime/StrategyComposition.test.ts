import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Candle, Side } from '../../core/types';
import type { Logger } from '../ports/Logger';
import type { MarketDataPort } from '../ports/MarketData';
import { StrategyRouter } from '../../core/strategy/StrategyRouter';
import {
  PositionManagerRouter,
  type StrategyPositionManager,
} from '../../core/strategy/PositionManagerRouter';
import type { PositionManagementResult } from '../../core/strategy/StrategyDecision';
import { createUnfrozenStrategyIdentity } from '../../core/strategy/StrategyIdentity';
import { LocalCausalSequence } from '../../core/market-data/LocalCausalWatermark';
import { SharedEntryReservation } from '../../core/risk/SharedEntryReservation';
import { SharedMarketDataRuntime } from '../services/SharedMarketDataRuntime';
import { ShadowTradingEngine } from '../../core/shadow/ShadowTradingEngine';
import type {
  ShadowManagementObservation,
  ShadowPosition,
  ShadowStrategyPolicy,
} from '../../core/shadow/ShadowTradingTypes';
import {
  MicroBurstStrategy,
  type MicroBurstStrategyContext,
} from '../../strategies/micro-burst/domain/MicroBurstStrategy';
import { buildMicroBurstContext } from '../../strategies/micro-burst/domain/MicroBurstContextBuilder';
import { defaultMicroBurstConfig } from '../../strategies/micro-burst/domain/MicroBurstTypes';
import {
  DeterministicProbeStrategy,
  type DeterministicProbeContext,
} from '../../testing/strategies/DeterministicProbeStrategy';

const BASE = 1_700_000_000_000;

function candles(count: number, intervalMs: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const closeTime = BASE - (count - index - 1) * intervalMs;
    const close = 100 + index * 0.01;
    return {
      timestamp: closeTime - intervalMs + 1,
      openTime: closeTime - intervalMs + 1,
      closeTime,
      open: close - 0.01,
      high: close + 0.05,
      low: close - 0.05,
      close,
      volume: 100 + index,
      buyVolume: 50,
    };
  });
}

class MemoryShadowJournal {
  private positions: ShadowPosition[] = [];

  appendPosition(position: ShadowPosition): void {
    this.positions = [
      ...this.positions.filter((item) => item.tradeId !== position.tradeId),
      position,
    ];
  }

  appendEvent(): void {}
  loadOpenPositions(): ShadowPosition[] {
    return this.positions.filter((position) => position.state !== 'CLOSED');
  }
  loadAllPositions(): ShadowPosition[] {
    return this.positions;
  }
  loadAllEvents(): never[] {
    return [];
  }
  getHealth(): { healthy: boolean; malformedCount: number } {
    return { healthy: true, malformedCount: 0 };
  }
  flush(): void {}
}

describe('shared strategy composition', () => {
  it('runs Micro and a test-only strategy on shared market state, then paper-manages only the probe owner', async () => {
    let depthConsumer: ((event: any) => void) | undefined;
    let tradeConsumer: ((event: any) => void) | undefined;
    let candleConsumer: ((update: any) => void) | undefined;
    const subscribeCounts = { depth: 0, aggTrade: 0, candle: 0 };
    const causalSequence = new LocalCausalSequence('composition-process', () => BASE);
    const exchange = {
      getServerTime: async () => BASE,
      getCandles: async (_symbol: string, interval: string, limit: number) =>
        (interval === '1m'
          ? candles(40, 60_000)
          : interval === '3m'
            ? candles(25, 180_000)
            : candles(20, 300_000)
        ).slice(-limit),
      getLastCandle: async () => null,
      getDepthSnapshot: async () => ({
        lastUpdateId: 100,
        bids: [['99.99', '100']] as [string, string][],
        asks: [['100.01', '100']] as [string, string][],
        receivedAtMs: BASE,
      }),
      subscribeToDepthDiff: vi.fn(
        (_symbol: string, _speed: '100ms' | '250ms' | '500ms', onDiff: (event: any) => void) => {
          subscribeCounts.depth++;
          depthConsumer = onDiff;
          return () => {};
        },
      ),
      subscribeToAggTrades: vi.fn((_symbol: string, onTrade: (event: any) => void) => {
        subscribeCounts.aggTrade++;
        tradeConsumer = onTrade;
        return () => {};
      }),
      subscribeToKlineCandles: vi.fn(
        (_symbol: string, _interval: string, onCandle: (update: any) => void) => {
          subscribeCounts.candle++;
          candleConsumer = onCandle;
          return () => {};
        },
      ),
    } as unknown as MarketDataPort;
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const shared = new SharedMarketDataRuntime({ exchange, logger, clock: { now: () => BASE } });
    const microBookLease = shared.orderBookDataPlane.acquire('ETHUSDT');
    const probeBookLease = shared.orderBookDataPlane.acquire('ETHUSDT');
    const microFlowLease = shared.aggTradeDataPlane.acquire('ETHUSDT');
    const probeFlowLease = shared.aggTradeDataPlane.acquire('ETHUSDT');
    const microCandleLease = shared.candleDataPlane.acquire('ETHUSDT', '5m');
    const probeCandleLease = shared.candleDataPlane.acquire('ETHUSDT', '5m');
    await shared.candleDataPlane.ensureWarm('ETHUSDT', '5m', 1);

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      depthConsumer?.({
        U: 100,
        u: 101,
        pu: 99,
        bids: [['99.99', '100']],
        asks: [],
        E: BASE,
        T: BASE,
        receivedAtMs: BASE,
        localCausality: causalSequence.receive(1),
      });
      for (const [index, eventTime] of [
        BASE - 300_000,
        BASE - 200_000,
        BASE - 100_000,
        BASE,
      ].entries())
        tradeConsumer?.({
          eventTime,
          receivedAtMs: BASE,
          price: '100',
          quantity: '1',
          isBuyerMaker: false,
          aggregateTradeId: index + 1,
          firstTradeId: index + 1,
          lastTradeId: index + 1,
          localCausality: causalSequence.receive(1),
        });

      await vi.waitFor(() => expect(microBookLease.book.getHealth()).toBe('HEALTHY'));
      const microBook = microBookLease.book.getSnapshot();
      const probeBook = probeBookLease.book.getSnapshot();
      const microFlow = microFlowLease.state.getTakerFlow(300_000);
      const probeFlow = probeFlowLease.state.getTakerFlow(300_000);
      const candleState = shared.candleDataPlane.read('ETHUSDT', '5m', 1);

      expect(microBookLease.book).toBe(probeBookLease.book);
      expect(microFlowLease.state).toBe(probeFlowLease.state);
      expect(subscribeCounts).toEqual({ depth: 1, aggTrade: 1, candle: 1 });
      expect(candleConsumer).toBeDefined();
      expect(microBook?.localCausality).toMatchObject({
        processGenerationId: 'composition-process',
        receivedSequence: 1,
        lastAppliedReceiveSequence: 1,
      });
      expect(probeFlow.localCausality).toMatchObject({
        processGenerationId: 'composition-process',
        receivedSequence: 5,
        lastAppliedReceiveSequence: 5,
      });
      expect(candleState.candles).toHaveLength(1);

      const baseMicroContext = await buildMicroBurstContext(
        'ETHUSDT',
        {
          candles: {
            getCandles: async (_symbol, interval) =>
              candles(
                interval === '1m' ? 40 : interval === '3m' ? 25 : 20,
                interval === '1m' ? 60_000 : interval === '3m' ? 180_000 : 300_000,
              ),
          },
          btc: {
            getBtcContext: () => ({
              ret1m: 0,
              ret3m: 0,
              ret5m: 0,
              acceleration: 0,
              conflictFlag: false,
              direction: 'NEUTRAL',
              observedAtMs: BASE,
              receivedAtMs: BASE,
            }),
          },
          book: { getDepthSnapshot: () => microBook },
          aggTradeFlow: { getTakerFlow: () => microFlow },
        },
        {
          snapshotAtMs: BASE,
          localNowAtMs: BASE,
          timingClock: { localNow: () => BASE, monotonicNow: () => 100 },
        },
      );
      const microContext: MicroBurstStrategyContext = {
        ...baseMicroContext,
        entryPolicy: 'MICRO',
        executionBook: microBook,
        observedAtMs: BASE,
        exchangeObservedAtMs: BASE,
      };
      const microIdentity = createUnfrozenStrategyIdentity(
        'MICRO_BURST',
        'reference',
        'm'.repeat(40),
      );
      const microStrategy = new MicroBurstStrategy(microIdentity, 'SHADOW');
      const microRouter = new StrategyRouter<MicroBurstStrategyContext>();
      microRouter.register(microStrategy);
      const microDecision = await microRouter.evaluate('MICRO_BURST', microContext);
      const directMicroDecision = microStrategy.evaluate(microContext);
      expect(microRouter.contract('MICRO_BURST')).toEqual(microStrategy.contract);
      expect(microRouter.contract('MICRO_BURST')?.inputs).toHaveLength(6);
      expect(microDecision).toMatchObject({
        decision: directMicroDecision.decision,
        reason: directMicroDecision.reason,
        side: directMicroDecision.side,
      });
      if (baseMicroContext.dataQuality.contextValid)
        expect(['INTENT', 'REJECTED']).toContain(microDecision.evaluationStatus);
      else expect(microDecision.evaluationStatus).toBe('NOT_EVALUABLE');

      const probeIdentity = createUnfrozenStrategyIdentity(
        'TEST_PROBE',
        'deterministic-test-only',
        'p'.repeat(40),
      );
      const probeRouter = new StrategyRouter<DeterministicProbeContext>();
      probeRouter.register(new DeterministicProbeStrategy(probeIdentity, 'SHADOW'));
      const probeContext: DeterministicProbeContext = {
        symbol: 'ETHUSDT',
        timestamp: BASE,
        bookHealth: microBook?.status ?? 'UNAVAILABLE',
        flowGapFree: probeFlow.gapFree,
        candleCount: candleState.candles.length,
        localCausalState: {
          depth: probeBook?.localCausality ?? null,
          aggTrade: probeFlow.localCausality ?? null,
        },
        outcome: 'INTENT',
        side: 'LONG',
      };
      const probeDecision = await probeRouter.evaluate('TEST_PROBE', probeContext);
      expect(probeDecision).toMatchObject({ decision: 'ENTRY_INTENT', evaluationStatus: 'INTENT' });
      expect(probeRouter.contract('TEST_PROBE')?.configuration).toMatchObject({
        value: { operationalRegistration: false },
      });
      expect(Object.isFrozen(probeRouter.contract('TEST_PROBE')?.inputs)).toBe(true);
      const probePolicySource = readFileSync(
        resolve('src/testing/strategies/DeterministicProbeStrategy.ts'),
        'utf8',
      );
      expect(probePolicySource).not.toMatch(
        /TradingExchangePort|SharedStrategyExecutionService|marketOpen|closeSideMarketSafe/,
      );

      const liveAdmission = new SharedEntryReservation();
      const microHandoff = liveAdmission.tryAcquire('ETHUSDT');
      expect(microHandoff.acquired).toBe(true);
      expect(liveAdmission.tryAcquire('ETHUSDT')).toEqual({
        acquired: false,
        reason: 'SYMBOL_BUSY',
      });
      if (microHandoff.acquired) microHandoff.release();
      for (const outcome of ['REJECTED', 'WAIT', 'NOT_EVALUABLE'] as const) {
        const result = await probeRouter.evaluate('TEST_PROBE', { ...probeContext, outcome });
        expect(result).toMatchObject({ decision: 'NO_TRADE', evaluationStatus: outcome });
      }
      const unavailableProbe = await probeRouter.evaluate('TEST_PROBE', {
        ...probeContext,
        bookHealth: 'STALE',
        outcome: 'INTENT',
      });
      expect(unavailableProbe).toMatchObject({
        decision: 'NO_TRADE',
        evaluationStatus: 'NOT_EVALUABLE',
      });

      const managerRouter = new PositionManagerRouter<{
        symbol: string;
        tradeId: string;
        closeRequested: boolean;
      }>();
      const probeManager: StrategyPositionManager<{
        symbol: string;
        tradeId: string;
        closeRequested: boolean;
      }> = {
        strategyId: 'TEST_PROBE',
        manage: (identity, context) => {
          if (identity.strategyId !== 'TEST_PROBE')
            throw new Error('TEST_PROBE_OWNERSHIP_MISMATCH');
          return {
            tradeId: context.tradeId,
            decision: context.closeRequested ? 'CLOSE_MARKET' : 'HOLD',
            reason: context.closeRequested
              ? 'DETERMINISTIC_PROBE_EXIT'
              : 'DETERMINISTIC_PROBE_HOLD',
            diagnostics: { owner: identity.strategyId },
          };
        },
      };
      managerRouter.register(probeManager);
      const paperPolicy: ShadowStrategyPolicy = {
        strategyId: 'TEST_PROBE',
        evaluateLifecycle: (_position, observation: ShadowManagementObservation) => {
          const lifecycle = observation.strategyContext as PositionManagementResult;
          return lifecycle.decision === 'CLOSE_MARKET'
            ? { action: 'CLOSE', reason: lifecycle.reason }
            : { action: 'HOLD', reason: lifecycle.reason };
        },
      };
      const journal = new MemoryShadowJournal();
      const shadow = new ShadowTradingEngine(journal, new Map([['TEST_PROBE', paperPolicy]]));
      const openIntent = {
        strategyId: 'TEST_PROBE' as const,
        strategyVersion: probeIdentity.strategyVersion,
        symbol: probeDecision.symbol,
        side: probeDecision.side as Side,
        decisionAtMs: BASE,
        decisionReceivedAtMs: BASE,
        referencePrice: 100,
        structuralStop: 99,
        destination: 102,
        leverage: 1,
        positionFraction: 0.01,
        parentDecisionId: String(probeDecision.diagnostics.decisionId),
        provenance: {
          strategyVersion: probeIdentity.strategyVersion,
          codeCommitSha: probeIdentity.codeCommitSha,
        },
      };
      const opened = shadow.open(openIntent, {
        bestBid: 100,
        bestAsk: 100.1,
        observedAtMs: BASE,
        status: 'HEALTHY',
      });
      expect(opened.status).toBe('OPENED');
      if (opened.status !== 'OPENED') throw new Error('EXPECTED_TEST_PROBE_PAPER_OPEN');
      const recovered = new ShadowTradingEngine(journal, new Map([['TEST_PROBE', paperPolicy]]));
      expect(recovered.getOpenPositions()).toHaveLength(1);
      const closeLifecycle = await managerRouter.route(probeIdentity, {
        symbol: 'ETHUSDT',
        tradeId: opened.position.tradeId,
        closeRequested: true,
      });
      expect(closeLifecycle.status).toBe('ROUTED');
      if (closeLifecycle.status !== 'ROUTED') throw new Error('EXPECTED_TEST_PROBE_OWNER_ROUTE');
      const closed = recovered.manage(
        { strategyId: 'TEST_PROBE', symbol: 'ETHUSDT' },
        {
          exchangeTimeMs: BASE + 1_000,
          receivedAtMs: BASE + 1_000,
          currentPrice: 101,
          quote: { bestBid: 100.9, bestAsk: 101, observedAtMs: BASE + 1_000, status: 'HEALTHY' },
          marketDataQuality: 'HEALTHY',
          strategyContext: closeLifecycle.decision,
        },
      );
      expect(closed).toMatchObject({ state: 'CLOSED', strategyId: 'TEST_PROBE' });
      expect('marketOpen' in exchange).toBe(false);
      const microOwnerRoute = await managerRouter.route(microIdentity, {
        symbol: 'ETHUSDT',
        tradeId: 'micro-owned-trade',
        closeRequested: true,
      });
      expect(microOwnerRoute).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        strategyId: 'MICRO_BURST',
      });
    } finally {
      microCandleLease.release();
      probeCandleLease.release();
      microBookLease.release();
      probeBookLease.release();
      microFlowLease.release();
      probeFlowLease.release();
      shared.close();
    }
  });
});
