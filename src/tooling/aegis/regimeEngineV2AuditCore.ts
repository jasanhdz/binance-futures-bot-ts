import {
  validateRegimeCandles,
  REGIME_CANDLE_MS,
} from '../../domain/services/regime-v2/RegimeDataIntegrity';
import { promises as fs } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { Side } from '../../core/types';
import { RegimeEngineV2 } from '../../domain/services/regime-v2/RegimeEngineV2';
import {
  RegimeEngineV2Decision,
  RegimeEngineV2InputCandle,
  RegimeEngineV2MarketContext,
  RegimeEngineV2MomentumEnvironment,
  RegimeEngineV2TransitionRisk,
} from '../../domain/services/regime-v2/RegimeEngineV2.types';

export const DEFAULT_REGIME_ENGINE_V2_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'DOGEUSDT',
  'SUIUSDT',
  'LTCUSDT',
];

const HORIZONS = [15, 30, 60, 120] as const;
type SupportedHorizon = (typeof HORIZONS)[number];
export type RegimeEngineV2AuditSide = Side | 'BOTH';

export type RegimeEngineV2AuditOptions = {
  candlesDbPath?: string;
  reportsDir?: string;
  symbols?: string[];
  timeframe?: '5m';
  from?: string;
  to?: string;
  sampleEvery?: number;
  leverage?: number;
  limit?: number;
  writeReports?: boolean;
  momentumPatternOnly?: boolean;
  feeBps?: number;
  slippageBps?: number;
  progressEvery?: number;
  maxSamplesPerSymbol?: number;
  horizons?: SupportedHorizon[];
  engineLookbackCandles?: number;
  writeJson?: boolean;
  writeCsv?: boolean;
  side?: RegimeEngineV2AuditSide;
  legacyXrpLongPattern?: boolean;
};

export type RegimeEngineV2DirectionalEnvironment =
  | 'ALLOW_LONG_MOMENTUM'
  | 'WATCH_LONG_MOMENTUM'
  | 'AVOID_FOR_LONG'
  | 'UNKNOWN_FOR_LONG'
  | 'ALLOW_SHORT_MOMENTUM'
  | 'WATCH_SHORT_MOMENTUM'
  | 'AVOID_FOR_SHORT'
  | 'UNKNOWN_FOR_SHORT';

export type RegimeEngineV2MomentumPattern = {
  side: Side;
  kind: 'CONSECUTIVE' | 'BREAKOUT' | 'CONSECUTIVE_BREAKOUT';
  reasons: string[];
  indicators: {
    consecutiveCandles: number;
    volumeRatio?: number;
    closeLocation?: number;
    wickRatio?: number;
    distanceFromEma25Pct?: number;
    breakout?: 'UP' | 'DOWN' | 'NONE';
  };
};

export type RegimeEngineV2Outcome = {
  horizonMinutes: number;
  complete?: boolean;
  incompleteReason?: 'missing_future_data' | 'invalid_candle_data' | 'invalid_horizon';
  grossForwardReturnRoe?: number;
  forwardReturnRoe?: number;
  mfeRoe?: number;
  maeRoe?: number;
  mfeMaeRatio?: number;
  hit5BeforeMinus5?: HitOutcome;
  hit8BeforeMinus5?: HitOutcome;
  hit10BeforeMinus8?: HitOutcome;
  timeTo5Minutes?: number;
  timeTo8Minutes?: number;
  timeTo10Minutes?: number;
  falseBreakout?: boolean;
  postSignalDrawdownRoe?: number;
  totalCostRoe?: number;
};

export type HitOutcome = 'TARGET_FIRST' | 'ADVERSE_FIRST' | 'BOTH_SAME_CANDLE' | 'NONE';

export type RegimeEngineV2AuditSample = {
  timestamp: string;
  timestampMs: number;
  symbol: string;
  side: Side;
  close: number;
  directionalEnvironment: RegimeEngineV2DirectionalEnvironment;
  pattern?: RegimeEngineV2MomentumPattern;
  decision: RegimeEngineV2Decision;
  outcomes: Record<'15m' | '30m' | '60m' | '120m', RegimeEngineV2Outcome>;
};

export type RegimeEngineV2MetricRow = {
  bucket: string;
  horizon: string;
  count: number;
  candidateCount?: number;
  incompleteCount?: number;
  avgForwardReturnRoe?: number;
  avgMfeRoe?: number;
  avgMaeRoe?: number;
  mfeMaeRatio?: number;
  hit5BeforeMinus5Rate?: number;
  hit8BeforeMinus5Rate?: number;
  hit10BeforeMinus8Rate?: number;
  p90MaeRoe?: number;
  avgTimeTo8Minutes?: number;
  falseBreakoutRate?: number;
};

export type RegimeEngineV2EnvironmentDiagnosticRow = {
  bucket: RegimeEngineV2DirectionalEnvironment;
  count: number;
  topTechnicalRegimes: string;
  topSymbols: string;
  avgTransitionRiskScore?: number;
  avgMarketConfirmationScore?: number;
  p90MaeRoe?: number;
  falseBreakoutRate?: number;
};

export type RegimeEngineV2WalkForwardRow = {
  bucket: string;
  trainFrom: string;
  trainTo: string;
  testFrom: string;
  testTo: string;
  trainHit8?: number;
  testHit8?: number;
  decay?: number;
  label: 'stable' | 'decay' | 'insufficient';
};

export type RegimeEngineV2AuditReport = {
  generatedAt: string;
  options: Required<Pick<RegimeEngineV2AuditOptions, 'sampleEvery' | 'leverage' | 'timeframe'>> &
    RegimeEngineV2AuditOptions;
  counts: {
    candlesBySymbol: Record<string, number>;
    samples: number;
  };
  distributions: {
    technicalRegime: Record<string, number>;
    momentumEnvironment: Record<string, number>;
  };
  byMomentumEnvironment: RegimeEngineV2MetricRow[];
  byTechnicalRegime: RegimeEngineV2MetricRow[];
  bySymbolSide: RegimeEngineV2MetricRow[];
  byMarketConfirmation: RegimeEngineV2MetricRow[];
  byTransitionRisk: RegimeEngineV2MetricRow[];
  byEarlyMatureExhausted: RegimeEngineV2MetricRow[];
  byDirectionalEnvironment: RegimeEngineV2MetricRow[];
  byPatternSideEnvironment: RegimeEngineV2MetricRow[];
  byEnvironmentTechnicalRegime: RegimeEngineV2MetricRow[];
  byEnvironmentSymbolSide: RegimeEngineV2MetricRow[];
  byShortBreakdownQuality: RegimeEngineV2MetricRow[];
  byShortDegradationReason: RegimeEngineV2MetricRow[];
  byShortRetestContext: RegimeEngineV2MetricRow[];
  environmentDiagnostics: RegimeEngineV2EnvironmentDiagnosticRow[];
  walkForward: RegimeEngineV2WalkForwardRow[];
  recommendations: string[];
  warnings: string[];
  outputFiles?: {
    markdown: string;
    json: string;
    csv: string;
    recommendations: string;
  };
};

type DbCandleRow = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buy_volume?: number;
};

