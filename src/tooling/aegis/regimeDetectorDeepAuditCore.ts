import { promises as fs } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { Side } from '../../domain/types';

export const DEFAULT_DEEP_REGIME_SYMBOLS = [
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
    'LTCUSDT'
];

export type TechnicalRegimeLabel =
    | 'MOMENTUM_UP'
    | 'MOMENTUM_DOWN'
    | 'BREAKOUT_UP'
    | 'BREAKOUT_DOWN'
    | 'TREND_UP'
    | 'TREND_DOWN'
    | 'CHOP'
    | 'EXHAUSTION'
    | 'HIGH_VOL_RISK'
    | 'UNKNOWN';

export type MarketConfirmation = 'CONFIRM' | 'NEUTRAL' | 'MIXED' | 'CONTRADICT' | 'UNKNOWN';

export type CandleRow = {
    timestampMs: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
};

export type TechnicalRegimeSnapshot = {
    technicalRegime: TechnicalRegimeLabel;
    confidence: number;
    direction: Side | 'NONE';
    strength: number;
    reason: string;
    ema7?: number;
    ema25?: number;
    ema99?: number;
    emaSlope?: number;
    adx?: number;
    choppiness?: number;
    atr?: number;
    atrPercentile?: number;
    bollingerWidth?: number;
    volumeRatio?: number;
    closeLocation?: number;
    bodyPct?: number;
    wickAgainstPct?: number;
    rangeBreakout?: 'UP' | 'DOWN' | 'NONE';
    exhaustionRisk: number;
    volatilityRisk: number;
};

export type TechnicalRegimeThresholds = {
    minAdxForMomentum: number;
    maxChoppinessForMomentum: number;
    minVolumeRatioForMomentum: number;
    maxAtrPercentileForAggressive: number;
    maxExhaustionScore: number;
    breakoutLookback: number;
    emaSlopeThreshold: number;
};

export const DEFAULT_TECHNICAL_REGIME_THRESHOLDS: TechnicalRegimeThresholds = {
    minAdxForMomentum: 20,
    maxChoppinessForMomentum: 55,
    minVolumeRatioForMomentum: 1.2,
    maxAtrPercentileForAggressive: 0.92,
    maxExhaustionScore: 0.72,
    breakoutLookback: 20,
    emaSlopeThreshold: 0
};

export type DeepRegimeOutcome = {
    horizonMinutes: number;
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
};

export type HitOutcome = 'TARGET_FIRST' | 'ADVERSE_FIRST' | 'BOTH_SAME_CANDLE' | 'NONE';

export type DeepRegimeSample = {
    timestamp: string;
    timestampMs: number;
    month: string;
    symbol: string;
    side: Side;
    technicalRegime: TechnicalRegimeLabel;
    confidence: number;
    direction: Side | 'NONE';
    strength: number;
    marketConfirmation: MarketConfirmation;
    btcTechnicalRegime?: TechnicalRegimeLabel;
    ethTechnicalRegime?: TechnicalRegimeLabel;
    finalRegimeForMomentum: 'ALLOW' | 'BLOCK' | 'NEUTRAL';
    reason: string;
    indicators: TechnicalRegimeSnapshot;
    outcomes: Record<'15m' | '30m' | '60m' | '120m', DeepRegimeOutcome>;
};

export type DeepRegimeMetricRow = {
    bucket: string;
    regime?: string;
    symbol?: string;
    side?: Side | 'ALL';
    horizon: string;
    count: number;
    avgForwardReturnRoe?: number;
    medianForwardReturnRoe?: number;
    avgMfeRoe?: number;
    avgMaeRoe?: number;
    mfeMaeRatio?: number;
    hit5BeforeMinus5Rate?: number;
    hit8BeforeMinus5Rate?: number;
    hit10BeforeMinus8Rate?: number;
    avgTimeTo5Minutes?: number;
    avgTimeTo8Minutes?: number;
    avgTimeTo10Minutes?: number;
    falseBreakoutRate?: number;
    worstMaeP75?: number;
    worstMaeP90?: number;
    worstMaeP95?: number;
    conclusion: 'good' | 'bad' | 'mixed' | 'insufficient';
};

export type DeepRegimeAuditReport = {
    generatedAt: string;
    options: Required<Pick<DeepRegimeAuditOptions, 'timeframe' | 'leverage' | 'sampleEvery'>> & DeepRegimeAuditOptions;
    counts: {
        candlesBySymbol: Record<string, number>;
        samples: number;
        unknownSamples: number;
        chopSamples: number;
        directionalSamples: number;
    };
    byRegime: DeepRegimeMetricRow[];
    byRegimeSide: DeepRegimeMetricRow[];
    bySymbol: DeepRegimeMetricRow[];
    bySymbolRegimeSide: DeepRegimeMetricRow[];
    byMonthRegime: DeepRegimeMetricRow[];
    byMarketConfirmation: DeepRegimeMetricRow[];
    unknownBreakdown: Record<string, number>;
    chopBreakdown: Record<string, number>;
    recommendations: string[];
    warnings: string[];
    outputFiles?: {
        markdown: string;
        json: string;
        csv: string;
        recommendations: string;
    };
};

export type DeepRegimeAuditOptions = {
    candlesDbPath?: string;
    reportsDir?: string;
    symbols?: string[];
    timeframe?: string;
    from?: string;
    to?: string;
    limit?: number;
    sampleEvery?: number;
    leverage?: number;
    writeReports?: boolean;
    thresholds?: Partial<TechnicalRegimeThresholds>;
};

const HORIZONS = [15, 30, 60, 120] as const;

