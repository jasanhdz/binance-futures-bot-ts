import path from 'path';
import { promises as fs } from 'fs';
import Database from 'better-sqlite3';
import {
  AegisRegimeDecision,
  AegisRegimeGuard,
  AegisRegimeGuardConfig,
  AegisRegimeLabel,
  DEFAULT_AEGIS_REGIME_GUARD_CONFIG,
} from '../../domain/services/AegisRegimeGuard';
import {
  AegisTurboSignalHistoryInput,
  AegisTurboTradeCloseInput,
  AegisTurboTradeEventInput,
  AegisTurboTradeOpenInput,
  AegisTurboVotes,
} from '../../infra/logging/AegisTurboHistoryLogger';
import { Side } from '../../domain/types';

export const DEFAULT_REGIME_AUDIT_SYMBOLS = [
  'ETHUSDT',
  'BTCUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'SUIUSDT',
  'LTCUSDT',
];

export type CandleRow = {
  timestampMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type HitOutcome = 'TARGET_FIRST' | 'ADVERSE_FIRST' | 'BOTH_SAME_CANDLE' | 'NONE';

export type OutcomeWindow = {
  minutes: number;
  entryPrice?: number;
  futureHigh?: number;
  futureLow?: number;
  lastClose?: number;
  mfeRoe?: number;
  maeRoe?: number;
  returnRoe?: number;
  hit5BeforeMinus5?: HitOutcome;
  hit8BeforeMinus8?: HitOutcome;
  hit15BeforeMinus10?: HitOutcome;
};

export type IndicatorSnapshot = {
  ema7?: number;
  ema25?: number;
  ema99?: number;
  emaSlope?: number;
  atr?: number;
  atrPercentile?: number;
  volumeRelative?: number;
  bollingerWidth?: number;
  adx?: number;
  choppiness?: number;
  classification: 'TREND_UP' | 'TREND_DOWN' | 'CHOP' | 'HIGH_VOL_RISK' | 'UNKNOWN';
};

export type MomentumPatternSnapshot = {
  candles: 2 | 3;
  volumeRatio: number;
  closeLocation: number;
  bodyMovePct: number;
  upperWickPct: number;
  lowerWickPct: number;
  overextensionAtr?: number;
};

export type MomentumForwardChecks = {
  nextCandleClosedFavor?: boolean;
  nextTwoCandlesClosedFavor?: boolean;
  immediateReversal?: boolean;
};

export type RegimeAuditEvaluation = {
  timestamp: string;
  timestampMs: number;
  symbol: string;
  side: Side;
  regime: AegisRegimeLabel;
  confidence: number;
  reason: string;
  wouldBlock: boolean;
  allowed: boolean;
  source: string;
  turboScore?: number;
  votes?: AegisTurboVotes;
  setupGrade?: string;
  entryQualityScore?: number | null;
  tailRiskScore?: number | null;
  btcAction?: string;
  btcScore?: number;
  btcVotes?: AegisTurboVotes;
  ethAction?: string;
  ethScore?: number;
  ethVotes?: AegisTurboVotes;
  eventRiskMode?: string;
  eventRiskReason?: string;
  eventRiskWouldBlock?: boolean;
  snapshotAgeSeconds?: number;
  existingEntryPolicyRegime?: Record<string, unknown>;
  indicators?: IndicatorSnapshot;
  indicatorWarning?: string;
  momentumPattern?: MomentumPatternSnapshot;
  turboAgreement?: boolean;
  regimeConfirm?: boolean;
  btcEthConfirm?: boolean;
  btcEthContradict?: boolean;
  forwardChecks?: MomentumForwardChecks;
  outcomes: Record<'15m' | '30m' | '60m', OutcomeWindow>;
};

export type RegimeGroupMetrics = {
  regime: string;
  side?: Side | 'ALL';
  count: number;
  avgMfe15?: number;
  avgMfe30?: number;
  avgMfe60?: number;
  avgMae15?: number;
  avgMae30?: number;
  avgMae60?: number;
  medianMfe60?: number;
  medianMae60?: number;
  hit5BeforeMinus5Rate?: number;
  hit8BeforeMinus8Rate?: number;
  reversalImmediateRate?: number;
  nextCandleFavorRate?: number;
  nextTwoCandlesFavorRate?: number;
  avgFutureReturn60?: number;
  conclusion: 'good' | 'noisy' | 'bad' | 'insufficient';
};

export type SymbolGroupMetrics = {
  symbol: string;
  mostCommonRegime?: string;
  countMomentum: number;
  countChop: number;
  avgMfe60?: number;
  avgMae60?: number;
  bestLabel?: string;
  worstLabel?: string;
  comment: string;
};

export type SpecialCaseAudit = {
  label: string;
  symbol: string;
  tradeId: string;
  side?: Side;
  openedAt?: string;
  closedAt?: string;
  pnlUsdt?: number;
  roe?: number;
  mfeRoe?: number;
  maeRoe?: number;
  regimeAtEntry?: string;
  regimeReason?: string;
  wouldBlockInEnforce?: boolean;
  impact?: 'helped' | 'hurt' | 'neutral' | 'unknown';
  momentumPatternAtEntry?: boolean;
  momentumInterpretation?: string;
};

export type ConfirmationSegmentMetrics = {
  segment: string;
  count: number;
  avgMfe60?: number;
  avgMae60?: number;
  hit8BeforeMinus8Rate?: number;
  avgFutureReturn60?: number;
  nextCandleFavorRate?: number;
  reversalImmediateRate?: number;
};

export type SpecialMomentumWindowAudit = {
  label: string;
  symbol: string;
  from: string;
  to: string;
  patterns: number;
  longPatterns: number;
  shortPatterns: number;
  bestRegime?: string;
  worstRegime?: string;
  avgReturn60?: number;
};

export type RegimeAuditReport = {
  generatedAt: string;
  options: RegimeAuditOptions;
  counts: {
    signalsLoaded: number;
    eventsLoaded: number;
    tradesLoaded: number;
    evaluations: number;
    skippedSignals: number;
    corruptedLines: number;
    candlesBySymbol: Record<string, number>;
  };
  evaluations: RegimeAuditEvaluation[];
  byRegime: RegimeGroupMetrics[];
  byRegimeSide: RegimeGroupMetrics[];
  bySymbol: SymbolGroupMetrics[];
  confirmationSegments: ConfirmationSegmentMetrics[];
  inconsistencies: RegimeAuditEvaluation[];
  specialCases: SpecialCaseAudit[];
  specialMomentumWindows: SpecialMomentumWindowAudit[];
  warnings: string[];
  outputFiles?: {
    jsonl?: string;
    csv?: string;
    markdown?: string;
  };
};

export type RegimeAuditOptions = {
  logsDir?: string;
  candlesDbPath?: string;
  reportsDir?: string;
  days?: number;
  from?: string;
  to?: string;
  symbols?: string[];
  limit?: number;
  leverage?: number;
  writeReports?: boolean;
  includeHold?: boolean;
  timeframe?: string;
  momentumOnly?: boolean;
  momentumCandles?: 2 | 3;
  minVolumeRatio?: number;
};

type TradeRecord = (AegisTurboTradeOpenInput | AegisTurboTradeCloseInput) & { timestamp?: string };
type LoadedJsonl<T> = { rows: T[]; corrupted: number };
type Timed<T> = { row: T; timestampMs: number };

type MatchedMetadata = {
  setupGrade?: string;
  entryQualityScore?: number | null;
  tailRiskScore?: number | null;
  eventRiskMode?: string;
  eventRiskReason?: string;
  eventRiskWouldBlock?: boolean;
  entryPolicyRegime?: Record<string, unknown>;
};

const WINDOWS = [15, 30, 60] as const;
const REPORT_COLUMNS = [
  'timestamp',
  'symbol',
  'side',
  'regime',
  'confidence',
  'reason',
  'wouldBlock',
  'turboScore',
  'setupGrade',
  'entryQualityScore',
  'tailRiskScore',
  'btcAction',
  'ethAction',
  'eventRiskMode',
  'snapshotAgeSeconds',
  'mfeRoe15',
  'maeRoe15',
  'returnRoe15',
  'mfeRoe30',
  'maeRoe30',
  'returnRoe30',
  'mfeRoe60',
  'maeRoe60',
  'returnRoe60',
  'hit5BeforeMinus5',
  'hit8BeforeMinus8',
  'hit15BeforeMinus10',
  'momentumCandles',
  'momentumVolumeRatio',
  'turboAgreement',
  'regimeConfirm',
  'btcEthConfirm',
  'btcEthContradict',
  'nextCandleClosedFavor',
  'nextTwoCandlesClosedFavor',
  'immediateReversal',
  'indicatorClassification',
  'indicatorWarning',
];

export async function auditRegimeGuard(
  options: RegimeAuditOptions = {},
): Promise<RegimeAuditReport> {
  const logsDir = options.logsDir ?? path.join(process.cwd(), 'logs', 'aegis');
  const reportsDir = options.reportsDir ?? path.join(process.cwd(), 'reports');
  const symbols = (options.symbols?.length ? options.symbols : DEFAULT_REGIME_AUDIT_SYMBOLS).map(
    (symbol) => symbol.toUpperCase(),
  );
  const symbolSet = new Set(symbols);
  const dates = await resolveDates(logsDir, options);
  const warnings: string[] = [];
  let corruptedLines = 0;

  const signals: AegisTurboSignalHistoryInput[] = [];
  const events: AegisTurboTradeEventInput[] = [];
  const trades: TradeRecord[] = [];
  for (const date of dates) {
    const loadedSignals = await readJsonl<AegisTurboSignalHistoryInput>(
      path.join(logsDir, `turbo_signals_${date}.jsonl`),
    );
    const loadedEvents = await readJsonl<AegisTurboTradeEventInput>(
      path.join(logsDir, `turbo_trade_events_${date}.jsonl`),
    );
    const loadedTrades = await readJsonl<TradeRecord>(
      path.join(logsDir, `turbo_trades_${date}.jsonl`),
    );
    corruptedLines += loadedSignals.corrupted + loadedEvents.corrupted + loadedTrades.corrupted;
    appendRows(signals, loadedSignals.rows);
    appendRows(events, loadedEvents.rows);
    appendRows(trades, loadedTrades.rows);
  }

  if (corruptedLines > 0) warnings.push(`Skipped ${corruptedLines} corrupted JSONL line(s).`);

  const filteredSignals = signals
    .filter((signal) => symbolSet.has(normalizeSymbol(signal.symbol)))
    .filter((signal) => inTimeRange(signal.timestamp, options.from, options.to))
    .sort((a, b) => parseTimestamp(a.timestamp) - parseTimestamp(b.timestamp));

  const dbPath =
    options.candlesDbPath ?? path.join(process.cwd(), '..', 'data', 'binance_candles.db');
  const candleStore = loadCandles(dbPath, symbols, options.timeframe ?? '5m', warnings);
  const signalIndex = buildTimedIndex(filteredSignals, (signal) => normalizeSymbol(signal.symbol));
  const eventMetadata = events.filter((event) => event.event === 'ENTRY_POLICY_DECISION');
  const eventIndex = buildTimedIndex(eventMetadata, (event) => normalizeSymbol(event.symbol));
  const tradeOpens = trades.filter(isOpenTrade);
  const openTradeIndex = buildTimedIndex(tradeOpens, (trade) => normalizeSymbol(trade.symbol));
  const evaluations: RegimeAuditEvaluation[] = [];
  let skippedSignals = 0;
  const limit = options.limit ?? 2000;

  if (options.momentumOnly) {
    const momentumFrom = options.from ?? (dates[0] ? `${dates[0]}T00:00:00.000Z` : undefined);
    const momentumTo =
      options.to ??
      (dates[dates.length - 1] ? `${dates[dates.length - 1]}T23:59:59.999Z` : undefined);
    const patterns = buildMomentumCandidates(candleStore, {
      symbols,
      from: momentumFrom,
      to: momentumTo,
      candles: options.momentumCandles ?? 3,
      minVolumeRatio: options.minVolumeRatio ?? 1.3,
      limit,
    });
    for (const pattern of patterns) {
      const signal = nearestTimed(
        signalIndex.get(pattern.symbol) ?? [],
        pattern.timestampMs,
        10 * 60_000,
      );
      const evaluation = evaluateCandidate({
        symbol: pattern.symbol,
        timestampMs: pattern.timestampMs,
        side: pattern.side,
        signal,
        signalIndex,
        eventIndex,
        openTradeIndex,
        candleStore,
        leverage: options.leverage ?? numberOrUndefined(signal?.leverage) ?? 20,
        momentumPattern: pattern.snapshot,
      });
      evaluations.push(evaluation);
    }
  } else {
    for (const signal of filteredSignals) {
      if (evaluations.length >= limit) break;
      const timestampMs = parseTimestamp(signal.timestamp);
      const side = resolveSide(signal, options.includeHold === true);
      if (!side || !Number.isFinite(timestampMs)) {
        skippedSignals += 1;
        continue;
      }

      const evaluation = evaluateCandidate({
        symbol: normalizeSymbol(signal.symbol),
        timestampMs,
        side,
        signal,
        signalIndex,
        eventIndex,
        openTradeIndex,
        candleStore,
        leverage: options.leverage ?? numberOrUndefined(signal.leverage) ?? 20,
      });
      evaluations.push(evaluation);
    }
  }

  const report: RegimeAuditReport = {
    generatedAt: new Date().toISOString(),
    options: {
      ...options,
      logsDir,
      candlesDbPath: dbPath,
      reportsDir,
      symbols,
      writeReports: options.writeReports !== false,
    },
    counts: {
      signalsLoaded: filteredSignals.length,
      eventsLoaded: events.length,
      tradesLoaded: trades.length,
      evaluations: evaluations.length,
      skippedSignals,
      corruptedLines,
      candlesBySymbol: Object.fromEntries(
        [...candleStore.entries()].map(([symbol, candles]) => [symbol, candles.length]),
      ),
    },
    evaluations,
    byRegime: buildRegimeMetrics(evaluations),
    byRegimeSide: buildRegimeSideMetrics(evaluations),
    bySymbol: buildSymbolMetrics(evaluations),
    confirmationSegments: buildConfirmationSegments(evaluations),
    inconsistencies: evaluations
      .filter((evaluation) => Boolean(evaluation.indicatorWarning))
      .slice(0, 50),
    specialCases: buildSpecialCases(trades, evaluations, signalIndex),
    specialMomentumWindows: buildSpecialMomentumWindows(evaluations),
    warnings,
  };

  if (options.writeReports !== false) {
    report.outputFiles = await writeAuditReports(report, reportsDir);
  }

  return report;
}

function evaluateCandidate(input: {
  symbol: string;
  timestampMs: number;
  side: Side;
  signal?: AegisTurboSignalHistoryInput;
  signalIndex: Map<string, Timed<AegisTurboSignalHistoryInput>[]>;
  eventIndex: Map<string, Timed<AegisTurboTradeEventInput>[]>;
  openTradeIndex: Map<string, Timed<AegisTurboTradeOpenInput>[]>;
  candleStore: Map<string, CandleRow[]>;
  leverage: number;
  momentumPattern?: MomentumPatternSnapshot;
}): RegimeAuditEvaluation {
  const matched = mergeMetadata(
    nearestTimed(input.eventIndex.get(input.symbol) ?? [], input.timestampMs, 120_000),
    nearestTimed(input.openTradeIndex.get(input.symbol) ?? [], input.timestampMs, 120_000),
  );
  const btcSignal = nearestTimed(
    input.signalIndex.get('BTCUSDT') ?? [],
    input.timestampMs,
    10 * 60_000,
  );
  const ethSignal = nearestTimed(
    input.signalIndex.get('ETHUSDT') ?? [],
    input.timestampMs,
    10 * 60_000,
  );
  const candles = input.candleStore.get(input.symbol) ?? [];
  const decision = AegisRegimeGuard.evaluate({
    symbol: input.symbol,
    side: input.side,
    isAltSymbol: input.symbol !== 'BTCUSDT' && input.symbol !== 'ETHUSDT',
    turboScore: numberOrUndefined(input.signal?.turbo_score),
    votes: normalizeVotes(input.signal?.votes),
    setupGrade: matched.setupGrade,
    entryQualityScore: matched.entryQualityScore,
    tailRiskScore: matched.tailRiskScore,
    eventRiskMode: matched.eventRiskMode,
    eventRiskReason: matched.eventRiskReason,
    eventRiskWouldBlock: matched.eventRiskWouldBlock,
    btcAction: actionOf(btcSignal),
    btcScore: numberOrUndefined(btcSignal?.turbo_score),
    btcVotes: normalizeVotes(btcSignal?.votes),
    ethAction: actionOf(ethSignal),
    ethScore: numberOrUndefined(ethSignal?.turbo_score),
    ethVotes: normalizeVotes(ethSignal?.votes),
    snapshotAgeSeconds: numberOrUndefined(input.signal?.freshness?.snapshot_age_seconds),
    nowMs: input.timestampMs,
    config: liveShadowRegimeConfig(),
  });

  const indicators = calculateIndicators(candles, input.timestampMs);
  return buildEvaluation({
    signal: input.signal ?? syntheticSignal(input.symbol, input.timestampMs),
    timestampMs: input.timestampMs,
    side: input.side,
    decision,
    matched,
    btcSignal,
    ethSignal,
    candles,
    leverage: input.leverage,
    indicators,
    momentumPattern: input.momentumPattern,
  });
}

function syntheticSignal(symbol: string, timestampMs: number): AegisTurboSignalHistoryInput {
  return {
    timestamp: new Date(timestampMs).toISOString(),
    symbol,
    strategy: 'AEGIS_TURBO',
    mode: 'OFFLINE_MOMENTUM_AUDIT',
  };
}

function buildMomentumCandidates(
  candleStore: Map<string, CandleRow[]>,
  options: {
    symbols: string[];
    from?: string;
    to?: string;
    candles: 2 | 3;
    minVolumeRatio: number;
    limit: number;
  },
): Array<{ symbol: string; timestampMs: number; side: Side; snapshot: MomentumPatternSnapshot }> {
  const fromMs = options.from ? parseTimestamp(options.from) : -Infinity;
  const toMs = options.to ? parseTimestamp(options.to) : Infinity;
  const candidates: Array<{
    symbol: string;
    timestampMs: number;
    side: Side;
    snapshot: MomentumPatternSnapshot;
  }> = [];
  for (const symbol of options.symbols) {
    const candles = candleStore.get(symbol) ?? [];
    for (let index = Math.max(20, options.candles - 1); index < candles.length; index += 1) {
      const current = candles[index];
      if (current.timestampMs < fromMs || current.timestampMs > toMs) continue;
      const pattern = detectMomentumPattern(
        candles,
        index,
        options.candles,
        options.minVolumeRatio,
      );
      if (!pattern) continue;
      candidates.push({
        symbol,
        timestampMs: current.timestampMs,
        side: pattern.side,
        snapshot: pattern.snapshot,
      });
    }
  }
  return candidates
    .sort(
      (a, b) =>
        a.timestampMs - b.timestampMs ||
        a.symbol.localeCompare(b.symbol) ||
        a.side.localeCompare(b.side),
    )
    .slice(0, options.limit);
}

export function detectMomentumPattern(
  candles: CandleRow[],
  index: number,
  count: 2 | 3,
  minVolumeRatio: number,
): { side: Side; snapshot: MomentumPatternSnapshot } | undefined {
  if (index < count - 1 || index < 20) return undefined;
  const window = candles.slice(index - count + 1, index + 1);
  const allGreen = window.every((candle) => candle.close > candle.open);
  const allRed = window.every((candle) => candle.close < candle.open);
  const ascendingCloses = window.every(
    (candle, itemIndex) => itemIndex === 0 || candle.close > window[itemIndex - 1].close,
  );
  const descendingCloses = window.every(
    (candle, itemIndex) => itemIndex === 0 || candle.close < window[itemIndex - 1].close,
  );
  const side: Side | undefined =
    allGreen && ascendingCloses ? 'LONG' : allRed && descendingCloses ? 'SHORT' : undefined;
  if (!side) return undefined;

  const previousVolumes = candles
    .slice(Math.max(0, index - 20), index)
    .map((candle) => candle.volume);
  const volumeRatio = ratio(candles[index].volume, avg(previousVolumes));
  if (volumeRatio === undefined || volumeRatio < minVolumeRatio) return undefined;

  const latest = candles[index];
  const range = latest.high - latest.low;
  const closeLocation = range > 0 ? (latest.close - latest.low) / range : 0.5;
  const bodyMovePct = latest.open > 0 ? Math.abs(latest.close - latest.open) / latest.open : 0;
  const upperWickPct = range > 0 ? (latest.high - Math.max(latest.open, latest.close)) / range : 0;
  const lowerWickPct = range > 0 ? (Math.min(latest.open, latest.close) - latest.low) / range : 0;
  const atr = last(atrSeries(candles.slice(Math.max(0, index - 30), index + 1), 14));
  const bodyMove = Math.abs(window[window.length - 1].close - window[0].open);
  return {
    side,
    snapshot: {
      candles: count,
      volumeRatio: round(volumeRatio) ?? volumeRatio,
      closeLocation: round(closeLocation) ?? closeLocation,
      bodyMovePct: round(bodyMovePct) ?? bodyMovePct,
      upperWickPct: round(upperWickPct) ?? upperWickPct,
      lowerWickPct: round(lowerWickPct) ?? lowerWickPct,
      overextensionAtr: atr && atr > 0 ? round(bodyMove / atr) : undefined,
    },
  };
}

export function calculateOutcome(
  candles: CandleRow[],
  timestampMs: number,
  side: Side,
  leverage: number,
  minutes: number,
): OutcomeWindow {
  const entryIndex = findEntryCandleIndex(candles, timestampMs);
  if (entryIndex < 0) return { minutes };

  const entry = candles[entryIndex];
  const endMs = timestampMs + minutes * 60_000;
  const future = candles.slice(entryIndex + 1).filter((candle) => candle.timestampMs <= endMs);
  if (future.length === 0 || entry.close <= 0) {
    return { minutes, entryPrice: entry.close };
  }

  const futureHigh = max(future.map((candle) => candle.high));
  const futureLow = min(future.map((candle) => candle.low));
  const lastClose = future[future.length - 1].close;
  const mfeRoe =
    side === 'LONG'
      ? ((futureHigh - entry.close) / entry.close) * leverage
      : ((entry.close - futureLow) / entry.close) * leverage;
  const maeRoe =
    side === 'LONG'
      ? ((futureLow - entry.close) / entry.close) * leverage
      : ((entry.close - futureHigh) / entry.close) * leverage;
  const returnRoe =
    side === 'LONG'
      ? ((lastClose - entry.close) / entry.close) * leverage
      : ((entry.close - lastClose) / entry.close) * leverage;

  return {
    minutes,
    entryPrice: round(entry.close),
    futureHigh: round(futureHigh),
    futureLow: round(futureLow),
    lastClose: round(lastClose),
    mfeRoe: round(mfeRoe),
    maeRoe: round(maeRoe),
    returnRoe: round(returnRoe),
    hit5BeforeMinus5: hitThresholdBeforeAdverse(future, entry.close, side, leverage, 0.05, 0.05),
    hit8BeforeMinus8: hitThresholdBeforeAdverse(future, entry.close, side, leverage, 0.08, 0.08),
    hit15BeforeMinus10: hitThresholdBeforeAdverse(future, entry.close, side, leverage, 0.15, 0.1),
  };
}

export function hitThresholdBeforeAdverse(
  candles: CandleRow[],
  entryPrice: number,
  side: Side,
  leverage: number,
  targetRoe: number,
  adverseRoe: number,
): HitOutcome {
  if (entryPrice <= 0) return 'NONE';
  for (const candle of candles) {
    const favorable =
      side === 'LONG'
        ? ((candle.high - entryPrice) / entryPrice) * leverage
        : ((entryPrice - candle.low) / entryPrice) * leverage;
    const adverse =
      side === 'LONG'
        ? ((candle.low - entryPrice) / entryPrice) * leverage
        : ((entryPrice - candle.high) / entryPrice) * leverage;
    const hitTarget = favorable >= targetRoe;
    const hitAdverse = adverse <= -adverseRoe;
    if (hitTarget && hitAdverse) return 'BOTH_SAME_CANDLE';
    if (hitTarget) return 'TARGET_FIRST';
    if (hitAdverse) return 'ADVERSE_FIRST';
  }
  return 'NONE';
}

export function calculateIndicators(candles: CandleRow[], timestampMs: number): IndicatorSnapshot {
  const index = findEntryCandleIndex(candles, timestampMs);
  if (index < 100) return { classification: 'UNKNOWN' };

  const history = candles.slice(Math.max(0, index - 180), index + 1);
  const closes = history.map((candle) => candle.close);
  const highs = history.map((candle) => candle.high);
  const lows = history.map((candle) => candle.low);
  const volumes = history.map((candle) => candle.volume);
  const ema7Series = emaSeries(closes, 7);
  const ema25Series = emaSeries(closes, 25);
  const ema99Series = emaSeries(closes, 99);
  const ema7 = last(ema7Series);
  const ema25 = last(ema25Series);
  const ema99 = last(ema99Series);
  const emaSlope =
    ema7Series.length > 8 && ema7 !== undefined
      ? (ema7 - ema7Series[ema7Series.length - 8]) / ema7
      : undefined;
  const atrValues = atrSeries(history, 14);
  const atr = last(atrValues);
  const atrPercentile = atr !== undefined ? percentileRank(atrValues.slice(-100), atr) : undefined;
  const volumeRelative = ratio(last(volumes), avg(volumes.slice(-21, -1)));
  const bollingerWidth = calculateBollingerWidth(closes.slice(-20));
  const choppiness = calculateChoppiness(history.slice(-14));
  const adx = calculateAdx(history.slice(-40), 14);

  let classification: IndicatorSnapshot['classification'] = 'UNKNOWN';
  const trendUp =
    ema7 !== undefined &&
    ema25 !== undefined &&
    ema99 !== undefined &&
    ema7 > ema25 &&
    ema25 > ema99 &&
    (emaSlope ?? 0) > 0;
  const trendDown =
    ema7 !== undefined &&
    ema25 !== undefined &&
    ema99 !== undefined &&
    ema7 < ema25 &&
    ema25 < ema99 &&
    (emaSlope ?? 0) < 0;
  if ((atrPercentile ?? 0) >= 0.85) classification = 'HIGH_VOL_RISK';
  else if ((choppiness ?? 0) >= 61.8 || (adx ?? 100) < 18) classification = 'CHOP';
  else if (trendUp) classification = 'TREND_UP';
  else if (trendDown) classification = 'TREND_DOWN';

  return {
    ema7: round(ema7),
    ema25: round(ema25),
    ema99: round(ema99),
    emaSlope: round(emaSlope),
    atr: round(atr),
    atrPercentile: round(atrPercentile),
    volumeRelative: round(volumeRelative),
    bollingerWidth: round(bollingerWidth),
    adx: round(adx),
    choppiness: round(choppiness),
    classification,
  };
}

export function buildRegimeMetrics(evaluations: RegimeAuditEvaluation[]): RegimeGroupMetrics[] {
  const groups = groupBy(evaluations, (evaluation) => evaluation.regime);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([regime, rows]) => {
      return buildRegimeMetricRow(regime, rows);
    });
}

