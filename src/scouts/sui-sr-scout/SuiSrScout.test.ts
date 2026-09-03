import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadSuiSrScoutConfig, validateConfig } from './config/SuiSrScoutConfig';
import {
  SCOUT_UNIVERSE,
  TRADEABLE_SYMBOL,
  CONTEXT_SYMBOL,
  FEATURE_SCHEMA_VERSION,
  DECISIONS,
  EXECUTION_MODES,
} from './domain/ScoutTypes';
import type {
  SuiSrScoutConfig,
  ScoutDecision,
  LevelCandidateEvent,
  FeatureVector,
  SrZone,
} from './domain/ScoutTypes';
import { createThreeMinuteCandleBuilder } from './market/ThreeMinuteCandleBuilder';
import { createLevelDetector } from './domain/LevelDetector';
import { createFeatureVectorBuilder } from './domain/FeatureVector';
import { createBreakRiskPolicy } from './domain/BreakRiskPolicy';
import { createDecisionPolicy } from './domain/DecisionPolicy';
import { createRiskPolicy } from './domain/RiskPolicy';
import { createRuleBaselineModel, RULE_BASELINE_ARTIFACT_ID } from './ml/RuleBaselineModel';
import { createLiveCanaryExecutor, type OrderPort } from './application/LiveCanaryExecutor';
import { createAsyncEvidenceJournal } from './application/AsyncEvidenceJournal';
import type { Logger } from '../../app/ports/Logger';
import type { BuiltCandle } from './market/ThreeMinuteCandleBuilder';
import type { RawAggTradeEvent, RawDepthEvent } from './market/ScoutMarketDataRuntime';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeDefaultConfig(overrides: Partial<SuiSrScoutConfig> = {}): SuiSrScoutConfig {
  return {
    enabled: true,
    executionMode: 'OBSERVE',
    liveEnabled: false,
    symbol: 'SUIUSDT',
    contextSymbol: 'BTCUSDT',
    maxOpenPositions: 1,
    maxQuoteNotional: 100,
    maxLeverage: 10,
    maxRiskPerTradeBps: 200,
    maxDailyLossBps: 500,
    cooldownAfterStopMs: 300000,
    minNetRMultiple: 1.5,
    tickIntervalMs: 100,
    feedStaleThresholdMs: 5000,
    feedGapThresholdMs: 2000,
    candleIntervals: ['1m', '3m'],
    srZoneAtrTolerance: 0.15,
    srMinTouchCount: 2,
    srZoneScoreMin: 0.4,
    breakConfirmationCandles: 2,
    btcAggressiveThreshold: 0.65,
    killSwitch: true,
    ...overrides,
  };
}

function makeCandle(overrides: Partial<BuiltCandle> = {}): BuiltCandle {
  return {
    openTime: Date.now(),
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1000,
    buyVolume: 500,
    closeTime: Date.now() + 60000,
    interval: '3m',
    isClosed: true,
    candleCount: 1,
    ...overrides,
  };
}

