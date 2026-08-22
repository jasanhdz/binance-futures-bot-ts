import path from 'path';
import { promises as fs } from 'fs';
import {
    AegisAccountSnapshotInput,
    AegisTurboSignalHistoryInput,
    AegisTurboTradeCloseInput,
    AegisTurboTradeEventInput,
    AegisTurboTradeOpenInput
} from '../infra/logging/AegisTurboHistoryLogger';
import { isVerifiedAegisMetricRecord } from '../infra/logging/AegisTradeOwnership';

type AnalyzeOptions = {
    date?: string;
    from?: string;
    to?: string;
    symbol?: string;
    allSymbols?: boolean;
    baseDir?: string;
    reportsDir?: string;
    writeReports?: boolean;
};

type TradeRecord = (AegisTurboTradeOpenInput | AegisTurboTradeCloseInput) & {
    timestamp: string;
};

type AnalyzerReport = {
    summary: Record<string, unknown>;
    by_symbol: Record<string, Record<string, unknown>>;
    by_side: Record<string, Record<string, unknown>>;
    by_score_bucket: Record<string, Record<string, unknown>>;
    by_exit_reason: Record<string, Record<string, unknown>>;
    signals: Record<string, unknown>;
    portfolio: Record<string, unknown>;
    warnings: string[];
    output_files?: {
        json: string;
        markdown: string;
    };
};

const SCORE_BUCKETS = ['<0.55', '0.55-0.60', '0.60-0.65', '0.65-0.70', '>=0.70'];

export async function analyzeAegisTurboHistory(options: AnalyzeOptions): Promise<AnalyzerReport> {
    const baseDir = options.baseDir ?? path.join(process.cwd(), 'logs', 'aegis');
    const reportsDir = options.reportsDir ?? path.join(process.cwd(), 'reports');
    const dates = resolveDates(options);
    const warnings: string[] = [];

    const signals: AegisTurboSignalHistoryInput[] = [];
    const trades: TradeRecord[] = [];
    const events: AegisTurboTradeEventInput[] = [];
    const snapshots: AegisAccountSnapshotInput[] = [];
    let corruptedLines = 0;

    for (const date of dates) {
        const loadedSignals = await readJsonl<AegisTurboSignalHistoryInput>(path.join(baseDir, `turbo_signals_${date}.jsonl`));
        const loadedTrades = await readJsonl<TradeRecord>(path.join(baseDir, `turbo_trades_${date}.jsonl`));
        const loadedEvents = await readJsonl<AegisTurboTradeEventInput>(path.join(baseDir, `turbo_trade_events_${date}.jsonl`));
        const loadedSnapshots = await readJsonl<AegisAccountSnapshotInput>(path.join(baseDir, `account_snapshots_${date}.jsonl`));
        corruptedLines += loadedSignals.corrupted + loadedTrades.corrupted + loadedEvents.corrupted + loadedSnapshots.corrupted;
        signals.push(...loadedSignals.rows);
        trades.push(...loadedTrades.rows);
        events.push(...loadedEvents.rows);
        snapshots.push(...loadedSnapshots.rows);
    }

    if (corruptedLines > 0) warnings.push(`Skipped ${corruptedLines} corrupted JSONL line(s).`);

    const symbolFilter = options.allSymbols ? undefined : options.symbol?.toUpperCase();
    const filteredSignals = filterSymbol(signals, symbolFilter);
    const filteredTrades = filterSymbol(trades, symbolFilter);
    const filteredEvents = filterSymbol(events, symbolFilter);
    const filteredSnapshots = filterSnapshots(snapshots, symbolFilter);

    const report = buildReport({
        dates,
        signals: filteredSignals,
        trades: filteredTrades,
        events: filteredEvents,
        snapshots: filteredSnapshots,
        warnings,
        corruptedLines,
        symbolFilter
    });

    if (options.writeReports !== false) {
        await fs.mkdir(reportsDir, { recursive: true });
        const reportName = reportFileStem(dates);
        const jsonPath = path.join(reportsDir, `${reportName}.json`);
        const markdownPath = path.join(reportsDir, `${reportName}.md`);
        await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        await fs.writeFile(markdownPath, renderMarkdown(report, dates), 'utf8');
        report.output_files = { json: jsonPath, markdown: markdownPath };
    }

    return report;
}

