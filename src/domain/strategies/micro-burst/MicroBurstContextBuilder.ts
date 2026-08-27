import { Candle, Side } from '../../types';
import {
  BtcContext,
  BookDataStatus,
  DataQualityDiagnostics,
  MicroBurstConfig,
  MicroBurstContext,
  MicroBurstCandleSet,
  MicroRegime,
  defaultMicroBurstConfig,
} from './MicroBurstTypes';
import { detectSupportResistance } from './MicroBurstSupportResistance';
import { analyzeMicroMomentum } from './MicroBurstMomentumAnalyzer';
import { analyzeBookPressure, isBookHealthy } from './MicroBurstBookPressureAnalyzer';
import { classifyMicroRegime } from './MicroBurstMicroRegime';

export interface CandleSnapshotProvider {
  getCandles(symbol: string, interval: string, limit: number): Promise<Candle[]>;
}

export interface BtcMicroContextProvider {
  getBtcContext(): BtcContext | undefined;
}

export interface OrderBookSnapshotProvider {
  getDepthSnapshot(symbol: string): DepthSnapshot | undefined;
  getDepthSnapshotAgeMs(): number | null;
}

interface DepthLevel {
  price: number;
  qty: number;
}

interface DepthSnapshot {
  bidDepth: DepthLevel[];
  askDepth: DepthLevel[];
}

export interface MicroBurstContextBuilderDeps {
  candles: CandleSnapshotProvider;
  btc?: BtcMicroContextProvider;
  book?: OrderBookSnapshotProvider;
}

const CLOSED_INTERVALS = ['1m', '3m', '5m'] as const;

function filterClosedCandles(candles: Candle[], intervalMs: number): Candle[] {
  const now = Date.now();
  return candles.filter((c) => now - c.timestamp >= intervalMs);
}

function getDataQuality(
  snapshotAt: number,
  closedCandles1m: Candle[],
  closedCandles3m: Candle[],
  closedCandles5m: Candle[],
  bookStatus: BookDataStatus,
  bookAgeMs: number | null,
  btcAgeMs: number | null,
  levelsAvailableAt: number | null,
): DataQualityDiagnostics {
  const latestClosed1m = closedCandles1m[closedCandles1m.length - 1]?.timestamp ?? 0;
  const latestClosed3m = closedCandles3m[closedCandles3m.length - 1]?.timestamp ?? 0;
  const latestClosed5m = closedCandles5m[closedCandles5m.length - 1]?.timestamp ?? 0;
  const candleFreshnessMs = snapshotAt - Math.max(latestClosed1m, latestClosed3m, latestClosed5m);

  const invalidReasons: string[] = [];
  if (closedCandles1m.length < 30) invalidReasons.push('insufficient_1m_candles');
  if (closedCandles3m.length < 20) invalidReasons.push('insufficient_3m_candles');
  if (closedCandles5m.length < 15) invalidReasons.push('insufficient_5m_candles');
  if (candleFreshnessMs > 120_000) invalidReasons.push('stale_candles');
  if (bookStatus !== 'HEALTHY') invalidReasons.push('unhealthy_book');
  if (bookAgeMs !== null && bookAgeMs > 30_000) invalidReasons.push('stale_book');
  if (btcAgeMs !== null && btcAgeMs > 60_000) invalidReasons.push('stale_btc');
  if (levelsAvailableAt !== null && levelsAvailableAt > snapshotAt - 300_000)
    invalidReasons.push('levels_not_available');

  const closedCandlesOnly = closedCandles1m.every((c) => now - c.timestamp >= 60_000);

  return {
    snapshotAt,
    latestClosed1mAt: latestClosed1m,
    latestClosed3mAt: latestClosed3m,
    latestClosed5mAt: latestClosed5m,
    candleFreshnessMs,
    bookAgeMs,
    btcAgeMs,
    bookStatus,
    closedCandlesOnly,
    levelsAvailableAt,
    contextValid: invalidReasons.length === 0,
    invalidReasons,
  };
}

const now = Date.now();

function computeStructuralClarity(
  regime: MicroRegime,
  nearSupport: boolean,
  nearResistance: boolean,
  momentumDirection: Side | 'NEUTRAL',
  momentumStrength: number,
  bookHealthy: boolean,
): boolean {
  if (regime === 'VOLATILE') return false;
  if (!nearSupport && !nearResistance) return false;
  if (momentumDirection === 'NEUTRAL') return false;
  if (momentumStrength < 0.3) return false;
  if (!bookHealthy) return false;
  return true;
}

