import { promises as fs } from 'fs';
import path from 'path';
import { deflateSync } from 'zlib';
import Database from 'better-sqlite3';
import { Side } from '../domain/types';
import { RegimeEngineV2 } from '../domain/services/regime-v2/RegimeEngineV2';
import { RegimeEngineV2Decision, RegimeEngineV2InputCandle, RegimeEngineV2MarketAction } from '../domain/services/regime-v2/RegimeEngineV2.types';

type JsonRecord = Record<string, any>;

export type RecentTradeLossAuditOptions = {
    repoRoot?: string;
    logsDir?: string;
    candlesDbPath?: string;
    outDir?: string;
    symbols?: string[];
    includeControl?: string;
    from?: string;
    to?: string;
    charts?: boolean;
    writeReports?: boolean;
    generatedAt?: string;
};

export type AuditCandle = RegimeEngineV2InputCandle & {
    timestamp: number;
    iso: string;
    ema7?: number;
    ema25?: number;
    ema99?: number;
    atr14?: number;
    volumeRatio20?: number;
    closeLocation?: number;
    wickRatio?: number;
    bodyPct?: number;
    distanceFromEma25Pct?: number;
    return5m?: number;
    return15m?: number;
    return30m?: number;
    return60m?: number;
};

export type TradeAuditSummary = {
    tradeId: string;
    symbol: string;
    side: Side;
    finalStrategy: string;
    openedAt: string;
    closedAt?: string;
    entryPrice?: number;
    exitPrice?: number;
    quantity?: number;
    leverage?: number;
    positionFraction?: number;
    pnlUsdt?: number;
    roe?: number;
    exitReason?: string;
    exitType?: string;
    slPrice?: number;
    tpPrice?: number;
    slippageVsSlPrice?: number;
    slippageVsSlRoe?: number;
};

export type FilterAudit = {
    decision?: string;
    reason?: string;
    wouldBlock?: boolean;
    enforced?: boolean;
    mode?: string;
    metadata?: JsonRecord;
};

export type TradeAudit = {
    summary: TradeAuditSummary;
    openRecord?: JsonRecord;
    closeRecord?: JsonRecord;
    entryPolicy?: JsonRecord;
    signal?: JsonRecord;
    contextSignals: {
        btc?: JsonRecord;
        eth?: JsonRecord;
    };
    events: JsonRecord[];
    filters: {
        decisionBrain: FilterAudit;
        entryQuality: FilterAudit;
        cleanEntry: FilterAudit;
        eventRisk: FilterAudit;
        regime: FilterAudit;
        regimeContext: FilterAudit;
        momentumRide: FilterAudit;
        shortGate: FilterAudit;
        probeMode: FilterAudit;
    };
    market: {
        entryCandle?: AuditCandle;
        closeCandle?: AuditCandle;
        preEntry?: JsonRecord;
        tradePath?: JsonRecord;
        regimeEngineV2?: RegimeEngineV2Decision;
        warnings: string[];
    };
    diagnosis: {
        probableRootCauses: Array<{ cause: string; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; evidenceFor: string[]; evidenceAgainst: string[] }>;
        filtersThatAllowed: string[];
        filtersThatWarned: string[];
        entryWasLate?: boolean;
        exitActedCorrectly?: boolean;
        notes: string[];
    };
    chartPath?: string;
};

export type RecentTradeLossAuditReport = {
    generatedAt: string;
    options: Required<Pick<RecentTradeLossAuditOptions, 'repoRoot' | 'logsDir' | 'candlesDbPath' | 'outDir'>> & RecentTradeLossAuditOptions;
    timezoneNote: string;
    trades: TradeAudit[];
    comparison: JsonRecord[];
    recommendations: {
        now: string[];
        shadow: string[];
        futureGates: string[];
        ml: string[];
        doNotTouch: string[];
    };
    warnings: string[];
    contextCharts?: string[];
    outputFiles?: {
        markdown: string;
        json: string;
        csv: string;
        charts: string[];
        diff?: string;
    };
};

type TradePair = {
    tradeId: string;
    symbol: string;
    open?: JsonRecord;
    close?: JsonRecord;
};

const DEFAULT_DB = '/home/jasan/Develop/trading_system/data/binance_candles.db';
const DEFAULT_OUT_DIR = '/home/jasan/Develop';

export async function auditRecentLosingTrades(options: RecentTradeLossAuditOptions = {}): Promise<RecentTradeLossAuditReport> {
    const repoRoot = options.repoRoot ?? process.cwd();
    const logsDir = options.logsDir ?? path.join(repoRoot, 'logs', 'aegis');
    const candlesDbPath = options.candlesDbPath ?? DEFAULT_DB;
    const outDir = options.outDir ?? DEFAULT_OUT_DIR;
    const symbols = (options.symbols?.length ? options.symbols : ['ETHUSDT', 'ADAUSDT']).map((symbol) => symbol.toUpperCase());
    const includeControl = options.includeControl?.toUpperCase();
    const generatedAt = options.generatedAt ?? new Date().toISOString();
    const fromMs = parseDateBoundary(options.from, 'start');
    const toMs = parseDateBoundary(options.to, 'end');
    const dateKeys = dateKeysBetween(fromMs, toMs);
    const warnings: string[] = [];

    const tradeRows = await loadJsonlByPrefix(logsDir, 'turbo_trades', dateKeys, warnings);
    const eventRows = await loadJsonlByPrefix(logsDir, 'turbo_trade_events', dateKeys, warnings);
    const signalRows = await loadJsonlByPrefix(logsDir, 'turbo_signals', dateKeys, warnings);
    const pairs = pairTrades(tradeRows);
    const selected = selectTrades(pairs, symbols, includeControl, fromMs, toMs, warnings);
    const candlesBySymbol = loadAuditCandles(candlesDbPath, selected, fromMs, toMs, warnings);
    const signalIndex = indexSignals(signalRows);
    const eventsByTrade = groupByTradeId(eventRows);

    const trades = selected.map((pair) => buildTradeAudit(pair, {
        events: eventsByTrade.get(pair.tradeId) ?? [],
        signalIndex,
        candlesBySymbol,
        outDir,
        charts: options.charts === true,
        warnings
    }));
    const contextCharts = options.charts === true
        ? writeContextChartsSync(candlesBySymbol, trades, outDir)
        : [];

    const report: RecentTradeLossAuditReport = {
        generatedAt,
        options: {
            ...options,
            repoRoot,
            logsDir,
            candlesDbPath,
            outDir,
            symbols,
            includeControl
        },
        timezoneNote: 'Logs and SQLite timestamps are treated as UTC. Binance screenshots may be local time; matching was done by trade_id, symbol, side, entry/exit price and nearby timestamp, not by assuming the screenshot timezone.',
        trades,
        comparison: buildComparisonRows(trades),
        recommendations: buildRecommendations(trades),
        warnings,
        contextCharts
    };

    if (options.writeReports !== false) {
        report.outputFiles = await writeAuditReports(report, outDir);
    }
    return report;
}