function buildReport(input: {
    dates: string[];
    signals: AegisTurboSignalHistoryInput[];
    trades: TradeRecord[];
    events: AegisTurboTradeEventInput[];
    snapshots: AegisAccountSnapshotInput[];
    warnings: string[];
    corruptedLines: number;
    symbolFilter?: string;
}): AnalyzerReport {
    const opens = input.trades.filter(isOpenTrade);
    const closes = input.trades.filter(isCloseTrade);
    const openById = new Map(opens.map(trade => [trade.trade_id, trade]));
    const closeIds = new Set(closes.map(trade => trade.trade_id));
    const stillOpen = opens.filter(trade => !closeIds.has(trade.trade_id));
    const closedWithOpen = closes.map(close => ({ close, open: openById.get(close.trade_id) }));
    const pnlValues = closes.map(trade => numberOrZero(trade.net_pnl_usdt ?? trade.pnl_usdt));
    const roeValues = closes.map(trade => finiteNumber(trade.roe)).filter((value): value is number => value !== undefined);
    const grossProfit = pnlValues.filter(value => value > 0).reduce(sum, 0);
    const grossLoss = pnlValues.filter(value => value < 0).reduce(sum, 0);
    const fees = closes.map(trade => numberOrZero(trade.fees_estimated)).reduce(sum, 0);
    const startingBalance = firstFinite(input.snapshots.map(snapshot => snapshot.wallet_balance ?? snapshot.available_balance));
    const endingBalance = lastFinite(input.snapshots.map(snapshot => snapshot.wallet_balance ?? snapshot.available_balance));
    const exitEye = buildExitEyeStats(input.events);

    const summary = {
        date: input.dates.length === 1 ? input.dates[0] : undefined,
        range: input.dates.length > 1 ? `${input.dates[0]} to ${input.dates[input.dates.length - 1]}` : undefined,
        total_signals: input.signals.length,
        total_trades: opens.length,
        closed_trades: closes.length,
        open_trades: stillOpen.length,
        wins: pnlValues.filter(value => value > 0).length,
        losses: pnlValues.filter(value => value < 0).length,
        win_rate: ratioPct(pnlValues.filter(value => value > 0).length, closes.length),
        gross_pnl: round(grossProfit + grossLoss),
        net_pnl: round(pnlValues.reduce(sum, 0)),
        total_fees: round(fees),
        profit_factor: profitFactor(grossProfit, grossLoss),
        profit_factor_note: grossLoss === 0 && grossProfit > 0 ? 'gross_loss_is_zero' : undefined,
        avg_roe: round(avg(roeValues)),
        median_roe: round(median(roeValues)),
        best_trade_roe: round(max(roeValues)),
        worst_trade_roe: round(min(roeValues)),
        max_consecutive_losses: maxConsecutiveLosses(pnlValues),
        avg_mfe_roe: round(avg(closes.map(trade => finiteNumber(trade.mfe_roe)).filter(isNumber))),
        avg_mae_roe: round(avg(closes.map(trade => finiteNumber(trade.mae_roe)).filter(isNumber))),
        mfe_mae_ratio: ratio(
            avg(closes.map(trade => finiteNumber(trade.mfe_roe)).filter(isNumber)),
            absOrNull(avg(closes.map(trade => finiteNumber(trade.mae_roe)).filter(isNumber)))
        ),
        avg_duration_minutes: round(avg(closes.map(trade => finiteNumber(trade.duration_minutes)).filter(isNumber))),
        max_drawdown_estimated: round(estimatedMaxDrawdown(input.snapshots)),
        starting_balance: round(startingBalance),
        ending_balance: round(endingBalance),
        portfolio_return_pct: startingBalance && endingBalance
            ? round(((endingBalance - startingBalance) / startingBalance) * 100)
            : null,
        ...exitEye
    };

    return {
        summary: stripUndefined(summary),
        by_symbol: groupClosedTrades(closedWithOpen, trade => trade.close.symbol),
        by_side: groupClosedTrades(closedWithOpen, trade => trade.close.side ?? trade.open?.side ?? 'UNKNOWN'),
        by_score_bucket: buildScoreBuckets(input.signals, closedWithOpen),
        by_exit_reason: groupClosedTrades(closedWithOpen, trade => classifyExitReason(trade.close.exit_reason)),
        signals: buildSignalStats(input.signals, input.events),
        portfolio: buildPortfolioStats(input.snapshots, opens),
        warnings: input.warnings
    };
}