export function buildRegimeSideMetrics(evaluations: RegimeAuditEvaluation[]): RegimeGroupMetrics[] {
  const groups = groupBy(evaluations, (evaluation) => `${evaluation.side}:${evaluation.regime}`);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rows]) => {
      const [side, regime] = key.split(':') as [Side, string];
      return buildRegimeMetricRow(regime, rows, side);
    });
}

function buildRegimeMetricRow(
  regime: string,
  rows: RegimeAuditEvaluation[],
  side: Side | 'ALL' = 'ALL',
): RegimeGroupMetrics {
  const avgMfe60 = avg(rows.map((row) => row.outcomes['60m'].mfeRoe).filter(isNumber));
  const avgMae60 = avg(rows.map((row) => row.outcomes['60m'].maeRoe).filter(isNumber));
  const hit5 = hitRate(rows.map((row) => row.outcomes['60m'].hit5BeforeMinus5));
  const hit8 = hitRate(rows.map((row) => row.outcomes['60m'].hit8BeforeMinus8));
  return {
    regime,
    side,
    count: rows.length,
    avgMfe15: round(avg(rows.map((row) => row.outcomes['15m'].mfeRoe).filter(isNumber))),
    avgMfe30: round(avg(rows.map((row) => row.outcomes['30m'].mfeRoe).filter(isNumber))),
    avgMfe60: round(avgMfe60),
    avgMae15: round(avg(rows.map((row) => row.outcomes['15m'].maeRoe).filter(isNumber))),
    avgMae30: round(avg(rows.map((row) => row.outcomes['30m'].maeRoe).filter(isNumber))),
    avgMae60: round(avgMae60),
    medianMfe60: round(median(rows.map((row) => row.outcomes['60m'].mfeRoe).filter(isNumber))),
    medianMae60: round(median(rows.map((row) => row.outcomes['60m'].maeRoe).filter(isNumber))),
    hit5BeforeMinus5Rate: round(hit5),
    hit8BeforeMinus8Rate: round(hit8),
    reversalImmediateRate: booleanRate(rows.map((row) => row.forwardChecks?.immediateReversal)),
    nextCandleFavorRate: booleanRate(rows.map((row) => row.forwardChecks?.nextCandleClosedFavor)),
    nextTwoCandlesFavorRate: booleanRate(
      rows.map((row) => row.forwardChecks?.nextTwoCandlesClosedFavor),
    ),
    avgFutureReturn60: round(
      avg(rows.map((row) => row.outcomes['60m'].returnRoe).filter(isNumber)),
    ),
    conclusion: classifyRegime(rows.length, avgMfe60, avgMae60, hit5),
  };
}

