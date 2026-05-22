import path from 'path';
import { promises as fs } from 'fs';

export type AegisProbeReportMode = 'summary' | 'detail' | 'near-miss';

export type AegisProbeReportInput = {
    symbol?: string;
    windowMinutes: number;
    mode: AegisProbeReportMode;
};

export type AegisProbeEvaluationSample = {
    timestamp: string;
    tradeId: string | null;
    symbol: string;
    side: string;
    event: string;
    decision: string;
    probeReason: string;
    finalReason: string | null;
    eventRiskMode: string | null;
    eventRiskReason: string | null;
    cleanEntryDecision: string | null;
    cleanEntryReasons: string[];
    decisionBrain: string | null;
    entryQualityRecommendation: string | null;
    entryQualityScore: number | null;
    tailRiskScore: number | null;
    setupGrade: string | null;
    turboScore: number | null;
    votes: { long?: number; short?: number; neutral?: number };
};

export type AegisProbeTradeSample = {
    tradeId: string;
    symbol: string;
    side: string;
    openedAt: string | null;
    closedAt: string | null;
    durationMinutes: number | null;
    entryPrice: number | null;
    exitPrice: number | null;
    leverage: number | null;
    positionFraction: number | null;
    marginEstimated: number | null;
    pnlUsdt: number | null;
    roe: number | null;
    mfeRoe: number | null;
    maeRoe: number | null;
    timeToGreenMinutes: number | null;
    timeTo5RoeMinutes: number | null;
    timeTo8RoeMinutes: number | null;
    timeTo10RoeMinutes: number | null;
    breakEvenActivated: boolean;
    protectProfitActivated: boolean;
    trailingActivated: boolean;
    exitEyeClose: boolean;
    exitReason: string | null;
    canonicalExitType: string | null;
    displayExitLabel: string | null;
    eventRiskMode: string | null;
    eventRiskReason: string | null;
    cleanEntryDecision: string | null;
    cleanEntryReasons: string[];
    decisionBrain: string | null;
    entryQualityRecommendation: string | null;
    entryQualityScore: number | null;
    tailRiskScore: number | null;
    setupGrade: string | null;
    turboScore: number | null;
    votes: { long?: number; short?: number; neutral?: number };
};

export type ExitReasonLabelMismatch = {
    tradeId: string;
    symbol: string;
    reason: string;
    exitType: string;
    mismatchReason: string;
};

export type AegisProbeReportOutput = {
    windowStart: string;
    windowEnd: string;
    totalEvaluations: number;
    probeAllowed: number;
    probeDenied: number;
    tradesOpenedByProbe: number;
    tradesClosedByProbe: number;
    winRate: number | null;
    pnlTotal: number;
    avgRoe: number | null;
    avgMfeRoe: number | null;
    avgMaeRoe: number | null;
    mfeMaeRatio: number | null;
    avgTimeToGreenMinutes: number | null;
    avgTimeTo5RoeMinutes: number | null;
    avgTimeTo8RoeMinutes: number | null;
    avgTimeTo10RoeMinutes: number | null;
    stopLossCount: number;
    breakEvenActivatedCount: number;
    protectProfitActivatedCount: number;
    trailingActivatedCount: number;
    exitEyeCloseCount: number;
    byEventRiskReason: Record<string, number>;
    byCleanEntryReason: Record<string, number>;
    bySetupGrade: Record<string, number>;
    byTailRiskBand: Record<string, number>;
    bySymbol: Record<string, number>;
    topTrades: AegisProbeTradeSample[];
    evaluations: AegisProbeEvaluationSample[];
    trades: AegisProbeTradeSample[];
    exitReasonLabelMismatches: ExitReasonLabelMismatch[];
    warnings: string[];
};

export type ParsedProbeCommand = AegisProbeReportInput & { valid: true };
export type InvalidProbeCommand = { valid: false; help: string };

type JsonRecord = Record<string, any>;

const MAX_WINDOW_MINUTES = 24 * 60;
const DEFAULT_WINDOW_MINUTES = 24 * 60;
const MAX_TELEGRAM_MESSAGE_CHARS = 3500;

const WINDOW_MINUTES: Record<string, number> = {
    '15m': 15,
    '30m': 30,
    '1h': 60,
    '2h': 120,
    '4h': 240,
    '6h': 360,
    '12h': 720,
    '24h': 1440
};

export class AegisProbeReportService {
    private readonly baseDir: string;
    private readonly now: () => Date;

    constructor(options: { baseDir?: string; now?: () => Date } = {}) {
        this.baseDir = options.baseDir ?? path.join(process.cwd(), 'logs', 'aegis');
        this.now = options.now ?? (() => new Date());
    }