function makeZone(overrides: Partial<SrZone> = {}): SrZone {
  return {
    id: 'sr_test_1',
    side: 'RESISTANCE',
    high: 102,
    low: 101.5,
    score: 0.6,
    touchCount: 3,
    firstTouchMs: Date.now() - 3600000,
    lastTouchMs: Date.now() - 60000,
    lastCloseMs: Date.now() - 60000,
    avgRejectionMagnitude: 0.5,
    totalVolume: 5000,
    broken: false,
    brokenAtMs: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<LevelCandidateEvent> = {}): LevelCandidateEvent {
  const zone = makeZone();
  return {
    timestamp: Date.now(),
    symbol: 'SUIUSDT',
    zone,
    eventType: 'TOUCH',
    priceAtEvent: 101.8,
    atr: 0.5,
    ...overrides,
  };
}

function makeFeatureVector(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
    schemaVersion: FEATURE_SCHEMA_VERSION,
    symbol: 'SUIUSDT',
    timestamp: Date.now(),
    level: {
      side: 'SHORT',
      zoneHigh: 102,
      zoneLow: 101.5,
      zoneWidthTicks: 500,
      zoneScore: 0.6,
      touchCount: 3,
      ageMs: 3600000,
      timeSinceLastTouchMs: 60000,
      distanceTicks: 200,
      distanceAtr: 0.4,
      bodyWickRatio: 0.5,
      closeLocation: 0.5,
      compressionBefore: 0,
      reclaimBeyond: false,
      roomToTargetTicks: 500,
      roomToOpposingTicks: 500,
    },
    price: {
      return1m: 0,
      return3m: 0,
      return5m: 0,
      realizedVol: 0.01,
      atr14_3m: 0.5,
      rangePercentile: 0.5,
      emaSlope: 0,
      emaDistance: 0,
      rsi14: 50,
      volumeRelativeMedian: 1,
      volumeAcceleration: 0,
      candleSequence: 0,
      higherHighLowerLow: 0,
      momentumAcceleration: 0,
    },
    flow: {
      takerBuyRatio5s: 0.5,
      takerBuyRatio30s: 0.5,
      takerBuyRatio1m: 0.5,
      takerBuyRatio3m: 0.5,
      signedNotional1m: 0,
      tradeIntensity1m: 10,
      consecutiveAggressiveFlow: 0,
    },
    book: {
      spreadBps: 1,
      topBookImbalance: 0.5,
      multiLevelImbalance: 0.5,
      imbalanceChange: 0,
      bestBidDepletion: 0,
      bestAskDepletion: 0,
      visibleAbsorptionAtZone: 0,
    },
    futures: {
      fundingRate: 0.0001,
      fundingTimestamp: Date.now(),
      openInterestChange3m: 0,
      openInterestTimestamp: Date.now(),
      basisPct: 0,
      basisTimestamp: Date.now(),
    },
    btcContext: {
      return1m: 0,
      return3m: 0,
      realizedVol: 0.01,
      takerImbalance: 0.5,
      rangeExpansion: 1,
      directionRelative: 0,
      aggressiveAgainstTrade: false,
      timestamp: Date.now(),
    },
    unavailableFeatures: [],
    ...overrides,
  };
}

describe('SUI SR Scout — Universe and configuration', () => {
  it('universe is exactly BTCUSDT and SUIUSDT', () => {
    expect(SCOUT_UNIVERSE).toEqual(['BTCUSDT', 'SUIUSDT']);
    expect(SCOUT_UNIVERSE).toHaveLength(2);
  });

  it('only SUIUSDT is tradeable', () => {
    expect(TRADEABLE_SYMBOL).toBe('SUIUSDT');
    expect(CONTEXT_SYMBOL).toBe('BTCUSDT');
  });

  it('all five decisions are defined', () => {
    expect(DECISIONS).toEqual([
      'ALLOW_REJECTION_LONG',
      'ALLOW_REJECTION_SHORT',
      'WAIT_BREAKOUT_PULLBACK',
      'BLOCK_BREAKOUT_RISK',
      'NO_TRADE',
    ]);
  });

  it('both execution modes are defined', () => {
    expect(EXECUTION_MODES).toEqual(['OBSERVE', 'LIVE_CANARY']);
  });
});