function buildTradeAudit(pair: TradePair, input: {
    events: JsonRecord[];
    signalIndex: ReturnType<typeof indexSignals>;
    candlesBySymbol: Map<string, AuditCandle[]>;
    outDir: string;
    charts: boolean;
    warnings: string[];
}): TradeAudit {
    const open = pair.open;
    const close = pair.close;
    const entryPolicyEvent = input.events.find((event) => event.event === 'ENTRY_POLICY_DECISION');
    const entryPolicy = open?.metadata?.entryPolicy ?? entryPolicyEvent?.metadata?.entryPolicy ?? entryPolicyEvent?.metadata?.trace ?? entryPolicyEvent?.metadata;
    const side = (open?.side ?? close?.side ?? entryPolicy?.side ?? entryPolicy?.trace?.side ?? 'LONG') as Side;
    const openedAt = open?.opened_at ?? close?.opened_at ?? entryPolicyEvent?.timestamp;
    const closedAt = close?.closed_at;
    const symbol = pair.symbol;
    const signal = findTradeSignal(input.signalIndex, pair.tradeId, symbol, openedAt);
    const contextSignals = {
        btc: findContextSignal(input.signalIndex, 'BTCUSDT', openedAt),
        eth: symbol === 'ETHUSDT' ? signal : findContextSignal(input.signalIndex, 'ETHUSDT', openedAt)
    };
    const candles = input.candlesBySymbol.get(symbol) ?? [];
    const entryMs = parseTimestamp(openedAt);
    const closeMs = closedAt ? parseTimestamp(closedAt) : undefined;
    const entryCandle = nearestCandle(candles, entryMs);
    const closeCandle = closeMs ? nearestCandle(candles, closeMs) : undefined;
    const market = analyzeMarketPath(candles, {
        side,
        entryMs,
        closeMs,
        entryPrice: num(open?.entry_price ?? close?.entry_price),
        exitPrice: num(close?.exit_price),
        leverage: num(open?.leverage ?? close?.leverage) ?? 20
    });
    const regimeEngineV2 = evaluateRegimeEngineV2(symbol, candles, entryMs, contextSignals);
    const summary = summarizeTrade(pair, entryPolicy, side);
    const filters = extractFilters(entryPolicy, open);
    const diagnosis = diagnoseTrade(summary, filters, market, regimeEngineV2, entryPolicy);
    const chartPath = input.charts
        ? writeTradeChartSync(symbol, candles, summary, regimeEngineV2, input.outDir)
        : undefined;

    return {
        summary,
        openRecord: open,
        closeRecord: close,
        entryPolicy,
        signal,
        contextSignals,
        events: input.events,
        filters,
        market: {
            entryCandle,
            closeCandle,
            preEntry: market.preEntry,
            tradePath: market.tradePath,
            regimeEngineV2,
            warnings: market.warnings
        },
        diagnosis,
        chartPath
    };
}

function summarizeTrade(pair: TradePair, entryPolicy: JsonRecord | undefined, side: Side): TradeAuditSummary {
    const open = pair.open;
    const close = pair.close;
    const slPrice = num(open?.sl_price);
    const exitPrice = num(close?.exit_price);
    const entryPrice = num(open?.entry_price ?? close?.entry_price);
    const leverage = num(open?.leverage ?? close?.leverage);
    const slippageVsSlPrice = slPrice !== undefined && exitPrice !== undefined ? exitPrice - slPrice : undefined;
    const slippageVsSlRoe = slippageVsSlPrice !== undefined && entryPrice && leverage
        ? (side === 'LONG' ? slippageVsSlPrice / entryPrice : -slippageVsSlPrice / entryPrice) * leverage
        : undefined;

    return {
        tradeId: pair.tradeId,
        symbol: pair.symbol,
        side,
        finalStrategy: entryPolicy?.finalStrategy ?? entryPolicy?.strategy ?? open?.metadata?.entryPolicy?.finalStrategy ?? open?.strategy ?? close?.strategy ?? 'unknown',
        openedAt: open?.opened_at ?? close?.opened_at,
        closedAt: close?.closed_at,
        entryPrice,
        exitPrice,
        quantity: num(open?.quantity ?? close?.quantity),
        leverage,
        positionFraction: num(open?.position_fraction ?? close?.position_fraction),
        pnlUsdt: num(close?.pnl_usdt),
        roe: num(close?.roe),
        exitReason: close?.exit_reason,
        exitType: close?.metadata?.exit_type,
        slPrice,
        tpPrice: num(open?.tp_price),
        slippageVsSlPrice,
        slippageVsSlRoe
    };
}

function extractFilters(entryPolicy?: JsonRecord, open?: JsonRecord): TradeAudit['filters'] {
    const guards = entryPolicy?.guards ?? entryPolicy?.trace?.guards ?? {};
    const clean = guards.clean_entry ?? open?.metadata?.cleanEntryGuard;
    const momentum = guards.momentum_ride ?? entryPolicy?.momentumRide;
    return {
        decisionBrain: filterFromGuard(guards.decision_brain),
        entryQuality: filterFromGuard(guards.entry_quality),
        cleanEntry: filterFromGuard(clean),
        eventRisk: filterFromGuard(guards.event_risk),
        regime: filterFromGuard(guards.regime ?? entryPolicy?.regime),
        regimeContext: filterFromGuard(guards.regime_context ?? entryPolicy?.regimeContext),
        momentumRide: filterFromGuard(momentum),
        shortGate: filterFromGuard(guards.short_gate),
        probeMode: filterFromGuard(guards.probe_mode ?? open?.metadata?.probeMode)
    };
}

function filterFromGuard(guard?: JsonRecord): FilterAudit {
    if (!guard) return {};
    const metadata = guard.metadata ?? guard;
    return {
        decision: guard.decision ?? metadata.decision ?? (metadata.allowed === true ? 'ALLOW' : metadata.allowed === false ? 'DENY' : undefined),
        reason: guard.reason ?? metadata.reason,
        wouldBlock: guard.wouldBlock ?? metadata.wouldBlock ?? metadata.eventRiskWouldBlock,
        enforced: guard.enforced,
        mode: guard.mode ?? metadata.mode,
        metadata
    };
}