export async function auditRegimeEngineV2(
  options: RegimeEngineV2AuditOptions = {},
): Promise<RegimeEngineV2AuditReport> {
  const symbols = (
    options.symbols?.length ? options.symbols : DEFAULT_REGIME_ENGINE_V2_SYMBOLS
  ).map((symbol) => symbol.toUpperCase());
  const timeframe = options.timeframe ?? '5m';
  const dbPath =
    options.candlesDbPath ?? '/home/jasan/Develop/trading_system/data/binance_candles.db';
  const reportsDir = options.reportsDir ?? '/home/jasan/Develop';
  const warnings: string[] = [];
  const fromMs = options.from ? parseTimestamp(options.from) : -Infinity;
  const toMs = options.to ? parseEndTimestamp(options.to) : Infinity;
  const candlesBySymbol = loadCandles(dbPath, symbols, timeframe, warnings, fromMs, toMs);
  const report = buildRegimeEngineV2AuditReport(candlesBySymbol, {
    ...options,
    candlesDbPath: dbPath,
    reportsDir,
    symbols,
    timeframe,
    warnings,
  });
  if (options.writeReports !== false) {
    report.outputFiles = await writeReports(report, reportsDir);
  }
  return report;
}

export function loadRegimeEngineV2Candles(options: RegimeEngineV2AuditOptions = {}): {
  candlesBySymbol: Map<string, RegimeEngineV2InputCandle[]>;
  symbols: string[];
  warnings: string[];
} {
  const symbols = (
    options.symbols?.length ? options.symbols : DEFAULT_REGIME_ENGINE_V2_SYMBOLS
  ).map((symbol) => symbol.toUpperCase());
  const timeframe = options.timeframe ?? '5m';
  const dbPath =
    options.candlesDbPath ?? '/home/jasan/Develop/trading_system/data/binance_candles.db';
  const warnings: string[] = [];
  const fromMs = options.from ? parseTimestamp(options.from) : -Infinity;
  const toMs = options.to ? parseEndTimestamp(options.to) : Infinity;
  const candlesBySymbol = loadCandles(dbPath, symbols, timeframe, warnings, fromMs, toMs);
  return { candlesBySymbol, symbols, warnings };
}

export function buildRegimeEngineV2AuditReport(
  candlesBySymbol: Map<string, RegimeEngineV2InputCandle[]>,
  options: RegimeEngineV2AuditOptions & { warnings?: string[] } = {},
): RegimeEngineV2AuditReport {
  const { samples, sampleEvery, leverage, feeBps, slippageBps, horizons, engineLookbackCandles } =
    buildRegimeEngineV2AuditSamples(candlesBySymbol, options);
  const symbols = options.symbols ?? [...candlesBySymbol.keys()];
  const shortSamples = samples.filter((sample) => sample.side === 'SHORT');
  const report: RegimeEngineV2AuditReport = {
    generatedAt: new Date().toISOString(),
    options: {
      ...options,
      timeframe: options.timeframe ?? '5m',
      sampleEvery,
      leverage,
      feeBps,
      slippageBps,
      horizons,
      engineLookbackCandles,
      momentumPatternOnly: options.momentumPatternOnly ?? false,
      writeReports: options.writeReports !== false,
      writeJson: options.writeJson !== false,
      writeCsv: options.writeCsv !== false,
      side: options.side ?? 'BOTH',
      legacyXrpLongPattern: options.legacyXrpLongPattern ?? false,
    },
    counts: {
      candlesBySymbol: Object.fromEntries(
        symbols.map((symbol) => [symbol, candlesBySymbol.get(symbol)?.length ?? 0]),
      ),
      samples: samples.length,
    },
    distributions: {
      technicalRegime: countBy(samples, (sample) => sample.decision.technicalRegime),
      momentumEnvironment: countBy(samples, (sample) => sample.decision.momentumEnvironment),
    },
    byMomentumEnvironment: buildMetricRows(
      samples,
      (sample) => sample.decision.momentumEnvironment,
      horizons,
    ),
    byTechnicalRegime: buildMetricRows(
      samples,
      (sample) => sample.decision.technicalRegime,
      horizons,
    ),
    bySymbolSide: buildMetricRows(samples, (sample) => `${sample.symbol}|${sample.side}`, horizons),
    byMarketConfirmation: buildMetricRows(
      samples,
      (sample) => sample.decision.marketConfirmation.state,
      horizons,
    ),
    byTransitionRisk: buildMetricRows(
      samples,
      (sample) => sample.decision.transition.risk,
      horizons,
    ),
    byEarlyMatureExhausted: buildMetricRows(
      samples,
      (sample) => maturityBucket(sample.decision.technicalRegime),
      horizons,
    ),
    byDirectionalEnvironment: buildMetricRows(
      samples,
      (sample) => sample.directionalEnvironment,
      horizons,
    ),
    byPatternSideEnvironment: buildMetricRows(
      samples.filter((sample) => sample.pattern),
      (sample) => `PATTERN_${sample.side}|${sample.directionalEnvironment}`,
      horizons,
    ),
    byEnvironmentTechnicalRegime: buildMetricRows(
      samples,
      (sample) => `${sample.directionalEnvironment}|${sample.decision.technicalRegime}`,
      horizons,
    ),
    byEnvironmentSymbolSide: buildMetricRows(
      samples,
      (sample) => `${sample.directionalEnvironment}|${sample.symbol}|${sample.side}`,
      horizons,
    ),
    byShortBreakdownQuality: buildMetricRows(shortSamples, shortBreakdownQualityBucket, horizons),
    byShortDegradationReason: buildShortDegradationReasonRows(shortSamples, horizons),
    byShortRetestContext: buildMetricRows(shortSamples, shortRetestContextBucket, horizons),
    environmentDiagnostics: buildEnvironmentDiagnostics(samples),
    walkForward: buildWalkForward(samples),
    recommendations: [],
    warnings: options.warnings ?? [],
  };
  report.recommendations = buildRecommendations(report);
  return report;
}

export function buildRegimeEngineV2AuditSamples(
  candlesBySymbol: Map<string, RegimeEngineV2InputCandle[]>,
  options: RegimeEngineV2AuditOptions & { warnings?: string[] } = {},
): {
  samples: RegimeEngineV2AuditSample[];
  sampleEvery: number;
  leverage: number;
  feeBps: number;
  slippageBps: number;
  horizons: SupportedHorizon[];
  engineLookbackCandles: number;
} {
  const symbols = options.symbols ?? [...candlesBySymbol.keys()];
  const sampleEvery = Math.max(1, Math.floor(options.sampleEvery ?? 6));
  const leverage = options.leverage ?? 20;
  const limit = options.limit ?? Infinity;
  const feeBps = options.feeBps ?? 0;
  const slippageBps = options.slippageBps ?? 0;
  const horizons = selectedHorizons(options.horizons);
  const progressEvery = Math.max(0, Math.floor(options.progressEvery ?? 0));
  const maxSamplesPerSymbol =
    options.maxSamplesPerSymbol === undefined
      ? Infinity
      : Math.max(0, Math.floor(options.maxSamplesPerSymbol));
  const engineLookbackCandles = Math.max(140, Math.floor(options.engineLookbackCandles ?? 260));
  const sideFilter = options.side ?? 'BOTH';
  const requirePattern =
    options.momentumPatternOnly === true || options.legacyXrpLongPattern === true;
  const samples: RegimeEngineV2AuditSample[] = [];
  const sampleFromMs = options.from ? parseTimestamp(options.from) : -Infinity;
  const sampleToMs = options.to ? parseEndTimestamp(options.to) : Infinity;
  const decisionCache = new Map<string, Map<number, RegimeEngineV2Decision>>();
  let scanned = 0;
  const decisionFor = (symbol: string, index: number): RegimeEngineV2Decision | undefined => {
    const candles = candlesBySymbol.get(symbol) ?? [];
    if (!candles[index]) return undefined;
    const symbolCache = decisionCache.get(symbol) ?? new Map<number, RegimeEngineV2Decision>();
    const cached = symbolCache.get(index);
    if (cached) return cached;
    const start = Math.max(0, index + 1 - engineLookbackCandles);
    const decision = RegimeEngineV2.evaluate({
      symbol,
      candles: candles.slice(start, index + 1),
      market: marketContext(symbol, index, decisionFor, candlesBySymbol),
    });
    symbolCache.set(index, decision);
    decisionCache.set(symbol, symbolCache);
    return decision;
  };

  for (const symbol of symbols) {
    const candles = candlesBySymbol.get(symbol) ?? [];
    let symbolSamples = 0;
    for (
      let index = 120;
      index < candles.length && samples.length < limit && symbolSamples < maxSamplesPerSymbol;
      index += sampleEvery
    ) {
      scanned++;
      const timestamp = candles[index].timestamp ?? 0;
      if (timestamp < sampleFromMs || timestamp > sampleToMs) continue;
      const decision = decisionFor(symbol, index);
      if (!decision) continue;
      const pattern = options.legacyXrpLongPattern
        ? detectLegacyXrpLongPattern(candles, index)
        : detectMomentumRidePattern(candles, index);
      if (requirePattern && !pattern) continue;
      const sides = (
        requirePattern && pattern ? [pattern.side] : sidesFor(decision.momentumEnvironment)
      ).filter((side) => sideFilter === 'BOTH' || side === sideFilter);
      for (const side of sides) {
        if (samples.length >= limit) break;
        samples.push({
          timestamp: decision.timestamp,
          timestampMs: Date.parse(decision.timestamp),
          symbol,
          side,
          close: candles[index].close,
          directionalEnvironment: directionalEnvironmentBucket(decision.momentumEnvironment, side),
          pattern: pattern?.side === side ? pattern : undefined,
          decision,
          outcomes: buildOutcomes(candles, index, side, leverage, horizons, decision, {
            feeBps,
            slippageBps,
          }),
        });
        symbolSamples++;
        if (progressEvery > 0 && samples.length % progressEvery === 0) {
          console.error(
            `[RegimeEngineV2Audit] samples=${samples.length} scanned=${scanned} symbol=${symbol} ts=${decision.timestamp}`,
          );
        }
      }
    }
  }

  return { samples, sampleEvery, leverage, feeBps, slippageBps, horizons, engineLookbackCandles };
}