describe('SUI SR Scout — Config validation', () => {
  beforeEach(() => {
    delete process.env.SUI_SR_SCOUT_ENABLED;
    delete process.env.SUI_SR_SCOUT_EXECUTION_MODE;
    delete process.env.SUI_SR_SCOUT_LIVE_ENABLED;
    delete process.env.SUI_SR_SCOUT_SYMBOL;
    delete process.env.SUI_SR_SCOUT_CONTEXT_SYMBOL;
    delete process.env.SUI_SR_SCOUT_MAX_QUOTE_NOTIONAL;
    delete process.env.SUI_SR_SCOUT_MAX_LEVERAGE;
    delete process.env.SUI_SR_SCOUT_MAX_RISK_PER_TRADE_BPS;
    delete process.env.SUI_SR_SCOUT_MAX_DAILY_LOSS_BPS;
    delete process.env.SUI_SR_SCOUT_COOLDOWN_AFTER_STOP_MS;
    delete process.env.SUI_SR_SCOUT_KILL_SWITCH;
  });

  it('loads safe defaults for OBSERVE mode', () => {
    const cfg = loadSuiSrScoutConfig();
    expect(cfg.executionMode).toBe('OBSERVE');
    expect(cfg.killSwitch).toBe(true);
    expect(cfg.liveEnabled).toBe(false);
    expect(cfg.symbol).toBe('SUIUSDT');
    expect(cfg.contextSymbol).toBe('BTCUSDT');
  });

  it('rejects LIVE_CANARY without live enabled', () => {
    process.env.SUI_SR_SCOUT_EXECUTION_MODE = 'LIVE_CANARY';
    process.env.SUI_SR_SCOUT_LIVE_ENABLED = 'false';
    expect(() => loadSuiSrScoutConfig()).toThrow('SUI_SR_SCOUT_LIVE_ENABLED must be true');
  });

  it('rejects LIVE_CANARY with wrong symbol', () => {
    process.env.SUI_SR_SCOUT_EXECUTION_MODE = 'LIVE_CANARY';
    process.env.SUI_SR_SCOUT_LIVE_ENABLED = '1';
    process.env.SUI_SR_SCOUT_SYMBOL = 'BTCUSDT';
    expect(() => loadSuiSrScoutConfig()).toThrow('must be SUIUSDT');
  });

  it('rejects LIVE_CANARY without required limits', () => {
    process.env.SUI_SR_SCOUT_EXECUTION_MODE = 'LIVE_CANARY';
    process.env.SUI_SR_SCOUT_LIVE_ENABLED = '1';
    expect(() => loadSuiSrScoutConfig()).toThrow('positive number');
  });

  it('validateConfig catches invalid symbol', () => {
    const cfg = makeDefaultConfig({ symbol: 'BTCUSDT' as any });
    const errors = validateConfig(cfg);
    expect(errors).toContain('symbol must be SUIUSDT');
  });

  it('validateConfig catches invalid contextSymbol', () => {
    const cfg = makeDefaultConfig({ contextSymbol: 'SUIUSDT' as any });
    const errors = validateConfig(cfg);
    expect(errors).toContain('contextSymbol must be BTCUSDT');
  });
});

describe('SUI SR Scout — No existing strategies start', () => {
  it('coordinator does not import TradingService', async () => {
    const mod = await import('./application/ScoutCoordinator');
    const src = mod.createScoutCoordinator.toString();
    expect(src).not.toContain('TradingService');
    expect(src).not.toContain('Aegis');
    expect(src).not.toContain('Momentum');
    expect(src).not.toContain('MicroBurst');
  });
});

describe('SUI SR Scout — Candle builder', () => {
  it('builds 3m candles from 1m events', () => {
    const builder = createThreeMinuteCandleBuilder();
    const baseTime = Math.floor(Date.now() / 180000) * 180000;
    for (let i = 0; i < 3; i++) {
      const event = {
        symbol: 'SUIUSDT',
        interval: '1m',
        openTime: baseTime + i * 60000,
        open: 100 + i * 0.1,
        high: 101 + i * 0.1,
        low: 99 + i * 0.1,
        close: 100.5 + i * 0.1,
        volume: 1000,
        closeTime: baseTime + (i + 1) * 60000 - 1,
        isClosed: true,
        exchangeTime: baseTime + i * 60000,
        receivedAtMs: Date.now(),
      };
      const result = builder.onCandle(event);
      if (i === 2) {
        expect(result).not.toBeNull();
        expect(result!.interval).toBe('3m');
      }
    }
  });

  it('ignores non-SUI symbols', () => {
    const builder = createThreeMinuteCandleBuilder();
    const event = {
      symbol: 'BTCUSDT',
      interval: '1m',
      openTime: Date.now(),
      open: 50000,
      high: 50100,
      low: 49900,
      close: 50050,
      volume: 500,
      closeTime: Date.now() + 60000,
      isClosed: true,
      exchangeTime: Date.now(),
      receivedAtMs: Date.now(),
    };
    const result = builder.onCandle(event);
    expect(result).toBeNull();
  });
});