    parseCommand(args: string[]): ParsedProbeCommand | InvalidProbeCommand {
        return parseProbeCommand(args);
    }

    async buildTelegramMessages(args: string[]): Promise<string[]> {
        const parsed = this.parseCommand(args);
        if (!parsed.valid) return [parsed.help];
        const report = await this.buildReport(parsed);
        return formatProbeReportMessages(report, parsed);
    }

    async buildReport(input: AegisProbeReportInput): Promise<AegisProbeReportOutput> {
        const windowMinutes = Math.min(input.windowMinutes, MAX_WINDOW_MINUTES);
        const windowEndDate = this.now();
        const windowStartDate = new Date(windowEndDate.getTime() - windowMinutes * 60 * 1000);
        const warnings: string[] = [];
        const symbolFilter = input.symbol?.toUpperCase();
        const eventRows = await this.readRows('turbo_trade_events', windowStartDate, windowEndDate, warnings);
        const tradeRows = await this.readRows('turbo_trades', windowStartDate, windowEndDate, warnings);
        const tradeEventsById = groupEventsByTradeId(eventRows);

        const evaluations = eventRows
            .filter((row) => isInWindow(row, windowStartDate, windowEndDate))
            .map(extractProbeEvaluation)
            .filter((sample): sample is AegisProbeEvaluationSample => Boolean(sample))
            .filter((sample) => !symbolFilter || sample.symbol === symbolFilter);

        const allowedTradeIds = new Set(
            evaluations
                .filter((sample) => sample.decision === 'ALLOW')
                .map((sample) => sample.tradeId)
                .filter((tradeId): tradeId is string => Boolean(tradeId))
        );

        const trades = tradeRows
            .filter((row) => isProbeTrade(row, allowedTradeIds))
            .map((row) => extractProbeTrade(row, tradeEventsById.get(stableText(row.trade_id)) ?? []))
            .filter((trade): trade is AegisProbeTradeSample => Boolean(trade))
            .filter((trade) => !symbolFilter || trade.symbol === symbolFilter);

        const openedTradeIds = new Set(trades.map((trade) => trade.tradeId));
        const closedTrades = trades.filter((trade) => trade.closedAt);
        const byEventRiskReason: Record<string, number> = {};
        const byCleanEntryReason: Record<string, number> = {};
        const bySetupGrade: Record<string, number> = {};
        const byTailRiskBand: Record<string, number> = {};
        const bySymbol: Record<string, number> = {};

        for (const sample of evaluations) {
            increment(byEventRiskReason, sample.eventRiskReason ?? 'UNKNOWN');
            for (const reason of sample.cleanEntryReasons.length > 0 ? sample.cleanEntryReasons : ['UNKNOWN']) {
                increment(byCleanEntryReason, reason);
            }
            increment(bySetupGrade, sample.setupGrade ?? 'UNKNOWN');
            increment(byTailRiskBand, tailRiskBand(sample.tailRiskScore));
            increment(bySymbol, sample.symbol);
        }

        const wins = closedTrades.filter((trade) => (trade.roe ?? 0) > 0).length;
        const pnlTotal = sum(closedTrades.map((trade) => trade.pnlUsdt));
        const avgMfe = average(closedTrades.map((trade) => trade.mfeRoe));
        const avgMae = average(closedTrades.map((trade) => trade.maeRoe));
        const mismatches = detectExitReasonLabelMismatches(tradeRows, tradeEventsById)
            .filter((mismatch) => !symbolFilter || mismatch.symbol === symbolFilter);

        return {
            windowStart: windowStartDate.toISOString(),
            windowEnd: windowEndDate.toISOString(),
            totalEvaluations: evaluations.length,
            probeAllowed: evaluations.filter((sample) => sample.decision === 'ALLOW').length,
            probeDenied: evaluations.filter((sample) => sample.decision === 'DENY').length,
            tradesOpenedByProbe: openedTradeIds.size,
            tradesClosedByProbe: closedTrades.length,
            winRate: closedTrades.length > 0 ? wins / closedTrades.length : null,
            pnlTotal,
            avgRoe: average(closedTrades.map((trade) => trade.roe)),
            avgMfeRoe: avgMfe,
            avgMaeRoe: avgMae,
            mfeMaeRatio: avgMfe !== null && avgMae !== null && avgMae !== 0 ? avgMfe / Math.abs(avgMae) : null,
            avgTimeToGreenMinutes: average(closedTrades.map((trade) => trade.timeToGreenMinutes)),
            avgTimeTo5RoeMinutes: average(closedTrades.map((trade) => trade.timeTo5RoeMinutes)),
            avgTimeTo8RoeMinutes: average(closedTrades.map((trade) => trade.timeTo8RoeMinutes)),
            avgTimeTo10RoeMinutes: average(closedTrades.map((trade) => trade.timeTo10RoeMinutes)),
            stopLossCount: closedTrades.filter((trade) => String(trade.exitReason ?? '').toUpperCase().includes('STOP_LOSS')).length,
            breakEvenActivatedCount: trades.filter((trade) => trade.breakEvenActivated).length,
            protectProfitActivatedCount: trades.filter((trade) => trade.protectProfitActivated).length,
            trailingActivatedCount: trades.filter((trade) => trade.trailingActivated).length,
            exitEyeCloseCount: closedTrades.filter((trade) => trade.exitEyeClose).length,
            byEventRiskReason,
            byCleanEntryReason,
            bySetupGrade,
            byTailRiskBand,
            bySymbol,
            topTrades: [...closedTrades].sort(compareProbeTrade).slice(0, 5),
            evaluations: evaluations.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, 20),
            trades: [...trades].sort((a, b) => Date.parse(b.openedAt ?? b.closedAt ?? '') - Date.parse(a.openedAt ?? a.closedAt ?? '')).slice(0, 20),
            exitReasonLabelMismatches: mismatches,
            warnings
        };
    }

    private async readRows(prefix: string, windowStart: Date, windowEnd: Date, warnings: string[]): Promise<JsonRecord[]> {
        const rows: JsonRecord[] = [];
        for (const date of datesInRange(windowStart, windowEnd)) {
            const filePath = path.join(this.baseDir, `${prefix}_${date}.jsonl`);
            let content = '';
            try {
                content = await fs.readFile(filePath, 'utf8');
            } catch (error: any) {
                if (error?.code !== 'ENOENT') warnings.push(`No se pudo leer ${path.basename(filePath)}: ${String(error)}`);
                continue;
            }
            let corrupt = 0;
            for (const line of content.split(/\r?\n/).filter((value) => value.trim().length > 0)) {
                try {
                    const parsed = JSON.parse(line);
                    if (parsed && typeof parsed === 'object') rows.push(parsed);
                } catch {
                    corrupt += 1;
                }
            }
            if (corrupt > 0) warnings.push(`${path.basename(filePath)}: ${corrupt} líneas JSON corruptas ignoradas`);
        }
        return rows;
    }
}