function diagnoseTrade(
    summary: TradeAuditSummary,
    filters: TradeAudit['filters'],
    market: ReturnType<typeof analyzeMarketPath>,
    regimeEngineV2: RegimeEngineV2Decision | undefined,
    entryPolicy?: JsonRecord
): TradeAudit['diagnosis'] {
    const filtersThatAllowed: string[] = [];
    const filtersThatWarned: string[] = [];
    for (const [name, filter] of Object.entries(filters)) {
        if (filter.decision?.includes('ALLOW') || filter.reason === 'probe_allowed') filtersThatAllowed.push(`${name}:${filter.reason ?? filter.decision}`);
        if (filter.wouldBlock || filter.decision?.includes('DENY') || filter.decision?.includes('WAIT') || filter.decision?.includes('SHADOW')) filtersThatWarned.push(`${name}:${filter.reason ?? filter.decision}`);
    }
    if (entryPolicy?.regime?.wouldBlock) filtersThatWarned.push(`regimeObserved:${entryPolicy.regime.regime ?? 'unknown'}/${entryPolicy.regime.reason ?? 'would_block'}`);
    if (regimeEngineV2 && ['AVOID_MOMENTUM', 'UNKNOWN'].includes(regimeEngineV2.momentumEnvironment)) {
        filtersThatWarned.push(`regimeEngineV2:${regimeEngineV2.momentumEnvironment}/${regimeEngineV2.technicalRegime}`);
    }

    const causes: TradeAudit['diagnosis']['probableRootCauses'] = [];
    const addCause = (cause: string, confidence: 'HIGH' | 'MEDIUM' | 'LOW', evidenceFor: string[], evidenceAgainst: string[] = []) => {
        causes.push({ cause, confidence, evidenceFor, evidenceAgainst });
    };
    const pre = (market.preEntry ?? {}) as JsonRecord;
    const path = (market.tradePath ?? {}) as JsonRecord;
    const isLoss = (summary.pnlUsdt ?? 0) < 0 || (summary.roe ?? 0) < 0;
    const eventRiskWouldBlock = filters.eventRisk.wouldBlock === true || filters.cleanEntry.metadata?.eventRiskWouldBlock === true;
    const probeAllowed = filters.probeMode.reason === 'probe_allowed';
    const regimeWarned = entryPolicy?.regime?.wouldBlock === true || ['AVOID_MOMENTUM', 'UNKNOWN'].includes(regimeEngineV2?.momentumEnvironment ?? '');
    const entryWasLate = summary.side === 'LONG'
        ? (pre.return60m ?? 0) < 0 || (pre.distanceFromEma25Pct ?? 0) < 0
        : (pre.return60m ?? 0) > 0 || (pre.distanceFromEma25Pct ?? 0) > 0;

    if (isLoss && eventRiskWouldBlock) {
        addCause('event_risk_underblocking', probeAllowed ? 'HIGH' : 'MEDIUM', [
            `EventRisk wouldBlock=${String(filters.eventRisk.wouldBlock)} reason=${filters.eventRisk.reason ?? filters.cleanEntry.metadata?.eventRiskReason}`,
            `Final reason=${entryPolicy?.finalReason ?? 'unknown'}`
        ]);
    }
    if (isLoss && regimeWarned) {
        addCause('weak_regime_ignored', 'HIGH', [
            `Logged regime=${entryPolicy?.regime?.regime ?? 'n/a'} wouldBlock=${String(entryPolicy?.regime?.wouldBlock)}`,
            `RegimeEngineV2=${regimeEngineV2?.momentumEnvironment ?? 'n/a'} technical=${regimeEngineV2?.technicalRegime ?? 'n/a'} transition=${regimeEngineV2?.transition.risk ?? 'n/a'}`
        ]);
    }
    if (isLoss && entryWasLate) {
        addCause('late_entry', 'MEDIUM', [
            `Pre-entry 60m return=${pct(pre.return60m)}`,
            `Distance from EMA25=${pct(pre.distanceFromEma25Pct)}`
        ]);
    }
    if (isLoss && (summary.slippageVsSlRoe ?? 0) < -0.01) {
        addCause('stop_slippage', 'LOW', [
            `Exit vs SL ROE delta=${pct(summary.slippageVsSlRoe)}`
        ]);
    }
    if (isLoss && (path.mfeRoe ?? 0) < 0.05) {
        addCause('market_reversal_after_valid_signal', 'MEDIUM', [
            `MFE only ${pct(path.mfeRoe)} before MAE ${pct(path.maeRoe)}`
        ], [
            `DecisionBrain=${filters.decisionBrain.metadata?.decisionBrainDecision ?? filters.decisionBrain.decision}`
        ]);
    }
    if (causes.length === 0) {
        addCause(isLoss ? 'model_wrong_direction' : 'valid_signal_managed_profitably', isLoss ? 'LOW' : 'MEDIUM', [
            `Turbo score=${entryPolicy?.turboScore ?? 'n/a'} votes=${JSON.stringify(entryPolicy?.votes ?? {})}`
        ]);
    }

    return {
        probableRootCauses: causes,
        filtersThatAllowed,
        filtersThatWarned: unique(filtersThatWarned),
        entryWasLate,
        exitActedCorrectly: summary.exitType?.includes('STOP LOSS') || summary.exitReason === 'AEGIS_EXIT_EYE_OPPOSITE_SIGNAL',
        notes: [
            `Momentum final candidate=${entryPolicy?.strategyCandidates?.momentum_ride?.decision ?? entryPolicy?.guards?.momentum_ride?.decision ?? 'n/a'} reason=${entryPolicy?.strategyCandidates?.momentum_ride?.reason ?? entryPolicy?.momentumRide?.reasons?.join('|') ?? 'n/a'}`,
            `MFE=${pct(path.mfeRoe)} MAE=${pct(path.maeRoe)} first30m MFE=${pct(path.first30mMfeRoe)} first30m MAE=${pct(path.first30mMaeRoe)}`
        ]
    };
}

function analyzeMarketPath(candles: AuditCandle[], input: { side: Side; entryMs: number; closeMs?: number; entryPrice?: number; exitPrice?: number; leverage: number }) {
    const warnings: string[] = [];
    const entryIndex = nearestCandleIndex(candles, input.entryMs);
    const closeIndex = input.closeMs ? nearestCandleIndex(candles, input.closeMs) : -1;
    if (entryIndex < 0) {
        warnings.push('missing_entry_candle');
        return { warnings, preEntry: {}, tradePath: {} };
    }
    const entry = candles[entryIndex];
    const entryPrice = input.entryPrice ?? entry.close;
    const endIndex = closeIndex >= entryIndex ? closeIndex : candles.length - 1;
    const tradeCandles = candles.slice(entryIndex, endIndex + 1);
    const first30 = candles.slice(entryIndex, Math.min(candles.length, entryIndex + 7));
    const preEntry = {
        return5m: entry.return5m,
        return15m: entry.return15m,
        return30m: entry.return30m,
        return60m: entry.return60m,
        ema7: entry.ema7,
        ema25: entry.ema25,
        ema99: entry.ema99,
        atr14: entry.atr14,
        volumeRatio20: entry.volumeRatio20,
        closeLocation: entry.closeLocation,
        wickRatio: entry.wickRatio,
        bodyPct: entry.bodyPct,
        distanceFromEma25Pct: entry.distanceFromEma25Pct,
        localHigh20: max(candles.slice(Math.max(0, entryIndex - 20), entryIndex).map((candle) => candle.high)),
        localLow20: min(candles.slice(Math.max(0, entryIndex - 20), entryIndex).map((candle) => candle.low))
    };
    const tradePath = {
        ...roePath(tradeCandles, input.side, entryPrice, input.leverage),
        first30mMfeRoe: roePath(first30, input.side, entryPrice, input.leverage).mfeRoe,
        first30mMaeRoe: roePath(first30, input.side, entryPrice, input.leverage).maeRoe
    };
    return { warnings, preEntry, tradePath };
}

function roePath(candles: AuditCandle[], side: Side, entryPrice: number, leverage: number): JsonRecord {
    let mfeRoe = -Infinity;
    let maeRoe = Infinity;
    const thresholds = [-0.05, -0.08, -0.1, -0.2, -0.4, 0.05, 0.08];
    const timeTo: Record<string, number | undefined> = {};
    const entryMs = candles[0]?.timestamp;
    for (const candle of candles) {
        const highRoe = side === 'LONG'
            ? (candle.high - entryPrice) / entryPrice * leverage
            : (entryPrice - candle.low) / entryPrice * leverage;
        const lowRoe = side === 'LONG'
            ? (candle.low - entryPrice) / entryPrice * leverage
            : (entryPrice - candle.high) / entryPrice * leverage;
        mfeRoe = Math.max(mfeRoe, highRoe);
        maeRoe = Math.min(maeRoe, lowRoe);
        for (const threshold of thresholds) {
            const key = `timeTo${threshold >= 0 ? 'Plus' : 'Minus'}${Math.abs(threshold * 100).toFixed(0)}RoeMinutes`;
            if (timeTo[key] !== undefined || entryMs === undefined) continue;
            if (threshold >= 0 && highRoe >= threshold) timeTo[key] = Math.round((candle.timestamp - entryMs) / 60000);
            if (threshold < 0 && lowRoe <= threshold) timeTo[key] = Math.round((candle.timestamp - entryMs) / 60000);
        }
    }
    return {
        mfeRoe: Number.isFinite(mfeRoe) ? mfeRoe : undefined,
        maeRoe: Number.isFinite(maeRoe) ? maeRoe : undefined,
        ...timeTo
    };
}

function evaluateRegimeEngineV2(symbol: string, candles: AuditCandle[], entryMs: number, contextSignals: { btc?: JsonRecord; eth?: JsonRecord }): RegimeEngineV2Decision | undefined {
    const index = nearestCandleIndex(candles, entryMs);
    if (index < 0) return undefined;
    const lookback = candles.slice(Math.max(0, index - 180), index + 1).map((candle) => ({
        timestamp: candle.timestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        buyVolume: candle.buyVolume
    }));
    return RegimeEngineV2.evaluate({
        symbol,
        candles: lookback,
        timeframe: '5m',
        market: {
            btc: signalToMarket(contextSignals.btc),
            eth: signalToMarket(contextSignals.eth)
        }
    });
}

function signalToMarket(signal?: JsonRecord): { action?: RegimeEngineV2MarketAction; score?: number } | undefined {
    const action = signal?.final_action ?? signal?.gated_action ?? signal?.raw_action;
    if (action !== 'LONG' && action !== 'SHORT' && action !== 'HOLD') return undefined;
    return { action, score: num(signal?.turbo_score) };
}