describe('SUI SR Scout — Level detector', () => {
  it('detects pivot highs and lows', () => {
    const detector = createLevelDetector({
      srZoneAtrTolerance: 0.15,
      srMinTouchCount: 2,
      srZoneScoreMin: 0.4,
      breakConfirmationCandles: 2,
    });

    const candles: BuiltCandle[] = [
      makeCandle({ openTime: 0, high: 100, low: 98, close: 99 }),
      makeCandle({ openTime: 60000, high: 102, low: 100, close: 101 }),
      makeCandle({ openTime: 120000, high: 101, low: 97, close: 98 }),
      makeCandle({ openTime: 180000, high: 103, low: 101, close: 102 }),
    ];

    const { highs, lows } = detector.detectPivots(candles);
    expect(highs).toContain(102);
    expect(lows).toContain(97);
  });

  it('clusters nearby pivots into zones', () => {
    const detector = createLevelDetector({
      srZoneAtrTolerance: 0.15,
      srMinTouchCount: 2,
      srZoneScoreMin: 0.4,
      breakConfirmationCandles: 2,
    });

    const pivots = {
      highs: [100.1, 100.2, 100.15],
      lows: [98.1, 98.2],
    };

    const zones = detector.clusterZones(pivots, 0.5, 0.01);
    expect(zones.length).toBeGreaterThanOrEqual(1);
    expect(zones.some((z) => z.side === 'RESISTANCE')).toBe(true);
    expect(zones.some((z) => z.side === 'SUPPORT')).toBe(true);
  });
});

describe('SUI SR Scout — Break risk policy', () => {
  it('blocks when breakout is accepted', () => {
    const policy = createBreakRiskPolicy();
    const zone = makeZone({ side: 'RESISTANCE', high: 102, low: 101.5 });
    const event = makeEvent({ zone });
    const fv = makeFeatureVector();

    const candles: BuiltCandle[] = [
      makeCandle({ close: 103, high: 103.5, volume: 2000 }),
      makeCandle({ close: 104, high: 104.5, volume: 3000 }),
    ];

    const result = policy.evaluate(event, fv, candles, 2);
    expect(result.decision).toBe('BLOCK_BREAKOUT_RISK');
    expect(result.reasons.some((r) => r.includes('breakout_accepted'))).toBe(true);
  });
});

describe('SUI SR Scout — Decision policy', () => {
  it('rejects when BTC is aggressive against trade', () => {
    const policy = createDecisionPolicy({
      minNetRMultiple: 1.5,
      btcAggressiveThreshold: 0.65,
    });
    const zone = makeZone({ side: 'RESISTANCE' });
    const event = makeEvent({ zone });
    const fv = makeFeatureVector({
      btcContext: {
        ...makeFeatureVector().btcContext,
        aggressiveAgainstTrade: true,
      },
    });

    const result = policy.evaluate(event, fv, [], [], [], [], []);
    expect(result.decision).toBe('BLOCK_BREAKOUT_RISK');
    expect(result.reasons).toContain('btc_aggressive_against_trade');
  });

  it('returns NO_TRADE when a critical feature is missing rather than substituting zero', () => {
    const policy = createDecisionPolicy({ minNetRMultiple: 1.5, btcAggressiveThreshold: 0.65 });
    const result = policy.evaluate(
      makeEvent(),
      makeFeatureVector({
        unavailableFeatures: [
          { feature: 'funding_missing', reason: 'MISSING', observedAtMs: null },
        ],
      }),
      [],
      [],
      [],
      [],
      [],
    );
    expect(result.decision).toBe('NO_TRADE');
    expect(result.reasons).toContain('critical_feature_funding_missing_missing');
  });
});