function buildOutcomes(
  candles: RegimeEngineV2InputCandle[],
  index: number,
  side: Side,
  leverage: number,
  horizons: SupportedHorizon[],
  decision: RegimeEngineV2Decision,
  costs: { feeBps?: number; slippageBps?: number },
): RegimeEngineV2AuditSample['outcomes'] {
  return Object.fromEntries(
    HORIZONS.map((horizon) => [
      `${horizon}m`,
      horizons.includes(horizon)
        ? calculateRegimeEngineV2Outcome(candles, index, side, leverage, horizon, decision, costs)
        : { horizonMinutes: horizon },
    ]),
  ) as RegimeEngineV2AuditSample['outcomes'];
}

function loadCandles(
  dbPath: string,
  symbols: string[],
  timeframe: string,
  warnings: string[],
  fromMs: number,
  toMs: number,
): Map<string, RegimeEngineV2InputCandle[]> {
  const output = new Map<string, RegimeEngineV2InputCandle[]>();
  const db = new Database(dbPath, { readonly: true });
  try {
    const statement = db.prepare(`
            SELECT timestamp, open, high, low, close, volume, buy_volume
            FROM ohlcv_data
            WHERE symbol IN (?, ?) AND timeframe = ?
            ORDER BY timestamp ASC
        `);
    for (const symbol of symbols) {
      const rows = statement.all(symbol, slashSymbol(symbol), timeframe) as DbCandleRow[];
      const candles = rows
        .map(toCandle)
        .filter(
          (candle) =>
            (candle.timestamp ?? 0) >= fromMs - 2 * 24 * 60 * 60 * 1000 &&
            (candle.timestamp ?? 0) <= toMs + 2 * 60 * 60 * 1000,
        );
      output.set(symbol, candles);
      if (candles.length === 0) warnings.push(`No candles loaded for ${symbol} ${timeframe}.`);
    }
  } finally {
    db.close();
  }
  return output;
}

function slashSymbol(symbol: string): string {
  return symbol.endsWith('USDT') ? `${symbol.slice(0, -4)}/USDT` : symbol;
}

function toCandle(row: DbCandleRow): RegimeEngineV2InputCandle {
  const timestamp = parseTimestamp(row.timestamp);
  return {
    timestamp,
    openTime: timestamp,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    buyVolume: row.buy_volume === undefined ? undefined : Number(row.buy_volume),
  };
}

function marketContext(
  symbol: string,
  index: number,
  decisionFor: (symbol: string, index: number) => RegimeEngineV2Decision | undefined,
  candlesBySymbol: Map<string, RegimeEngineV2InputCandle[]>,
): RegimeEngineV2MarketContext | undefined {
  if (symbol === 'BTCUSDT') return undefined;
  // Context must be aligned by candle timestamp, never by array position.
  const targetTimestamp = candlesBySymbol.get(symbol)?.[index]?.timestamp;
  const btc =
    targetTimestamp !== undefined
      ? decisionForAtTimestamp('BTCUSDT', targetTimestamp, decisionFor, candlesBySymbol)
      : undefined;
  const eth =
    targetTimestamp && symbol !== 'ETHUSDT'
      ? decisionForAtTimestamp('ETHUSDT', targetTimestamp, decisionFor, candlesBySymbol)
      : undefined;
  return {
    btc: btc
      ? {
          action: actionFromEnv(btc.momentumEnvironment),
          score: btc.confidence,
          direction: btc.technicalDirection,
        }
      : undefined,
    eth:
      symbol === 'ETHUSDT'
        ? undefined
        : eth
          ? {
              action: actionFromEnv(eth.momentumEnvironment),
              score: eth.confidence,
              direction: eth.technicalDirection,
            }
          : undefined,
  };
}

function decisionForAtTimestamp(
  symbol: string,
  timestamp: number,
  decisionFor: (symbol: string, index: number) => RegimeEngineV2Decision | undefined,
  candlesBySymbol: Map<string, RegimeEngineV2InputCandle[]>,
): RegimeEngineV2Decision | undefined {
  const index = (candlesBySymbol.get(symbol) ?? []).findIndex(
    (candle) => candle.timestamp === timestamp,
  );
  return index < 0 ? undefined : decisionFor(symbol, index);
}

function actionFromEnv(env: RegimeEngineV2MomentumEnvironment): 'LONG' | 'SHORT' | 'HOLD' {
  if (env.includes('LONG')) return 'LONG';
  if (env.includes('SHORT')) return 'SHORT';
  return 'HOLD';
}

function sidesFor(environment: RegimeEngineV2MomentumEnvironment): Side[] {
  if (environment.includes('LONG')) return ['LONG'];
  if (environment.includes('SHORT')) return ['SHORT'];
  return ['LONG', 'SHORT'];
}

export function directionalEnvironmentBucket(
  environment: RegimeEngineV2MomentumEnvironment,
  side: Side,
): RegimeEngineV2DirectionalEnvironment {
  if (side === 'LONG') {
    if (environment === 'ALLOW_LONG_MOMENTUM') return 'ALLOW_LONG_MOMENTUM';
    if (environment === 'WATCH_LONG_MOMENTUM') return 'WATCH_LONG_MOMENTUM';
    if (environment === 'UNKNOWN') return 'UNKNOWN_FOR_LONG';
    return 'AVOID_FOR_LONG';
  }
  if (environment === 'ALLOW_SHORT_MOMENTUM') return 'ALLOW_SHORT_MOMENTUM';
  if (environment === 'WATCH_SHORT_MOMENTUM') return 'WATCH_SHORT_MOMENTUM';
  if (environment === 'UNKNOWN') return 'UNKNOWN_FOR_SHORT';
  return 'AVOID_FOR_SHORT';
}