export function buildSymbolMetrics(evaluations: RegimeAuditEvaluation[]): SymbolGroupMetrics[] {
  const groups = groupBy(evaluations, (evaluation) => evaluation.symbol);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([symbol, rows]) => {
      const byRegime = buildRegimeMetrics(rows).filter((row) => row.count > 0);
      const ranked = [...byRegime].sort(
        (a, b) => (b.avgFutureReturn60 ?? -Infinity) - (a.avgFutureReturn60 ?? -Infinity),
      );
      const avgMfe60 = avg(rows.map((row) => row.outcomes['60m'].mfeRoe).filter(isNumber));
      const avgMae60 = avg(rows.map((row) => row.outcomes['60m'].maeRoe).filter(isNumber));
      return {
        symbol,
        mostCommonRegime: mostCommon(rows.map((row) => row.regime)),
        countMomentum: rows.filter(
          (row) => row.regime === 'MOMENTUM_UP' || row.regime === 'MOMENTUM_DOWN',
        ).length,
        countChop: rows.filter((row) => row.regime === 'CHOP').length,
        avgMfe60: round(avgMfe60),
        avgMae60: round(avgMae60),
        bestLabel: ranked[0]?.regime,
        worstLabel: ranked[ranked.length - 1]?.regime,
        comment:
          rows.length < 10 || avgMfe60 === undefined || avgMae60 === undefined
            ? 'low_sample'
            : avgMfe60 > Math.abs(avgMae60)
              ? 'favorable_mfe_mae'
              : 'noisy_or_adverse',
      };
    });
}

