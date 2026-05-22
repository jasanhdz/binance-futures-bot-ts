import path from 'path';
import { promises as fs } from 'fs';
import {
    AegisTurboTradeCloseInput,
    AegisTurboTradeEventInput,
    AegisTurboTradeOpenInput
} from '../infra/logging/AegisTurboHistoryLogger';
import { RegimeAvoidShadowEvaluator, RegimeAvoidShadowEvaluation } from '../domain/services/aegis-entry/guards/RegimeAvoidShadowEvaluator';
import { Side } from '../domain/types';

export type RegimeAvoidShadowAuditOptions = {
    date?: string;
    from?: string;
    to?: string;
    days?: number;
    now?: Date;
    symbol?: string;
    allSymbols?: boolean;
    baseDir?: string;
    reportsDir?: string;
    writeReports?: boolean;
};

type TradeRecord = (AegisTurboTradeOpenInput | AegisTurboTradeCloseInput) & { timestamp?: string };

export type RegimeAvoidShadowTradeEvaluation = {
    tradeId: string;
    symbol: string;
    side: Side;
    openedAt?: string;
    closedAt?: string;
    pnl: number;
    roe?: number;
    mfeRoe?: number;
    maeRoe?: number;
    regime?: string;
    shadow: RegimeAvoidShadowEvaluation;
};

export type RegimeAvoidShadowMetrics = {
    trades: number;
    wouldAvoid: number;
    wouldNotAvoid: number;
    avoidedWinners: number;
    avoidedLosers: number;
    falsePositiveAvoid: number;
    truePositiveAvoid: number;
    wouldAvoidPnLImpact: number;
    netSavedPnlEstimated: number;
    avoidedLossCount: number;
    avoidedWinCount: number;
    avoidedLossRoeSum: number;
    avoidedWinRoeSum: number;
    netAvoidedRoe: number;
    avoidedMfeMean?: number;
    avoidedMaeMean?: number;
};

export type RegimeAvoidShadowAuditReport = {
    generatedAt: string;
    options: {
        dates: string[];
        symbol?: string;
        source: string;
        mode: 'SHADOW';
    };
    summary: RegimeAvoidShadowMetrics & {
        corruptedLines: number;
        duplicateTradesSkipped: number;
    };
    bySymbolSide: Record<string, RegimeAvoidShadowMetrics>;
    byRegime: Record<string, RegimeAvoidShadowMetrics>;
    evaluations: RegimeAvoidShadowTradeEvaluation[];
    warnings: string[];
    conclusions: string[];
    outputFiles?: {
        json: string;
        markdown: string;
    };
};

export async function auditRegimeAvoidShadow(options: RegimeAvoidShadowAuditOptions = {}): Promise<RegimeAvoidShadowAuditReport> {
    const baseDir = options.baseDir ?? path.join(process.cwd(), 'logs', 'aegis');
    const reportsDir = options.reportsDir ?? path.join(process.cwd(), 'reports', 'tools');
    const dates = resolveDates(options);
    const warnings: string[] = [];
    let corruptedLines = 0;
    const trades: TradeRecord[] = [];
    const events: AegisTurboTradeEventInput[] = [];

    for (const date of dates) {
        const loadedTrades = await readJsonl<TradeRecord>(path.join(baseDir, `turbo_trades_${date}.jsonl`));
        const loadedEvents = await readJsonl<AegisTurboTradeEventInput>(path.join(baseDir, `turbo_trade_events_${date}.jsonl`));
        corruptedLines += loadedTrades.corrupted + loadedEvents.corrupted;
        for (const row of loadedTrades.rows) trades.push(row);
        for (const row of loadedEvents.rows) events.push(row);
    }

    if (corruptedLines > 0) warnings.push(`Skipped ${corruptedLines} corrupted JSONL line(s).`);

    const symbolFilter = options.allSymbols ? undefined : options.symbol?.toUpperCase();
    const result = buildReport({
        dates,
        trades: filterSymbol(trades, symbolFilter),
        events: filterSymbol(events, symbolFilter),
        warnings,
        corruptedLines,
        symbolFilter
    });

    if (options.writeReports !== false) {
        await fs.mkdir(reportsDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15);
        const jsonPath = path.join(reportsDir, `regime_avoid_shadow_${stamp}.json`);
        const markdownPath = path.join(reportsDir, `regime_avoid_shadow_${stamp}.md`);
        await fs.writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
        await fs.writeFile(markdownPath, renderRegimeAvoidShadowMarkdown(result), 'utf8');
        result.outputFiles = { json: jsonPath, markdown: markdownPath };
    }

    return result;
}