function pairTrades(rows: JsonRecord[]): Map<string, TradePair> {
    const pairs = new Map<string, TradePair>();
    for (const row of rows) {
        const tradeId = row.trade_id;
        if (!tradeId) continue;
        const pair: TradePair = pairs.get(tradeId) ?? { tradeId, symbol: row.symbol };
        pair.symbol = row.symbol ?? pair.symbol;
        if (row.status === 'OPEN' || row.opened_at && !row.closed_at) pair.open = row;
        if (row.status === 'CLOSED' || row.closed_at) pair.close = row;
        pairs.set(tradeId, pair);
    }
    return pairs;
}

function selectTrades(pairs: Map<string, TradePair>, symbols: string[], includeControl: string | undefined, fromMs: number, toMs: number, warnings: string[]): TradePair[] {
    const selected: TradePair[] = [];
    for (const symbol of symbols) {
        const loss = Array.from(pairs.values())
            .filter((pair) => {
                const closeMs = pair.close?.closed_at ? parseTimestamp(pair.close.closed_at) : NaN;
                return pair.symbol === symbol
                    && Number.isFinite(closeMs)
                    && closeMs >= fromMs
                    && closeMs <= toMs
                    && (num(pair.close?.pnl_usdt) ?? 0) < 0;
            })
            .sort((a, b) => parseTimestamp(b.close?.closed_at) - parseTimestamp(a.close?.closed_at))[0];
        if (loss) selected.push(loss);
        else warnings.push(`No losing trade found for ${symbol} in requested window`);
    }
    if (includeControl) {
        const control = Array.from(pairs.values())
            .filter((pair) => pair.symbol === includeControl && (num(pair.close?.pnl_usdt) ?? 0) > 0)
            .sort((a, b) => Math.abs(parseTimestamp(a.close?.closed_at) - midpoint(fromMs, toMs)) - Math.abs(parseTimestamp(b.close?.closed_at) - midpoint(fromMs, toMs)))[0];
        if (control) selected.push(control);
        else warnings.push(`No positive control trade found for ${includeControl}`);
    }
    return selected.sort((a, b) => parseTimestamp(a.open?.opened_at ?? a.close?.opened_at) - parseTimestamp(b.open?.opened_at ?? b.close?.opened_at));
}

function loadAuditCandles(dbPath: string, selected: TradePair[], fromMs: number, toMs: number, warnings: string[]): Map<string, AuditCandle[]> {
    const symbols = unique([
        ...selected.map((pair) => pair.symbol),
        'BTCUSDT',
        'ETHUSDT'
    ]);
    let minMs = fromMs;
    let maxMs = toMs;
    for (const pair of selected) {
        const openMs = parseTimestamp(pair.open?.opened_at ?? pair.close?.opened_at);
        const closeMs = parseTimestamp(pair.close?.closed_at ?? pair.open?.opened_at);
        minMs = Math.min(minMs, openMs - 6 * 3600000);
        maxMs = Math.max(maxMs, closeMs + 3 * 3600000);
    }
    const db = new Database(dbPath, { readonly: true });
    const query = db.prepare(`
        SELECT timestamp, open, high, low, close, volume, buy_volume
        FROM ohlcv_data
        WHERE symbol = ? AND timeframe = '5m' AND timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp ASC
    `);
    const candlesBySymbol = new Map<string, AuditCandle[]>();
    for (const symbol of symbols) {
        const dbSymbol = toDbSymbol(symbol);
        const rows = query.all(dbSymbol, toSqlTimestamp(minMs), toSqlTimestamp(maxMs)) as JsonRecord[];
        if (rows.length === 0) warnings.push(`No OHLCV rows found for ${symbol} (${dbSymbol})`);
        candlesBySymbol.set(symbol, addIndicators(rows.map(rowToCandle)));
    }
    db.close();
    return candlesBySymbol;
}

function addIndicators(candles: AuditCandle[]): AuditCandle[] {
    const closes = candles.map((c) => c.close);
    const ema7 = ema(closes, 7);
    const ema25 = ema(closes, 25);
    const ema99 = ema(closes, 99);
    const atr14 = atr(candles, 14);
    return candles.map((candle, index) => {
        const range = candle.high - candle.low;
        const direction = candle.close >= candle.open ? 'LONG' : 'SHORT';
        const upperWick = candle.high - Math.max(candle.open, candle.close);
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;
        const avgVolume20 = avg(candles.slice(Math.max(0, index - 20), index).map((c) => c.volume));
        const e25 = ema25[index];
        return {
            ...candle,
            ema7: ema7[index],
            ema25: e25,
            ema99: ema99[index],
            atr14: atr14[index],
            volumeRatio20: avgVolume20 ? candle.volume / avgVolume20 : undefined,
            closeLocation: range > 0 ? (candle.close - candle.low) / range : undefined,
            wickRatio: range > 0 ? (direction === 'LONG' ? upperWick : lowerWick) / range : undefined,
            bodyPct: candle.close > 0 ? Math.abs(candle.close - candle.open) / candle.close : undefined,
            distanceFromEma25Pct: e25 ? (candle.close - e25) / e25 : undefined,
            return5m: ret(closes, index, 1),
            return15m: ret(closes, index, 3),
            return30m: ret(closes, index, 6),
            return60m: ret(closes, index, 12)
        };
    });
}

function indexSignals(rows: JsonRecord[]) {
    const byTradeId = new Map<string, JsonRecord>();
    const bySymbol = new Map<string, JsonRecord[]>();
    for (const row of rows) {
        if (row.trade_id) byTradeId.set(row.trade_id, row);
        const list = bySymbol.get(row.symbol) ?? [];
        list.push(row);
        bySymbol.set(row.symbol, list);
    }
    for (const list of bySymbol.values()) list.sort((a, b) => parseTimestamp(a.timestamp) - parseTimestamp(b.timestamp));
    return { byTradeId, bySymbol };
}

function findTradeSignal(index: ReturnType<typeof indexSignals>, tradeId: string, symbol: string, openedAt?: string): JsonRecord | undefined {
    return index.byTradeId.get(tradeId) ?? findContextSignal(index, symbol, openedAt);
}

function findContextSignal(index: ReturnType<typeof indexSignals>, symbol: string, at?: string): JsonRecord | undefined {
    const list = index.bySymbol.get(symbol) ?? [];
    const atMs = parseTimestamp(at);
    let best: JsonRecord | undefined;
    for (const signal of list) {
        const ts = parseTimestamp(signal.timestamp);
        if (ts <= atMs) best = signal;
        else break;
    }
    return best;
}

function groupByTradeId(rows: JsonRecord[]): Map<string, JsonRecord[]> {
    const map = new Map<string, JsonRecord[]>();
    for (const row of rows) {
        if (!row.trade_id) continue;
        const list = map.get(row.trade_id) ?? [];
        list.push(row);
        map.set(row.trade_id, list);
    }
    for (const list of map.values()) list.sort((a, b) => parseTimestamp(a.timestamp) - parseTimestamp(b.timestamp));
    return map;
}

async function loadJsonlByPrefix(logsDir: string, prefix: string, dateKeys: string[], warnings: string[]): Promise<JsonRecord[]> {
    const rows: JsonRecord[] = [];
    for (const dateKey of dateKeys) {
        const file = path.join(logsDir, `${prefix}_${dateKey}.jsonl`);
        try {
            const text = await fs.readFile(file, 'utf8');
            for (const line of text.split('\n')) {
                if (!line.trim()) continue;
                try {
                    rows.push(JSON.parse(line));
                } catch {
                    warnings.push(`Invalid JSONL line skipped in ${file}`);
                }
            }
        } catch (error: any) {
            if (error?.code !== 'ENOENT') warnings.push(`Could not read ${file}: ${error?.message ?? error}`);
        }
    }
    return rows;
}