export function parseProbeCommand(args: string[]): ParsedProbeCommand | InvalidProbeCommand {
    const tokens = args.map((arg) => arg.trim()).filter(Boolean);
    if (tokens.length === 0) return parsed('summary', undefined, DEFAULT_WINDOW_MINUTES);
    const first = tokens[0]?.toLowerCase();

    if (first === 'near-miss') {
        const windowMinutes = tokens[1] ? parseWindowMinutes(tokens[1]) : DEFAULT_WINDOW_MINUTES;
        if (!windowMinutes || tokens.length > 2) return invalidProbeCommand();
        return parsed('near-miss', undefined, windowMinutes);
    }

    if (first === 'detail') {
        const symbol = normalizeSymbol(tokens[1]);
        const windowMinutes = tokens[2] ? parseWindowMinutes(tokens[2]) : DEFAULT_WINDOW_MINUTES;
        if (!symbol || !windowMinutes || tokens.length > 3) return invalidProbeCommand();
        return parsed('detail', symbol, windowMinutes);
    }

    const onlyWindow = parseWindowMinutes(tokens[0]);
    if (onlyWindow && tokens.length === 1) return parsed('summary', undefined, onlyWindow);

    const symbol = normalizeSymbol(tokens[0]);
    if (symbol) {
        const windowMinutes = tokens[1] ? parseWindowMinutes(tokens[1]) : DEFAULT_WINDOW_MINUTES;
        if (!windowMinutes || tokens.length > 2) return invalidProbeCommand();
        return parsed('summary', symbol, windowMinutes);
    }

    return invalidProbeCommand();
}