function buildReport(input: {
    dates: string[];
    trades: TradeRecord[];
    events: AegisTurboTradeEventInput[];
    warnings: string[];
    corruptedLines: number;
    symbolFilter?: string;
}): RegimeAvoidShadowAuditReport {
    const opens = input.trades.filter(isOpenTrade);
    const closes = input.trades.filter(isCloseTrade);
    const openById = new Map(opens.map(trade => [trade.trade_id, trade]));
    const closeById = new Map<string, AegisTurboTradeCloseInput>();
    let duplicateTradesSkipped = 0;
    for (const close of closes) {
        if (closeById.has(close.trade_id)) duplicateTradesSkipped++;
        closeById.set(close.trade_id, close);
    }
    const entryPolicyByTradeId = new Map<string, AegisTurboTradeEventInput>();
    for (const event of input.events) {
        if (event.event === 'ENTRY_POLICY_DECISION' && event.trade_id) {
            entryPolicyByTradeId.set(event.trade_id, event);
        }
    }

    const evaluations = [...closeById.values()]
        .map((close) => evaluateTrade(close, openById.get(close.trade_id), entryPolicyByTradeId.get(close.trade_id)))
        .filter((row): row is RegimeAvoidShadowTradeEvaluation => row !== undefined);

    const report: RegimeAvoidShadowAuditReport = {
        generatedAt: new Date().toISOString(),
        options: {
            dates: input.dates,
            symbol: input.symbolFilter,
            source: 'calibration_20260522',
            mode: 'SHADOW'
        },
        summary: {
            ...buildMetrics(evaluations),
            corruptedLines: input.corruptedLines,
            duplicateTradesSkipped
        },
        bySymbolSide: groupMetrics(evaluations, row => `${row.symbol} ${row.side}`),
        byRegime: groupMetrics(evaluations, row => row.regime ?? row.shadow.matchedRegime ?? 'MISSING_REGIME'),
        evaluations,
        warnings: input.warnings,
        conclusions: []
    };
    report.conclusions = buildConclusions(report);
    return report;
}

function evaluateTrade(
    close: AegisTurboTradeCloseInput,
    open?: AegisTurboTradeOpenInput,
    entryPolicyEvent?: AegisTurboTradeEventInput
): RegimeAvoidShadowTradeEvaluation | undefined {
    const side = close.side ?? open?.side;
    if (!side) return undefined;
    const entryPolicy = asRecord(open?.metadata?.entryPolicy) ?? asRecord(entryPolicyEvent?.metadata);
    const regime = extractRegime(entryPolicy);
    const finalDecision = stringValue(entryPolicy?.finalDecision);
    const finalStrategy = stringValue(entryPolicy?.finalStrategy);
    const shadow = RegimeAvoidShadowEvaluator.evaluate({
        symbol: close.symbol,
        side,
        technicalRegime: regime,
        finalDecision,
        finalStrategy,
        tradeId: close.trade_id,
        timestamp: close.opened_at ?? open?.opened_at ?? close.timestamp
    });

    return {
        tradeId: close.trade_id,
        symbol: close.symbol.toUpperCase(),
        side,
        openedAt: close.opened_at ?? open?.opened_at,
        closedAt: close.closed_at,
        pnl: numberOrZero(close.net_pnl_usdt ?? close.pnl_usdt),
        roe: finiteNumber(close.roe),
        mfeRoe: finiteNumber(close.mfe_roe),
        maeRoe: finiteNumber(close.mae_roe),
        regime,
        shadow
    };
}

function extractRegime(entryPolicy?: Record<string, unknown>): string | undefined {
    // TODO: fallback reconstruyendo technicalRegime desde SQLite OHLCV cuando no exista regimeContext en ENTRY_POLICY_DECISION.
    const regimeContext = asRecord(entryPolicy?.regimeContext);
    const regime = asRecord(entryPolicy?.regime);
    const trace = asRecord(entryPolicy?.trace);
    const traceGuards = asRecord(trace?.guards);
    const traceRegimeContextGuard = asRecord(traceGuards?.regime_context);
    const traceRegimeContextMetadata = asRecord(traceRegimeContextGuard?.metadata);
    const traceRegimeContext = asRecord(traceRegimeContextMetadata?.regimeContext);
    return stringValue(regimeContext?.label)
        ?? stringValue(regime?.regime)
        ?? stringValue(traceRegimeContext?.label);
}