export async function auditRegimeDetectorDeep(options: DeepRegimeAuditOptions = {}): Promise<DeepRegimeAuditReport> {
    const symbols = (options.symbols?.length ? options.symbols : DEFAULT_DEEP_REGIME_SYMBOLS)
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean);
    const timeframe = options.timeframe ?? '5m';
    const leverage = finiteOr(options.leverage, 20);
    const sampleEvery = Math.max(1, Math.floor(finiteOr(options.sampleEvery, 3)));
    const dbPath = options.candlesDbPath ?? path.join(process.cwd(), '..', 'data', 'binance_candles.db');
    const reportsDir = options.reportsDir ?? '/home/jasan/Develop';
    const warnings: string[] = [];
    const fromMs = options.from ? parseTimestamp(options.from) : -Infinity;
    const toMs = options.to ? parseTimestamp(options.to) : Infinity;
    const thresholds = normalizeThresholds(options.thresholds);
    const candlesBySymbol = loadCandles(dbPath, symbols, timeframe, warnings, fromMs, toMs);
    const snapshotsBySymbol = buildSnapshotsBySymbol(candlesBySymbol, thresholds);
    const samples: DeepRegimeSample[] = [];
    const limit = options.limit ?? Infinity;

    for (const symbol of symbols) {
        const candles = candlesBySymbol.get(symbol) ?? [];
        const snapshots = snapshotsBySymbol.get(symbol) ?? [];
        for (let index = 120; index < candles.length && samples.length < limit; index += sampleEvery) {
            const candle = candles[index];
            if (candle.timestampMs < fromMs || candle.timestampMs > toMs) continue;
            const snapshot = snapshots[index];
            if (!snapshot) continue;
            const sides: Side[] = snapshot.direction === 'LONG' ? ['LONG']
                : snapshot.direction === 'SHORT' ? ['SHORT']
                    : ['LONG', 'SHORT'];
            for (const side of sides) {
                if (samples.length >= limit) break;
                samples.push(buildSample({
                    symbol,
                    side,
                    index,
                    candle,
                    candles,
                    snapshot,
                    snapshotsBySymbol,
                    leverage
                }));
            }
        }
    }

    const report: DeepRegimeAuditReport = {
        generatedAt: new Date().toISOString(),
        options: {
            ...options,
            candlesDbPath: dbPath,
            reportsDir,
            symbols,
            timeframe,
            leverage,
            sampleEvery,
            thresholds,
            writeReports: options.writeReports !== false
        },
        counts: {
            candlesBySymbol: Object.fromEntries(symbols.map((symbol) => [symbol, candlesBySymbol.get(symbol)?.length ?? 0])),
            samples: samples.length,
            unknownSamples: samples.filter((sample) => sample.technicalRegime === 'UNKNOWN').length,
            chopSamples: samples.filter((sample) => sample.technicalRegime === 'CHOP').length,
            directionalSamples: samples.filter((sample) => sample.direction !== 'NONE').length
        },
        byRegime: buildMetricRows(samples, 'regime'),
        byRegimeSide: buildMetricRows(samples, 'regimeSide'),
        bySymbol: buildMetricRows(samples, 'symbol'),
        bySymbolRegimeSide: buildMetricRows(samples, 'symbolRegimeSide'),
        byMonthRegime: buildMetricRows(samples, 'monthRegime'),
        byMarketConfirmation: buildMetricRows(samples, 'marketConfirmation'),
        unknownBreakdown: breakdownReasons(samples.filter((sample) => sample.technicalRegime === 'UNKNOWN')),
        chopBreakdown: breakdownReasons(samples.filter((sample) => sample.technicalRegime === 'CHOP')),
        recommendations: buildRecommendations(samples),
        warnings
    };

    if (options.writeReports !== false) {
        report.outputFiles = await writeReports(report, samples, reportsDir);
    }
    return report;
}

function buildSample(input: {
    symbol: string;
    side: Side;
    index: number;
    candle: CandleRow;
    candles: CandleRow[];
    snapshot: TechnicalRegimeSnapshot;
    snapshotsBySymbol: Map<string, TechnicalRegimeSnapshot[]>;
    leverage: number;
}): DeepRegimeSample {
    const btcSnapshot = nearestSnapshot(input.snapshotsBySymbol.get('BTCUSDT'), input.index);
    const ethSnapshot = nearestSnapshot(input.snapshotsBySymbol.get('ETHUSDT'), input.index);
    const marketConfirmation = classifyMarketConfirmation(input.side, input.symbol, btcSnapshot, ethSnapshot);
    const outcomes = Object.fromEntries(HORIZONS.map((horizon) => [
        `${horizon}m`,
        calculateOutcome(input.candles, input.index, input.side, input.leverage, horizon, input.snapshot)
    ])) as Record<'15m' | '30m' | '60m' | '120m', DeepRegimeOutcome>;
    return {
        timestamp: new Date(input.candle.timestampMs).toISOString(),
        timestampMs: input.candle.timestampMs,
        month: new Date(input.candle.timestampMs).toISOString().slice(0, 7),
        symbol: input.symbol,
        side: input.side,
        technicalRegime: input.snapshot.technicalRegime,
        confidence: input.snapshot.confidence,
        direction: input.snapshot.direction,
        strength: input.snapshot.strength,
        marketConfirmation,
        btcTechnicalRegime: btcSnapshot?.technicalRegime,
        ethTechnicalRegime: ethSnapshot?.technicalRegime,
        finalRegimeForMomentum: finalRegimeForMomentum(input.side, input.snapshot, marketConfirmation),
        reason: input.snapshot.reason,
        indicators: input.snapshot,
        outcomes
    };
}