export function detectExitReasonLabelMismatches(
    tradeRows: JsonRecord[],
    eventsByTradeId: Map<string, JsonRecord[]> = new Map()
): ExitReasonLabelMismatch[] {
    const mismatches: ExitReasonLabelMismatch[] = [];
    const derivedEventsByTradeId = eventsByTradeId.size > 0
        ? eventsByTradeId
        : groupEventsByTradeId(tradeRows.filter((row) => row.event !== undefined));
    for (const row of tradeRows) {
        if (stableText(row.status).toUpperCase() !== 'CLOSED') continue;
        const tradeId = stableText(row.trade_id);
        const reason = stableText(row.exit_reason);
        const metadata = row.metadata ?? {};
        const closeEvents = (derivedEventsByTradeId.get(tradeId) ?? [])
            .filter((event) => stableText(event.event) === 'TRADE_CLOSED');
        const eventClose = closeEvents.length > 0 ? closeEvents[closeEvents.length - 1] : undefined;
        const exitType = stableText(
            metadata.canonical_exit_type
                ?? metadata.exit_type
                ?? eventClose?.metadata?.canonicalExitType
                ?? eventClose?.metadata?.exitType
        );
        const mismatchReason = classifyExitMismatch(reason, exitType, derivedEventsByTradeId.get(tradeId) ?? []);
        if (mismatchReason) {
            mismatches.push({
                tradeId,
                symbol: stableText(row.symbol),
                reason,
                exitType,
                mismatchReason
            });
        }
    }
    return mismatches;
}

function extractProbeEvaluation(row: JsonRecord): AegisProbeEvaluationSample | undefined {
    const metadata = row.metadata ?? {};
    const trace = metadata.trace ?? {};
    const guards = metadata.guards ?? trace.guards ?? {};
    const probeGuard = guards.probe_mode ?? {};
    const probeMode = metadata.probeMode ?? probeGuard.metadata?.probeMode ?? {};
    const event = stableText(row.event);
    const hasProbe = event === 'PROBE_MODE_ALLOWED'
        || event === 'PROBE_MODE_DENIED'
        || Object.keys(probeGuard).length > 0
        || Object.keys(probeMode).length > 0
        || stableText(metadata.finalReason) === 'probe_mode_allowed';
    if (!hasProbe) return undefined;

    const cleanEntry = metadata.cleanEntryGuard ?? guards.clean_entry?.metadata ?? {};
    const eventRisk = guards.event_risk?.metadata ?? {};
    const decisionBrain = guards.decision_brain?.metadata ?? {};
    const entryQuality = guards.entry_quality?.metadata ?? {};
    const turbo = trace.turbo ?? {};
    const decision = event === 'PROBE_MODE_ALLOWED'
        || stableText(probeGuard.decision) === 'ALLOW'
        || stableText(metadata.finalReason) === 'probe_mode_allowed'
        ? 'ALLOW'
        : 'DENY';

    return {
        timestamp: timestampText(row),
        tradeId: nullableText(row.trade_id),
        symbol: stableText(row.symbol ?? metadata.symbol ?? trace.symbol ?? probeMode.symbol).toUpperCase(),
        side: normalizeSide(metadata.side ?? trace.side ?? probeMode.side),
        event,
        decision,
        probeReason: stableText(row.reason ?? probeGuard.reason ?? probeMode.reason),
        finalReason: nullableText(metadata.finalReason ?? trace.finalReason),
        eventRiskMode: nullableText(probeMode.eventRiskMode ?? cleanEntry.eventRiskMode ?? eventRisk.mode),
        eventRiskReason: nullableText(probeMode.eventRiskReason ?? cleanEntry.eventRiskReason ?? eventRisk.reason),
        cleanEntryDecision: nullableText(cleanEntry.decision ?? guards.clean_entry?.decision),
        cleanEntryReasons: arrayText(probeMode.cleanEntryReasons ?? cleanEntry.reasons),
        decisionBrain: nullableText(probeMode.decisionBrain ?? cleanEntry.decisionBrain ?? decisionBrain.decisionBrainDecision),
        entryQualityRecommendation: nullableText(probeMode.entryQualityRecommendation ?? cleanEntry.entryQualityRecommendation ?? decisionBrain.entryQualityRecommendation ?? entryQuality.action),
        entryQualityScore: finiteNumber(cleanEntry.entryQualityScore ?? decisionBrain.entryQualityScore ?? eventRisk.entryQualityScore),
        tailRiskScore: finiteNumber(probeMode.tailRiskScore ?? cleanEntry.tailRiskScore ?? decisionBrain.tailRiskScore ?? eventRisk.tailRiskScore),
        setupGrade: nullableText(metadata.setupGrade ?? metadata.setup_grade ?? cleanEntry.setupGrade ?? decisionBrain.setupGrade),
        turboScore: finiteNumber(probeMode.turboScore ?? cleanEntry.turboScore ?? turbo.score ?? metadata.turboScore),
        votes: normalizeVotes(cleanEntry.votes ?? turbo.votes ?? metadata.votes)
    };
}