export function buildConfirmationSegments(
  evaluations: RegimeAuditEvaluation[],
): ConfirmationSegmentMetrics[] {
  const segments: Array<{ name: string; rows: RegimeAuditEvaluation[] }> = [
    { name: 'momentum_pattern_only', rows: evaluations },
    {
      name: 'momentum_pattern + turbo_agreement',
      rows: evaluations.filter((row) => row.turboAgreement),
    },
    {
      name: 'momentum_pattern + regime_confirm',
      rows: evaluations.filter((row) => row.regimeConfirm),
    },
    {
      name: 'momentum_pattern + turbo_agreement + regime_confirm',
      rows: evaluations.filter((row) => row.turboAgreement && row.regimeConfirm),
    },
    {
      name: 'momentum_pattern + turbo_agreement + regime_confirm + BTC/ETH confirm',
      rows: evaluations.filter(
        (row) => row.turboAgreement && row.regimeConfirm && row.btcEthConfirm,
      ),
    },
    {
      name: 'momentum_pattern + BTC/ETH contradict',
      rows: evaluations.filter((row) => row.btcEthContradict),
    },
  ];
  return segments.map((segment) => confirmationMetrics(segment.name, segment.rows));
}

function confirmationMetrics(
  segment: string,
  rows: RegimeAuditEvaluation[],
): ConfirmationSegmentMetrics {
  return {
    segment,
    count: rows.length,
    avgMfe60: round(avg(rows.map((row) => row.outcomes['60m'].mfeRoe).filter(isNumber))),
    avgMae60: round(avg(rows.map((row) => row.outcomes['60m'].maeRoe).filter(isNumber))),
    hit8BeforeMinus8Rate: round(hitRate(rows.map((row) => row.outcomes['60m'].hit8BeforeMinus8))),
    avgFutureReturn60: round(
      avg(rows.map((row) => row.outcomes['60m'].returnRoe).filter(isNumber)),
    ),
    nextCandleFavorRate: booleanRate(rows.map((row) => row.forwardChecks?.nextCandleClosedFavor)),
    reversalImmediateRate: booleanRate(rows.map((row) => row.forwardChecks?.immediateReversal)),
  };
}

function buildEvaluation(input: {
  signal: AegisTurboSignalHistoryInput;
  timestampMs: number;
  side: Side;
  decision: AegisRegimeDecision;
  matched: MatchedMetadata;
  btcSignal?: AegisTurboSignalHistoryInput;
  ethSignal?: AegisTurboSignalHistoryInput;
  candles: CandleRow[];
  leverage: number;
  indicators: IndicatorSnapshot;
  momentumPattern?: MomentumPatternSnapshot;
}): RegimeAuditEvaluation {
  const outcomes = Object.fromEntries(
    WINDOWS.map((minutes) => [
      `${minutes}m`,
      calculateOutcome(input.candles, input.timestampMs, input.side, input.leverage, minutes),
    ]),
  ) as Record<'15m' | '30m' | '60m', OutcomeWindow>;
  const turboAction = actionOf(input.signal);
  const btcAction = actionOf(input.btcSignal);
  const ethAction = actionOf(input.ethSignal);
  return {
    timestamp: new Date(input.timestampMs).toISOString(),
    timestampMs: input.timestampMs,
    symbol: normalizeSymbol(input.signal.symbol),
    side: input.side,
    regime: input.decision.regime,
    confidence: round(input.decision.confidence) ?? input.decision.confidence,
    reason: input.decision.reason,
    wouldBlock: input.decision.wouldBlock,
    allowed: input.decision.allowed,
    source: input.decision.source,
    turboScore: numberOrUndefined(input.signal.turbo_score),
    votes: normalizeVotes(input.signal.votes),
    setupGrade: input.matched.setupGrade,
    entryQualityScore: input.matched.entryQualityScore,
    tailRiskScore: input.matched.tailRiskScore,
    btcAction,
    btcScore: numberOrUndefined(input.btcSignal?.turbo_score),
    btcVotes: normalizeVotes(input.btcSignal?.votes),
    ethAction,
    ethScore: numberOrUndefined(input.ethSignal?.turbo_score),
    ethVotes: normalizeVotes(input.ethSignal?.votes),
    eventRiskMode: input.matched.eventRiskMode,
    eventRiskReason: input.matched.eventRiskReason,
    eventRiskWouldBlock: input.matched.eventRiskWouldBlock,
    snapshotAgeSeconds: numberOrUndefined(input.signal.freshness?.snapshot_age_seconds),
    existingEntryPolicyRegime: input.matched.entryPolicyRegime,
    indicators: input.indicators,
    indicatorWarning: indicatorWarning(input.decision.regime, input.indicators),
    momentumPattern: input.momentumPattern,
    turboAgreement: turboAction === input.side,
    regimeConfirm: regimeConfirmsSide(input.decision.regime, input.side),
    btcEthConfirm: btcEthConfirmsSide(input.side, btcAction, ethAction),
    btcEthContradict: btcEthContradictsSideForActions(input.side, btcAction, ethAction),
    forwardChecks: calculateForwardChecks(input.candles, input.timestampMs, input.side),
    outcomes,
  };
}