export function classifyTechnicalRegime(
    candles: CandleRow[],
    index: number,
    thresholds: TechnicalRegimeThresholds = DEFAULT_TECHNICAL_REGIME_THRESHOLDS
): TechnicalRegimeSnapshot {
    if (index < 100) {
        return baseSnapshot('UNKNOWN', 0.1, 'NONE', 'insufficient_history', {});
    }
    const history = candles.slice(Math.max(0, index - 180), index + 1);
    const current = candles[index];
    const previous = candles[index - 1];
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
    const emaSlope = ema7 !== undefined && ema7Series.length > 8 ? (ema7 - ema7Series[ema7Series.length - 8]) / ema7 : undefined;
    const atrValues = atrSeries(history, 14);
    const atr = last(atrValues);
    const atrPercentile = atr !== undefined ? percentileRank(atrValues.slice(-100), atr) : undefined;
    const adx = calculateAdx(history.slice(-40), 14);
    const choppiness = calculateChoppiness(history.slice(-14));
    const volumeRatio = ratio(last(volumes), avg(volumes.slice(-21, -1)));
    const bollingerWidth = calculateBollingerWidth(closes.slice(-20));
    const range = current.high - current.low;
    const closeLocation = range > 0 ? (current.close - current.low) / range : 0.5;
    const bodyPct = current.open > 0 ? Math.abs(current.close - current.open) / current.open : 0;
    const upStack = ema7 !== undefined && ema25 !== undefined && ema99 !== undefined && ema7 > ema25 && ema25 > ema99;
    const downStack = ema7 !== undefined && ema25 !== undefined && ema99 !== undefined && ema7 < ema25 && ema25 < ema99;
    const recentHigh = max(highs.slice(-(thresholds.breakoutLookback + 1), -1));
    const recentLow = min(lows.slice(-(thresholds.breakoutLookback + 1), -1));
    const breakoutUp = recentHigh !== undefined && current.close > recentHigh;
    const breakoutDown = recentLow !== undefined && current.close < recentLow;
    const rangeBreakout: 'UP' | 'DOWN' | 'NONE' = breakoutUp ? 'UP' : breakoutDown ? 'DOWN' : 'NONE';
    const wickAgainstPct = wickAgainst(current, upStack || breakoutUp ? 'LONG' : downStack || breakoutDown ? 'SHORT' : 'LONG');
    const overextensionAtr = atr && ema25 ? Math.abs(current.close - ema25) / atr : 0;
    const exhaustionRisk = clamp01(Math.max(
        atrPercentile !== undefined && atrPercentile >= 0.9 ? atrPercentile : 0,
        overextensionAtr >= 3 ? Math.min(1, overextensionAtr / 5) : 0,
        wickAgainstPct >= 0.5 && (volumeRatio ?? 0) >= 1.8 ? wickAgainstPct : 0
    ));
    const volatilityRisk = clamp01(atrPercentile ?? 0);
    const indicators = {
        ema7: round(ema7),
        ema25: round(ema25),
        ema99: round(ema99),
        emaSlope: round(emaSlope),
        adx: round(adx),
        choppiness: round(choppiness),
        atr: round(atr),
        atrPercentile: round(atrPercentile),
        bollingerWidth: round(bollingerWidth),
        volumeRatio: round(volumeRatio),
        closeLocation: round(closeLocation),
        bodyPct: round(bodyPct),
        wickAgainstPct: round(wickAgainstPct),
        rangeBreakout,
        exhaustionRisk: round(exhaustionRisk) ?? exhaustionRisk,
        volatilityRisk: round(volatilityRisk) ?? volatilityRisk
    };

    if ((atrPercentile ?? 0) >= thresholds.maxAtrPercentileForAggressive) {
        return baseSnapshot('HIGH_VOL_RISK', scoreFrom(volatilityRisk), 'NONE', 'atr_percentile_high', indicators);
    }
    if (exhaustionRisk >= thresholds.maxExhaustionScore) {
        const direction: Side | 'NONE' = upStack || breakoutUp ? 'LONG' : downStack || breakoutDown ? 'SHORT' : 'NONE';
        return baseSnapshot('EXHAUSTION', scoreFrom(exhaustionRisk), direction, 'overextension_or_reversal_wick', indicators);
    }
    if (breakoutUp && (volumeRatio ?? 0) >= thresholds.minVolumeRatioForMomentum && (adx ?? 0) >= Math.max(16, thresholds.minAdxForMomentum - 2) && (choppiness ?? 100) <= thresholds.maxChoppinessForMomentum + 3) {
        return baseSnapshot('BREAKOUT_UP', confidence([volumeRatioScore(volumeRatio), adxScore(adx), chopScore(choppiness), closeLocation]), 'LONG', 'range_breakout_up_volume_confirmed', indicators);
    }
    if (breakoutDown && (volumeRatio ?? 0) >= thresholds.minVolumeRatioForMomentum && (adx ?? 0) >= Math.max(16, thresholds.minAdxForMomentum - 2) && (choppiness ?? 100) <= thresholds.maxChoppinessForMomentum + 3) {
        return baseSnapshot('BREAKOUT_DOWN', confidence([volumeRatioScore(volumeRatio), adxScore(adx), chopScore(choppiness), 1 - closeLocation]), 'SHORT', 'range_breakout_down_volume_confirmed', indicators);
    }
    if (upStack && (emaSlope ?? 0) > thresholds.emaSlopeThreshold && (adx ?? 0) >= thresholds.minAdxForMomentum && (choppiness ?? 100) <= thresholds.maxChoppinessForMomentum && (volumeRatio ?? 0) >= thresholds.minVolumeRatioForMomentum) {
        return baseSnapshot('MOMENTUM_UP', confidence([adxScore(adx), chopScore(choppiness), volumeRatioScore(volumeRatio), slopeScore(emaSlope)]), 'LONG', 'ema_stack_up_adx_volume', indicators);
    }
    if (downStack && (emaSlope ?? 0) < -thresholds.emaSlopeThreshold && (adx ?? 0) >= thresholds.minAdxForMomentum && (choppiness ?? 100) <= thresholds.maxChoppinessForMomentum && (volumeRatio ?? 0) >= thresholds.minVolumeRatioForMomentum) {
        return baseSnapshot('MOMENTUM_DOWN', confidence([adxScore(adx), chopScore(choppiness), volumeRatioScore(volumeRatio), slopeScore(Math.abs(emaSlope ?? 0))]), 'SHORT', 'ema_stack_down_adx_volume', indicators);
    }
    if ((choppiness ?? 0) >= 61.8 || (adx ?? 100) < 18 || (bollingerWidth ?? 1) < 0.01) {
        return baseSnapshot('CHOP', confidence([chopRiskScore(choppiness), 1 - (adxScore(adx) ?? 0), bollingerWidth !== undefined ? Math.max(0, 1 - bollingerWidth * 50) : 0.4]), 'NONE', 'low_adx_or_high_choppiness', indicators);
    }
    if (upStack && (emaSlope ?? 0) > thresholds.emaSlopeThreshold && (adx ?? 0) >= Math.max(16, thresholds.minAdxForMomentum - 2)) {
        return baseSnapshot('TREND_UP', confidence([adxScore(adx), slopeScore(emaSlope), chopScore(choppiness)]), 'LONG', 'ema_stack_up', indicators);
    }
    if (downStack && (emaSlope ?? 0) < -thresholds.emaSlopeThreshold && (adx ?? 0) >= Math.max(16, thresholds.minAdxForMomentum - 2)) {
        return baseSnapshot('TREND_DOWN', confidence([adxScore(adx), slopeScore(Math.abs(emaSlope ?? 0)), chopScore(choppiness)]), 'SHORT', 'ema_stack_down', indicators);
    }
    if (!previous || ema7 === undefined || ema25 === undefined || ema99 === undefined || adx === undefined || choppiness === undefined) {
        return baseSnapshot('UNKNOWN', 0.25, 'NONE', 'missing_indicator_data', indicators);
    }
    return baseSnapshot('UNKNOWN', 0.35, 'NONE', 'mixed_or_unclassified_structure', indicators);
}