describe('SUI SR Scout — Risk policy', () => {
  it('blocks when kill switch is active', () => {
    const policy = createRiskPolicy();
    const cfg = makeDefaultConfig({ killSwitch: true });
    const event = makeEvent();
    const fv = makeFeatureVector();

    const result = policy.checkAllGates(event, fv, cfg, {
      feedHealthy: true,
      openPositionCount: 0,
      consecutiveLosses: 0,
      dailyLossBps: 0,
      lastStopTimeMs: 0,
      nowMs: Date.now(),
    });

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('kill_switch_active');
  });

  it('blocks when in OBSERVE mode', () => {
    const policy = createRiskPolicy();
    const cfg = makeDefaultConfig({ executionMode: 'OBSERVE', killSwitch: false });
    const event = makeEvent();
    const fv = makeFeatureVector();

    const result = policy.checkAllGates(event, fv, cfg, {
      feedHealthy: true,
      openPositionCount: 0,
      consecutiveLosses: 0,
      dailyLossBps: 0,
      lastStopTimeMs: 0,
      nowMs: Date.now(),
    });

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('observe_mode');
  });

  it('blocks when feed is unhealthy', () => {
    const policy = createRiskPolicy();
    const cfg = makeDefaultConfig({
      executionMode: 'LIVE_CANARY',
      liveEnabled: true,
      killSwitch: false,
    });
    const event = makeEvent();
    const fv = makeFeatureVector();

    const result = policy.checkAllGates(event, fv, cfg, {
      feedHealthy: false,
      openPositionCount: 0,
      consecutiveLosses: 0,
      dailyLossBps: 0,
      lastStopTimeMs: 0,
      nowMs: Date.now(),
    });

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('feed_unhealthy');
  });

  it('blocks when max positions reached', () => {
    const policy = createRiskPolicy();
    const cfg = makeDefaultConfig({
      executionMode: 'LIVE_CANARY',
      liveEnabled: true,
      killSwitch: false,
    });
    const event = makeEvent();
    const fv = makeFeatureVector();

    const result = policy.checkAllGates(event, fv, cfg, {
      feedHealthy: true,
      openPositionCount: 1,
      consecutiveLosses: 0,
      dailyLossBps: 0,
      lastStopTimeMs: 0,
      nowMs: Date.now(),
    });

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('max_open_positions_reached');
  });
});

describe('SUI SR Scout — Rule baseline model', () => {
  it('returns valid prediction', () => {
    const model = createRuleBaselineModel();
    const fv = makeFeatureVector();

    const prediction = model.predict(fv);
    expect(prediction.probability).toBeGreaterThanOrEqual(0);
    expect(prediction.probability).toBeLessThanOrEqual(1);
    expect(prediction.artifactId).toBe(RULE_BASELINE_ARTIFACT_ID);
    expect(prediction.featureSchemaVersion).toBe(FEATURE_SCHEMA_VERSION);
  });

  it('penalizes when BTC is aggressive against trade', () => {
    const model = createRuleBaselineModel();
    const fv = makeFeatureVector({
      btcContext: {
        ...makeFeatureVector().btcContext,
        aggressiveAgainstTrade: true,
      },
    });

    const prediction = model.predict(fv);
    expect(prediction.probability).toBeLessThan(0.5);
  });
});