function liveShadowRegimeConfig(): AegisRegimeGuardConfig {
  return {
    ...DEFAULT_AEGIS_REGIME_GUARD_CONFIG,
    enabled: true,
    mode: 'SHADOW',
    source: 'HYBRID_HEURISTIC',
    allowWhen: [
      'MOMENTUM_UP',
      'MOMENTUM_DOWN',
      'BREAKOUT_UP',
      'BREAKOUT_DOWN',
      'TREND_UP',
      'TREND_DOWN',
    ],
    blockWhen: ['CHOP', 'EXHAUSTION', 'RISK_OFF', 'HIGH_VOL_RISK', 'UNKNOWN'],
    minConfidence: 0.6,
    maxSnapshotAgeSeconds: 900,
    highTailRiskThreshold: 0.45,
    requireBtcEthAlignmentForAlts: true,
    allowAltLongWhenBtcShort: false,
    allowAltShortWhenBtcLong: false,
    telemetry: {
      logAllEvaluations: true,
      includeInEntryMetadata: true,
    },
  };
}

function loadCandles(
  dbPath: string,
  symbols: string[],
  timeframe: string,
  warnings: string[],
): Map<string, CandleRow[]> {
  const store = new Map<string, CandleRow[]>();
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const stmt = db.prepare(`
            SELECT timestamp, open, high, low, close, volume
            FROM ohlcv_data
            WHERE symbol = ? AND timeframe = ?
            ORDER BY timestamp ASC
        `);
    for (const symbol of symbols) {
      const dbSymbol = toSlashSymbol(symbol);
      const rows = stmt.all(dbSymbol, timeframe) as Array<Record<string, unknown>>;
      store.set(
        symbol,
        rows
          .map((row) => ({
            timestampMs: parseTimestamp(row.timestamp),
            open: numberOrZero(row.open),
            high: numberOrZero(row.high),
            low: numberOrZero(row.low),
            close: numberOrZero(row.close),
            volume: numberOrZero(row.volume),
          }))
          .filter((row) => Number.isFinite(row.timestampMs) && row.close > 0),
      );
    }
    db.close();
  } catch (error) {
    warnings.push(`Could not load candles from ${dbPath}: ${String(error)}`);
  }
  return store;
}

function mergeMetadata(
  event?: AegisTurboTradeEventInput,
  open?: AegisTurboTradeOpenInput,
): MatchedMetadata {
  const eventMetadata = event?.metadata ?? {};
  const entryPolicy = asRecord(eventMetadata.entryPolicy) ?? eventMetadata;
  const guards = asRecord(entryPolicy.guards);
  const traceGuards = asRecord(asRecord(entryPolicy.trace)?.guards);
  const regimeGuard = asRecord(guards?.regime) ?? asRecord(traceGuards?.regime);
  const cleanEntry =
    asRecord(asRecord(open?.metadata)?.cleanEntryGuard) ??
    asRecord(asRecord(guards?.clean_entry)?.metadata) ??
    asRecord(asRecord(traceGuards?.clean_entry)?.metadata);
  const eventRisk = asRecord(guards?.event_risk) ?? asRecord(traceGuards?.event_risk);
  const eventRiskMetadata = asRecord(eventRisk?.metadata);
  return {
    setupGrade: stringOrUndefined(cleanEntry?.setupGrade),
    entryQualityScore: numberOrNull(
      cleanEntry?.entryQualityModelScore ?? cleanEntry?.entryQualityScore,
    ),
    tailRiskScore: numberOrNull(cleanEntry?.tailRiskScore),
    eventRiskMode: stringOrUndefined(cleanEntry?.eventRiskMode ?? eventRiskMetadata?.eventRiskMode),
    eventRiskReason: stringOrUndefined(cleanEntry?.eventRiskReason ?? eventRisk?.reason),
    eventRiskWouldBlock: booleanOrUndefined(
      cleanEntry?.eventRiskWouldBlock ?? eventRisk?.wouldBlock,
    ),
    entryPolicyRegime: regimeGuard,
  };
}

function nearestByTime<T extends { timestamp?: string }>(
  rows: T[],
  timestampMs: number,
  maxDistanceMs: number,
): T | undefined {
  let best: T | undefined;
  let bestDistance = Infinity;
  for (const row of rows) {
    const rowTs = parseTimestamp(row.timestamp);
    const distance = Math.abs(rowTs - timestampMs);
    if (distance < bestDistance && distance <= maxDistanceMs) {
      best = row;
      bestDistance = distance;
    }
  }
  return best;
}

function buildTimedIndex<T extends { timestamp?: string }>(
  rows: T[],
  keyFn: (row: T) => string,
): Map<string, Timed<T>[]> {
  const index = new Map<string, Timed<T>[]>();
  for (const row of rows) {
    const timestampMs = parseTimestamp(row.timestamp);
    if (!Number.isFinite(timestampMs)) continue;
    const key = keyFn(row);
    const rowsForKey = index.get(key);
    if (rowsForKey) rowsForKey.push({ row, timestampMs });
    else index.set(key, [{ row, timestampMs }]);
  }
  for (const rowsForKey of index.values()) {
    rowsForKey.sort((a, b) => a.timestampMs - b.timestampMs);
  }
  return index;
}