export function detectMomentumRidePattern(
  candles: RegimeEngineV2InputCandle[],
  index: number,
): RegimeEngineV2MomentumPattern | undefined {
  const history = candles.slice(0, index + 1);
  if (history.length < 30) return undefined;
  const current = history[history.length - 1];
  const prior20 = history.slice(-21, -1);
  const last3 = history.slice(-3);
  const range = current.high - current.low;
  if (!current || current.close <= 0 || range <= 0 || prior20.length < 20) return undefined;

  const closeLocation = (current.close - current.low) / range;
  const upperWickRatio = (current.high - Math.max(current.open, current.close)) / range;
  const lowerWickRatio = (Math.min(current.open, current.close) - current.low) / range;
  const volumeRatio = ratio(current.volume, avg(prior20.map((candle) => candle.volume)));
  const recentHigh = max(prior20.map((candle) => candle.high));
  const recentLow = min(prior20.map((candle) => candle.low));
  const closes = history.map((candle) => candle.close);
  const ema25 = emaLast(closes, 25);
  const distanceFromEma25Pct = ema25 && ema25 > 0 ? (current.close - ema25) / ema25 : undefined;
  const longConsecutive =
    last3.every((candle) => candle.close > candle.open) &&
    last3[2].close > last3[1].close &&
    last3[1].close > last3[0].close;
  const shortConsecutive =
    last3.every((candle) => candle.close < candle.open) &&
    last3[2].close < last3[1].close &&
    last3[1].close < last3[0].close;
  const breakoutUp = recentHigh !== undefined && current.close > recentHigh;
  const breakoutDown = recentLow !== undefined && current.close < recentLow;
  const hasVolume = (volumeRatio ?? 0) >= 1.08;
  const notOverextended = Math.abs(distanceFromEma25Pct ?? 0) <= 0.045;

  if (
    (longConsecutive || breakoutUp) &&
    hasVolume &&
    closeLocation >= 0.62 &&
    upperWickRatio <= 0.42 &&
    notOverextended
  ) {
    return {
      side: 'LONG',
      kind:
        longConsecutive && breakoutUp
          ? 'CONSECUTIVE_BREAKOUT'
          : longConsecutive
            ? 'CONSECUTIVE'
            : 'BREAKOUT',
      reasons: [
        ...(longConsecutive ? ['consecutive_long_candles'] : []),
        ...(breakoutUp ? ['range_breakout_up'] : []),
        'volume_ratio_min',
        'strong_close_location',
        'wick_ratio_acceptable',
        'not_extremely_overextended',
      ],
      indicators: {
        consecutiveCandles: longConsecutive ? 3 : 0,
        volumeRatio: round(volumeRatio),
        closeLocation: round(closeLocation),
        wickRatio: round(upperWickRatio),
        distanceFromEma25Pct: round(distanceFromEma25Pct),
        breakout: breakoutUp ? 'UP' : 'NONE',
      },
    };
  }

  if (
    (shortConsecutive || breakoutDown) &&
    hasVolume &&
    closeLocation <= 0.38 &&
    lowerWickRatio <= 0.42 &&
    notOverextended
  ) {
    return {
      side: 'SHORT',
      kind:
        shortConsecutive && breakoutDown
          ? 'CONSECUTIVE_BREAKOUT'
          : shortConsecutive
            ? 'CONSECUTIVE'
            : 'BREAKOUT',
      reasons: [
        ...(shortConsecutive ? ['consecutive_short_candles'] : []),
        ...(breakoutDown ? ['range_breakout_down'] : []),
        'volume_ratio_min',
        'strong_close_location',
        'wick_ratio_acceptable',
        'not_extremely_overextended',
      ],
      indicators: {
        consecutiveCandles: shortConsecutive ? 3 : 0,
        volumeRatio: round(volumeRatio),
        closeLocation: round(closeLocation),
        wickRatio: round(lowerWickRatio),
        distanceFromEma25Pct: round(distanceFromEma25Pct),
        breakout: breakoutDown ? 'DOWN' : 'NONE',
      },
    };
  }

  return undefined;
}

export function detectLegacyXrpLongPattern(
  candles: RegimeEngineV2InputCandle[],
  index: number,
): RegimeEngineV2MomentumPattern | undefined {
  const history = candles.slice(0, index + 1);
  if (history.length < 80) return undefined;
  const current = history[history.length - 1];
  const prior20 = history.slice(-21, -1);
  const last3 = history.slice(-3);
  const last4 = history.slice(-4);
  const range = current.high - current.low;
  if (!current || current.close <= 0 || range <= 0 || prior20.length < 20) return undefined;

  const closeLocation = (current.close - current.low) / range;
  const upperWickRatio = (current.high - Math.max(current.open, current.close)) / range;
  const bodyRatio = Math.abs(current.close - current.open) / range;
  const volumeRatio = ratio(current.volume, avg(prior20.map((candle) => candle.volume)));
  const recentVolumePersistence = ratio(
    avg(last3.map((candle) => candle.volume)),
    avg(history.slice(-23, -3).map((candle) => candle.volume)),
  );
  const closes = history.map((candle) => candle.close);
  const ema20 = emaLast(closes, 20);
  const ema50 = emaLast(closes, 50);
  const distanceFromEma25Pct = ema20 && ema20 > 0 ? (current.close - ema20) / ema20 : undefined;
  const greenStreak = countTrailingCandles(history, (candle) => candle.close > candle.open);
  const lastThreeRising =
    last3.every((candle) => candle.close > candle.open) &&
    last3[2].close > last3[1].close &&
    last3[1].close > last3[0].close;
  const atLeastThreeOfFourGreen = last4.filter((candle) => candle.close > candle.open).length >= 3;
  const trendOk =
    ema20 !== undefined && ema50 !== undefined && current.close > ema20 && ema20 >= ema50;
  const volumeOk = (volumeRatio ?? 0) >= 1.1 || (recentVolumePersistence ?? 0) >= 1.15;
  const notOverextended = (distanceFromEma25Pct ?? 0) <= 0.012;
  const qualityOk = closeLocation >= 0.58 && bodyRatio >= 0.32 && upperWickRatio <= 0.5;

  if (
    (greenStreak >= 3 || lastThreeRising || atLeastThreeOfFourGreen) &&
    volumeOk &&
    trendOk &&
    qualityOk &&
    notOverextended
  ) {
    return {
      side: 'LONG',
      kind: greenStreak >= 3 || lastThreeRising ? 'CONSECUTIVE' : 'BREAKOUT',
      reasons: [
        greenStreak >= 3 ? 'legacy_xrp_green_streak_3' : 'legacy_xrp_three_of_four_green',
        'legacy_xrp_volume_expansion',
        'legacy_xrp_strong_close',
        'legacy_xrp_body_quality',
        'legacy_xrp_ema20_trend',
        'legacy_xrp_not_overextended',
      ],
      indicators: {
        consecutiveCandles: Math.max(greenStreak, lastThreeRising ? 3 : 0),
        volumeRatio: round(volumeRatio),
        closeLocation: round(closeLocation),
        wickRatio: round(upperWickRatio),
        distanceFromEma25Pct: round(distanceFromEma25Pct),
        breakout: 'NONE',
      },
    };
  }

  return undefined;
}