function baseSnapshot(
    technicalRegime: TechnicalRegimeLabel,
    confidenceValue: number,
    direction: Side | 'NONE',
    reason: string,
    indicators: Partial<TechnicalRegimeSnapshot>
): TechnicalRegimeSnapshot {
    return {
        technicalRegime,
        confidence: round(clamp01(confidenceValue)) ?? clamp01(confidenceValue),
        direction,
        strength: round(clamp01(confidenceValue)) ?? clamp01(confidenceValue),
        reason,
        exhaustionRisk: 0,
        volatilityRisk: 0,
        ...indicators
    };
}

function buildSnapshotsBySymbol(
    candlesBySymbol: Map<string, CandleRow[]>,
    thresholds: TechnicalRegimeThresholds
): Map<string, TechnicalRegimeSnapshot[]> {
    const output = new Map<string, TechnicalRegimeSnapshot[]>();
    for (const [symbol, candles] of candlesBySymbol.entries()) {
        output.set(symbol, candles.map((_, index) => classifyTechnicalRegime(candles, index, thresholds)));
    }
    return output;
}

function calculateOutcome(
    candles: CandleRow[],
    index: number,
    side: Side,
    leverage: number,
    horizonMinutes: number,
    snapshot: TechnicalRegimeSnapshot
): DeepRegimeOutcome {
    const entry = candles[index];
    if (!entry || entry.close <= 0) return { horizonMinutes };
    const endMs = entry.timestampMs + horizonMinutes * 60_000;
    const future = candles.slice(index + 1).filter((candle) => candle.timestampMs <= endMs);
    if (future.length === 0) return { horizonMinutes };
    const futureHigh = max(future.map((candle) => candle.high));
    const futureLow = min(future.map((candle) => candle.low));
    const lastClose = future[future.length - 1].close;
    const mfeRoe = side === 'LONG'
        ? ((futureHigh! - entry.close) / entry.close) * leverage
        : ((entry.close - futureLow!) / entry.close) * leverage;
    const maeRoe = side === 'LONG'
        ? ((futureLow! - entry.close) / entry.close) * leverage
        : ((entry.close - futureHigh!) / entry.close) * leverage;
    const forwardReturnRoe = side === 'LONG'
        ? ((lastClose - entry.close) / entry.close) * leverage
        : ((entry.close - lastClose) / entry.close) * leverage;
    return {
        horizonMinutes,
        forwardReturnRoe: round(forwardReturnRoe),
        mfeRoe: round(mfeRoe),
        maeRoe: round(maeRoe),
        mfeMaeRatio: Math.abs(maeRoe) > 0 ? round(mfeRoe / Math.abs(maeRoe)) : undefined,
        hit5BeforeMinus5: hitThreshold(future, entry.close, side, leverage, 0.05, 0.05),
        hit8BeforeMinus5: hitThreshold(future, entry.close, side, leverage, 0.08, 0.05),
        hit10BeforeMinus8: hitThreshold(future, entry.close, side, leverage, 0.10, 0.08),
        timeTo5Minutes: timeToTarget(future, entry.close, side, leverage, 0.05),
        timeTo8Minutes: timeToTarget(future, entry.close, side, leverage, 0.08),
        timeTo10Minutes: timeToTarget(future, entry.close, side, leverage, 0.10),
        falseBreakout: snapshot.technicalRegime.startsWith('BREAKOUT')
            ? forwardReturnRoe < 0 || mfeRoe < 0.05
            : undefined
    };
}

function hitThreshold(candles: CandleRow[], entryPrice: number, side: Side, leverage: number, target: number, adverse: number): HitOutcome {
    for (const candle of candles) {
        const favorable = side === 'LONG'
            ? ((candle.high - entryPrice) / entryPrice) * leverage
            : ((entryPrice - candle.low) / entryPrice) * leverage;
        const unfavorable = side === 'LONG'
            ? ((candle.low - entryPrice) / entryPrice) * leverage
            : ((entryPrice - candle.high) / entryPrice) * leverage;
        const hitTarget = favorable >= target;
        const hitAdverse = unfavorable <= -adverse;
        if (hitTarget && hitAdverse) return 'BOTH_SAME_CANDLE';
        if (hitTarget) return 'TARGET_FIRST';
        if (hitAdverse) return 'ADVERSE_FIRST';
    }
    return 'NONE';
}