function groupClosedTrades(
    rows: Array<{ close: AegisTurboTradeCloseInput; open?: AegisTurboTradeOpenInput }>,
    keyFn: (row: { close: AegisTurboTradeCloseInput; open?: AegisTurboTradeOpenInput }) => string
): Record<string, Record<string, unknown>> {
    const groups = new Map<string, Array<{ close: AegisTurboTradeCloseInput; open?: AegisTurboTradeOpenInput }>>();
    for (const row of rows) {
        const key = keyFn(row) || 'UNKNOWN';
        groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const output: Record<string, Record<string, unknown>> = {};
    for (const [key, values] of groups.entries()) {
        const pnlValues = values.map(row => numberOrZero(row.close.net_pnl_usdt ?? row.close.pnl_usdt));
        const roeValues = values.map(row => finiteNumber(row.close.roe)).filter(isNumber);
        const grossProfit = pnlValues.filter(value => value > 0).reduce(sum, 0);
        const grossLoss = pnlValues.filter(value => value < 0).reduce(sum, 0);
        const reasons = values.map(row => classifyExitReason(row.close.exit_reason));
        output[key] = stripUndefined({
            trades: values.length,
            wins: pnlValues.filter(value => value > 0).length,
            losses: pnlValues.filter(value => value < 0).length,
            win_rate: ratioPct(pnlValues.filter(value => value > 0).length, values.length),
            net_pnl: round(pnlValues.reduce(sum, 0)),
            profit_factor: profitFactor(grossProfit, grossLoss),
            avg_roe: round(avg(roeValues)),
            best_trade_roe: round(max(roeValues)),
            worst_trade_roe: round(min(roeValues)),
            avg_mfe_roe: round(avg(values.map(row => finiteNumber(row.close.mfe_roe)).filter(isNumber))),
            avg_mae_roe: round(avg(values.map(row => finiteNumber(row.close.mae_roe)).filter(isNumber))),
            max_consecutive_losses: maxConsecutiveLosses(pnlValues),
            most_common_exit_reason: mostCommon(reasons),
            best_score_bucket: bestScoreBucket(values)
        });
    }
    return output;
}

function buildScoreBuckets(
    signals: AegisTurboSignalHistoryInput[],
    trades: Array<{ close: AegisTurboTradeCloseInput; open?: AegisTurboTradeOpenInput }>
): Record<string, Record<string, unknown>> {
    const output: Record<string, Record<string, unknown>> = {};
    for (const bucket of SCORE_BUCKETS) {
        const bucketSignals = signals.filter(signal => scoreBucket(signal.turbo_score) === bucket);
        const bucketTrades = trades.filter(row => scoreBucket(row.open?.turbo_score) === bucket);
        const pnlValues = bucketTrades.map(row => numberOrZero(row.close.net_pnl_usdt ?? row.close.pnl_usdt));
        const roeValues = bucketTrades.map(row => finiteNumber(row.close.roe)).filter(isNumber);
        const grossProfit = pnlValues.filter(value => value > 0).reduce(sum, 0);
        const grossLoss = pnlValues.filter(value => value < 0).reduce(sum, 0);
        output[bucket] = {
            signals: bucketSignals.length,
            executed: bucketSignals.filter(signal => signal.executed === true).length,
            trades: bucketTrades.length,
            win_rate: ratioPct(pnlValues.filter(value => value > 0).length, bucketTrades.length),
            avg_roe: round(avg(roeValues)),
            net_pnl: round(pnlValues.reduce(sum, 0)),
            profit_factor: profitFactor(grossProfit, grossLoss)
        };
    }
    return output;
}

function buildSignalStats(signals: AegisTurboSignalHistoryInput[], events: AegisTurboTradeEventInput[]): Record<string, unknown> {
    return {
        signals_total: signals.length,
        signals_executed: signals.filter(signal => signal.executed === true).length,
        signals_blocked: signals.filter(signal => signal.gate_allowed === false).length,
        top_block_reasons: countTop(signals.map(signal => signal.gate_reason ?? signal.gated_blocked_by ?? signal.reason).filter(Boolean) as string[]),
        raw_long_count: signals.filter(signal => signal.raw_action === 'LONG').length,
        raw_short_count: signals.filter(signal => signal.raw_action === 'SHORT').length,
        gated_long_count: signals.filter(signal => signal.gated_action === 'LONG').length,
        gated_short_count: signals.filter(signal => signal.gated_action === 'SHORT').length,
        short_disabled_count: countReason(signals, events, 'short'),
        stale_snapshot_count: countReason(signals, events, 'stale'),
        insufficient_agreement_count: countReason(signals, events, 'insufficient')
    };
}

function buildExitEyeStats(events: AegisTurboTradeEventInput[]): Record<string, unknown> {
    const exitEyeEvents = events.filter(event => String(event.event || '').startsWith('AEGIS_EXIT_EYE_'));
    const roeValues = exitEyeEvents.map(event => finiteNumber(event.roe ?? event.metadata?.currentRoe)).filter(isNumber);
    const givebackValues = exitEyeEvents.map(event => finiteNumber(event.metadata?.givebackRoe)).filter(isNumber);
    return {
        exit_eye_shadow_protect_count: exitEyeEvents.filter(event => event.event === 'AEGIS_EXIT_EYE_SHADOW_PROTECT').length,
        exit_eye_shadow_close_count: exitEyeEvents.filter(event => event.event === 'AEGIS_EXIT_EYE_SHADOW_CLOSE').length,
        exit_eye_close_count: exitEyeEvents.filter(event => event.event === 'AEGIS_EXIT_EYE_CLOSE_POSITION').length,
        avg_roe_when_exit_eye_triggered: round(avg(roeValues)),
        avg_giveback_when_exit_eye_triggered: round(avg(givebackValues))
    };
}

function buildPortfolioStats(snapshots: AegisAccountSnapshotInput[], opens: AegisTurboTradeOpenInput[]): Record<string, unknown> {
    const maxSimultaneousPositions = max(snapshots.map(snapshot => finiteNumber(snapshot.open_positions_count)).filter(isNumber)) ?? 0;
    return {
        max_simultaneous_positions: maxSimultaneousPositions,
        symbols_traded: Array.from(new Set(opens.map(trade => trade.symbol))).sort(),
        long_exposure_count: max(snapshots.map(snapshot => snapshot.portfolio_exposure?.long_symbols).filter(isNumber)) ?? 0,
        short_exposure_count: max(snapshots.map(snapshot => snapshot.portfolio_exposure?.short_symbols).filter(isNumber)) ?? 0,
        total_margin_peak: round(max(snapshots.map(snapshot => snapshot.total_margin_used ?? snapshot.portfolio_exposure?.total_margin_used).filter(isNumber))),
        total_notional_peak: round(max(snapshots.map(snapshot => snapshot.total_notional ?? snapshot.portfolio_exposure?.total_notional).filter(isNumber))),
        daily_loss_events: snapshots.filter(snapshot => typeof snapshot.daily_pnl_pct === 'number' && snapshot.daily_pnl_pct < 0).length
    };
}

function renderMarkdown(report: AnalyzerReport, dates: string[]): string {
    const titleDate = dates.length === 1 ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`;
    const summary = report.summary;
    const bySymbolRows = Object.entries(report.by_symbol)
        .map(([symbol, row]) => `| ${symbol} | ${row.trades ?? 0} | ${formatPct(row.win_rate)} | ${formatMoney(row.net_pnl)} | ${formatPf(row.profit_factor)} | ${formatPct(row.avg_roe)} | ${row.best_score_bucket ?? 'N/A'} |`)
        .join('\n') || '| N/A | 0 | 0.0% | $0.00 | N/A | 0.0% | N/A |';
    const bucketRows = Object.entries(report.by_score_bucket)
        .map(([bucket, row]) => `| ${bucket} | ${row.signals ?? 0} | ${row.trades ?? 0} | ${formatPct(row.win_rate)} | ${formatPct(row.avg_roe)} | ${formatMoney(row.net_pnl)} |`)
        .join('\n');

    return `# Aegis Turbo Report - ${titleDate}

## Summary
- Total trades: ${summary.total_trades ?? 0}
- Win rate: ${formatPct(summary.win_rate)}
- Net PnL: ${formatMoney(summary.net_pnl)}
- Profit factor: ${formatPf(summary.profit_factor)}
- Avg ROE: ${formatPct(summary.avg_roe)}
- Max DD estimated: ${formatPct(summary.max_drawdown_estimated)}
- Exit Eye shadow protect/close/real close: ${summary.exit_eye_shadow_protect_count ?? 0}/${summary.exit_eye_shadow_close_count ?? 0}/${summary.exit_eye_close_count ?? 0}
- Exit Eye avg ROE/giveback: ${formatPct(summary.avg_roe_when_exit_eye_triggered)} / ${formatPct(summary.avg_giveback_when_exit_eye_triggered)}

## By Symbol
| Symbol | Trades | Win Rate | Net PnL | PF | Avg ROE | Best Bucket |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
${bySymbolRows}

## By Score Bucket
| Score | Signals | Trades | Win Rate | Avg ROE | Net PnL |
| --- | ---: | ---: | ---: | ---: | ---: |
${bucketRows}

## Notes
- Sample size may be small.
- Interpret with caution.
${report.warnings.length ? `- Warnings: ${report.warnings.join('; ')}\n` : ''}`;
}

async function readJsonl<T extends Record<string, unknown>>(filePath: string): Promise<{ rows: T[]; corrupted: number }> {
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
    } catch (error: any) {
        if (error?.code === 'ENOENT') return { rows: [], corrupted: 0 };
        throw error;
    }
}

function parseArgs(argv: string[]): AnalyzeOptions {
    const options: AnalyzeOptions = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === '--date') options.date = next, i++;
        else if (arg === '--from') options.from = next, i++;
        else if (arg === '--to') options.to = next, i++;
        else if (arg === '--symbol') options.symbol = next, i++;
        else if (arg === '--all-symbols') options.allSymbols = true;
        else if (arg === '--base-dir') options.baseDir = next, i++;
        else if (arg === '--reports-dir') options.reportsDir = next, i++;
    }
    return options;
}

function resolveDates(options: AnalyzeOptions): string[] {
    if (options.date) return [options.date];
    const from = options.from ?? today();
    const to = options.to ?? from;
    const dates: string[] = [];
    const cursor = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    while (cursor <= end) {
        dates.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return dates;
}

function reportFileStem(dates: string[]): string {
    if (dates.length === 1) return `aegis_turbo_report_${dates[0]}`;
    return `aegis_turbo_report_${dates[0]}_to_${dates[dates.length - 1]}`;
}

function filterSymbol<T extends { symbol?: string }>(rows: T[], symbol?: string): T[] {
    if (!symbol) return rows;
    return rows.filter(row => row.symbol?.toUpperCase() === symbol);
}

function filterSnapshots(rows: AegisAccountSnapshotInput[], symbol?: string): AegisAccountSnapshotInput[] {
    if (!symbol) return rows;
    return rows.map(row => ({
        ...row,
        symbols: row.symbols?.filter(symbolRow => symbolRow.symbol.toUpperCase() === symbol)
    }));
}

function isOpenTrade(trade: TradeRecord): trade is AegisTurboTradeOpenInput & { timestamp: string } {
    return trade.status === 'OPEN';
}

function isCloseTrade(trade: TradeRecord): trade is AegisTurboTradeCloseInput & { timestamp: string } {
    return trade.status === 'CLOSED' && isVerifiedAegisMetricRecord(trade as unknown as Record<string, unknown>);
}

function scoreBucket(score?: number): string {
    if (score === undefined || !Number.isFinite(score)) return '<0.55';
    if (score < 0.55) return '<0.55';
    if (score < 0.60) return '0.55-0.60';
    if (score < 0.65) return '0.60-0.65';
    if (score < 0.70) return '0.65-0.70';
    return '>=0.70';
}

function classifyExitReason(reason?: string): string {
    const value = String(reason ?? '').toUpperCase();
    if (value.includes('STOP') || value.includes('SL')) return 'STOP_LOSS';
    if (value.includes('TAKE') || value.includes('TP')) return 'TAKE_PROFIT';
    if (value.includes('TRAIL')) return 'TRAILING_STOP';
    if (value.includes('BREAK') || value.includes('BE_')) return 'BREAK_EVEN';
    if (value.includes('MANUAL')) return 'MANUAL_CLOSE';
    if (value.includes('TIME') || value.includes('MAX_HOLD')) return 'MAX_HOLD';
    if (value.includes('EMERGENCY') || value.includes('FAILED') || value.includes('BRACKET')) return 'EMERGENCY_CLOSE';
    return 'UNKNOWN';
}

function bestScoreBucket(rows: Array<{ close: AegisTurboTradeCloseInput; open?: AegisTurboTradeOpenInput }>): string | null {
    const buckets = new Map<string, number>();
    for (const row of rows) {
        const bucket = scoreBucket(row.open?.turbo_score);
        buckets.set(bucket, (buckets.get(bucket) ?? 0) + numberOrZero(row.close.net_pnl_usdt ?? row.close.pnl_usdt));
    }
    let best: { bucket: string; pnl: number } | null = null;
    for (const [bucket, pnl] of buckets.entries()) {
        if (!best || pnl > best.pnl) best = { bucket, pnl };
    }
    return best?.bucket ?? null;
}

function countReason(signals: AegisTurboSignalHistoryInput[], events: AegisTurboTradeEventInput[], needle: string): number {
    const haystack = [
        ...signals.map(signal => `${signal.reason ?? ''} ${signal.gate_reason ?? ''} ${signal.gated_blocked_by ?? ''}`),
        ...events.map(event => `${event.reason ?? ''} ${JSON.stringify(event.metadata ?? {})}`)
    ];
    return haystack.filter(value => value.toLowerCase().includes(needle)).length;
}

function estimatedMaxDrawdown(snapshots: AegisAccountSnapshotInput[]): number | null {
    let peak = -Infinity;
    let maxDrawdown = 0;
    for (const snapshot of snapshots) {
        const balance = finiteNumber(snapshot.wallet_balance ?? snapshot.available_balance);
        if (balance === undefined) continue;
        peak = Math.max(peak, balance);
        if (peak > 0) maxDrawdown = Math.min(maxDrawdown, ((balance - peak) / peak) * 100);
    }
    return Number.isFinite(peak) ? maxDrawdown : null;
}

function profitFactor(grossProfit: number, grossLoss: number): number | null {
    if (grossLoss === 0) return null;
    return round(grossProfit / Math.abs(grossLoss));
}

function maxConsecutiveLosses(values: number[]): number {
    let current = 0;
    let best = 0;
    for (const value of values) {
        if (value < 0) {
            current++;
            best = Math.max(best, current);
        } else {
            current = 0;
        }
    }
    return best;
}

function countTop(values: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10));
}

function mostCommon(values: string[]): string | null {
    return Object.entries(countTop(values))[0]?.[0] ?? null;
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberOrZero(value: unknown): number {
    return finiteNumber(value) ?? 0;
}

function firstFinite(values: unknown[]): number | null {
    for (const value of values) {
        const number = finiteNumber(value);
        if (number !== undefined) return number;
    }
    return null;
}

function lastFinite(values: unknown[]): number | null {
    for (let i = values.length - 1; i >= 0; i--) {
        const number = finiteNumber(values[i]);
        if (number !== undefined) return number;
    }
    return null;
}

function avg(values: number[]): number | null {
    return values.length ? values.reduce(sum, 0) / values.length : null;
}

function median(values: number[]): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function max(values: number[]): number | null {
    return values.length ? Math.max(...values) : null;
}

function min(values: number[]): number | null {
    return values.length ? Math.min(...values) : null;
}

function ratioPct(numerator: number, denominator: number): number {
    return denominator > 0 ? round((numerator / denominator) * 100) ?? 0 : 0;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
    if (numerator === null || denominator === null || denominator === 0) return null;
    return round(numerator / denominator);
}

function absOrNull(value: number | null): number | null {
    return value === null ? null : Math.abs(value);
}

function round(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

function sum(total: number, value: number): number {
    return total + value;
}

function isNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function formatPct(value: unknown): string {
    const number = finiteNumber(value);
    return number === undefined ? 'N/A' : `${number.toFixed(2)}%`;
}

function formatMoney(value: unknown): string {
    const number = finiteNumber(value) ?? 0;
    return `${number >= 0 ? '+' : '-'}$${Math.abs(number).toFixed(2)}`;
}

function formatPf(value: unknown): string {
    const number = finiteNumber(value);
    return number === undefined ? 'N/A' : number.toFixed(2);
}

function today(): string {
    return new Date().toISOString().slice(0, 10);
}

async function main(): Promise<void> {
    const report = await analyzeAegisTurboHistory(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({
        summary: report.summary,
        output_files: report.output_files,
        warnings: report.warnings
    }, null, 2));
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exit(1);
    });
}