export function calculateRegimeEngineV2Outcome(
  candles: RegimeEngineV2InputCandle[],
  index: number,
  side: Side,
  leverage: number,
  horizonMinutes: number,
  decision: RegimeEngineV2Decision,
  costs: { feeBps?: number; slippageBps?: number } = {},
): RegimeEngineV2Outcome {
  const count = (horizonMinutes * 60_000) / REGIME_CANDLE_MS;
  if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(index) || index < 0) {
    return { horizonMinutes, complete: false, incompleteReason: 'invalid_horizon' };
  }
  const window = candles.slice(index, index + count + 1);
  if (validateRegimeCandles(window)) {
    return { horizonMinutes, complete: false, incompleteReason: 'invalid_candle_data' };
  }
  if (window.length !== count + 1) {
    return { horizonMinutes, complete: false, incompleteReason: 'missing_future_data' };
  }
  const entry = window[0];
  const future = window.slice(1);
  const futureHigh = max(future.map((candle) => candle.high));
  const futureLow = min(future.map((candle) => candle.low));
  const lastClose = future[future.length - 1].close;
  if (futureHigh === undefined || futureLow === undefined) return { horizonMinutes };
  const mfeRoe =
    side === 'LONG'
      ? ((futureHigh - entry.close) / entry.close) * leverage
      : ((entry.close - futureLow) / entry.close) * leverage;
  const maeRoe =
    side === 'LONG'
      ? ((futureLow - entry.close) / entry.close) * leverage
      : ((entry.close - futureHigh) / entry.close) * leverage;
  const forwardReturnRoe =
    side === 'LONG'
      ? ((lastClose - entry.close) / entry.close) * leverage
      : ((entry.close - lastClose) / entry.close) * leverage;
  const totalCostRoe = roundTripCostRoe(leverage, costs.feeBps ?? 0, costs.slippageBps ?? 0);
  const netMfeRoe = mfeRoe - totalCostRoe;
  const netMaeRoe = maeRoe - totalCostRoe;
  const netForwardReturnRoe = forwardReturnRoe - totalCostRoe;
  return {
    horizonMinutes,
    complete: true,
    grossForwardReturnRoe: round(forwardReturnRoe),
    forwardReturnRoe: round(netForwardReturnRoe),
    mfeRoe: round(netMfeRoe),
    maeRoe: round(netMaeRoe),
    mfeMaeRatio: Math.abs(netMaeRoe) > 0 ? round(netMfeRoe / Math.abs(netMaeRoe)) : undefined,
    hit5BeforeMinus5: hitThreshold(future, entry.close, side, leverage, 0.05, 0.05, totalCostRoe),
    hit8BeforeMinus5: hitThreshold(future, entry.close, side, leverage, 0.08, 0.05, totalCostRoe),
    hit10BeforeMinus8: hitThreshold(future, entry.close, side, leverage, 0.1, 0.08, totalCostRoe),
    timeTo5Minutes: timeToTarget(future, entry.close, side, leverage, 0.05, totalCostRoe),
    timeTo8Minutes: timeToTarget(future, entry.close, side, leverage, 0.08, totalCostRoe),
    timeTo10Minutes: timeToTarget(future, entry.close, side, leverage, 0.1, totalCostRoe),
    falseBreakout: decision.technicalRegime.includes('BREAKOUT')
      ? netForwardReturnRoe < 0 || netMfeRoe < 0.05
      : undefined,
    postSignalDrawdownRoe: round(netMaeRoe),
    totalCostRoe: round(totalCostRoe),
  };
}

function hitThreshold(
  candles: RegimeEngineV2InputCandle[],
  entryPrice: number,
  side: Side,
  leverage: number,
  target: number,
  adverse: number,
  costRoe = 0,
): HitOutcome {
  for (const candle of candles) {
    const favorable =
      (side === 'LONG'
        ? ((candle.high - entryPrice) / entryPrice) * leverage
        : ((entryPrice - candle.low) / entryPrice) * leverage) - costRoe;
    const unfavorable =
      (side === 'LONG'
        ? ((candle.low - entryPrice) / entryPrice) * leverage
        : ((entryPrice - candle.high) / entryPrice) * leverage) - costRoe;
    const hitTarget = favorable >= target;
    const hitAdverse = unfavorable <= -adverse;
    if (hitTarget && hitAdverse) return 'BOTH_SAME_CANDLE';
    if (hitTarget) return 'TARGET_FIRST';
    if (hitAdverse) return 'ADVERSE_FIRST';
  }
  return 'NONE';
}

function timeToTarget(
  candles: RegimeEngineV2InputCandle[],
  entryPrice: number,
  side: Side,
  leverage: number,
  target: number,
  costRoe = 0,
): number | undefined {
  const hit = candles.find((candle) => {
    const favorable =
      (side === 'LONG'
        ? ((candle.high - entryPrice) / entryPrice) * leverage
        : ((entryPrice - candle.low) / entryPrice) * leverage) - costRoe;
    return favorable >= target;
  });
  return hit
    ? ((hit.timestamp ?? 0) - (candles[0].timestamp ?? 0) + 5 * 60_000) / 60_000
    : undefined;
}

function buildMetricRows(
  samples: RegimeEngineV2AuditSample[],
  keyFn: (sample: RegimeEngineV2AuditSample) => string,
  horizons: SupportedHorizon[] = [...HORIZONS],
): RegimeEngineV2MetricRow[] {
  const groups = new Map<string, RegimeEngineV2AuditSample[]>();
  for (const sample of samples) {
    const key = keyFn(sample);
    const group = groups.get(key);
    if (group) group.push(sample);
    else groups.set(key, [sample]);
  }
  const rows: RegimeEngineV2MetricRow[] = [];
  for (const [bucket, group] of groups.entries()) {
    for (const horizon of horizons) {
      rows.push(metricRow(bucket, group, `${horizon}m`));
    }
  }
  return rows.sort(
    (a, b) => a.bucket.localeCompare(b.bucket) || a.horizon.localeCompare(b.horizon),
  );
}

function buildShortDegradationReasonRows(
  samples: RegimeEngineV2AuditSample[],
  horizons: SupportedHorizon[] = [...HORIZONS],
): RegimeEngineV2MetricRow[] {
  const reasons = new Map<string, RegimeEngineV2AuditSample[]>();
  for (const sample of samples) {
    const shortReasons = sample.decision.reasons.filter(
      (reason) =>
        reason.startsWith('short_') ||
        reason === 'breakout_degraded_to_watch' ||
        reason === 'breakout_degraded_to_avoid',
    );
    for (const reason of shortReasons) {
      const group = reasons.get(reason);
      if (group) group.push(sample);
      else reasons.set(reason, [sample]);
    }
  }
  const rows: RegimeEngineV2MetricRow[] = [];
  for (const [reason, group] of reasons.entries()) {
    for (const horizon of horizons) rows.push(metricRow(reason, group, `${horizon}m`));
  }
  return rows.sort(
    (a, b) =>
      b.count - a.count || a.bucket.localeCompare(b.bucket) || a.horizon.localeCompare(b.horizon),
  );
}

function metricRow(
  bucket: string,
  samples: RegimeEngineV2AuditSample[],
  horizon: '15m' | '30m' | '60m' | '120m',
): RegimeEngineV2MetricRow {
  const outcomes = samples
    .map((sample) => sample.outcomes[horizon])
    .filter((outcome) => outcome.complete === true);
  const avgMfe = avg(outcomes.map((outcome) => outcome.mfeRoe).filter(isNumber));
  const avgMae = avg(outcomes.map((outcome) => outcome.maeRoe).filter(isNumber));
  return {
    bucket,
    horizon,
    count: outcomes.length,
    candidateCount: samples.length,
    incompleteCount: samples.length - outcomes.length,
    avgForwardReturnRoe: round(
      avg(outcomes.map((outcome) => outcome.forwardReturnRoe).filter(isNumber)),
    ),
    avgMfeRoe: round(avgMfe),
    avgMaeRoe: round(avgMae),
    mfeMaeRatio:
      avgMae !== undefined && Math.abs(avgMae) > 0
        ? round((avgMfe ?? 0) / Math.abs(avgMae))
        : undefined,
    hit5BeforeMinus5Rate: hitRate(outcomes.map((outcome) => outcome.hit5BeforeMinus5)),
    hit8BeforeMinus5Rate: hitRate(outcomes.map((outcome) => outcome.hit8BeforeMinus5)),
    hit10BeforeMinus8Rate: hitRate(outcomes.map((outcome) => outcome.hit10BeforeMinus8)),
    p90MaeRoe: round(
      percentile(
        outcomes
          .map((outcome) => (isNumber(outcome.maeRoe) ? Math.abs(outcome.maeRoe) : undefined))
          .filter(isNumber),
        0.9,
      ),
    ),
    avgTimeTo8Minutes: round(
      avg(outcomes.map((outcome) => outcome.timeTo8Minutes).filter(isNumber)),
    ),
    falseBreakoutRate: boolRate(outcomes.map((outcome) => outcome.falseBreakout)),
  };
}