async function writeAuditReports(report: RecentTradeLossAuditReport, outDir: string): Promise<NonNullable<RecentTradeLossAuditReport['outputFiles']>> {
    await fs.mkdir(outDir, { recursive: true });
    const stamp = stampFromIso(report.generatedAt);
    const markdown = path.join(outDir, `aegis_recent_losses_audit_${stamp}.md`);
    const json = path.join(outDir, `aegis_recent_losses_audit_${stamp}.json`);
    const csv = path.join(outDir, `aegis_recent_losses_audit_summary_${stamp}.csv`);
    await fs.writeFile(markdown, renderRecentLossAuditMarkdown(report), 'utf8');
    await fs.writeFile(json, JSON.stringify(report, null, 2), 'utf8');
    await fs.writeFile(csv, renderRecentLossAuditCsv(report), 'utf8');
    return {
        markdown,
        json,
        csv,
        charts: [
            ...report.trades.map((trade) => trade.chartPath).filter((value): value is string => Boolean(value)),
            ...(report.contextCharts ?? [])
        ]
    };
}

export function renderRecentLossAuditCsv(report: RecentTradeLossAuditReport): string {
    const header = ['trade_id', 'symbol', 'side', 'final_strategy', 'opened_at_utc', 'closed_at_utc', 'entry', 'exit', 'pnl_usdt', 'roe', 'decision_brain', 'entry_quality', 'clean_entry', 'event_risk', 'regime_v2', 'mfe_roe', 'mae_roe', 'root_causes'];
    const rows = report.trades.map((trade) => [
        trade.summary.tradeId,
        trade.summary.symbol,
        trade.summary.side,
        trade.summary.finalStrategy,
        trade.summary.openedAt,
        trade.summary.closedAt ?? '',
        fmt(trade.summary.entryPrice),
        fmt(trade.summary.exitPrice),
        fmt(trade.summary.pnlUsdt),
        fmt(trade.summary.roe),
        `${trade.filters.decisionBrain.decision ?? ''}:${trade.filters.decisionBrain.reason ?? ''}`,
        `${trade.filters.entryQuality.decision ?? ''}:${trade.filters.entryQuality.reason ?? ''}`,
        `${trade.filters.cleanEntry.decision ?? ''}:${trade.filters.cleanEntry.reason ?? ''}`,
        `${trade.filters.eventRisk.decision ?? ''}:${trade.filters.eventRisk.reason ?? ''}`,
        `${trade.market.regimeEngineV2?.momentumEnvironment ?? ''}:${trade.market.regimeEngineV2?.technicalRegime ?? ''}`,
        fmt(trade.market.tradePath?.mfeRoe),
        fmt(trade.market.tradePath?.maeRoe),
        trade.diagnosis.probableRootCauses.map((cause) => `${cause.cause}:${cause.confidence}`).join('|')
    ]);
    return [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n');
}

export function renderRecentLossAuditMarkdown(report: RecentTradeLossAuditReport): string {
    const lines: string[] = [];
    lines.push(`# Aegis Recent Losses Audit`);
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push('');
    lines.push(`Timezone: ${report.timezoneNote}`);
    lines.push('');
    lines.push(`## Executive Summary`);
    lines.push('');
    for (const trade of report.trades) {
        lines.push(`- ${trade.summary.symbol} ${trade.summary.side} ${trade.summary.pnlUsdt !== undefined && trade.summary.pnlUsdt >= 0 ? 'control/win' : 'loss'}: ${trade.summary.tradeId}, strategy=${trade.summary.finalStrategy}, pnl=${usd(trade.summary.pnlUsdt)}, roe=${pct(trade.summary.roe)}, root=${trade.diagnosis.probableRootCauses.map((cause) => `${cause.cause}(${cause.confidence})`).join(', ')}`);
    }
    lines.push('');
    lines.push(`## Trade Details`);
    for (const trade of report.trades) {
        appendTradeMarkdown(lines, trade);
    }
    if ((report.contextCharts ?? []).length > 0) {
        lines.push('');
        lines.push(`## Context Charts`);
        for (const chart of report.contextCharts ?? []) lines.push(`- ${chart}`);
    }
    lines.push('');
    lines.push(`## Filter Comparison`);
    lines.push('');
    lines.push('| Trade | DecisionBrain | EntryQuality | CleanEntry | EventRisk | RegimeEngineV2 | MomentumRide | BTC/ETH | TailRisk | Exit |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const trade of report.trades) {
        const btc = trade.contextSignals.btc;
        const eth = trade.contextSignals.eth;
        lines.push([
            trade.summary.symbol,
            cell(trade.filters.decisionBrain),
            cell(trade.filters.entryQuality),
            cell(trade.filters.cleanEntry),
            cell(trade.filters.eventRisk),
            `${trade.market.regimeEngineV2?.momentumEnvironment ?? 'n/a'} / ${trade.market.regimeEngineV2?.technicalRegime ?? 'n/a'}`,
            `${trade.entryPolicy?.strategyCandidates?.momentum_ride?.decision ?? trade.filters.momentumRide.decision ?? 'n/a'}:${trade.entryPolicy?.strategyCandidates?.momentum_ride?.reason ?? trade.filters.momentumRide.reason ?? 'n/a'}`,
            `BTC ${btc?.final_action ?? btc?.gated_action ?? 'n/a'} ${fmt(btc?.turbo_score)} / ETH ${eth?.final_action ?? eth?.gated_action ?? 'n/a'} ${fmt(eth?.turbo_score)}`,
            fmt(trade.filters.decisionBrain.metadata?.tailRiskScore ?? trade.filters.cleanEntry.metadata?.tailRiskScore),
            `${trade.summary.exitReason ?? 'n/a'} / ${trade.summary.exitType ?? 'n/a'}`
        ].map((value) => `| ${String(value).replace(/\|/g, '/') } `).join('') + '|');
    }
    lines.push('');
    lines.push(`## Comparison Rows`);
    lines.push('');
    lines.push('| Symbol | Result | Strategy | Setup | EventRisk | Regime | First30m MFE | First30m MAE | Full MFE | Full MAE |');
    lines.push('|---|---:|---|---|---|---|---:|---:|---:|---:|');
    for (const row of report.comparison) {
        lines.push(`| ${row.symbol} | ${usd(row.pnlUsdt)} / ${pct(row.roe)} | ${row.finalStrategy} | ${row.setupGrade ?? 'n/a'} | ${row.eventRisk ?? 'n/a'} | ${row.regime ?? 'n/a'} | ${pct(row.first30mMfeRoe)} | ${pct(row.first30mMaeRoe)} | ${pct(row.mfeRoe)} | ${pct(row.maeRoe)} |`);
    }
    lines.push('');
    lines.push(`## Recommendations`);
    lines.push('');
    lines.push(`### Now / Observability`);
    report.recommendations.now.forEach((item) => lines.push(`- ${item}`));
    lines.push('');
    lines.push(`### Shadow Filters`);
    report.recommendations.shadow.forEach((item) => lines.push(`- ${item}`));
    lines.push('');
    lines.push(`### Future Live Gates`);
    report.recommendations.futureGates.forEach((item) => lines.push(`- ${item}`));
    lines.push('');
    lines.push(`### ML`);
    report.recommendations.ml.forEach((item) => lines.push(`- ${item}`));
    lines.push('');
    lines.push(`### Do Not Touch Yet`);
    report.recommendations.doNotTouch.forEach((item) => lines.push(`- ${item}`));
    if (report.warnings.length > 0) {
        lines.push('');
        lines.push(`## Warnings`);
        report.warnings.forEach((warning) => lines.push(`- ${warning}`));
    }
    return lines.join('\n');
}

function appendTradeMarkdown(lines: string[], trade: TradeAudit): void {
    lines.push('');
    lines.push(`### ${trade.summary.symbol} ${trade.summary.side}`);
    lines.push('');
    lines.push(`- trade_id: ${trade.summary.tradeId}`);
    lines.push(`- finalStrategy: ${trade.summary.finalStrategy}`);
    lines.push(`- opened_at UTC: ${trade.summary.openedAt}`);
    lines.push(`- closed_at UTC: ${trade.summary.closedAt ?? 'n/a'}`);
    lines.push(`- entry/exit: ${fmt(trade.summary.entryPrice)} -> ${fmt(trade.summary.exitPrice)}`);
    lines.push(`- qty/leverage/positionFraction: ${fmt(trade.summary.quantity)} / ${fmt(trade.summary.leverage)}x / ${pct(trade.summary.positionFraction)}`);
    lines.push(`- pnl/roe: ${usd(trade.summary.pnlUsdt)} / ${pct(trade.summary.roe)}`);
    lines.push(`- SL/TP: ${fmt(trade.summary.slPrice)} / ${fmt(trade.summary.tpPrice)}; slippage vs SL=${fmt(trade.summary.slippageVsSlPrice)} (${pct(trade.summary.slippageVsSlRoe)} ROE)`);
    lines.push(`- exit: ${trade.summary.exitReason ?? 'n/a'} / ${trade.summary.exitType ?? 'n/a'}; actedCorrectly=${String(trade.diagnosis.exitActedCorrectly)}`);
    lines.push(`- chart: ${trade.chartPath ?? 'n/a'}`);
    lines.push('');
    lines.push(`Filters:`);
    lines.push(`- DecisionBrain: ${cell(trade.filters.decisionBrain)}; decision=${trade.filters.decisionBrain.metadata?.decisionBrainDecision ?? 'n/a'} setup=${trade.filters.decisionBrain.metadata?.setupGrade ?? 'n/a'} aPlus=${String(trade.filters.decisionBrain.metadata?.aPlus)}`);
    lines.push(`- EntryQuality: ${cell(trade.filters.entryQuality)}; modelScore=${fmt(trade.filters.decisionBrain.metadata?.entryQualityModelScore ?? trade.filters.cleanEntry.metadata?.entryQualityModelScore)} featureStatus=${trade.filters.decisionBrain.metadata?.featureStatus ?? trade.filters.cleanEntry.metadata?.featureStatus ?? 'n/a'}`);
    lines.push(`- CleanEntry: ${cell(trade.filters.cleanEntry)}; reasons=${JSON.stringify(trade.filters.cleanEntry.metadata?.reasons ?? [])}`);
    lines.push(`- EventRisk: ${cell(trade.filters.eventRisk)}; wouldBlock=${String(trade.filters.eventRisk.wouldBlock ?? trade.filters.cleanEntry.metadata?.eventRiskWouldBlock)} mode=${trade.filters.cleanEntry.metadata?.eventRiskMode ?? trade.filters.eventRisk.metadata?.mode ?? 'n/a'}`);
    lines.push(`- Regime logged: ${trade.entryPolicy?.regime?.regime ?? 'n/a'} decision=${trade.entryPolicy?.regime?.decision ?? 'n/a'} wouldBlock=${String(trade.entryPolicy?.regime?.wouldBlock)}`);
    lines.push(`- RegimeEngineV2 offline: ${trade.market.regimeEngineV2?.momentumEnvironment ?? 'n/a'} / ${trade.market.regimeEngineV2?.technicalRegime ?? 'n/a'} / transition=${trade.market.regimeEngineV2?.transition.risk ?? 'n/a'} reasons=${JSON.stringify(trade.market.regimeEngineV2?.reasons ?? [])}`);
    lines.push(`- MomentumRide: ${trade.entryPolicy?.strategyCandidates?.momentum_ride?.decision ?? trade.filters.momentumRide.decision ?? 'n/a'} / ${trade.entryPolicy?.strategyCandidates?.momentum_ride?.reason ?? trade.filters.momentumRide.reason ?? 'n/a'}`);
    lines.push(`- ProbeMode: ${cell(trade.filters.probeMode)}`);
    lines.push('');
    lines.push(`Market path:`);
    lines.push(`- pre-entry returns 5/15/30/60m: ${pct(trade.market.preEntry?.return5m)} / ${pct(trade.market.preEntry?.return15m)} / ${pct(trade.market.preEntry?.return30m)} / ${pct(trade.market.preEntry?.return60m)}`);
    lines.push(`- entry candle closeLocation=${fmt(trade.market.preEntry?.closeLocation)} wickRatio=${fmt(trade.market.preEntry?.wickRatio)} volumeRatio=${fmt(trade.market.preEntry?.volumeRatio20)} distanceEMA25=${pct(trade.market.preEntry?.distanceFromEma25Pct)}`);
    lines.push(`- MFE/MAE: ${pct(trade.market.tradePath?.mfeRoe)} / ${pct(trade.market.tradePath?.maeRoe)}; first30m ${pct(trade.market.tradePath?.first30mMfeRoe)} / ${pct(trade.market.tradePath?.first30mMaeRoe)}`);
    lines.push(`- time to -5/-8/-10/-20/-40 ROE: ${trade.market.tradePath?.timeToMinus5RoeMinutes ?? 'n/a'} / ${trade.market.tradePath?.timeToMinus8RoeMinutes ?? 'n/a'} / ${trade.market.tradePath?.timeToMinus10RoeMinutes ?? 'n/a'} / ${trade.market.tradePath?.timeToMinus20RoeMinutes ?? 'n/a'} / ${trade.market.tradePath?.timeToMinus40RoeMinutes ?? 'n/a'} min`);
    lines.push('');
    lines.push(`Root causes:`);
    for (const cause of trade.diagnosis.probableRootCauses) {
        lines.push(`- ${cause.cause} (${cause.confidence}) for=[${cause.evidenceFor.join('; ')}] against=[${cause.evidenceAgainst.join('; ')}]`);
    }
}

function buildComparisonRows(trades: TradeAudit[]): JsonRecord[] {
    return trades.map((trade) => ({
        symbol: trade.summary.symbol,
        tradeId: trade.summary.tradeId,
        side: trade.summary.side,
        pnlUsdt: trade.summary.pnlUsdt,
        roe: trade.summary.roe,
        finalStrategy: trade.summary.finalStrategy,
        decisionBrain: trade.filters.decisionBrain.reason ?? trade.filters.decisionBrain.decision,
        entryQuality: trade.filters.entryQuality.reason ?? trade.filters.entryQuality.decision,
        cleanEntry: trade.filters.cleanEntry.reason ?? trade.filters.cleanEntry.decision,
        eventRisk: trade.filters.cleanEntry.metadata?.eventRiskReason ?? trade.filters.eventRisk.reason ?? trade.filters.eventRisk.decision,
        regime: `${trade.entryPolicy?.regime?.regime ?? trade.market.regimeEngineV2?.technicalRegime ?? 'n/a'}:${trade.market.regimeEngineV2?.momentumEnvironment ?? 'n/a'}`,
        tailRisk: trade.filters.decisionBrain.metadata?.tailRiskScore ?? trade.filters.cleanEntry.metadata?.tailRiskScore,
        btc: trade.contextSignals.btc?.final_action ?? trade.contextSignals.btc?.gated_action,
        eth: trade.contextSignals.eth?.final_action ?? trade.contextSignals.eth?.gated_action,
        setupGrade: trade.filters.decisionBrain.metadata?.setupGrade ?? trade.filters.cleanEntry.metadata?.setupGrade,
        mfeRoe: trade.market.tradePath?.mfeRoe,
        maeRoe: trade.market.tradePath?.maeRoe,
        first30mMfeRoe: trade.market.tradePath?.first30mMfeRoe,
        first30mMaeRoe: trade.market.tradePath?.first30mMaeRoe,
        exit: `${trade.summary.exitReason ?? ''}:${trade.summary.exitType ?? ''}`
    }));
}

function buildRecommendations(trades: TradeAudit[]): RecentTradeLossAuditReport['recommendations'] {
    const losses = trades.filter((trade) => (trade.summary.pnlUsdt ?? 0) < 0);
    const hasRegimeWarnings = losses.some((trade) => trade.diagnosis.probableRootCauses.some((cause) => cause.cause === 'weak_regime_ignored'));
    const hasEventRisk = losses.some((trade) => trade.diagnosis.probableRootCauses.some((cause) => cause.cause === 'event_risk_underblocking'));
    return {
        now: [
            'Add/keep visible entry postmortem telemetry for every live entry: finalStrategy, probe/momentum/aegis candidate, EventRisk wouldBlock, RegimeEngineV2 observed environment, first 30m MFE/MAE.',
            'Alert when an entry is allowed while RegimeEngineV2 observes UNKNOWN/AVOID or logged regime shadow wouldBlock.',
            'Log BTC/ETH context as explicit confirm/mixed/contradict instead of only raw action/score.'
        ],
        shadow: [
            hasRegimeWarnings ? 'Shadow rule: no LONG when RegimeEngineV2 is AVOID/UNKNOWN or logged regime shadow wouldBlock, unless later data proves it blocks too many winners.' : 'Shadow RegimeEngineV2 avoid/unknown separation by side.',
            hasEventRisk ? 'Shadow rule: delay LONG one candle when EventRisk CAUTION wouldBlock is true and entry is allowed only by Probe Mode.' : 'Shadow EventRisk CAUTION delay rule.',
            'Shadow metric: first 30m MAE by symbol/side/setupGrade to separate false strong setups from valid breakouts.'
        ],
        futureGates: [
            'Promote only after shadow validation: block or reduce size when BTC/ETH context contradicts and RegimeEngineV2 is CHOP/UNKNOWN/AVOID.',
            'Consider position fraction reduction for Aegis Turbo trades opened via Probe Mode over CleanEntry WAIT_CONFIRMATION.'
        ],
        ml: [
            'Build losing-entry vs winning-entry dataset with target hit8-before-minus5 and features from entry candle, RegimeEngineV2, BTC/ETH context, first 30m MAE.',
            'Run feature importance to identify whether EntryQuality or DecisionBrain overweights raw turbo score in CHOP/CAUTION.'
        ],
        doNotTouch: [
            'Do not change YAML thresholds or live gates from this audit alone.',
            'Do not disable Aegis Turbo fallback or Momentum Ride priority based on two losses.',
            'Do not hard-block Probe Mode until AVAX-like winners are evaluated in shadow.'
        ]
    };
}

function writeTradeChartSync(symbol: string, candles: AuditCandle[], summary: TradeAuditSummary, regime: RegimeEngineV2Decision | undefined, outDir: string): string {
    const entryMs = parseTimestamp(summary.openedAt);
    const closeMs = parseTimestamp(summary.closedAt);
    const window = candles.filter((candle) => candle.timestamp >= entryMs - 6 * 3600000 && candle.timestamp <= closeMs + 3 * 3600000);
    const safeDate = summary.openedAt.slice(0, 10).replace(/-/g, '');
    const file = path.join(outDir, `aegis_loss_audit_${symbol}_${safeDate}_chart.png`);
    const png = renderPngChart(window, {
        title: `${symbol} ${summary.side} ${summary.tradeId}`,
        entryMs,
        closeMs,
        entryPrice: summary.entryPrice,
        exitPrice: summary.exitPrice,
        slPrice: summary.slPrice,
        tpPrice: summary.tpPrice,
        regimeLabel: regime ? `${regime.momentumEnvironment}/${regime.technicalRegime}` : undefined
    });
    require('fs').writeFileSync(file, png);
    return file;
}

function writeContextChartsSync(candlesBySymbol: Map<string, AuditCandle[]>, trades: TradeAudit[], outDir: string): string[] {
    if (trades.length === 0) return [];
    const opened = trades.map((trade) => parseTimestamp(trade.summary.openedAt)).filter(Number.isFinite);
    const closed = trades.map((trade) => parseTimestamp(trade.summary.closedAt)).filter(Number.isFinite);
    const minMs = Math.min(...opened) - 6 * 3600000;
    const maxMs = Math.max(...closed, ...opened) + 3 * 3600000;
    const safeDate = new Date(Math.max(...closed, ...opened)).toISOString().slice(0, 10).replace(/-/g, '');
    const paths: string[] = [];
    for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
        const candles = (candlesBySymbol.get(symbol) ?? []).filter((candle) => candle.timestamp >= minMs && candle.timestamp <= maxMs);
        if (candles.length === 0) continue;
        const file = path.join(outDir, `aegis_loss_audit_${symbol.slice(0, -4)}_context_${safeDate}_chart.png`);
        const png = renderPngChart(candles, {
            title: `${symbol} context ${safeDate}`,
            entryMs: Math.min(...opened),
            closeMs: Math.max(...closed, ...opened),
            regimeLabel: 'macro context'
        });
        require('fs').writeFileSync(file, png);
        paths.push(file);
    }
    return paths;
}

