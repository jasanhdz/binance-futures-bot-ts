import { Candle, Side } from '../../types';
import {
  BtcContext,
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

interface DepthLevel {
  price: number;
  qty: number;
}

interface DepthSnapshot {
  bidDepth: DepthLevel[];
  askDepth: DepthLevel[];
}

export interface MicroBurstContextBuilderDeps {
  getCandles: (symbol: string, interval: string, limit: number) => Promise<Candle[]>;
  getDepth?: (symbol: string) => DepthSnapshot | undefined;
  getBtcContext?: () => BtcContext | undefined;
}

function computeStructuralClarity(
  regime: MicroRegime,
  nearSupport: boolean,
  nearResistance: boolean,
  momentumDirection: Side | 'NEUTRAL',
  momentumStrength: number,
  bookHealthy: boolean,
): boolean {
  if (regime === 'VOLATILE') return false;
  const nearLevel = nearSupport || nearResistance;
  if (!nearLevel) return false;
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

  const [candles1m, candles3m, candles5m] = await Promise.all([
    deps.getCandles(symbol, '1m', 100),
    deps.getCandles(symbol, '3m', 80),
    deps.getCandles(symbol, '5m', 60),
  ]);

  const currentPrice = candles1m[candles1m.length - 1]?.close ?? 0;
  const timestamp = Date.now();

  const levels = detectSupportResistance(candles5m, {
    lookbackBars: cfg.srLookbackBars,
    clusterToleranceBps: cfg.srClusterToleranceBps,
    minStrength: cfg.srMinStrength,
  });

  const momentum = analyzeMicroMomentum(candles1m, candles3m, candles5m);

  const depth = deps.getDepth?.(symbol);
  const bookPressure = analyzeBookPressure(depth, momentum.direction !== 'NEUTRAL' ? momentum.direction : 'LONG', {
    anomalySpreadBps: cfg.bookAnomalySpreadBps,
    minImbalance: cfg.bookMinImbalance,
  });

  const btcRaw = deps.getBtcContext?.() ?? null;
  const btcContext: BtcContext | null = btcRaw
    ? btcRaw
    : null;

  const btcConflict = btcContext
    ? (momentum.direction === 'LONG' && btcContext.direction === 'SHORT' && Math.abs(btcContext.ret3m) > cfg.btcConflictThreshold) ||
      (momentum.direction === 'SHORT' && btcContext.direction === 'LONG' && Math.abs(btcContext.ret3m) > cfg.btcConflictThreshold)
    : false;

  const adjustedBtcContext = btcContext ? { ...btcContext, conflictFlag: btcConflict } : null;

  const microRegime = classifyMicroRegime(candles5m);
  const bookHealthy = isBookHealthy(bookPressure, momentum.direction !== 'NEUTRAL' ? momentum.direction : 'LONG');

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

  return {
    symbol,
    timestamp,
    currentPrice,
    candles: candleSet,
    levels,
    momentum,
    bookPressure,
    btcContext: adjustedBtcContext,
    structuralClarity,
    microRegime,
  };
}