function buildWalkForward(samples: RegimeEngineV2AuditSample[]): RegimeEngineV2WalkForwardRow[] {
  if (samples.length === 0) return [];
  const start = Math.min(...samples.map((sample) => sample.timestampMs));
  const end = Math.max(...samples.map((sample) => sample.timestampMs));
  const rows: RegimeEngineV2WalkForwardRow[] = [];
  const trainDays = 10;
  const testDays = 5;
  const stepDays = 5;
  for (
    let trainFrom = start;
    trainFrom + (trainDays + testDays) * dayMs() <= end;
    trainFrom += stepDays * dayMs()
  ) {
    const trainTo = trainFrom + trainDays * dayMs();
    const testFrom = trainTo;
    const testTo = testFrom + testDays * dayMs();
    const train = samples.filter(
      (sample) =>
        sample.timestampMs >= trainFrom &&
        sample.timestampMs + 60 * 60_000 < trainTo &&
        sample.outcomes['60m'].complete === true,
    );
    const test = samples.filter(
      (sample) =>
        sample.timestampMs >= testFrom &&
        sample.timestampMs + 60 * 60_000 < testTo &&
        sample.outcomes['60m'].complete === true,
    );
    for (const bucket of directionalEnvironmentBuckets()) {
      const trainBucket = train.filter((sample) => sample.directionalEnvironment === bucket);
      const testBucket = test.filter((sample) => sample.directionalEnvironment === bucket);
      const trainHit8 = hit8For(trainBucket);
      const testHit8 = hit8For(testBucket);
      const sufficient = trainBucket.length >= 20 && testBucket.length >= 10;
      rows.push({
        bucket,
        trainFrom: new Date(trainFrom).toISOString(),
        trainTo: new Date(trainTo).toISOString(),
        testFrom: new Date(testFrom).toISOString(),
        testTo: new Date(testTo).toISOString(),
        trainHit8,
        testHit8,
        decay:
          trainHit8 !== undefined && testHit8 !== undefined
            ? round(testHit8 - trainHit8)
            : undefined,
        label: sufficient
          ? (testHit8 ?? 0) >= (trainHit8 ?? 0) - 0.08
            ? 'stable'
            : 'decay'
          : 'insufficient',
      });
    }
  }
  return rows;
}

function buildEnvironmentDiagnostics(
  samples: RegimeEngineV2AuditSample[],
): RegimeEngineV2EnvironmentDiagnosticRow[] {
  return directionalEnvironmentBuckets()
    .map((bucket) => {
      const group = samples.filter((sample) => sample.directionalEnvironment === bucket);
      const outcomes60 = group
        .map((sample) => sample.outcomes['60m'])
        .filter((outcome) => outcome.complete === true);
      return {
        bucket,
        count: group.length,
        topTechnicalRegimes: topCounts(group, (sample) => sample.decision.technicalRegime, 4),
        topSymbols: topCounts(group, (sample) => `${sample.symbol}|${sample.side}`, 5),
        avgTransitionRiskScore: round(
          avg(group.map((sample) => transitionRiskScore(sample.decision.transition.risk))),
        ),
        avgMarketConfirmationScore: round(
          avg(group.map((sample) => sample.decision.scores.marketConfirmationScore)),
        ),
        p90MaeRoe: round(
          percentile(
            outcomes60
              .map((outcome) => (isNumber(outcome.maeRoe) ? Math.abs(outcome.maeRoe) : undefined))
              .filter(isNumber),
            0.9,
          ),
        ),
        falseBreakoutRate: boolRate(outcomes60.map((outcome) => outcome.falseBreakout)),
      };
    })
    .filter((row) => row.count > 0);
}

function buildRecommendations(report: RegimeEngineV2AuditReport): string[] {
  const env60 = report.byDirectionalEnvironment.filter((row) => row.horizon === '60m');
  const allowLong = env60.find((row) => row.bucket === 'ALLOW_LONG_MOMENTUM');
  const watchLong = env60.find((row) => row.bucket === 'WATCH_LONG_MOMENTUM');
  const avoidLong = env60.find((row) => row.bucket === 'AVOID_FOR_LONG');
  const allowShort = env60.find((row) => row.bucket === 'ALLOW_SHORT_MOMENTUM');
  const watchShort = env60.find((row) => row.bucket === 'WATCH_SHORT_MOMENTUM');
  const avoidShort = env60.find((row) => row.bucket === 'AVOID_FOR_SHORT');
  const early = report.byEarlyMatureExhausted.find(
    (row) => row.bucket === 'EARLY' && row.horizon === '60m',
  );
  const mature = report.byEarlyMatureExhausted.find(
    (row) => row.bucket === 'MATURE' && row.horizon === '60m',
  );
  const allowShortDiag = report.environmentDiagnostics.find(
    (row) => row.bucket === 'ALLOW_SHORT_MOMENTUM',
  );
  const watchShortDiag = report.environmentDiagnostics.find(
    (row) => row.bucket === 'WATCH_SHORT_MOMENTUM',
  );
  return [
    compareRows('ALLOW_LONG vs WATCH_LONG', allowLong, watchLong),
    compareRows('WATCH_LONG vs AVOID_FOR_LONG', watchLong, avoidLong),
    compareRows('ALLOW_SHORT vs WATCH_SHORT', allowShort, watchShort),
    compareRows('WATCH_SHORT vs AVOID_FOR_SHORT', watchShort, avoidShort),
    compareRows('EARLY vs MATURE', early, mature),
    `ALLOW_SHORT diagnostics: regimes=${allowShortDiag?.topTechnicalRegimes || 'n/a'}, symbols=${allowShortDiag?.topSymbols || 'n/a'}, p90MAE=${fmt(allowShortDiag?.p90MaeRoe)}, falseBreakout=${fmt(allowShortDiag?.falseBreakoutRate)}.`,
    `WATCH_SHORT diagnostics: regimes=${watchShortDiag?.topTechnicalRegimes || 'n/a'}, symbols=${watchShortDiag?.topSymbols || 'n/a'}, p90MAE=${fmt(watchShortDiag?.p90MaeRoe)}, falseBreakout=${fmt(watchShortDiag?.falseBreakoutRate)}.`,
    report.options.momentumPatternOnly
      ? 'This V2.3 report is conditioned on offline Momentum Ride-like patterns, so AVOID buckets are side-specific context filters.'
      : 'Use --momentum-pattern-only before interpreting ALLOW/WATCH/AVOID as Momentum Ride context quality.',
    'Do not move RegimeEngineV2 to live enforcement from this audit alone.',
    'Use symbol/side stability before wiring Momentum Ride allowed regimes to RegimeEngineV2.',
  ];
}