function renderPngChart(candles: AuditCandle[], marker: { title: string; entryMs: number; closeMs: number; entryPrice?: number; exitPrice?: number; slPrice?: number; tpPrice?: number; regimeLabel?: string }): Buffer {
    const width = 1200;
    const height = 720;
    const pad = { l: 70, r: 30, t: 38, b: 130 };
    const img = new RgbaImage(width, height, [12, 17, 23, 255]);
    if (candles.length === 0) return encodePng(width, height, img.data);
    const prices = candles.flatMap((candle) => [candle.high, candle.low, candle.ema25, candle.ema99].filter((v): v is number => typeof v === 'number' && Number.isFinite(v)));
    const minPrice = Math.min(...prices, marker.slPrice ?? Infinity, marker.exitPrice ?? Infinity);
    const maxPrice = Math.max(...prices, marker.tpPrice ?? -Infinity, marker.entryPrice ?? -Infinity);
    const minTs = candles[0].timestamp;
    const maxTs = candles[candles.length - 1].timestamp;
    const maxVol = Math.max(...candles.map((candle) => candle.volume), 1);
    const plotW = width - pad.l - pad.r;
    const plotH = height - pad.t - pad.b;
    const volTop = height - 96;
    const volH = 62;
    const x = (ts: number) => pad.l + (maxTs === minTs ? 0 : (ts - minTs) / (maxTs - minTs) * plotW);
    const y = (price: number) => pad.t + (maxPrice === minPrice ? 0.5 : (maxPrice - price) / (maxPrice - minPrice)) * plotH;
    img.rect(pad.l, pad.t, plotW, plotH, [18, 24, 32, 255]);
    for (let i = 0; i <= 6; i++) {
        const gy = pad.t + i / 6 * plotH;
        img.line(pad.l, gy, width - pad.r, gy, [38, 48, 60, 255]);
    }
    candles.forEach((candle) => {
        const cx = x(candle.timestamp);
        const barH = candle.volume / maxVol * volH;
        img.rect(cx - 1, volTop + volH - barH, 2, barH, [54, 68, 86, 200]);
    });
    drawSeries(img, candles.map((c) => [x(c.timestamp), y(c.close)]), [225, 225, 225, 255]);
    drawSeries(img, candles.filter((c) => c.ema25 !== undefined).map((c) => [x(c.timestamp), y(c.ema25 as number)]), [247, 196, 78, 255]);
    drawSeries(img, candles.filter((c) => c.ema99 !== undefined).map((c) => [x(c.timestamp), y(c.ema99 as number)]), [83, 166, 255, 255]);
    drawPriceLine(img, y, width, pad, marker.entryPrice, [20, 184, 120, 255]);
    drawPriceLine(img, y, width, pad, marker.exitPrice, [239, 68, 68, 255]);
    drawPriceLine(img, y, width, pad, marker.slPrice, [248, 113, 113, 210]);
    drawPriceLine(img, y, width, pad, marker.tpPrice, [34, 197, 94, 210]);
    drawTimeLine(img, x(marker.entryMs), pad.t, plotH, [20, 184, 120, 255]);
    if (Number.isFinite(marker.closeMs)) drawTimeLine(img, x(marker.closeMs), pad.t, plotH, [239, 68, 68, 255]);
    img.text(20, 16, marker.title, [230, 236, 243, 255]);
    img.text(20, height - 42, `white=close yellow=EMA25 blue=EMA99 green=entry red=exit/sl ${marker.regimeLabel ?? ''}`, [185, 195, 208, 255]);
    return encodePng(width, height, img.data);
}