describe('SUI SR Scout — Live canary executor', () => {
  it('OBSERVE mode never calls order port', async () => {
    const mockPort: OrderPort = {
      marketOpen: vi.fn(),
      placeStopClose: vi.fn(),
      cancelOrderById: vi.fn(),
      closeSideMarketSafe: vi.fn(),
      hasOpenPosition: vi.fn(),
      getUSDTBalance: vi.fn(),
      setLeverage: vi.fn(),
      ensureMarginType: vi.fn(),
      getSymbolFilters: vi.fn(),
    };

    const executor = createLiveCanaryExecutor(noopLogger, mockPort);
    const cfg = makeDefaultConfig({ executionMode: 'OBSERVE' });
    const event = makeEvent();
    const fv = makeFeatureVector();

    const result = await executor.execute('ALLOW_REJECTION_LONG', event, fv, cfg);
    expect(result).toBeNull();
    expect(mockPort.marketOpen).not.toHaveBeenCalled();
  });

  it('LIVE_CANARY fails closed with null order port', async () => {
    const executor = createLiveCanaryExecutor(noopLogger, null);
    const cfg = makeDefaultConfig({
      executionMode: 'LIVE_CANARY',
      liveEnabled: true,
      killSwitch: false,
    });
    const event = makeEvent();
    const fv = makeFeatureVector();

    const result = await executor.execute('ALLOW_REJECTION_LONG', event, fv, cfg);
    expect(result).toBeNull();
  });

  it('LIVE_CANARY rejects when kill switch active', async () => {
    const mockPort: OrderPort = {
      marketOpen: vi.fn(),
      placeStopClose: vi.fn(),
      cancelOrderById: vi.fn(),
      closeSideMarketSafe: vi.fn(),
      hasOpenPosition: vi.fn(),
      getUSDTBalance: vi.fn(),
      setLeverage: vi.fn(),
      ensureMarginType: vi.fn(),
      getSymbolFilters: vi.fn(),
    };

    const executor = createLiveCanaryExecutor(noopLogger, mockPort);
    const cfg = makeDefaultConfig({
      executionMode: 'LIVE_CANARY',
      liveEnabled: true,
      killSwitch: true,
    });
    const event = makeEvent();
    const fv = makeFeatureVector();

    const result = await executor.execute('ALLOW_REJECTION_LONG', event, fv, cfg);
    expect(result).toBeNull();
    expect(mockPort.marketOpen).not.toHaveBeenCalled();
  });
});

describe('SUI SR Scout — Evidence journal', () => {
  it('appends entries and tracks count', async () => {
    const journal = createAsyncEvidenceJournal(noopLogger, '/tmp/scout-test-journal');
    const entry = {
      timestamp: Date.now(),
      decisionId: 'test_1',
      symbol: 'SUIUSDT' as const,
      event: makeEvent(),
      featureVector: makeFeatureVector(),
      baselineDecision: 'NO_TRADE' as ScoutDecision,
      modelDecision: null,
      modelScore: null,
      modelArtifactId: null,
      finalDecision: 'NO_TRADE' as ScoutDecision,
      blockReasons: ['test'],
      intendedStop: null,
      intendedTarget: null,
      intendedRR: null,
      orderResult: null,
      mfe: null,
      mae: null,
      netResult: null,
      provenance: {
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        modelArtifactId: null,
        modelVersion: null,
        configHash: '',
        evaluatedAtMs: Date.now(),
      },
    };

    journal.append(entry);
    expect(journal.getEntryCount()).toBe(1);

    journal.append({ ...entry, decisionId: 'test_2' });
    expect(journal.getEntryCount()).toBe(2);

    await journal.close();
  });
});

describe('SUI SR Scout — Feature schema version', () => {
  it('feature schema version is 1', () => {
    expect(FEATURE_SCHEMA_VERSION).toBe(1);
  });

  it('model artifact uses same schema version', () => {
    const model = createRuleBaselineModel();
    expect(model.featureSchemaVersion).toBe(FEATURE_SCHEMA_VERSION);
  });
});