export function renderRegimeEngineV2Markdown(report: RegimeEngineV2AuditReport): string {
  return [
    report.options.momentumPatternOnly
      ? '# Aegis RegimeEngineV2 V2.3 Pattern Audit'
      : '# Aegis RegimeEngineV2 Audit',
    '',
    `Generated: ${report.generatedAt}`,
    `Samples: ${report.counts.samples}`,
    `Momentum pattern only: ${report.options.momentumPatternOnly ? 'yes' : 'no'}`,
    `Legacy XRP long pattern: ${report.options.legacyXrpLongPattern ? 'yes' : 'no'}`,
    `Side filter: ${report.options.side ?? 'BOTH'}`,
    `Fee bps: ${report.options.feeBps ?? 0}`,
    `Slippage bps: ${report.options.slippageBps ?? 0}`,
    `Engine lookback candles: ${report.options.engineLookbackCandles ?? 'n/a'}`,
    '',
    '## Executive Summary',
    ...report.recommendations.map((line) => `- ${line}`),
    '',
    '## Technical Regime Distribution',
    countTable(report.distributions.technicalRegime),
    '',
    '## Momentum Environment Distribution',
    countTable(report.distributions.momentumEnvironment),
    '',
    '## Performance By Momentum Environment',
    metricsTable(report.byMomentumEnvironment),
    '',
    '## Directional Context Performance',
    metricsTable(report.byDirectionalEnvironment),
    '',
    '## Pattern Side + Context Performance',
    metricsTable(report.byPatternSideEnvironment),
    '',
    '## ALLOW_SHORT vs WATCH_SHORT Diagnostics',
    environmentDiagnosticsTable(report.environmentDiagnostics),
    '',
    '## Short Breakdown Quality Buckets',
    metricsTable(report.byShortBreakdownQuality),
    '',
    '## Short Degradation Reasons',
    metricsTable(report.byShortDegradationReason),
    '',
    '## Short Retest Context',
    metricsTable(report.byShortRetestContext),
    '',
    '## Performance By Technical Regime',
    metricsTable(report.byTechnicalRegime),
    '',
    '## Performance By Symbol/Side',
    metricsTable(report.bySymbolSide),
    '',
    '## Market Confirmation Effect',
    metricsTable(report.byMarketConfirmation),
    '',
    '## Transition Risk Effect',
    metricsTable(report.byTransitionRisk),
    '',
    '## EARLY vs MATURE vs EXHAUSTED',
    metricsTable(report.byEarlyMatureExhausted),
    '',
    '## Environment + Technical Regime',
    metricsTable(report.byEnvironmentTechnicalRegime),
    '',
    '## Environment + Symbol/Side',
    metricsTable(report.byEnvironmentSymbolSide),
    '',
    '## Walk-Forward Stability',
    walkForwardTable(report.walkForward),
    '',
    '## What Not To Move Live Yet',
    '- Do not change regime_config.live.yaml.',
    '- Do not enable RegimeEngineV2 blocking.',
    '- Do not change Momentum Ride live thresholds from this first audit.',
    '- Do not change leverage or sizing.',
    '',
  ].join('\n');
}

function walkForwardTable(rows: RegimeEngineV2WalkForwardRow[]): string {
  if (rows.length === 0) return '_No walk-forward rows._';
  const summary = new Map<string, { stable: number; decay: number; insufficient: number }>();
  for (const row of rows) {
    const current = summary.get(row.bucket) ?? { stable: 0, decay: 0, insufficient: 0 };
    current[row.label] += 1;
    summary.set(row.bucket, current);
  }
  return [
    '| bucket | stable | decay | insufficient |',
    '|---|---:|---:|---:|',
    ...[...summary.entries()].map(
      ([bucket, counts]) =>
        `| ${bucket} | ${counts.stable} | ${counts.decay} | ${counts.insufficient} |`,
    ),
  ].join('\n');
}

async function writeReports(
  report: RegimeEngineV2AuditReport,
  reportsDir: string,
): Promise<RegimeEngineV2AuditReport['outputFiles']> {
  await fs.mkdir(reportsDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15) + 'Z';
  const markdown = path.join(
    reportsDir,
    report.options.momentumPatternOnly
      ? `aegis_regime_engine_v2_v23_audit_${stamp}.md`
      : `aegis_regime_engine_v2_audit_${stamp}.md`,
  );
  const json = path.join(
    reportsDir,
    report.options.momentumPatternOnly
      ? `aegis_regime_engine_v2_v23_audit_${stamp}.json`
      : `aegis_regime_engine_v2_audit_${stamp}.json`,
  );
  const csv = path.join(
    reportsDir,
    report.options.momentumPatternOnly
      ? `aegis_regime_engine_v2_v23_metrics_${stamp}.csv`
      : `aegis_regime_engine_v2_metrics_${stamp}.csv`,
  );
  const recommendations = path.join(
    reportsDir,
    report.options.momentumPatternOnly
      ? `aegis_regime_engine_v2_v23_recommendations_${stamp}.md`
      : `aegis_regime_engine_v2_recommendations_${stamp}.md`,
  );
  await fs.writeFile(markdown, renderRegimeEngineV2Markdown(report), 'utf8');
  if (report.options.writeJson !== false)
    await fs.writeFile(json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (report.options.writeCsv !== false) await fs.writeFile(csv, metricsCsv(report), 'utf8');
  await fs.writeFile(
    recommendations,
    `# RegimeEngineV2 Recommendations\n\n${report.recommendations.map((line) => `- ${line}`).join('\n')}\n`,
    'utf8',
  );
  return { markdown, json, csv, recommendations };
}

function metricsCsv(report: RegimeEngineV2AuditReport): string {
  const rows = [
    ...report.byMomentumEnvironment.map((row) => ({ group: 'momentumEnvironment', ...row })),
    ...report.byDirectionalEnvironment.map((row) => ({ group: 'directionalEnvironment', ...row })),
    ...report.byPatternSideEnvironment.map((row) => ({ group: 'patternSideEnvironment', ...row })),
    ...report.byTechnicalRegime.map((row) => ({ group: 'technicalRegime', ...row })),
    ...report.bySymbolSide.map((row) => ({ group: 'symbolSide', ...row })),
    ...report.byEnvironmentTechnicalRegime.map((row) => ({
      group: 'environmentTechnicalRegime',
      ...row,
    })),
    ...report.byEnvironmentSymbolSide.map((row) => ({ group: 'environmentSymbolSide', ...row })),
    ...report.byShortBreakdownQuality.map((row) => ({ group: 'shortBreakdownQuality', ...row })),
    ...report.byShortDegradationReason.map((row) => ({ group: 'shortDegradationReason', ...row })),
    ...report.byShortRetestContext.map((row) => ({ group: 'shortRetestContext', ...row })),
    ...report.byMarketConfirmation.map((row) => ({ group: 'marketConfirmation', ...row })),
    ...report.byTransitionRisk.map((row) => ({ group: 'transitionRisk', ...row })),
  ];
  return (
    [
      'group,bucket,horizon,count,avgForwardReturnRoe,avgMfeRoe,avgMaeRoe,mfeMaeRatio,hit5BeforeMinus5Rate,hit8BeforeMinus5Rate,hit10BeforeMinus8Rate,p90MaeRoe,avgTimeTo8Minutes,falseBreakoutRate',
      ...rows.map((row) =>
        [
          row.group,
          row.bucket,
          row.horizon,
          row.count,
          row.avgForwardReturnRoe ?? '',
          row.avgMfeRoe ?? '',
          row.avgMaeRoe ?? '',
          row.mfeMaeRatio ?? '',
          row.hit5BeforeMinus5Rate ?? '',
          row.hit8BeforeMinus5Rate ?? '',
          row.hit10BeforeMinus8Rate ?? '',
          row.p90MaeRoe ?? '',
          row.avgTimeTo8Minutes ?? '',
          row.falseBreakoutRate ?? '',
        ].join(','),
      ),
    ].join('\n') + '\n'
  );
}

function countTable(counts: Record<string, number>): string {
  return [
    '| bucket | count |',
    '|---|---:|',
    ...Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `| ${key} | ${count} |`),
  ].join('\n');
}