function extractProbeTrade(row: JsonRecord, events: JsonRecord[]): AegisProbeTradeSample | undefined {
    const metadata = row.metadata ?? {};
    const cleanEntry = metadata.cleanEntryGuard ?? {};
    const probeMode = metadata.probeMode ?? {};
    const openedAt = nullableText(row.opened_at);
    const closedAt = nullableText(row.closed_at);
    const openedMs = openedAt ? Date.parse(openedAt) : undefined;
    const firstRoeEvent = firstEventAtOrAbove(events, 0, openedMs);
    const first5RoeEvent = firstEventAtOrAbove(events, 0.05, openedMs);
    const first8RoeEvent = firstEventAtOrAbove(events, 0.08, openedMs);
    const first10RoeEvent = firstEventAtOrAbove(events, 0.10, openedMs);
    const closeEvents = events.filter((event) => stableText(event.event) === 'TRADE_CLOSED');
    const closeEvent = closeEvents.length > 0 ? closeEvents[closeEvents.length - 1] : undefined;
    const exitType = stableText(metadata.canonical_exit_type ?? metadata.exit_type ?? closeEvent?.metadata?.canonicalExitType ?? closeEvent?.metadata?.exitType);

    return {
        tradeId: stableText(row.trade_id),
        symbol: stableText(row.symbol).toUpperCase(),
        side: normalizeSide(row.side),
        openedAt,
        closedAt,
        durationMinutes: finiteNumber(row.duration_minutes),
        entryPrice: finiteNumber(row.entry_price),
        exitPrice: finiteNumber(row.exit_price),
        leverage: finiteNumber(row.leverage),
        positionFraction: finiteNumber(row.position_fraction),
        marginEstimated: finiteNumber(row.margin_estimated),
        pnlUsdt: finiteNumber(row.pnl_usdt),
        roe: finiteNumber(row.roe),
        mfeRoe: finiteNumber(row.mfe_roe),
        maeRoe: finiteNumber(row.mae_roe),
        timeToGreenMinutes: minutesBetween(openedMs, firstRoeEvent),
        timeTo5RoeMinutes: minutesBetween(openedMs, first5RoeEvent),
        timeTo8RoeMinutes: minutesBetween(openedMs, first8RoeEvent),
        timeTo10RoeMinutes: minutesBetween(openedMs, first10RoeEvent),
        breakEvenActivated: events.some((event) => stableText(event.event).startsWith('BREAK_EVEN')),
        protectProfitActivated: events.some((event) => stableText(event.event).includes('PROTECT_PROFIT')),
        trailingActivated: events.some((event) => stableText(event.event) === 'TRAILING_ACTIVATED' || stableText(event.reason) === 'MOVE_SL_TRAILING'),
        exitEyeClose: events.some((event) => stableText(event.event) === 'AEGIS_EXIT_EYE_CLOSE_POSITION')
            || stableText(row.exit_reason).includes('AEGIS_EXIT_EYE'),
        exitReason: nullableText(row.exit_reason),
        canonicalExitType: exitType === 'N/D' ? null : exitType,
        displayExitLabel: nullableText(metadata.display_exit_label ?? closeEvent?.metadata?.displayExitLabel),
        eventRiskMode: nullableText(probeMode.eventRiskMode ?? cleanEntry.eventRiskMode),
        eventRiskReason: nullableText(probeMode.eventRiskReason ?? cleanEntry.eventRiskReason),
        cleanEntryDecision: nullableText(cleanEntry.decision),
        cleanEntryReasons: arrayText(probeMode.cleanEntryReasons ?? cleanEntry.reasons),
        decisionBrain: nullableText(probeMode.decisionBrain ?? cleanEntry.decisionBrain),
        entryQualityRecommendation: nullableText(probeMode.entryQualityRecommendation ?? cleanEntry.entryQualityRecommendation),
        entryQualityScore: finiteNumber(cleanEntry.entryQualityScore),
        tailRiskScore: finiteNumber(probeMode.tailRiskScore ?? cleanEntry.tailRiskScore),
        setupGrade: nullableText(cleanEntry.setupGrade ?? metadata.setup_grade),
        turboScore: finiteNumber(probeMode.turboScore ?? row.turbo_score),
        votes: normalizeVotes(cleanEntry.votes ?? row.votes)
    };
}

function isProbeTrade(row: JsonRecord, allowedTradeIds: Set<string>): boolean {
    const metadata = row.metadata ?? {};
    const tradeId = stableText(row.trade_id);
    return allowedTradeIds.has(tradeId)
        || metadata.probeMode?.allowed === true
        || metadata.entryPolicy?.finalReason === 'probe_mode_allowed';
}