function timeToTarget(candles: CandleRow[], entryPrice: number, side: Side, leverage: number, target: number): number | undefined {
    const hit = candles.find((candle) => {
        const favorable = side === 'LONG'
            ? ((candle.high - entryPrice) / entryPrice) * leverage
            : ((entryPrice - candle.low) / entryPrice) * leverage;
        return favorable >= target;
    });
    return hit ? (hit.timestampMs - candles[0].timestampMs + 5 * 60_000) / 60_000 : undefined;
}

function classifyMarketConfirmation(side: Side, symbol: string, btc?: TechnicalRegimeSnapshot, eth?: TechnicalRegimeSnapshot): MarketConfirmation {
    const checks = [btc, symbol === 'ETHUSDT' ? undefined : eth].filter((item): item is TechnicalRegimeSnapshot => Boolean(item));
    if (checks.length === 0) return 'UNKNOWN';
    let confirms = 0;
    let contradicts = 0;
    for (const item of checks) {
        if (regimeConfirmsSide(item.technicalRegime, side)) confirms += 1;
        else if (regimeContradictsSide(item.technicalRegime, side)) contradicts += 1;
    }
    if (contradicts > 0) return 'CONTRADICT';
    if (confirms === checks.length) return 'CONFIRM';
    if (confirms > 0) return 'MIXED';
    return 'NEUTRAL';
}

function finalRegimeForMomentum(side: Side, snapshot: TechnicalRegimeSnapshot, confirmation: MarketConfirmation): 'ALLOW' | 'BLOCK' | 'NEUTRAL' {
    if (snapshot.technicalRegime === 'CHOP' || snapshot.technicalRegime === 'UNKNOWN' || snapshot.technicalRegime === 'EXHAUSTION' || snapshot.technicalRegime === 'HIGH_VOL_RISK') return 'BLOCK';
    if (!regimeConfirmsSide(snapshot.technicalRegime, side)) return 'BLOCK';
    if (confirmation === 'CONTRADICT') return 'BLOCK';
    return confirmation === 'CONFIRM' || confirmation === 'MIXED' || confirmation === 'NEUTRAL' ? 'ALLOW' : 'NEUTRAL';
}

function buildMetricRows(samples: DeepRegimeSample[], mode: 'regime' | 'regimeSide' | 'symbol' | 'symbolRegimeSide' | 'monthRegime' | 'marketConfirmation'): DeepRegimeMetricRow[] {
    const grouped = new Map<string, DeepRegimeSample[]>();
    for (const sample of samples) {
        const key = metricKey(sample, mode);
        const rows = grouped.get(key) ?? [];
        rows.push(sample);
        grouped.set(key, rows);
    }
    const rows: DeepRegimeMetricRow[] = [];
    for (const [key, group] of grouped.entries()) {
        for (const horizon of HORIZONS) {
            rows.push(metricRow(key, group, `${horizon}m`, mode));
        }
    }
    return rows.sort((a, b) => a.bucket.localeCompare(b.bucket) || a.horizon.localeCompare(b.horizon));
}

function metricKey(sample: DeepRegimeSample, mode: string): string {
    if (mode === 'regime') return sample.technicalRegime;
    if (mode === 'regimeSide') return `${sample.technicalRegime}|${sample.side}`;
    if (mode === 'symbol') return sample.symbol;
    if (mode === 'symbolRegimeSide') return `${sample.symbol}|${sample.technicalRegime}|${sample.side}`;
    if (mode === 'monthRegime') return `${sample.month}|${sample.technicalRegime}`;
    return sample.marketConfirmation;
}

function metricRow(key: string, samples: DeepRegimeSample[], horizon: '15m' | '30m' | '60m' | '120m', mode: string): DeepRegimeMetricRow {
    const outcomes = samples.map((sample) => sample.outcomes[horizon]);
    const avgMfe = avg(outcomes.map((outcome) => outcome.mfeRoe).filter(isNumber));
    const avgMae = avg(outcomes.map((outcome) => outcome.maeRoe).filter(isNumber));
    const avgReturn = avg(outcomes.map((outcome) => outcome.forwardReturnRoe).filter(isNumber));
    const adverseMae = outcomes.map((outcome) => Math.abs(outcome.maeRoe ?? 0)).filter(isNumber);
    const parts = key.split('|');
    const regime = mode === 'regime' || mode === 'regimeSide'
        ? parts[0]
        : mode === 'symbolRegimeSide' || mode === 'monthRegime'
            ? parts[1]
            : undefined;
    return {
        bucket: key,
        regime,
        symbol: mode === 'symbol' || mode === 'symbolRegimeSide' ? parts[0] : undefined,
        side: mode === 'regimeSide' ? parts[1] as Side : mode === 'symbolRegimeSide' ? parts[2] as Side : 'ALL',
        horizon,
        count: samples.length,
        avgForwardReturnRoe: round(avgReturn),
        medianForwardReturnRoe: round(median(outcomes.map((outcome) => outcome.forwardReturnRoe).filter(isNumber))),
        avgMfeRoe: round(avgMfe),
        avgMaeRoe: round(avgMae),
        mfeMaeRatio: avgMae !== undefined && Math.abs(avgMae) > 0 ? round((avgMfe ?? 0) / Math.abs(avgMae)) : undefined,
        hit5BeforeMinus5Rate: rate(outcomes.map((outcome) => outcome.hit5BeforeMinus5)),
        hit8BeforeMinus5Rate: rate(outcomes.map((outcome) => outcome.hit8BeforeMinus5)),
        hit10BeforeMinus8Rate: rate(outcomes.map((outcome) => outcome.hit10BeforeMinus8)),
        avgTimeTo5Minutes: round(avg(outcomes.map((outcome) => outcome.timeTo5Minutes).filter(isNumber))),
        avgTimeTo8Minutes: round(avg(outcomes.map((outcome) => outcome.timeTo8Minutes).filter(isNumber))),
        avgTimeTo10Minutes: round(avg(outcomes.map((outcome) => outcome.timeTo10Minutes).filter(isNumber))),
        falseBreakoutRate: booleanRate(outcomes.map((outcome) => outcome.falseBreakout)),
        worstMaeP75: round(percentile(adverseMae, 0.75)),
        worstMaeP90: round(percentile(adverseMae, 0.90)),
        worstMaeP95: round(percentile(adverseMae, 0.95)),
        conclusion: conclusion(samples.length, avgReturn, avgMfe, avgMae)
    };
}