function nearestTimed<T>(
  rows: Timed<T>[],
  timestampMs: number,
  maxDistanceMs: number,
): T | undefined {
  if (rows.length === 0) return undefined;
  let low = 0;
  let high = rows.length - 1;
  let insert = rows.length;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (rows[mid].timestampMs >= timestampMs) {
      insert = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  const candidates = [rows[insert - 1], rows[insert]].filter((row): row is Timed<T> =>
    Boolean(row),
  );
  let best: Timed<T> | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.timestampMs - timestampMs);
    if (distance <= maxDistanceMs && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best?.row;
}

function buildSpecialCases(
  trades: TradeRecord[],
  evaluations: RegimeAuditEvaluation[],
  signalIndex: Map<string, Timed<AegisTurboSignalHistoryInput>[]>,
): SpecialCaseAudit[] {
  const opens = trades.filter(isOpenTrade);
  const openById = new Map(opens.map((open) => [open.trade_id, open]));
  const closes = trades.filter(isCloseTrade);
  const cases: Array<{ label: string; close?: AegisTurboTradeCloseInput }> = [
    {
      label: 'ADA perdedora',
      close: latestTrade(
        closes,
        'ADAUSDT',
        (row) => numberOrZero(row.net_pnl_usdt ?? row.pnl_usdt) < 0,
      ),
    },
    {
      label: 'AVAX ganadora',
      close: latestTrade(
        closes,
        'AVAXUSDT',
        (row) => numberOrZero(row.net_pnl_usdt ?? row.pnl_usdt) > 0,
      ),
    },
    {
      label: 'ETH ganadora',
      close: latestTrade(
        closes,
        'ETHUSDT',
        (row) => numberOrZero(row.net_pnl_usdt ?? row.pnl_usdt) > 0,
      ),
    },
    { label: 'LINK ganadora con MAE alto', close: highestMaeTrade(closes, 'LINKUSDT') },
    {
      label: 'SUI ganadora',
      close: latestTrade(
        closes,
        'SUIUSDT',
        (row) => numberOrZero(row.net_pnl_usdt ?? row.pnl_usdt) > 0,
      ),
    },
  ];

  return cases
    .filter((item) => item.close)
    .map((item) => {
      const close = item.close!;
      const open = openById.get(close.trade_id);
      const openedAt = open?.opened_at ?? close.opened_at ?? close.timestamp;
      const openedAtMs = parseTimestamp(openedAt);
      const nearestEval = openedAt
        ? nearestByTime(
            evaluations.filter((evaluation) => evaluation.symbol === normalizeSymbol(close.symbol)),
            parseTimestamp(openedAt),
            10 * 60_000,
          )
        : undefined;
      const fallbackDecision = nearestEval
        ? undefined
        : evaluateSpecialCaseRegime(close, open, signalIndex, openedAtMs);
      const wouldBlock = nearestEval?.wouldBlock;
      const fallbackWouldBlock = fallbackDecision?.wouldBlock;
      const pnl = numberOrUndefined(close.net_pnl_usdt ?? close.pnl_usdt);
      return {
        label: item.label,
        symbol: normalizeSymbol(close.symbol),
        tradeId: close.trade_id,
        side: close.side ?? open?.side,
        openedAt,
        closedAt: close.closed_at,
        pnlUsdt: round(pnl),
        roe: round(numberOrUndefined(close.roe)),
        mfeRoe: round(numberOrUndefined(close.mfe_roe)),
        maeRoe: round(numberOrUndefined(close.mae_roe)),
        regimeAtEntry: nearestEval?.regime ?? fallbackDecision?.regime,
        regimeReason: nearestEval?.reason ?? fallbackDecision?.reason,
        wouldBlockInEnforce: wouldBlock ?? fallbackWouldBlock,
        impact: classifySpecialCaseImpact(pnl, wouldBlock ?? fallbackWouldBlock),
        momentumPatternAtEntry: Boolean(nearestEval?.momentumPattern),
        momentumInterpretation: nearestEval?.momentumPattern
          ? 'trade aligns with offline momentum pattern'
          : 'not classified as original-bot momentum pattern in this audit window',
      };
    });
}

function evaluateSpecialCaseRegime(
  close: AegisTurboTradeCloseInput,
  open: AegisTurboTradeOpenInput | undefined,
  signalIndex: Map<string, Timed<AegisTurboSignalHistoryInput>[]>,
  openedAtMs: number,
): AegisRegimeDecision | undefined {
  if (!Number.isFinite(openedAtMs)) return undefined;
  const symbol = normalizeSymbol(close.symbol);
  const signal = nearestTimed(signalIndex.get(symbol) ?? [], openedAtMs, 10 * 60_000);
  const side = close.side ?? open?.side ?? (signal ? resolveSide(signal, false) : undefined);
  if (!side) return undefined;
  const matched = mergeMetadata(undefined, open);
  const btcSignal = nearestTimed(signalIndex.get('BTCUSDT') ?? [], openedAtMs, 10 * 60_000);
  const ethSignal = nearestTimed(signalIndex.get('ETHUSDT') ?? [], openedAtMs, 10 * 60_000);
  return AegisRegimeGuard.evaluate({
    symbol,
    side,
    isAltSymbol: symbol !== 'BTCUSDT' && symbol !== 'ETHUSDT',
    turboScore: numberOrUndefined(signal?.turbo_score ?? open?.turbo_score),
    votes: normalizeVotes(signal?.votes ?? open?.votes),
    setupGrade: matched.setupGrade,
    entryQualityScore: matched.entryQualityScore,
    tailRiskScore: matched.tailRiskScore,
    eventRiskMode: matched.eventRiskMode,
    eventRiskReason: matched.eventRiskReason,
    eventRiskWouldBlock: matched.eventRiskWouldBlock,
    btcAction: actionOf(btcSignal),
    btcScore: numberOrUndefined(btcSignal?.turbo_score),
    btcVotes: normalizeVotes(btcSignal?.votes),
    ethAction: actionOf(ethSignal),
    ethScore: numberOrUndefined(ethSignal?.turbo_score),
    ethVotes: normalizeVotes(ethSignal?.votes),
    snapshotAgeSeconds: numberOrUndefined(signal?.freshness?.snapshot_age_seconds),
    nowMs: openedAtMs,
    config: liveShadowRegimeConfig(),
  });
}

function classifySpecialCaseImpact(pnl?: number, wouldBlock?: boolean): SpecialCaseAudit['impact'] {
  if (pnl === undefined || wouldBlock === undefined) return 'unknown';
  if (wouldBlock && pnl < 0) return 'helped';
  if (wouldBlock && pnl > 0) return 'hurt';
  return 'neutral';
}

function latestTrade(
  closes: AegisTurboTradeCloseInput[],
  symbol: string,
  predicate: (row: AegisTurboTradeCloseInput) => boolean,
): AegisTurboTradeCloseInput | undefined {
  return closes
    .filter((row) => normalizeSymbol(row.symbol) === symbol && predicate(row))
    .sort(
      (a, b) =>
        parseTimestamp(b.closed_at ?? b.timestamp) - parseTimestamp(a.closed_at ?? a.timestamp),
    )[0];
}

function highestMaeTrade(
  closes: AegisTurboTradeCloseInput[],
  symbol: string,
): AegisTurboTradeCloseInput | undefined {
  return closes
    .filter(
      (row) =>
        normalizeSymbol(row.symbol) === symbol &&
        numberOrZero(row.net_pnl_usdt ?? row.pnl_usdt) > 0,
    )
    .sort((a, b) => Math.abs(numberOrZero(b.mae_roe)) - Math.abs(numberOrZero(a.mae_roe)))[0];
}

function indicatorWarning(
  regime: AegisRegimeLabel,
  indicators: IndicatorSnapshot,
): string | undefined {
  if (indicators.classification === 'UNKNOWN') return undefined;
  if (
    regime === 'MOMENTUM_UP' &&
    (indicators.classification === 'CHOP' || indicators.classification === 'TREND_DOWN')
  ) {
    return 'regime_momentum_up_indicators_chop_or_down';
  }
  if (
    regime === 'MOMENTUM_DOWN' &&
    (indicators.classification === 'CHOP' || indicators.classification === 'TREND_UP')
  ) {
    return 'regime_momentum_down_indicators_chop_or_up';
  }
  if (
    regime === 'CHOP' &&
    (indicators.classification === 'TREND_UP' || indicators.classification === 'TREND_DOWN')
  ) {
    return 'regime_chop_indicators_trend';
  }
  if (regime === 'HIGH_VOL_RISK' && indicators.classification !== 'HIGH_VOL_RISK') {
    return 'regime_high_vol_not_confirmed_by_atr';
  }
  return undefined;
}

function regimeConfirmsSide(regime: AegisRegimeLabel, side: Side): boolean {
  if (side === 'LONG')
    return regime === 'MOMENTUM_UP' || regime === 'TREND_UP' || regime === 'BREAKOUT_UP';
  return regime === 'MOMENTUM_DOWN' || regime === 'TREND_DOWN' || regime === 'BREAKOUT_DOWN';
}

function btcEthConfirmsSide(side: Side, btcAction?: string, ethAction?: string): boolean {
  const expected = side;
  const actions = [normalizeActionText(btcAction), normalizeActionText(ethAction)].filter(
    (value): value is Side => value === 'LONG' || value === 'SHORT',
  );
  return actions.length > 0 && actions.every((action) => action === expected);
}

function btcEthContradictsSideForActions(
  side: Side,
  btcAction?: string,
  ethAction?: string,
): boolean {
  const opposite = side === 'LONG' ? 'SHORT' : 'LONG';
  return normalizeActionText(btcAction) === opposite || normalizeActionText(ethAction) === opposite;
}

function normalizeActionText(value?: string): string | undefined {
  return (
    String(value || '')
      .trim()
      .toUpperCase() || undefined
  );
}

function calculateForwardChecks(
  candles: CandleRow[],
  timestampMs: number,
  side: Side,
): MomentumForwardChecks {
  const index = findEntryCandleIndex(candles, timestampMs);
  if (index < 0) return {};
  const entry = candles[index];
  const next = candles[index + 1];
  const second = candles[index + 2];
  return {
    nextCandleClosedFavor: next ? candleClosedFavor(entry.close, next.close, side) : undefined,
    nextTwoCandlesClosedFavor:
      next && second
        ? candleClosedFavor(entry.close, next.close, side) &&
          candleClosedFavor(next.close, second.close, side)
        : undefined,
    immediateReversal: next ? candleClosedAgainst(entry.close, next.close, side) : undefined,
  };
}

function candleClosedFavor(referenceClose: number, close: number, side: Side): boolean {
  return side === 'LONG' ? close > referenceClose : close < referenceClose;
}

function candleClosedAgainst(referenceClose: number, close: number, side: Side): boolean {
  return side === 'LONG' ? close < referenceClose : close > referenceClose;
}

function buildSpecialMomentumWindows(
  evaluations: RegimeAuditEvaluation[],
): SpecialMomentumWindowAudit[] {
  const windows = [
    {
      label: 'XRPUSDT agosto 2025',
      symbol: 'XRPUSDT',
      from: '2025-08-01T00:00:00.000Z',
      to: '2025-08-31T23:59:59.999Z',
    },
    { label: 'ADA perdedora reciente', symbol: 'ADAUSDT' },
    { label: 'AVAX ganadora reciente', symbol: 'AVAXUSDT' },
    { label: 'ETH ganadora reciente', symbol: 'ETHUSDT' },
    { label: 'LINK ganadora reciente', symbol: 'LINKUSDT' },
    { label: 'SUI ganadora reciente', symbol: 'SUIUSDT' },
  ];
  return windows.map((window) => {
    const symbolRows = evaluations.filter((row) => row.symbol === window.symbol);
    const rows =
      window.from && window.to
        ? symbolRows.filter((row) => row.timestamp >= window.from && row.timestamp <= window.to)
        : symbolRows.slice(-100);
    const ranked = buildRegimeMetrics(rows)
      .filter((row) => row.count > 0)
      .sort((a, b) => (b.avgFutureReturn60 ?? -Infinity) - (a.avgFutureReturn60 ?? -Infinity));
    return {
      label: window.label,
      symbol: window.symbol,
      from: window.from ?? rows[0]?.timestamp ?? 'n/a',
      to: window.to ?? rows[rows.length - 1]?.timestamp ?? 'n/a',
      patterns: rows.length,
      longPatterns: rows.filter((row) => row.side === 'LONG').length,
      shortPatterns: rows.filter((row) => row.side === 'SHORT').length,
      bestRegime: ranked[0]?.regime,
      worstRegime: ranked[ranked.length - 1]?.regime,
      avgReturn60: round(avg(rows.map((row) => row.outcomes['60m'].returnRoe).filter(isNumber))),
    };
  });
}

async function writeAuditReports(
  report: RegimeAuditReport,
  reportsDir: string,
): Promise<RegimeAuditReport['outputFiles']> {
  await fs.mkdir(reportsDir, { recursive: true });
  const stamp = new Date(report.generatedAt).toISOString().replace(/[:.]/g, '-');
  const jsonlPath = path.join(reportsDir, `regime_guard_audit_${stamp}.jsonl`);
  const csvPath = path.join(reportsDir, `regime_guard_audit_${stamp}.csv`);
  const markdownPath = path.join(reportsDir, `regime_guard_audit_summary_${stamp}.md`);
  await fs.writeFile(
    jsonlPath,
    `${report.evaluations.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  );
  await fs.writeFile(csvPath, renderCsv(report.evaluations), 'utf8');
  await fs.writeFile(markdownPath, renderMarkdown(report), 'utf8');
  return { jsonl: jsonlPath, csv: csvPath, markdown: markdownPath };
}

export function renderConsoleSummary(report: RegimeAuditReport): string {
  const lines: string[] = [];
  lines.push(`Aegis Regime Guard audit generated ${report.generatedAt}`);
  lines.push(
    `Mode: ${report.options.momentumOnly ? 'momentum-only offline candidates' : 'turbo-signal audit'}`,
  );
  lines.push(
    `Evaluations: ${report.counts.evaluations} | Signals loaded: ${report.counts.signalsLoaded} | Skipped: ${report.counts.skippedSignals}`,
  );
  if (report.warnings.length > 0) lines.push(`Warnings: ${report.warnings.join('; ')}`);
  lines.push('');
  lines.push('By regime');
  lines.push(
    formatTable(
      report.byRegime.map((row) => ({
        regime: row.regime,
        count: row.count,
        avgMfe60: row.avgMfe60,
        avgMae60: row.avgMae60,
        hit5: row.hit5BeforeMinus5Rate,
        hit8: row.hit8BeforeMinus8Rate,
        avgRet60: row.avgFutureReturn60,
        conclusion: row.conclusion,
      })),
    ),
  );
  lines.push('');
  lines.push('By regime and side');
  lines.push(
    formatTable(
      report.byRegimeSide.map((row) => ({
        side: row.side,
        regime: row.regime,
        count: row.count,
        avgMfe60: row.avgMfe60,
        avgMae60: row.avgMae60,
        hit8: row.hit8BeforeMinus8Rate,
        next1: row.nextCandleFavorRate,
        reversal: row.reversalImmediateRate,
        avgRet60: row.avgFutureReturn60,
        conclusion: row.conclusion,
      })),
    ),
  );
  lines.push('');
  lines.push('By symbol');
  lines.push(
    formatTable(
      report.bySymbol.map((row) => ({
        symbol: row.symbol,
        common: row.mostCommonRegime,
        momentum: row.countMomentum,
        chop: row.countChop,
        avgMfe60: row.avgMfe60,
        avgMae60: row.avgMae60,
        best: row.bestLabel,
        worst: row.worstLabel,
        comment: row.comment,
      })),
    ),
  );
  lines.push('');
  lines.push('Confirmation segments');
  lines.push(
    formatTable(
      report.confirmationSegments.map((row) => ({
        segment: row.segment,
        count: row.count,
        avgMfe60: row.avgMfe60,
        avgMae60: row.avgMae60,
        hit8: row.hit8BeforeMinus8Rate,
        next1: row.nextCandleFavorRate,
        reversal: row.reversalImmediateRate,
        avgRet60: row.avgFutureReturn60,
      })),
    ),
  );
  lines.push('');
  lines.push('Momentum recommendations');
  lines.push(renderMomentumRecommendation(report));
  lines.push('');
  lines.push(`Indicator inconsistencies sampled: ${report.inconsistencies.length}`);
  if (report.specialCases.length > 0) {
    lines.push('');
    lines.push('Special cases');
    lines.push(
      formatTable(
        report.specialCases.map((row) => ({
          label: row.label,
          symbol: row.symbol,
          side: row.side,
          pnl: row.pnlUsdt,
          roe: row.roe,
          mfe: row.mfeRoe,
          mae: row.maeRoe,
          regime: row.regimeAtEntry,
          momentumType: row.momentumPatternAtEntry,
          wouldBlock: row.wouldBlockInEnforce,
          impact: row.impact,
        })),
      ),
    );
  }
  if (report.specialMomentumWindows.length > 0) {
    lines.push('');
    lines.push('Special momentum windows');
    lines.push(
      formatTable(
        report.specialMomentumWindows.map((row) => ({
          label: row.label,
          symbol: row.symbol,
          patterns: row.patterns,
          long: row.longPatterns,
          short: row.shortPatterns,
          best: row.bestRegime,
          worst: row.worstRegime,
          avgRet60: row.avgReturn60,
        })),
      ),
    );
  }
  if (report.outputFiles) {
    lines.push('');
    lines.push(`Reports: ${Object.values(report.outputFiles).filter(Boolean).join(', ')}`);
  }
  return lines.join('\n');
}

function renderMomentumRecommendation(report: RegimeAuditReport): string {
  const longRows = report.byRegimeSide.filter((row) => row.side === 'LONG' && row.count >= 10);
  const shortRows = report.byRegimeSide.filter((row) => row.side === 'SHORT' && row.count >= 10);
  const longAllow = recommendedRegimes(longRows, true);
  const longBlock = recommendedRegimes(longRows, false);
  const shortAllow = recommendedRegimes(shortRows, true);
  const shortBlock = recommendedRegimes(shortRows, false);
  const base = report.confirmationSegments.find((row) => row.segment === 'momentum_pattern_only');
  const turboRegime = report.confirmationSegments.find(
    (row) => row.segment === 'momentum_pattern + turbo_agreement + regime_confirm',
  );
  const btcEth = report.confirmationSegments.find(
    (row) =>
      row.segment === 'momentum_pattern + turbo_agreement + regime_confirm + BTC/ETH confirm',
  );
  return [
    `LONG allow candidates: ${longAllow.join(', ') || 'none with enough sample'} | block candidates: ${longBlock.join(', ') || 'none with enough sample'}`,
    `SHORT allow candidates: ${shortAllow.join(', ') || 'none with enough sample'} | block candidates: ${shortBlock.join(', ') || 'none with enough sample'}`,
    `Turbo+Regime vs momentum-only avgRet60: ${base?.avgFutureReturn60 ?? 'n/a'} -> ${turboRegime?.avgFutureReturn60 ?? 'n/a'}`,
    `+ BTC/ETH confirm avgRet60: ${btcEth?.avgFutureReturn60 ?? 'n/a'}`,
  ].join('\n');
}

function recommendedRegimes(rows: RegimeGroupMetrics[], allow: boolean): string[] {
  return rows
    .filter((row) => {
      const hit8 = row.hit8BeforeMinus8Rate ?? 0;
      const avgRet = row.avgFutureReturn60 ?? 0;
      const reversal = row.reversalImmediateRate ?? 1;
      return allow
        ? avgRet > 0 && hit8 >= 0.48 && reversal <= 0.52
        : avgRet < 0 || hit8 < 0.4 || reversal > 0.6;
    })
    .sort((a, b) => (b.avgFutureReturn60 ?? -Infinity) - (a.avgFutureReturn60 ?? -Infinity))
    .map((row) => row.regime);
}

function renderMarkdown(report: RegimeAuditReport): string {
  const lines: string[] = [];
  lines.push(`# Aegis Regime Guard Audit`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Evaluations: ${report.counts.evaluations}`);
  lines.push('');
  lines.push(`## By Regime`);
  lines.push(markdownTable(report.byRegime));
  lines.push('');
  lines.push(`## By Regime And Side`);
  lines.push(markdownTable(report.byRegimeSide));
  lines.push('');
  lines.push(`## By Symbol`);
  lines.push(markdownTable(report.bySymbol));
  lines.push('');
  lines.push(`## Confirmation Segments`);
  lines.push(markdownTable(report.confirmationSegments));
  lines.push('');
  lines.push(`## Momentum Windows`);
  lines.push(markdownTable(report.specialMomentumWindows));
  lines.push('');
  lines.push(`## Indicator Inconsistencies`);
  lines.push(
    markdownTable(
      report.inconsistencies.slice(0, 25).map((row) => ({
        timestamp: row.timestamp,
        symbol: row.symbol,
        side: row.side,
        regime: row.regime,
        indicator: row.indicators?.classification,
        warning: row.indicatorWarning,
      })),
    ),
  );
  lines.push('');
  lines.push(`## Special Cases`);
  lines.push(markdownTable(report.specialCases));
  lines.push('');
  if (report.warnings.length > 0) {
    lines.push(`## Warnings`);
    lines.push(...report.warnings.map((warning) => `- ${warning}`));
  }
  return `${lines.join('\n')}\n`;
}

function renderCsv(evaluations: RegimeAuditEvaluation[]): string {
  const rows = [REPORT_COLUMNS.join(',')];
  for (const row of evaluations) {
    const values: Record<string, unknown> = {
      timestamp: row.timestamp,
      symbol: row.symbol,
      side: row.side,
      regime: row.regime,
      confidence: row.confidence,
      reason: row.reason,
      wouldBlock: row.wouldBlock,
      turboScore: row.turboScore,
      setupGrade: row.setupGrade,
      entryQualityScore: row.entryQualityScore,
      tailRiskScore: row.tailRiskScore,
      btcAction: row.btcAction,
      ethAction: row.ethAction,
      eventRiskMode: row.eventRiskMode,
      snapshotAgeSeconds: row.snapshotAgeSeconds,
      mfeRoe15: row.outcomes['15m'].mfeRoe,
      maeRoe15: row.outcomes['15m'].maeRoe,
      returnRoe15: row.outcomes['15m'].returnRoe,
      mfeRoe30: row.outcomes['30m'].mfeRoe,
      maeRoe30: row.outcomes['30m'].maeRoe,
      returnRoe30: row.outcomes['30m'].returnRoe,
      mfeRoe60: row.outcomes['60m'].mfeRoe,
      maeRoe60: row.outcomes['60m'].maeRoe,
      returnRoe60: row.outcomes['60m'].returnRoe,
      hit5BeforeMinus5: row.outcomes['60m'].hit5BeforeMinus5,
      hit8BeforeMinus8: row.outcomes['60m'].hit8BeforeMinus8,
      hit15BeforeMinus10: row.outcomes['60m'].hit15BeforeMinus10,
      momentumCandles: row.momentumPattern?.candles,
      momentumVolumeRatio: row.momentumPattern?.volumeRatio,
      turboAgreement: row.turboAgreement,
      regimeConfirm: row.regimeConfirm,
      btcEthConfirm: row.btcEthConfirm,
      btcEthContradict: row.btcEthContradict,
      nextCandleClosedFavor: row.forwardChecks?.nextCandleClosedFavor,
      nextTwoCandlesClosedFavor: row.forwardChecks?.nextTwoCandlesClosedFavor,
      immediateReversal: row.forwardChecks?.immediateReversal,
      indicatorClassification: row.indicators?.classification,
      indicatorWarning: row.indicatorWarning,
    };
    rows.push(REPORT_COLUMNS.map((column) => csvCell(values[column])).join(','));
  }
  return `${rows.join('\n')}\n`;
}

async function resolveDates(logsDir: string, options: RegimeAuditOptions): Promise<string[]> {
  const files = await fs.readdir(logsDir).catch(() => []);
  const dates = files
    .map((file) => /^turbo_signals_(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file)?.[1])
    .filter((date): date is string => Boolean(date))
    .sort();
  const from = options.from ? options.from.slice(0, 10) : undefined;
  const to = options.to ? options.to.slice(0, 10) : undefined;
  const ranged = dates.filter((date) => (!from || date >= from) && (!to || date <= to));
  if (options.days && options.days > 0) return ranged.slice(-options.days);
  return ranged.slice(-7);
}

async function readJsonl<T>(filePath: string): Promise<LoadedJsonl<T>> {
  const text = await fs.readFile(filePath, 'utf8').catch(() => '');
  if (!text.trim()) return { rows: [], corrupted: 0 };
  const rows: T[] = [];
  let corrupted = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      corrupted += 1;
    }
  }
  return { rows, corrupted };
}