function classifyExitMismatch(reason: string, exitType: string, events: JsonRecord[]): string | undefined {
    const normalizedReason = reason.toUpperCase();
    const normalizedExitType = exitType.toUpperCase();
    if (normalizedReason.includes('EXIT_EYE') && normalizedExitType.includes('TRAIL')) {
        return 'exit_eye_reason_with_trailing_exit_type';
    }
    if (normalizedReason.includes('STOP_LOSS') && normalizedExitType.includes('EXIT_EYE')) {
        return 'stop_loss_reason_with_exit_eye_exit_type';
    }
    if ((normalizedReason.includes('TAKE_PROFIT') || normalizedReason === 'SL/TP') && normalizedExitType.includes('EXIT_EYE')) {
        return 'take_profit_reason_with_exit_eye_exit_type';
    }
    const trailingEventSeen = events.some((event) => stableText(event.event) === 'TRAILING_ACTIVATED' || stableText(event.reason) === 'MOVE_SL_TRAILING');
    if (normalizedExitType.includes('TRAIL') && !trailingEventSeen) {
        return 'trailing_exit_type_without_trailing_activation';
    }
    return undefined;
}

function formatProbeReportMessages(report: AegisProbeReportOutput, input: AegisProbeReportInput): string[] {
    const lines: string[] = [`${titleFor(input)}\n`];

    if (input.mode === 'detail') {
        lines.push(
            `Total evaluaciones Probe: ${report.totalEvaluations}`,
            `Probe allowed: ${report.probeAllowed}`,
            `Probe denied: ${report.probeDenied}`,
            `Trades cerrados por Probe: ${report.tradesClosedByProbe}`
        );
        appendSection(lines, 'Por EventRisk reason:', report.byEventRiskReason, 8);
        appendSection(lines, 'Por CleanEntry reason:', report.byCleanEntryReason, 8);
        appendSection(lines, 'Por TailRisk band:', report.byTailRiskBand, 8);
        lines.push('', 'Últimos trades Probe:');
        appendProbeTrades(lines, report.trades);
        appendExitMismatchSection(lines, report.exitReasonLabelMismatches);
        appendWarnings(lines, report.warnings);
        return splitTelegramMessage(lines);
    }

    if (input.mode === 'near-miss') {
        lines.push(`Total evaluaciones Probe: ${report.totalEvaluations}`, '', 'Near-miss recientes:');
        appendProbeEvaluations(lines, report.evaluations.filter((sample) => sample.decision === 'ALLOW'));
        appendWarnings(lines, report.warnings);
        return splitTelegramMessage(lines);
    }

    lines.push(
        `Total evaluaciones Probe: ${report.totalEvaluations}`,
        `Probe allowed: ${report.probeAllowed}`,
        `Probe denied: ${report.probeDenied}`,
        `Trades abiertos por Probe: ${report.tradesOpenedByProbe}`,
        `Trades cerrados por Probe: ${report.tradesClosedByProbe}`,
        '',
        'Resultados:',
        `Win rate: ${formatPct(report.winRate)}`,
        `PnL total: ${formatUsd(report.pnlTotal)}`,
        `ROE promedio: ${formatPct(report.avgRoe, true)}`,
        `MFE promedio: ${formatPct(report.avgMfeRoe, true)}`,
        `MAE promedio: ${formatPct(report.avgMaeRoe, true)}`,
        `MFE/MAE ratio: ${formatNumber(report.mfeMaeRatio, 2)}`,
        `time_to_green promedio: ${formatMinutes(report.avgTimeToGreenMinutes)}`,
        `tiempo a +5% ROE: ${formatMinutes(report.avgTimeTo5RoeMinutes)}`,
        `tiempo a +8% ROE: ${formatMinutes(report.avgTimeTo8RoeMinutes)}`,
        `tiempo a +10% ROE: ${formatMinutes(report.avgTimeTo10RoeMinutes)}`,
        `Stop loss count: ${report.stopLossCount}`,
        `BE/protect/trailing: ${report.breakEvenActivatedCount}/${report.protectProfitActivatedCount}/${report.trailingActivatedCount}`,
        `ExitEye closes: ${report.exitEyeCloseCount}`,
        `exit_reason_label_mismatch: ${report.exitReasonLabelMismatches.length}`
    );
    appendSection(lines, 'Por EventRisk reason:', report.byEventRiskReason, 8);
    appendSection(lines, 'Por setupGrade:', report.bySetupGrade, 6);
    appendSection(lines, 'Por TailRisk band:', report.byTailRiskBand, 8);
    appendSection(lines, 'Por símbolo:', report.bySymbol, 8);
    lines.push('', 'Top trades Probe:');
    appendProbeTrades(lines, report.topTrades);
    appendExitMismatchSection(lines, report.exitReasonLabelMismatches);
    appendWarnings(lines, report.warnings);
    return splitTelegramMessage(lines);
}