function breakdownReasons(samples: DeepRegimeSample[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const sample of samples) counts[sample.reason] = (counts[sample.reason] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

function buildRecommendations(samples: DeepRegimeSample[]): string[] {
    const rows = buildMetricRows(samples, 'symbolRegimeSide').filter((row) => row.horizon === '60m' && row.count >= 30);
    const good = rows.filter((row) => row.conclusion === 'good').sort((a, b) => (b.avgForwardReturnRoe ?? -Infinity) - (a.avgForwardReturnRoe ?? -Infinity)).slice(0, 12);
    const bad = rows.filter((row) => row.conclusion === 'bad').sort((a, b) => (a.avgForwardReturnRoe ?? Infinity) - (b.avgForwardReturnRoe ?? Infinity)).slice(0, 12);
    const unknown = samples.filter((sample) => sample.technicalRegime === 'UNKNOWN').length / Math.max(1, samples.length);
    return [
        `UNKNOWN share: ${formatPct(unknown)}. Treat UNKNOWN as data-quality/context gap until validated, not automatically as bad.`,
        `Best 60m symbol/regime/side buckets: ${good.map((row) => `${row.bucket} ret=${formatPct(row.avgForwardReturnRoe)} hit8=${formatPct(row.hit8BeforeMinus5Rate)}`).join('; ') || 'none with enough sample'}.`,
        `Worst 60m symbol/regime/side buckets: ${bad.map((row) => `${row.bucket} ret=${formatPct(row.avgForwardReturnRoe)} hit8=${formatPct(row.hit8BeforeMinus5Rate)}`).join('; ') || 'none with enough sample'}.`,
        'Keep live RegimeGuard in SHADOW until technicalRegime is separated from Aegis context and validated walk-forward.',
        'Use per-symbol calibration; do not reuse one ADX/choppiness/volume threshold globally without stability checks.'
    ];
}

async function writeReports(report: DeepRegimeAuditReport, samples: DeepRegimeSample[], reportsDir: string): Promise<DeepRegimeAuditReport['outputFiles']> {
    await fs.mkdir(reportsDir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15) + 'Z';
    const markdown = path.join(reportsDir, `aegis_regime_detector_audit_${stamp}.md`);
    const json = path.join(reportsDir, `aegis_regime_detector_audit_${stamp}.json`);
    const csv = path.join(reportsDir, `aegis_regime_detector_metrics_${stamp}.csv`);
    const recommendations = path.join(reportsDir, `aegis_regime_detector_recommendations_${stamp}.md`);
    await fs.writeFile(markdown, renderMarkdown(report), 'utf8');
    await fs.writeFile(json, JSON.stringify({ ...report, samplePreview: samples.slice(0, 250) }, null, 2), 'utf8');
    await fs.writeFile(csv, renderCsv(report), 'utf8');
    await fs.writeFile(recommendations, renderRecommendations(report), 'utf8');
    return { markdown, json, csv, recommendations };
}

export function renderMarkdown(report: DeepRegimeAuditReport): string {
    return [
        '# Aegis Regime Detector Deep Audit',
        '',
        `Generated: ${report.generatedAt}`,
        `Symbols: ${(report.options.symbols ?? []).join(', ')}`,
        `Timeframe: ${report.options.timeframe}`,
        `Leverage proxy: ${report.options.leverage}x`,
        `Samples: ${report.counts.samples}`,
        '',
        '## Summary',
        '',
        `- UNKNOWN samples: ${report.counts.unknownSamples}`,
        `- CHOP samples: ${report.counts.chopSamples}`,
        `- Directional samples: ${report.counts.directionalSamples}`,
        '',
        '## By Regime 60m',
        '',
        markdownTable(report.byRegime.filter((row) => row.horizon === '60m')),
        '',
        '## By Regime And Side 60m',
        '',
        markdownTable(report.byRegimeSide.filter((row) => row.horizon === '60m')),
        '',
        '## By Market Confirmation 60m',
        '',
        markdownTable(report.byMarketConfirmation.filter((row) => row.horizon === '60m')),
        '',
        '## UNKNOWN Breakdown',
        '',
        markdownCounts(report.unknownBreakdown),
        '',
        '## CHOP Breakdown',
        '',
        markdownCounts(report.chopBreakdown),
        '',
        '## Recommendations',
        '',
        ...report.recommendations.map((item) => `- ${item}`),
        ''
    ].join('\n');
}

function renderRecommendations(report: DeepRegimeAuditReport): string {
    return [
        '# Aegis Regime Detector Recommendations',
        '',
        ...report.recommendations.map((item) => `- ${item}`),
        '',
        '## Do Not Change Yet',
        '',
        '- Do not enforce RegimeGuard live from this audit alone.',
        '- Do not merge technical regime, BTC/ETH confirmation and EntryQuality into one label.',
        '- Do not apply one global threshold set to all symbols without walk-forward validation.',
        ''
    ].join('\n');
}

function renderCsv(report: DeepRegimeAuditReport): string {
    const rows = [
        ...report.byRegime,
        ...report.byRegimeSide,
        ...report.bySymbol,
        ...report.bySymbolRegimeSide,
        ...report.byMonthRegime,
        ...report.byMarketConfirmation
    ];
    const header = [
        'bucket',
        'regime',
        'symbol',
        'side',
        'horizon',
        'count',
        'avgForwardReturnRoe',
        'medianForwardReturnRoe',
        'avgMfeRoe',
        'avgMaeRoe',
        'mfeMaeRatio',
        'hit5BeforeMinus5Rate',
        'hit8BeforeMinus5Rate',
        'hit10BeforeMinus8Rate',
        'avgTimeTo5Minutes',
        'avgTimeTo8Minutes',
        'avgTimeTo10Minutes',
        'falseBreakoutRate',
        'worstMaeP75',
        'worstMaeP90',
        'worstMaeP95',
        'conclusion'
    ];
    return [
        header.join(','),
        ...rows.map((row) => header.map((key) => csvValue((row as unknown as Record<string, unknown>)[key])).join(','))
    ].join('\n');
}

function loadCandles(dbPath: string, symbols: string[], timeframe: string, warnings: string[], fromMs = -Infinity, toMs = Infinity): Map<string, CandleRow[]> {
    const output = new Map<string, CandleRow[]>();
    try {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const hasFrom = Number.isFinite(fromMs);
        const hasTo = Number.isFinite(toMs);
        const warmupMs = hasFrom ? fromMs - 7 * 24 * 60 * 60_000 : fromMs;
        const stmt = db.prepare(`
            SELECT timestamp, open, high, low, close, volume
            FROM ohlcv_data
            WHERE symbol = ? AND timeframe = ?
            ${hasFrom ? 'AND timestamp >= ?' : ''}
            ${hasTo ? 'AND timestamp <= ?' : ''}
            ORDER BY timestamp ASC
        `);
        for (const symbol of symbols) {
            const params: unknown[] = [toSlashSymbol(symbol), timeframe];
            if (hasFrom) params.push(new Date(warmupMs).toISOString());
            if (hasTo) params.push(new Date(toMs).toISOString());
            const rows = stmt.all(...params) as Array<Record<string, unknown>>;
            output.set(symbol, rows.map((row) => ({
                timestampMs: parseTimestamp(row.timestamp),
                open: numberOrZero(row.open),
                high: numberOrZero(row.high),
                low: numberOrZero(row.low),
                close: numberOrZero(row.close),
                volume: numberOrZero(row.volume)
            })).filter((row) => Number.isFinite(row.timestampMs) && row.close > 0));
        }
        db.close();
    } catch (error) {
        warnings.push(`Could not load candles from ${dbPath}: ${String(error)}`);
    }
    return output;
}

function regimeConfirmsSide(regime: TechnicalRegimeLabel, side: Side): boolean {
    if (side === 'LONG') return regime === 'MOMENTUM_UP' || regime === 'TREND_UP' || regime === 'BREAKOUT_UP';
    return regime === 'MOMENTUM_DOWN' || regime === 'TREND_DOWN' || regime === 'BREAKOUT_DOWN';
}

function regimeContradictsSide(regime: TechnicalRegimeLabel, side: Side): boolean {
    if (side === 'LONG') return regime === 'MOMENTUM_DOWN' || regime === 'TREND_DOWN' || regime === 'BREAKOUT_DOWN';
    return regime === 'MOMENTUM_UP' || regime === 'TREND_UP' || regime === 'BREAKOUT_UP';
}

function nearestSnapshot(rows: TechnicalRegimeSnapshot[] | undefined, index: number): TechnicalRegimeSnapshot | undefined {
    return rows?.[index];
}

function confidence(values: Array<number | undefined>): number {
    const finite = values.filter(isNumber);
    return finite.length > 0 ? clamp01(avg(finite) ?? 0.5) : 0.5;
}

function scoreFrom(value: number): number {
    return clamp01(0.45 + value * 0.5);
}

function adxScore(value?: number): number | undefined {
    return value === undefined ? undefined : clamp01((value - 12) / 28);
}

function chopScore(value?: number): number | undefined {
    return value === undefined ? undefined : clamp01((65 - value) / 35);
}

function chopRiskScore(value?: number): number | undefined {
    return value === undefined ? undefined : clamp01((value - 45) / 35);
}

function volumeRatioScore(value?: number): number | undefined {
    return value === undefined ? undefined : clamp01((value - 1) / 1.5);
}

function slopeScore(value?: number): number | undefined {
    return value === undefined ? undefined : clamp01(Math.abs(value) / 0.003);
}

function conclusion(count: number, avgReturn?: number, avgMfe?: number, avgMae?: number): DeepRegimeMetricRow['conclusion'] {
    if (count < 30 || avgReturn === undefined || avgMfe === undefined || avgMae === undefined) return 'insufficient';
    const ratioValue = Math.abs(avgMae) > 0 ? avgMfe / Math.abs(avgMae) : 0;
    if (avgReturn > 0 && ratioValue >= 1.2) return 'good';
    if (avgReturn < 0 && ratioValue < 1) return 'bad';
    return 'mixed';
}

function rate(values: Array<HitOutcome | undefined>): number | undefined {
    const finite = values.filter((value): value is HitOutcome => value !== undefined);
    return finite.length > 0 ? round(finite.filter((value) => value === 'TARGET_FIRST').length / finite.length) : undefined;
}

function booleanRate(values: Array<boolean | undefined>): number | undefined {
    const finite = values.filter((value): value is boolean => typeof value === 'boolean');
    return finite.length > 0 ? round(finite.filter(Boolean).length / finite.length) : undefined;
}

function markdownTable(rows: DeepRegimeMetricRow[]): string {
    const selected = rows.slice(0, 40);
    const header = ['bucket', 'count', 'avgRet', 'avgMfe', 'avgMae', 'mfeMae', 'hit8', 'falseBreakout', 'conclusion'];
    return [
        `| ${header.join(' | ')} |`,
        `| ${header.map(() => '---').join(' | ')} |`,
        ...selected.map((row) => `| ${[
            row.bucket,
            row.count,
            formatPct(row.avgForwardReturnRoe),
            formatPct(row.avgMfeRoe),
            formatPct(row.avgMaeRoe),
            formatNumber(row.mfeMaeRatio),
            formatPct(row.hit8BeforeMinus5Rate),
            formatPct(row.falseBreakoutRate),
            row.conclusion
        ].join(' | ')} |`)
    ].join('\n');
}

function markdownCounts(counts: Record<string, number>): string {
    const rows = Object.entries(counts);
    if (rows.length === 0) return 'N/D';
    return rows.map(([key, value]) => `- ${key}: ${value}`).join('\n');
}

function csvValue(value: unknown): string {
    if (value === undefined || value === null) return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function wickAgainst(candle: CandleRow, side: Side): number {
    const range = candle.high - candle.low;
    if (range <= 0) return 0;
    return side === 'LONG'
        ? (candle.high - Math.max(candle.open, candle.close)) / range
        : (Math.min(candle.open, candle.close) - candle.low) / range;
}

function calculateBollingerWidth(values: number[]): number | undefined {
    if (values.length < 20) return undefined;
    const mean = avg(values);
    if (!mean) return undefined;
    const variance = avg(values.map((value) => (value - mean) ** 2));
    return variance === undefined ? undefined : (4 * Math.sqrt(variance)) / mean;
}

function calculateChoppiness(candles: CandleRow[]): number | undefined {
    if (candles.length < 14) return undefined;
    let trSum = 0;
    for (let index = 1; index < candles.length; index += 1) {
        const current = candles[index];
        const previous = candles[index - 1];
        trSum += Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close));
    }
    const highest = max(candles.map((candle) => candle.high));
    const lowest = min(candles.map((candle) => candle.low));
    if (highest === undefined || lowest === undefined) return undefined;
    const range = highest - lowest;
    return range > 0 && trSum > 0 ? 100 * Math.log10(trSum / range) / Math.log10(candles.length) : undefined;
}

function calculateAdx(candles: CandleRow[], period: number): number | undefined {
    if (candles.length < period + 1) return undefined;
    const dxValues: number[] = [];
    for (let index = 1; index < candles.length; index += 1) {
        const current = candles[index];
        const previous = candles[index - 1];
        const upMove = current.high - previous.high;
        const downMove = previous.low - current.low;
        const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
        const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
        const tr = Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close));
        if (tr <= 0) continue;
        const plusDi = (plusDm / tr) * 100;
        const minusDi = (minusDm / tr) * 100;
        const denom = plusDi + minusDi;
        if (denom > 0) dxValues.push((Math.abs(plusDi - minusDi) / denom) * 100);
    }
    return avg(dxValues.slice(-period));
}