function drawSeries(img: RgbaImage, points: number[][], color: number[]): void {
    for (let i = 1; i < points.length; i++) img.line(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1], color);
}

function drawPriceLine(img: RgbaImage, y: (price: number) => number, width: number, pad: { l: number; r: number }, price: number | undefined, color: number[]): void {
    if (price === undefined || !Number.isFinite(price)) return;
    const py = y(price);
    img.line(pad.l, py, width - pad.r, py, color);
}

function drawTimeLine(img: RgbaImage, x: number, top: number, height: number, color: number[]): void {
    if (!Number.isFinite(x)) return;
    img.line(x, top, x, top + height, color);
}

class RgbaImage {
    readonly data: Buffer;
    constructor(readonly width: number, readonly height: number, bg: number[]) {
        this.data = Buffer.alloc(width * height * 4);
        for (let i = 0; i < width * height; i++) {
            this.data[i * 4] = bg[0];
            this.data[i * 4 + 1] = bg[1];
            this.data[i * 4 + 2] = bg[2];
            this.data[i * 4 + 3] = bg[3];
        }
    }
    set(x: number, y: number, color: number[]): void {
        const px = Math.round(x);
        const py = Math.round(y);
        if (px < 0 || px >= this.width || py < 0 || py >= this.height) return;
        const offset = (py * this.width + px) * 4;
        this.data[offset] = color[0];
        this.data[offset + 1] = color[1];
        this.data[offset + 2] = color[2];
        this.data[offset + 3] = color[3] ?? 255;
    }
    rect(x: number, y: number, w: number, h: number, color: number[]): void {
        if (![x, y, w, h].every(Number.isFinite)) return;
        for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(this.height, Math.ceil(y + h)); yy++) {
            for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(this.width, Math.ceil(x + w)); xx++) this.set(xx, yy, color);
        }
    }
    line(x0: number, y0: number, x1: number, y1: number, color: number[]): void {
        if (![x0, y0, x1, y1].every(Number.isFinite)) return;
        let x = Math.round(x0);
        let y = Math.round(y0);
        const endX = Math.round(x1);
        const endY = Math.round(y1);
        const dx = Math.abs(endX - x);
        const sx = x < endX ? 1 : -1;
        const dy = -Math.abs(endY - y);
        const sy = y < endY ? 1 : -1;
        let err = dx + dy;
        while (true) {
            this.set(x, y, color);
            if (x === endX && y === endY) break;
            const e2 = 2 * err;
            if (e2 >= dy) { err += dy; x += sx; }
            if (e2 <= dx) { err += dx; y += sy; }
        }
    }
    text(x: number, y: number, text: string, color: number[]): void {
        let cursor = x;
        for (const ch of text.slice(0, 150)) {
            const code = ch.charCodeAt(0);
            for (let bit = 0; bit < 7; bit++) {
                if ((code >> bit) & 1) this.rect(cursor + (bit % 3) * 2, y + Math.floor(bit / 3) * 3, 2, 2, color);
            }
            cursor += 8;
        }
    }
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0;
        rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    }
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])])),
        pngChunk('IDAT', deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
    const typeBuf = Buffer.from(type);
    return Buffer.concat([u32(data.length), typeBuf, data, u32(crc32(Buffer.concat([typeBuf, data])))]); 
}