function appendProbeTrades(lines: string[], trades: AegisProbeTradeSample[]): void {
    if (trades.length === 0) {
        lines.push('N/D');
        return;
    }
    trades.slice(0, 5).forEach((trade, index) => {
        lines.push(`${index + 1}) ${trade.symbol} ${trade.side}`);
        lines.push(`Score ${formatScore(trade.turboScore)} | TailRisk ${formatScore(trade.tailRiskScore)} | Setup ${trade.setupGrade ?? 'UNKNOWN'} | Result ${formatPct(trade.roe, true)}`);
        lines.push(`   MFE ${formatPct(trade.mfeRoe, true)} / MAE ${formatPct(trade.maeRoe, true)} | Exit ${trade.exitReason ?? 'N/D'} ${trade.canonicalExitType ? `(${trade.canonicalExitType})` : ''}`);
        if (index < Math.min(trades.length, 5) - 1) lines.push('');
    });
}

function appendProbeEvaluations(lines: string[], samples: AegisProbeEvaluationSample[]): void {
    if (samples.length === 0) {
        lines.push('N/D');
        return;
    }
    samples.slice(0, 8).forEach((sample) => {
        lines.push(`• ${sample.symbol} ${sample.side} | ${sample.probeReason} | ER ${sample.eventRiskReason ?? 'UNKNOWN'} | Tail ${formatNumber(sample.tailRiskScore, 2)} | Setup ${sample.setupGrade ?? 'UNKNOWN'}`);
    });
}

function appendExitMismatchSection(lines: string[], mismatches: ExitReasonLabelMismatch[]): void {
    if (mismatches.length === 0) return;
    lines.push('', 'exit_reason_label_mismatch:');
    for (const mismatch of mismatches.slice(0, 5)) {
        lines.push(`• ${mismatch.symbol} ${mismatch.tradeId}: ${mismatch.reason} vs ${mismatch.exitType} (${mismatch.mismatchReason})`);
    }
}

function parsed(mode: AegisProbeReportMode, symbol: string | undefined, windowMinutes: number): ParsedProbeCommand {
    return { valid: true, mode, symbol, windowMinutes: Math.min(windowMinutes, MAX_WINDOW_MINUTES) };
}

function invalidProbeCommand(): InvalidProbeCommand {
    return { valid: false, help: probeHelpMessage() };
}

function probeHelpMessage(): string {
    return [
        'Uso: /probe [15m|30m|1h|2h|4h|6h|12h|24h]',
        '/probe SYMBOL [ventana]',
        '/probe detail SYMBOL [ventana]',
        '/probe near-miss [ventana]'
    ].join('\n');
}

function groupEventsByTradeId(rows: JsonRecord[]): Map<string, JsonRecord[]> {
    const grouped = new Map<string, JsonRecord[]>();
    for (const row of rows) {
        const tradeId = stableText(row.trade_id);
        if (tradeId === 'N/D') continue;
        const list = grouped.get(tradeId) ?? [];
        list.push(row);
        grouped.set(tradeId, list);
    }
    return grouped;
}

function firstEventAtOrAbove(events: JsonRecord[], roe: number, openedMs?: number): number | undefined {
    const sorted = [...events].sort((a, b) => timestampMs(a) - timestampMs(b));
    const event = sorted.find((row) => {
        const rowRoe = finiteNumber(row.roe);
        const rowMs = timestampMs(row);
        return rowRoe !== null && rowRoe >= roe && (!openedMs || rowMs >= openedMs);
    });
    return event ? timestampMs(event) : undefined;
}

function minutesBetween(startMs?: number, endMs?: number): number | null {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs === undefined || startMs === undefined) return null;
    return (endMs - startMs) / 60000;
}

function compareProbeTrade(a: AegisProbeTradeSample, b: AegisProbeTradeSample): number {
    return (b.roe ?? Number.NEGATIVE_INFINITY) - (a.roe ?? Number.NEGATIVE_INFINITY)
        || (b.mfeRoe ?? Number.NEGATIVE_INFINITY) - (a.mfeRoe ?? Number.NEGATIVE_INFINITY);
}

function isInWindow(row: JsonRecord, start: Date, end: Date): boolean {
    const ms = timestampMs(row);
    return Number.isFinite(ms) && ms >= start.getTime() && ms <= end.getTime();
}

function timestampMs(row: JsonRecord): number {
    const value = Date.parse(String(row.timestamp ?? row.closed_at ?? row.opened_at ?? ''));
    return Number.isFinite(value) ? value : Number.NaN;
}

function timestampText(row: JsonRecord): string {
    const timestamp = String(row.timestamp ?? '');
    return Number.isFinite(Date.parse(timestamp)) ? timestamp : new Date(0).toISOString();
}

