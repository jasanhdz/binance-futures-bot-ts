import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../app/ports/Logger';
import type {
  FeatureVector,
  LevelCandidateEvent,
  SuiSrScoutConfig,
  SrZone,
} from '../domain/ScoutTypes';
import {
  createLiveCanaryExecutor,
  type CanaryExecutionContext,
  type OrderPort,
} from './LiveCanaryExecutor';

const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function config(overrides: Partial<SuiSrScoutConfig> = {}): SuiSrScoutConfig {
  return {
    enabled: true,
    executionMode: 'LIVE_CANARY',
    liveEnabled: true,
    killSwitch: false,
    symbol: 'SUIUSDT',
    contextSymbol: 'BTCUSDT',
    maxOpenPositions: 1,
    maxQuoteNotional: 1_000,
    maxLeverage: 2,
    maxRiskPerTradeBps: 100,
    maxDailyLossBps: 500,
    cooldownAfterStopMs: 0,
    minNetRMultiple: 1.5,
    tickIntervalMs: 100,
    feedStaleThresholdMs: 5_000,
    feedGapThresholdMs: 2_000,
    candleIntervals: ['1m', '3m'],
    srZoneAtrTolerance: 0.15,
    srMinTouchCount: 2,
    srZoneScoreMin: 0.4,
    breakConfirmationCandles: 2,
    btcAggressiveThreshold: 0.65,
    canaryMarginFraction: 0.5,
    structuralStopBufferBps: 10,
    feeSlippageBps: 10,
    canaryTimeStopMs: 900_000,
    ...overrides,
  };
}

function zone(overrides: Partial<SrZone> = {}): SrZone {
  return {
    id: 'support',
    side: 'SUPPORT',
    high: 99,
    low: 98,
    score: 1,
    touchCount: 3,
    firstTouchMs: 1,
    lastTouchMs: 2,
    lastCloseMs: 3,
    avgRejectionMagnitude: 1,
    totalVolume: 1,
    broken: false,
    brokenAtMs: null,
    ...overrides,
  };
}

function event(overrides: Partial<LevelCandidateEvent> = {}): LevelCandidateEvent {
  return {
    timestamp: 1,
    symbol: 'SUIUSDT',
    zone: zone(),
    eventType: 'TOUCH',
    priceAtEvent: 100,
    atr: 1,
    ...overrides,
  };
}

function features(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
    schemaVersion: 1,
    symbol: 'SUIUSDT',
    timestamp: 1,
    level: {} as FeatureVector['level'],
    price: {} as FeatureVector['price'],
    flow: {} as FeatureVector['flow'],
    book: {} as FeatureVector['book'],
    futures: {} as FeatureVector['futures'],
    btcContext: { aggressiveAgainstTrade: false } as FeatureVector['btcContext'],
    unavailableFeatures: [],
    ...overrides,
  };
}

function context(decisionId = 'decision-1'): CanaryExecutionContext {
  return { decisionId, feedHealthy: true, targetPrice: 104.5 };
}

function port(overrides: Partial<OrderPort> = {}): OrderPort {
  return {
    marketOpen: vi.fn().mockResolvedValue({ avgPrice: 100, orderId: 'entry-1' }),
    placeStopClose: vi.fn().mockResolvedValue(true),
    placeTpClose: vi.fn().mockResolvedValue(true),
    cancelOrderById: vi.fn(),
    cancelCloseOrdersForSide: vi.fn(),
    closeSideMarketSafe: vi.fn(),
    hasOpenPosition: vi.fn().mockResolvedValue(false),
    getUSDTBalance: vi.fn().mockResolvedValue(1_000),
    setLeverage: vi.fn(),
    ensureMarginType: vi.fn(),
    getSymbolFilters: vi
      .fn()
      .mockResolvedValue({
        tickSize: 0.1,
        stepSize: 0.1,
        minNotional: 10,
        pricePrecision: 1,
        qtyPrecision: 1,
      }),
    ...overrides,
  };
}