function emaSeries(values: number[], period: number): number[] {
    if (values.length === 0) return [];
    const k = 2 / (period + 1);
    const out: number[] = [];
    let prev = values[0];
    for (const value of values) {
        prev = value * k + prev * (1 - k);
        out.push(prev);
    }
    return out;
}

function atrSeries(candles: CandleRow[], period: number): number[] {
    if (candles.length < 2) return [];
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i += 1) {
        const current = candles[i];
        const previous = candles[i - 1];
        trs.push(Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
    }
    const out: number[] = [];
    for (let i = 0; i < trs.length; i += 1) {
        const start = Math.max(0, i - period + 1);
        out.push(avg(trs.slice(start, i + 1)) ?? trs[i]);
    }
    return out;
}

function percentileRank(values: number[], value: number): number {
    const finite = values.filter(isNumber);
    if (finite.length === 0) return 0;
    return finite.filter((item) => item <= value).length / finite.length;
}

function parseTimestamp(value: unknown): number {
    if (typeof value === 'number') return value > 10_000_000_000 ? value : value * 1000;
    const parsed = Date.parse(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function toSlashSymbol(symbol: string): string {
    return symbol.endsWith('USDT') ? `${symbol.slice(0, -4)}/USDT` : symbol;
}

function numberOrZero(value: unknown): number {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function finiteOr(value: unknown, fallback: number): number {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function ratio(value?: number, divisor?: number): number | undefined {
    return value !== undefined && divisor !== undefined && divisor > 0 ? value / divisor : undefined;
}

function avg(values: number[]): number | undefined {
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function median(values: number[]): number | undefined {
    if (values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], pct: number): number | undefined {
    if (values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * pct) - 1));
    return sorted[index];
}

function max(values: number[]): number | undefined {
    return values.length > 0 ? Math.max(...values) : undefined;
}

function min(values: number[]): number | undefined {
    return values.length > 0 ? Math.min(...values) : undefined;
}

function last<T>(values: T[]): T | undefined {
    return values.length > 0 ? values[values.length - 1] : undefined;
}

function isNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function round(value: unknown, digits = 6): number | undefined {
    if (!isNumber(value)) return undefined;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function formatPct(value?: number): string {
    return value === undefined ? 'N/D' : `${(value * 100).toFixed(2)}%`;
}

function formatNumber(value?: number): string {
    return value === undefined ? 'N/D' : value.toFixed(3);
}

function normalizeThresholds(input?: Partial<TechnicalRegimeThresholds>): TechnicalRegimeThresholds {
    return {
        minAdxForMomentum: finiteOr(input?.minAdxForMomentum, DEFAULT_TECHNICAL_REGIME_THRESHOLDS.minAdxForMomentum),
        maxChoppinessForMomentum: finiteOr(input?.maxChoppinessForMomentum, DEFAULT_TECHNICAL_REGIME_THRESHOLDS.maxChoppinessForMomentum),
        minVolumeRatioForMomentum: finiteOr(input?.minVolumeRatioForMomentum, DEFAULT_TECHNICAL_REGIME_THRESHOLDS.minVolumeRatioForMomentum),
        maxAtrPercentileForAggressive: finiteOr(input?.maxAtrPercentileForAggressive, DEFAULT_TECHNICAL_REGIME_THRESHOLDS.maxAtrPercentileForAggressive),
        maxExhaustionScore: finiteOr(input?.maxExhaustionScore, DEFAULT_TECHNICAL_REGIME_THRESHOLDS.maxExhaustionScore),
        breakoutLookback: Math.max(2, Math.floor(finiteOr(input?.breakoutLookback, DEFAULT_TECHNICAL_REGIME_THRESHOLDS.breakoutLookback))),
        emaSlopeThreshold: finiteOr(input?.emaSlopeThreshold, DEFAULT_TECHNICAL_REGIME_THRESHOLDS.emaSlopeThreshold)
    };
}