function buildMetrics(rows: RegimeAvoidShadowTradeEvaluation[]): RegimeAvoidShadowMetrics {
    const avoided = rows.filter(row => row.shadow.wouldAvoid);
    const avoidedWinners = avoided.filter(row => row.pnl > 0);
    const avoidedLosers = avoided.filter(row => row.pnl < 0);
    const avoidedPnl = avoided.map(row => row.pnl).reduce(sum, 0);
    const avoidedLossRoeSum = avoidedLosers.map(row => row.roe ?? 0).reduce(sum, 0);
    const avoidedWinRoeSum = avoidedWinners.map(row => row.roe ?? 0).reduce(sum, 0);
    const avoidedRoeSum = avoided.map(row => row.roe ?? 0).reduce(sum, 0);
    return {
        trades: rows.length,
        wouldAvoid: avoided.length,
        wouldNotAvoid: rows.length - avoided.length,
        avoidedWinners: avoidedWinners.length,
        avoidedLosers: avoidedLosers.length,
        falsePositiveAvoid: avoidedWinners.length,
        truePositiveAvoid: avoidedLosers.length,
        wouldAvoidPnLImpact: round(avoidedPnl),
        netSavedPnlEstimated: round(-avoidedPnl),
        avoidedLossCount: avoidedLosers.length,
        avoidedWinCount: avoidedWinners.length,
        avoidedLossRoeSum: round(avoidedLossRoeSum),
        avoidedWinRoeSum: round(avoidedWinRoeSum),
        netAvoidedRoe: round(-avoidedRoeSum),
        avoidedMfeMean: round(avg(avoided.map(row => row.mfeRoe).filter(isNumber))),
        avoidedMaeMean: round(avg(avoided.map(row => row.maeRoe).filter(isNumber)))
    };
}