describe('LiveCanaryExecutor', () => {
  it('denies BTC regardless of otherwise-valid live input', async () => {
    const exchange = port();
    const executor = createLiveCanaryExecutor(logger, exchange);
    await expect(
      executor.execute(
        'ALLOW_REJECTION_LONG',
        event({ symbol: 'BTCUSDT' }),
        features({ symbol: 'BTCUSDT' }),
        config({ symbol: 'BTCUSDT' as 'SUIUSDT' }),
        context(),
      ),
    ).resolves.toBeNull();
    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(executor.getStatus()).toBe('BLOCKED');
  });

  it('does not access the port in observe mode', async () => {
    const exchange = port();
    const executor = createLiveCanaryExecutor(logger, exchange);
    await executor.execute(
      'ALLOW_REJECTION_LONG',
      event(),
      features(),
      config({ executionMode: 'OBSERVE' }),
      context(),
    );
    expect(exchange.hasOpenPosition).not.toHaveBeenCalled();
    expect(exchange.marketOpen).not.toHaveBeenCalled();
  });

  it('fails closed for unhealthy preflight input', async () => {
    const exchange = port();
    const executor = createLiveCanaryExecutor(logger, exchange);
    await executor.execute('ALLOW_REJECTION_LONG', event(), features(), config(), {
      ...context(),
      feedHealthy: false,
    });
    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(executor.getStatus()).toBe('BLOCKED');
  });

  it('uses structural prices, rounds quantity, and requires a net 1.5R target', async () => {
    const exchange = port();
    const executor = createLiveCanaryExecutor(logger, exchange);
    const result = await executor.execute(
      'ALLOW_REJECTION_LONG',
      event(),
      features(),
      config(),
      context(),
    );
    expect(result?.quantity).toBe(4.7); // $10 max risk / $2.1 structural stop distance, stepped down.
    expect(exchange.placeStopClose).toHaveBeenCalledWith('SUIUSDT', 'LONG', 97.9, 4.7);
    expect(exchange.placeTpClose).toHaveBeenCalledWith('SUIUSDT', 'LONG', 104.5, 4.7);
    expect(executor.getStatus()).toBe('POSITION_OPEN');
  });

  it('transitions through an entry and confirms stop before take profit', async () => {
    const exchange = port();
    const executor = createLiveCanaryExecutor(logger, exchange);
    await expect(
      executor.execute('ALLOW_REJECTION_LONG', event(), features(), config(), context()),
    ).resolves.toMatchObject({ stopConfirmed: true });
    expect(
      (exchange.placeStopClose as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    ).toBeLessThan((exchange.placeTpClose as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
    expect(executor.getStatus()).toBe('POSITION_OPEN');
  });

  it('emergency-closes and blocks when stop confirmation fails', async () => {
    const exchange = port({ placeStopClose: vi.fn().mockResolvedValue(false) });
    const executor = createLiveCanaryExecutor(logger, exchange);
    await expect(
      executor.execute('ALLOW_REJECTION_LONG', event(), features(), config(), context()),
    ).resolves.toBeNull();
    expect(exchange.closeSideMarketSafe).toHaveBeenCalledWith(
      'SUIUSDT',
      'LONG',
      4.7,
      'BOTH',
      'stop_not_confirmed',
    );
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
    expect(executor.getStatus()).toBe('BLOCKED');
  });

  it('blocks duplicate decision ids before a second entry', async () => {
    const exchange = port();
    const executor = createLiveCanaryExecutor(logger, exchange);
    await executor.execute('ALLOW_REJECTION_LONG', event(), features(), config(), context());
    await executor.execute('ALLOW_REJECTION_LONG', event(), features(), config(), context());
    expect(exchange.marketOpen).toHaveBeenCalledTimes(1);
    expect(executor.getStatus()).toBe('BLOCKED');
  });
});