export async function buildMicroBurstContext(
  symbol: string,
  deps: MicroBurstContextBuilderDeps,
  config?: Partial<MicroBurstConfig>,
): Promise<MicroBurstContext> {
  const cfg = { ...defaultMicroBurstConfig(), ...config };
  const snapshotAt = Date.now();

  const [rawCandles1m, rawCandles3m, rawCandles5m] = await Promise.all([
    deps.candles.getCandles(symbol, '1m', 100),
    deps.candles.getCandles(symbol, '3m', 80),
    deps.candles.getCandles(symbol, '5m', 60),
  ]);

  const candles1m = filterClosedCandles(rawCandles1m, 60_000);
  const candles3m = filterClosedCandles(rawCandles3m, 180_000);
  const candles5m = filterClosedCandles(rawCandles5m, 300_000);

  const currentPrice = candles1m[candles1m.length - 1]?.close ?? 0;

  const bookSnapshot = deps.book?.getDepthSnapshot(symbol);
  const bookAgeMs = deps.book?.getDepthSnapshotAgeMs() ?? null;
  const bookStatus: BookDataStatus = bookSnapshot
    ? bookAgeMs !== null && bookAgeMs > 30_000
      ? 'STALE'
      : 'HEALTHY'
    : 'UNAVAILABLE';

  const levels = detectSupportResistance(candles5m, {
    lookbackBars: cfg.srLookbackBars,
    pivotLeftBars: cfg.srPivotLeftBars,
    pivotRightBars: cfg.srPivotRightBars,
    clusterToleranceBps: cfg.srClusterToleranceBps,
    minStrength: cfg.srMinStrength,
    nearLevelThresholdBps: cfg.nearLevelThresholdBps,
  });

  const levelsAvailableAt =
    levels.levels.length > 0
      ? Math.max(...levels.levels.map((l) => l.availableAtCandleIndex))
      : null;

  const momentum = analyzeMicroMomentum(candles1m, candles3m, candles5m, cfg.momentumSlopePeriod);

  const bookPressure = analyzeBookPressure(bookSnapshot, bookStatus, {
    anomalySpreadBps: cfg.bookAnomalySpreadBps,
    minImbalance: cfg.bookMinImbalance,
  });

  const btcRaw = deps.btc?.getBtcContext();
  const btcAgeMs = btcRaw ? snapshotAt - (btcRaw as any).timestamp : null;
  const btcContext: BtcContext | null = btcRaw ?? null;

  const btcConflict = btcContext
    ? (momentum.direction === 'LONG' &&
        btcContext.direction === 'SHORT' &&
        Math.abs(btcContext.ret3m) > cfg.btcConflictThresholdBps) ||
      (momentum.direction === 'SHORT' &&
        btcContext.direction === 'LONG' &&
        Math.abs(btcContext.ret3m) > cfg.btcConflictThresholdBps)
    : false;

  const adjustedBtcContext = btcContext ? { ...btcContext, conflictFlag: btcConflict } : null;

  const microRegime = classifyMicroRegime(candles5m);
  const bookHealthy = isBookHealthy(bookPressure);

  const nearSupport = levels.nearest.structuralPosition === 'near_support';
  const nearResistance = levels.nearest.structuralPosition === 'near_resistance';

  const structuralClarity = computeStructuralClarity(
    microRegime,
    nearSupport,
    nearResistance,
    momentum.direction,
    momentum.strength,
    bookHealthy,
  );

  const candleSet: MicroBurstCandleSet = { candles1m, candles3m, candles5m };

  const dataQuality = getDataQuality(
    snapshotAt,
    candles1m,
    candles3m,
    candles5m,
    bookStatus,
    bookAgeMs,
    btcAgeMs,
    levelsAvailableAt,
  );

  return {
    symbol,
    timestamp: snapshotAt,
    currentPrice,
    candles: candleSet,
    levels,
    momentum,
    bookPressure,
    btcContext: adjustedBtcContext,
    structuralClarity,
    microRegime,
    dataQuality,
  };
}