function u32(value: number): Buffer {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(value >>> 0, 0);
    return buf;
}

function crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of buf) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function rowToCandle(row: JsonRecord): AuditCandle {
    const timestamp = parseSqlTimestamp(row.timestamp);
    return {
        timestamp,
        iso: new Date(timestamp).toISOString(),
        openTime: timestamp,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
        buyVolume: num(row.buy_volume)
    };
}

function ema(values: number[], window: number): Array<number | undefined> {
    const k = 2 / (window + 1);
    const out: Array<number | undefined> = [];
    let prev: number | undefined;
    values.forEach((value, index) => {
        prev = prev === undefined ? value : value * k + prev * (1 - k);
        out[index] = index + 1 >= window ? prev : undefined;
    });
    return out;
}

function atr(candles: AuditCandle[], window: number): Array<number | undefined> {
    const trs = candles.map((candle, index) => {
        const prev = candles[index - 1];
        return prev ? Math.max(candle.high - candle.low, Math.abs(candle.high - prev.close), Math.abs(candle.low - prev.close)) : candle.high - candle.low;
    });
    return trs.map((_, index) => index + 1 >= window ? avg(trs.slice(index + 1 - window, index + 1)) : undefined);
}

function ret(values: number[], index: number, lag: number): number | undefined {
    const prev = values[index - lag];
    const current = values[index];
    return prev && current ? (current - prev) / prev : undefined;
}

function nearestCandle(candles: AuditCandle[], timestamp: number): AuditCandle | undefined {
    const index = nearestCandleIndex(candles, timestamp);
    return index >= 0 ? candles[index] : undefined;
}

function nearestCandleIndex(candles: AuditCandle[], timestamp: number): number {
    if (candles.length === 0 || !Number.isFinite(timestamp)) return -1;
    let best = 0;
    let bestDistance = Infinity;
    candles.forEach((candle, index) => {
        const distance = Math.abs(candle.timestamp - timestamp);
        if (distance < bestDistance) {
            best = index;
            bestDistance = distance;
        }
    });
    return best;
}

function dateKeysBetween(fromMs: number, toMs: number): string[] {
    const keys: string[] = [];
    const start = new Date(fromMs - 24 * 3600000);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(toMs + 24 * 3600000);
    end.setUTCHours(0, 0, 0, 0);
    for (let t = start.getTime(); t <= end.getTime(); t += 24 * 3600000) keys.push(new Date(t).toISOString().slice(0, 10));
    return keys;
}

function parseDateBoundary(value: string | undefined, mode: 'start' | 'end'): number {
    if (!value) return mode === 'start' ? Date.now() - 7 * 24 * 3600000 : Date.now();
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(`${value}T${mode === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`);
    return parseTimestamp(value);
}

function parseTimestamp(value: any): number {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string' || value.length === 0) return NaN;
    if (value.includes('T')) return Date.parse(value);
    return parseSqlTimestamp(value);
}

function parseSqlTimestamp(value: string): number {
    const normalized = value.replace(' ', 'T').replace(/(\.\d{3})\d+$/, '$1') + 'Z';
    return Date.parse(normalized);
}

function toSqlTimestamp(ms: number): string {
    return new Date(ms).toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
}

function toDbSymbol(symbol: string): string {
    return symbol.endsWith('USDT') ? `${symbol.slice(0, -4)}/USDT` : symbol;
}

function stampFromIso(iso: string): string {
    return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function midpoint(a: number, b: number): number {
    return a + (b - a) / 2;
}

function num(value: any): number | undefined {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}

function avg(values: Array<number | undefined>): number | undefined {
    const finite = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return finite.length > 0 ? finite.reduce((sum, value) => sum + value, 0) / finite.length : undefined;
}

function min(values: Array<number | undefined>): number | undefined {
    const finite = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return finite.length > 0 ? Math.min(...finite) : undefined;
}

function max(values: Array<number | undefined>): number | undefined {
    const finite = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return finite.length > 0 ? Math.max(...finite) : undefined;
}

function unique<T>(values: T[]): T[] {
    return Array.from(new Set(values));
}

function fmt(value: any, digits = 4): string {
    const n = num(value);
    return n === undefined ? 'n/a' : n.toFixed(digits).replace(/\.?0+$/, '');
}

function pct(value: any): string {
    const n = num(value);
    return n === undefined ? 'n/a' : `${(n * 100).toFixed(2)}%`;
}

function usd(value: any): string {
    const n = num(value);
    return n === undefined ? 'n/a' : `$${n.toFixed(2)}`;
}

function cell(filter: FilterAudit): string {
    return `${filter.decision ?? 'n/a'}:${filter.reason ?? 'n/a'}${filter.wouldBlock ? ' wouldBlock' : ''}`;
}

function csvEscape(value: any): string {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