function groupMetrics(
    rows: RegimeAvoidShadowTradeEvaluation[],
    keyFn: (row: RegimeAvoidShadowTradeEvaluation) => string
): Record<string, RegimeAvoidShadowMetrics> {
    const groups = new Map<string, RegimeAvoidShadowTradeEvaluation[]>();
    for (const row of rows) {
        const key = keyFn(row);
        groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return Object.fromEntries([...groups.entries()].map(([key, values]) => [key, buildMetrics(values)]));
}

export function renderRegimeAvoidShadowMarkdown(report: RegimeAvoidShadowAuditReport): string {
    const lines = [
        '# Regime Avoid Shadow',
        '',
        `Generated: ${report.generatedAt}`,
        `Range: ${report.options.dates[0] ?? 'n/a'} to ${report.options.dates[report.options.dates.length - 1] ?? 'n/a'}`,
        `Source: ${report.options.source}`,
        `Mode: ${report.options.mode}`,
        '',
        '## Summary',
        metricLines(report.summary),
        '',
        '## By Symbol Side',
        markdownMetricsTable(report.bySymbolSide),
        '',
        '## By Regime',
        markdownMetricsTable(report.byRegime),
        '',
        '## Conclusions',
        ...report.conclusions.map(line => `- ${line}`)
    ];
    if (report.warnings.length > 0) {
        lines.push('', '## Warnings', ...report.warnings.map(line => `- ${line}`));
    }
    return `${lines.join('\n')}\n`;
}

function metricLines(metrics: RegimeAvoidShadowMetrics & { corruptedLines?: number; duplicateTradesSkipped?: number }): string {
    return [
        `Total trades evaluated: ${metrics.trades}`,
        `Would avoid: ${metrics.wouldAvoid}`,
        `Would not avoid: ${metrics.wouldNotAvoid}`,
        `Avoided winners: ${metrics.avoidedWinners}`,
        `Avoided losers: ${metrics.avoidedLosers}`,
        `WouldAvoidPnLImpact: ${metrics.wouldAvoidPnLImpact}`,
        `Net saved PnL estimated: ${metrics.netSavedPnlEstimated}`,
        `Net avoided ROE: ${metrics.netAvoidedRoe}`,
        `Avoided MFE mean: ${formatNullable(metrics.avoidedMfeMean)}`,
        `Avoided MAE mean: ${formatNullable(metrics.avoidedMaeMean)}`,
        `Corrupted lines skipped: ${metrics.corruptedLines ?? 0}`,
        `Duplicate trades skipped: ${metrics.duplicateTradesSkipped ?? 0}`
    ].join('\n');
}

function markdownMetricsTable(groups: Record<string, RegimeAvoidShadowMetrics>): string {
    const rows = Object.entries(groups).sort((a, b) => b[1].wouldAvoid - a[1].wouldAvoid || a[0].localeCompare(b[0]));
    if (rows.length === 0) return '_No rows._';
    return [
        '| group | trades | avoid | winners avoided | losers avoided | pnl impact | net saved | net roe |',
        '|---|---:|---:|---:|---:|---:|---:|---:|',
        ...rows.map(([group, metrics]) => `| ${group} | ${metrics.trades} | ${metrics.wouldAvoid} | ${metrics.avoidedWinners} | ${metrics.avoidedLosers} | ${metrics.wouldAvoidPnLImpact} | ${metrics.netSavedPnlEstimated} | ${metrics.netAvoidedRoe} |`)
    ].join('\n');
}

function buildConclusions(report: RegimeAvoidShadowAuditReport): string[] {
    const summary = report.summary;
    if (summary.wouldAvoid === 0) return ['No closed trades matched calibrated avoid regimes in this window.'];
    const lines = [
        summary.netSavedPnlEstimated > 0
            ? 'Shadow avoid would have avoided more losses than gains in PnL terms.'
            : 'Shadow avoid would have removed more gains than losses in PnL terms.',
        `True positive avoid: ${summary.truePositiveAvoid}; false positive avoid: ${summary.falsePositiveAvoid}.`
    ];
    const topRegime = Object.entries(report.byRegime).sort((a, b) => b[1].netSavedPnlEstimated - a[1].netSavedPnlEstimated)[0];
    if (topRegime) lines.push(`Best current avoided-regime contribution: ${topRegime[0]} netSavedPnlEstimated=${topRegime[1].netSavedPnlEstimated}.`);
    return lines;
}

function resolveDates(options: RegimeAvoidShadowAuditOptions): string[] {
    if (options.date) return [options.date];
    const now = options.now ?? new Date();
    if (options.days && options.days > 0) {
        const dates: string[] = [];
        for (let i = Math.max(0, Math.floor(options.days) - 1); i >= 0; i--) {
            dates.push(formatDate(new Date(now.getTime() - i * 24 * 60 * 60 * 1000)));
        }
        return dates;
    }
    if (options.from || options.to) {
        const from = parseDateOnly(options.from ?? options.to ?? formatDate(now));
        const to = parseDateOnly(options.to ?? options.from ?? formatDate(now));
        const dates: string[] = [];
        for (let current = from.getTime(); current <= to.getTime(); current += 24 * 60 * 60 * 1000) {
            dates.push(formatDate(new Date(current)));
        }
        return dates;
    }
    return [formatDate(now)];
}

async function readJsonl<T>(filePath: string): Promise<{ rows: T[]; corrupted: number }> {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        const rows: T[] = [];
        let corrupted = 0;
        for (const line of content.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                rows.push(JSON.parse(line) as T);
            } catch {
                corrupted++;
            }
        }
        return { rows, corrupted };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], corrupted: 0 };
        throw error;
    }
}

function filterSymbol<T extends { symbol?: string }>(rows: T[], symbol?: string): T[] {
    return symbol ? rows.filter(row => row.symbol?.toUpperCase() === symbol) : rows;
}

function isOpenTrade(trade: TradeRecord): trade is AegisTurboTradeOpenInput {
    return trade.status === 'OPEN';
}

function isCloseTrade(trade: TradeRecord): trade is AegisTurboTradeCloseInput {
    return trade.status === 'CLOSED';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberOrZero(value: unknown): number {
    return finiteNumber(value) ?? 0;
}

function sum(a: number, b: number): number {
    return a + b;
}

function avg(values: number[]): number | undefined {
    return values.length > 0 ? values.reduce(sum, 0) / values.length : undefined;
}

function isNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function round(value: number | undefined): number {
    return value === undefined || !Number.isFinite(value) ? 0 : Number(value.toFixed(6));
}

function formatNullable(value: number | undefined): string {
    return value === undefined ? 'n/a' : String(value);
}

function parseDateOnly(value: string): Date {
    return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

function formatDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}