function appendRows<T>(target: T[], rows: T[]): void {
  for (const row of rows) target.push(row);
}

function findEntryCandleIndex(candles: CandleRow[], timestampMs: number): number {
  if (candles.length === 0) return -1;
  let low = 0;
  let high = candles.length - 1;
  let best = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (candles[mid].timestampMs <= timestampMs) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best >= 0 ? best : 0;
}

function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const output = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    output.push(values[i] * k + output[i - 1] * (1 - k));
  }
  return output;
}

function atrSeries(candles: CandleRow[], period: number): number[] {
  if (candles.length < 2) return [];
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const prevClose = candles[i - 1].close;
    trs.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - prevClose),
        Math.abs(candles[i].low - prevClose),
      ),
    );
  }
  return rollingAverage(trs, period);
}

function calculateBollingerWidth(values: number[]): number | undefined {
  if (values.length < 20) return undefined;
  const mean = avg(values);
  if (!mean) return undefined;
  const variance = avg(values.map((value) => (value - mean) ** 2));
  if (variance === undefined) return undefined;
  const std = Math.sqrt(variance);
  return (4 * std) / mean;
}

function calculateChoppiness(candles: CandleRow[]): number | undefined {
  if (candles.length < 14) return undefined;
  const trSum = atrSeries(candles, 1).reduce((acc, value) => acc + value, 0);
  const range =
    max(candles.map((candle) => candle.high)) - min(candles.map((candle) => candle.low));
  if (!range || range <= 0 || trSum <= 0) return undefined;
  return (100 * Math.log10(trSum / range)) / Math.log10(candles.length);
}