function metricsTable(rows: RegimeEngineV2MetricRow[]): string {
  const filtered = rows
    .filter((row) => row.horizon === '60m')
    .sort((a, b) => b.count - a.count || a.bucket.localeCompare(b.bucket));
  if (filtered.length === 0) return '_No rows._';
  return [
    '| bucket | count | avgMFE | avgMAE | MFE/MAE | hit5 | hit8 | hit10 | p90 MAE | avg t+8 | false breakout |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...filtered.map(
      (row) =>
        `| ${row.bucket} | ${row.count} | ${fmt(row.avgMfeRoe)} | ${fmt(row.avgMaeRoe)} | ${fmt(row.mfeMaeRatio)} | ${fmt(row.hit5BeforeMinus5Rate)} | ${fmt(row.hit8BeforeMinus5Rate)} | ${fmt(row.hit10BeforeMinus8Rate)} | ${fmt(row.p90MaeRoe)} | ${fmt(row.avgTimeTo8Minutes)} | ${fmt(row.falseBreakoutRate)} |`,
    ),
  ].join('\n');
}

function environmentDiagnosticsTable(rows: RegimeEngineV2EnvironmentDiagnosticRow[]): string {
  if (rows.length === 0) return '_No rows._';
  return [
    '| bucket | count | top regimes | top symbols | avg transition | avg market | p90 MAE | false breakout |',
    '|---|---:|---|---|---:|---:|---:|---:|',
    ...rows.map(
      (row) =>
        `| ${row.bucket} | ${row.count} | ${row.topTechnicalRegimes || 'n/a'} | ${row.topSymbols || 'n/a'} | ${fmt(row.avgTransitionRiskScore)} | ${fmt(row.avgMarketConfirmationScore)} | ${fmt(row.p90MaeRoe)} | ${fmt(row.falseBreakoutRate)} |`,
    ),
  ].join('\n');
}

function maturityBucket(regime: string): string {
  if (regime.includes('EARLY')) return 'EARLY';
  if (regime.includes('MATURE')) return 'MATURE';
  if (regime.includes('EXHAUSTED')) return 'EXHAUSTED';
  if (regime.includes('PULLBACK')) return 'PULLBACK';
  return 'OTHER';
}

function shortBreakdownQualityBucket(sample: RegimeEngineV2AuditSample): string {
  const indicators = sample.decision.indicators;
  if ((indicators.shortAbsorptionRisk ?? 0) >= 0.72) return 'absorbed';
  if ((indicators.shortSweepRisk ?? 0) >= 0.24) return 'sweep';
  const quality = indicators.shortBreakdownQuality ?? 0;
  if (quality >= 0.66) return 'high_quality';
  if (quality >= 0.42) return 'medium_quality';
  return 'low_quality';
}

function shortRetestContextBucket(sample: RegimeEngineV2AuditSample): string {
  const indicators = sample.decision.indicators;
  if ((indicators.shortAbsorptionRisk ?? 0) >= 0.72) return 'absorbed';
  if ((indicators.shortSweepRisk ?? 0) >= 0.24) return 'sweep';
  if ((indicators.shortRetestScore ?? 0) >= 0.55) return 'retest_confirmed';
  return 'no_retest';
}

function compareRows(
  label: string,
  a?: RegimeEngineV2MetricRow,
  b?: RegimeEngineV2MetricRow,
): string {
  if (!a || !b) return `${label}: insufficient samples.`;
  return `${label}: hit8 ${fmt(a.hit8BeforeMinus5Rate)} vs ${fmt(b.hit8BeforeMinus5Rate)}, MFE/MAE ${fmt(a.mfeMaeRatio)} vs ${fmt(b.mfeMaeRatio)}.`;
}

function hit8For(samples: RegimeEngineV2AuditSample[]): number | undefined {
  if (samples.length === 0) return undefined;
  return hitRate(samples.map((sample) => sample.outcomes['60m'].hit8BeforeMinus5));
}

function directionalEnvironmentBuckets(): RegimeEngineV2DirectionalEnvironment[] {
  return [
    'ALLOW_LONG_MOMENTUM',
    'WATCH_LONG_MOMENTUM',
    'AVOID_FOR_LONG',
    'UNKNOWN_FOR_LONG',
    'ALLOW_SHORT_MOMENTUM',
    'WATCH_SHORT_MOMENTUM',
    'AVOID_FOR_SHORT',
    'UNKNOWN_FOR_SHORT',
  ];
}

function selectedHorizons(values?: SupportedHorizon[]): SupportedHorizon[] {
  const selected = (values?.length ? values : [...HORIZONS]).filter(
    (value): value is SupportedHorizon => HORIZONS.includes(value),
  );
  return selected.length > 0 ? [...new Set(selected)] : [...HORIZONS];
}

function topCounts<T>(rows: T[], keyFn: (row: T) => string, limit: number): string {
  return Object.entries(countBy(rows, keyFn))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => `${key}:${count}`)
    .join('; ');
}

function transitionRiskScore(risk: RegimeEngineV2TransitionRisk): number {
  if (risk === 'HIGH') return 1;
  if (risk === 'MODERATE') return 0.5;
  return 0;
}

function hitRate(values: Array<HitOutcome | undefined>): number | undefined {
  const known = values.filter((value): value is HitOutcome => value !== undefined);
  if (known.length === 0) return undefined;
  return round(known.filter((value) => value === 'TARGET_FIRST').length / known.length);
}

function boolRate(values: Array<boolean | undefined>): number | undefined {
  const known = values.filter((value): value is boolean => typeof value === 'boolean');
  return known.length > 0 ? round(known.filter(Boolean).length / known.length) : undefined;
}

function countBy<T>(rows: T[], keyFn: (row: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[keyFn(row)] = (counts[keyFn(row)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

function parseTimestamp(value: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(`${value}T00:00:00.000Z`);
  const normalized = value.includes('T') ? value : value.replace(' ', 'T').replace(' ', '') + 'Z';
  return Date.parse(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
}

function parseEndTimestamp(value: string): number {
  return parseTimestamp(value) + (/^\d{4}-\d{2}-\d{2}$/.test(value) ? dayMs() - 1 : 0);
}

function roundTripCostRoe(leverage: number, feeBps: number, slippageBps: number): number {
  return 2 * ((feeBps + slippageBps) / 10_000) * leverage;
}

function emaLast(values: number[], period: number): number | undefined {
  if (values.length === 0) return undefined;
  const alpha = 2 / (period + 1);
  let ema = values[0];
  for (const value of values) ema = value * alpha + ema * (1 - alpha);
  return ema;
}

function dayMs(): number {
  return 24 * 60 * 60 * 1000;
}

function max(values: number[]): number | undefined {
  const finite = values.filter(isNumber);
  return finite.length > 0 ? Math.max(...finite) : undefined;
}

function min(values: number[]): number | undefined {
  const finite = values.filter(isNumber);
  return finite.length > 0 ? Math.min(...finite) : undefined;
}

function avg(values: number[]): number | undefined {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
}

function ratio(a: number | undefined, b: number | undefined): number | undefined {
  return a !== undefined && b !== undefined && b !== 0 ? a / b : undefined;
}

function countTrailingCandles(
  candles: RegimeEngineV2InputCandle[],
  predicate: (candle: RegimeEngineV2InputCandle) => boolean,
): number {
  let count = 0;
  for (let index = candles.length - 1; index >= 0; index--) {
    if (!predicate(candles[index])) break;
    count++;
  }
  return count;
}

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function round(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : Number(value.toFixed(6));
}

function fmt(value: number | undefined): string {
  return value === undefined ? 'n/a' : String(value);
}