function parseWindowMinutes(value: string): number | undefined {
    return WINDOW_MINUTES[value.toLowerCase()];
}

function normalizeSymbol(value?: string): string | undefined {
    const symbol = String(value ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{3,20}$/.test(symbol)) return undefined;
    if (WINDOW_MINUTES[symbol.toLowerCase()]) return undefined;
    return symbol;
}

function normalizeSide(value: unknown): string {
    const text = stableText(value).toUpperCase();
    return text === 'LONG' || text === 'SHORT' ? text : 'N/D';
}

function normalizeVotes(value: unknown): { long?: number; short?: number; neutral?: number } {
    const votes = typeof value === 'object' && value !== null ? value as JsonRecord : {};
    return {
        long: finiteNumber(votes.long) ?? undefined,
        short: finiteNumber(votes.short) ?? undefined,
        neutral: finiteNumber(votes.neutral) ?? undefined
    };
}

function arrayText(value: unknown): string[] {
    return Array.isArray(value) ? value.map(stableText).filter((text) => text !== 'N/D') : [];
}

function stableText(value: unknown): string {
    const text = String(value ?? 'N/D').trim();
    return text.length > 0 ? text : 'N/D';
}

function nullableText(value: unknown): string | null {
    const text = stableText(value);
    return text === 'N/D' ? null : text;
}

function finiteNumber(value: unknown): number | null {
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function average(values: Array<number | null>): number | null {
    const finite = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return finite.length > 0 ? sum(finite) / finite.length : null;
}

function sum(values: Array<number | null>): number {
    return values.reduce<number>((total, value) => total + (typeof value === 'number' && Number.isFinite(value) ? value : 0), 0);
}

function tailRiskBand(value: number | null): string {
    if (value === null) return 'UNKNOWN';
    if (value < 0.20) return '0.00-0.20';
    if (value < 0.25) return '0.20-0.25';
    if (value < 0.30) return '0.25-0.30';
    if (value < 0.35) return '0.30-0.35';
    return '>0.35';
}

function increment(counts: Record<string, number>, key: string): void {
    const safeKey = key || 'N/D';
    counts[safeKey] = (counts[safeKey] ?? 0) + 1;
}

function appendSection(lines: string[], title: string, counts: Record<string, number>, max: number): void {
    lines.push('', title);
    const rows = Object.entries(counts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, max);
    if (rows.length === 0) {
        lines.push('• N/D: 0');
        return;
    }
    for (const [key, count] of rows) lines.push(`• ${key}: ${count}`);
}

function appendWarnings(lines: string[], warnings: string[]): void {
    if (warnings.length === 0) return;
    lines.push('', 'Warnings:');
    for (const warning of warnings.slice(0, 3)) lines.push(`• ${warning}`);
}

function splitTelegramMessage(lines: string[]): string[] {
    const messages: string[] = [];
    let current = '';
    for (const line of lines) {
        const next = current.length > 0 ? `${current}\n${line}` : line;
        if (next.length > MAX_TELEGRAM_MESSAGE_CHARS && current.length > 0) {
            messages.push(current);
            current = line;
        } else {
            current = next;
        }
    }
    if (current.length > 0) messages.push(current);
    return messages;
}

function datesInRange(start: Date, end: Date): string[] {
    const dates: string[] = [];
    const current = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
    while (current.getTime() <= last.getTime()) {
        dates.push(formatDate(current));
        current.setUTCDate(current.getUTCDate() + 1);
    }
    return dates;
}

function formatDate(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function titleFor(input: AegisProbeReportInput): string {
    const window = formatWindow(input.windowMinutes);
    if (input.mode === 'detail') return `🧪 Probe Mode ${input.symbol ?? 'Aegis'} — última ${window}`;
    if (input.mode === 'near-miss') return `🧪 Probe Mode near-miss — última ${window}`;
    return input.symbol ? `🧪 Probe Mode ${input.symbol} — última ${window}` : `🧪 Probe Mode — última ${window}`;
}

function formatWindow(windowMinutes: number): string {
    if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
    return `${windowMinutes}m`;
}

function formatPct(value: number | null, signed = false): string {
    if (value === null) return 'N/D';
    const pct = value * 100;
    return `${signed && pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function formatScore(value: number | null): string {
    return value === null ? 'N/D' : `${(value * 100).toFixed(1)}%`;
}

function formatUsd(value: number | null): string {
    if (value === null) return 'N/D';
    return `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(2)}`;
}

function formatMinutes(value: number | null): string {
    return value === null ? 'N/D' : `${value.toFixed(1)}m`;
}

function formatNumber(value: number | null, digits: number): string {
    return value === null ? 'N/D' : value.toFixed(digits);
}