function calculateAdx(candles: CandleRow[], period: number): number | undefined {
  if (candles.length < period + 2) return undefined;
  const dxValues: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    if (tr <= 0) continue;
    const plusDi = (plusDm / tr) * 100;
    const minusDi = (minusDm / tr) * 100;
    const denom = plusDi + minusDi;
    if (denom > 0) dxValues.push((Math.abs(plusDi - minusDi) / denom) * 100);
  }
  return avg(dxValues.slice(-period));
}

function rollingAverage(values: number[], period: number): number[] {
  const output: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const start = Math.max(0, i - period + 1);
    output.push(avg(values.slice(start, i + 1)) ?? 0);
  }
  return output;
}

function resolveSide(signal: AegisTurboSignalHistoryInput, includeHold: boolean): Side | undefined {
  const action = actionOf(signal);
  if (action === 'LONG' || action === 'SHORT') return action;
  if (includeHold && (signal.raw_action === 'LONG' || signal.raw_action === 'SHORT'))
    return signal.raw_action;
  return undefined;
}

function actionOf(signal?: AegisTurboSignalHistoryInput): string | undefined {
  if (!signal) return undefined;
  return (
    stringOrUndefined(signal.final_action) ??
    stringOrUndefined(signal.gated_action) ??
    stringOrUndefined(signal.raw_action)
  );
}

function isOpenTrade(trade: TradeRecord): trade is AegisTurboTradeOpenInput {
  return trade.status === 'OPEN';
}

function isCloseTrade(trade: TradeRecord): trade is AegisTurboTradeCloseInput {
  return trade.status === 'CLOSED';
}

function inTimeRange(timestamp: unknown, from?: string, to?: string): boolean {
  const ts = parseTimestamp(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (from && ts < parseTimestamp(from)) return false;
  if (to && ts > parseTimestamp(to)) return false;
  return true;
}

function parseTimestamp(value: unknown): number {
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value;
  if (value instanceof Date) return value.getTime();
  const text = String(value || '').trim();
  if (!text) return NaN;
  const parsed = Date.parse(
    text.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}Z`,
  );
  return parsed;
}

function normalizeSymbol(symbol: string): string {
  return String(symbol || '')
    .toUpperCase()
    .replace('/', '');
}

function toSlashSymbol(symbol: string): string {
  const normalized = normalizeSymbol(symbol);
  return normalized.endsWith('USDT') ? `${normalized.slice(0, -4)}/USDT` : normalized;
}

function normalizeVotes(value: unknown): AegisTurboVotes | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const votes = {
    long: numberOrUndefined(record.long),
    short: numberOrUndefined(record.short),
    neutral: numberOrUndefined(record.neutral),
  };
  return votes.long === undefined && votes.short === undefined && votes.neutral === undefined
    ? undefined
    : votes;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  return numberOrUndefined(value);
}

function numberOrZero(value: unknown): number {
  return numberOrUndefined(value) ?? 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function sum(a: number, b: number): number {
  return a + b;
}

function avg(values: number[]): number | undefined {
  return values.length > 0 ? values.reduce(sum, 0) / values.length : undefined;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function min(values: number[]): number {
  return Math.min(...values);
}

function max(values: number[]): number {
  return Math.max(...values);
}

function last<T>(values: T[]): T | undefined {
  return values[values.length - 1];
}

function ratio(numerator?: number, denominator?: number): number | undefined {
  if (numerator === undefined || denominator === undefined || denominator === 0) return undefined;
  return numerator / denominator;
}

function percentileRank(values: number[], value: number): number | undefined {
  const clean = values.filter(isNumber);
  if (clean.length === 0) return undefined;
  return clean.filter((item) => item <= value).length / clean.length;
}

function hitRate(values: Array<HitOutcome | undefined>): number | undefined {
  const known = values.filter((value): value is HitOutcome => Boolean(value));
  if (known.length === 0) return undefined;
  return known.filter((value) => value === 'TARGET_FIRST').length / known.length;
}

function booleanRate(values: Array<boolean | undefined>): number | undefined {
  const known = values.filter((value): value is boolean => typeof value === 'boolean');
  if (known.length === 0) return undefined;
  return round(known.filter(Boolean).length / known.length);
}

function classifyRegime(
  count: number,
  avgMfe?: number,
  avgMae?: number,
  hit5?: number,
): RegimeGroupMetrics['conclusion'] {
  if (count < 10 || avgMfe === undefined || avgMae === undefined) return 'insufficient';
  if (avgMfe > Math.abs(avgMae) * 1.25 && (hit5 ?? 0) >= 0.52) return 'good';
  if (avgMfe < Math.abs(avgMae) * 0.85 && (hit5 ?? 1) < 0.45) return 'bad';
  return 'noisy';
}

function groupBy<T>(rows: T[], keyFn: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFn(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function round(value: unknown, digits = 6): number | undefined {
  if (!isNumber(value)) return undefined;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatTable(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '(no rows)';
  const columns = Object.keys(rows[0]);
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => String(row[column] ?? '').length)),
  );
  const header = columns.map((column, index) => column.padEnd(widths[index])).join('  ');
  const body = rows.map((row) =>
    columns.map((column, index) => String(row[column] ?? '').padEnd(widths[index])).join('  '),
  );
  return [header, columns.map((_, index) => '-'.repeat(widths[index])).join('  '), ...body].join(
    '\n',
  );
}

function markdownTable(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '_No rows._';
  const columns = Object.keys(rows[0]);
  const header = `| ${columns.join(' | ')} |`;
  const separator = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map(
    (row) => `| ${columns.map((column) => String(row[column] ?? '')).join(' | ')} |`,
  );
  return [header, separator, ...body].join('\n');
}
