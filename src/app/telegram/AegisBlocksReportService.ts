import path from 'path';
import { promises as fs } from 'fs';

export type AegisBlocksReportMode = 'summary' | 'reasons' | 'symbols' | 'detail' | 'top' | 'near-miss';

export type AegisBlocksReportInput = {
    symbol?: string;
    windowMinutes: number;
    mode: AegisBlocksReportMode;
};

export type AegisBlockSample = {
    timestamp: string;
    symbol: string;
    side: string;
    reason: string;
    event: string;
    setupGrade: string | null;
    turboScore: number | null;
    votes: { long?: number; short?: number; neutral?: number } | null;
    decisionBrain: string | null;
    entryQuality: string | null;
    entryQualityScore: number | null;
    tailRiskScore: number | null;
    eventRiskMode: string | null;
    eventRiskReason: string | null;
    eventRiskWouldBlock: boolean | null;
    aPlus: boolean | null;
    rawWouldExecute: boolean | null;
    source: string | null;
    tradeId: string | null;
};

export type AegisBlocksReportOutput = {
    windowStart: string;
    windowEnd: string;
    totalBlocks: number;
    bySymbol: Record<string, number>;
    bySide: Record<string, number>;
    byReason: Record<string, number>;
    byDecisionBrain: Record<string, number>;
    byEntryQuality: Record<string, number>;
    byEventRisk: Record<string, number>;
    bySetupGrade: Record<string, number>;
    allowedEvents: Record<string, number>;
    topBlocks: Array<{ key: string; count: number }>;
    nearMisses: AegisBlockSample[];
    samples: AegisBlockSample[];
    warnings: string[];
};

export type ParsedBlocksCommand = AegisBlocksReportInput & {
    valid: true;
};

export type InvalidBlocksCommand = {
    valid: false;
    help: string;
};

type JsonRecord = Record<string, any>;

const MAX_WINDOW_MINUTES = 24 * 60;
const DEFAULT_WINDOW_MINUTES = 60;
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

const BLOCK_EVENTS = new Set([
    'DECISION_ENFORCEMENT_DENIED',
    'ENTRY_QUALITY_GATE_SHADOW_BLOCK',
    'ENTRY_QUALITY_GATE_DENIED',
    'EVENT_RISK_SHADOW_BLOCK',
    'EVENT_RISK_DENIED'
]);

const BLOCK_REASONS = new Set([
    'event_risk_caution_denied_weak_setup',
    'event_risk_caution_would_block_denied',
    'event_risk_risk_off_denied_non_a_plus',
    'entry_quality_shadow_block_hard_denied',
    'decision_brain_wait_confirmation',
    'decision_brain_do_not_enter',
    'decision_brain_manual_only',
    'short_score_below_premium_threshold',
    'short_votes_below_required',
    'turbo_score_below_threshold',
    'raw_would_execute_false'
]);

const ALLOWED_EVENTS = new Set([
    'GATE_ALLOWED',
    'ORDER_SUBMITTED',
    'POSITION_CONFIRMED',
    'BRACKETS_CONFIRMED',
    'TRADE_CLOSED'
]);

export class AegisBlocksReportService {
    private readonly baseDir: string;
    private readonly now: () => Date;

    constructor(options: { baseDir?: string; now?: () => Date } = {}) {
        this.baseDir = options.baseDir ?? path.join(process.cwd(), 'logs', 'aegis');
        this.now = options.now ?? (() => new Date());
    }

    parseCommand(args: string[]): ParsedBlocksCommand | InvalidBlocksCommand {
        return parseBlocksCommand(args);
    }

    async buildTelegramMessages(args: string[]): Promise<string[]> {
        const parsed = this.parseCommand(args);
        if (!parsed.valid) return [parsed.help];

        const report = await this.buildReport(parsed);
        return formatBlocksReportMessages(report, parsed);
    }

    async buildReport(input: AegisBlocksReportInput): Promise<AegisBlocksReportOutput> {
        const windowMinutes = Math.min(input.windowMinutes, MAX_WINDOW_MINUTES);
        const windowEndDate = this.now();
        const windowStartDate = new Date(windowEndDate.getTime() - windowMinutes * 60 * 1000);
        const warnings: string[] = [];
        const rows = await this.readRows(windowStartDate, windowEndDate, warnings);
        const symbolFilter = input.symbol?.toUpperCase();

        const blocks: AegisBlockSample[] = [];
        const allowedEvents: Record<string, number> = {};

        for (const row of rows) {
            const timestampMs = timestampMsFromRow(row);
            if (timestampMs === undefined || timestampMs < windowStartDate.getTime() || timestampMs > windowEndDate.getTime()) {
                continue;
            }

            const symbol = stableText(row.symbol ?? row.metadata?.symbol).toUpperCase();
            if (symbolFilter && symbol !== symbolFilter) continue;

            const event = stableText(row.event);
            if (ALLOWED_EVENTS.has(event)) {
                increment(allowedEvents, event);
            }

            if (!isBlockRow(row)) continue;
            blocks.push(extractBlockSample(row));
        }

        const bySymbol: Record<string, number> = {};
        const bySide: Record<string, number> = {};
        const byReason: Record<string, number> = {};
        const byDecisionBrain: Record<string, number> = {};
        const byEntryQuality: Record<string, number> = {};
        const byEventRisk: Record<string, number> = {};
        const bySetupGrade: Record<string, number> = {};

        for (const block of blocks) {
            increment(bySymbol, block.symbol);
            increment(bySide, block.side);
            increment(byReason, block.reason);
            increment(byDecisionBrain, block.decisionBrain ?? 'N/D');
            increment(byEntryQuality, block.entryQuality ?? 'N/D');
            increment(byEventRisk, block.eventRiskMode ?? 'N/D');
            increment(bySetupGrade, block.setupGrade ?? 'N/D');
        }

        const topBlocks = topEntries(bySymbol, 5)
            .concat(topEntries(byReason, 5))
            .sort((a, b) => b.count - a.count)
            .slice(0, 8);

        return {
            windowStart: windowStartDate.toISOString(),
            windowEnd: windowEndDate.toISOString(),
            totalBlocks: blocks.length,
            bySymbol,
            bySide,
            byReason,
            byDecisionBrain,
            byEntryQuality,
            byEventRisk,
            bySetupGrade,
            allowedEvents,
            topBlocks,
            nearMisses: blocks.filter(isNearMiss).sort(compareNearMiss).slice(0, 5),
            samples: blocks.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, 8),
            warnings
        };
    }

    private async readRows(windowStart: Date, windowEnd: Date, warnings: string[]): Promise<JsonRecord[]> {
        const rows: JsonRecord[] = [];
        for (const date of datesInRange(windowStart, windowEnd)) {
            const filePath = path.join(this.baseDir, `turbo_trade_events_${date}.jsonl`);
            let content = '';
            try {
                content = await fs.readFile(filePath, 'utf8');
            } catch (error: any) {
                if (error?.code !== 'ENOENT') warnings.push(`No se pudo leer ${path.basename(filePath)}: ${String(error)}`);
                continue;
            }

            const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
            let corrupt = 0;
            for (const line of lines) {
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

export function parseBlocksCommand(args: string[]): ParsedBlocksCommand | InvalidBlocksCommand {
    const tokens = args.map((arg) => arg.trim()).filter(Boolean);
    if (tokens.length === 0) return parsed('summary', undefined, DEFAULT_WINDOW_MINUTES);

    const first = tokens[0]?.toLowerCase();
    if (first === 'reasons' || first === 'symbols' || first === 'top' || first === 'near-miss') {
        const windowMinutes = tokens[1] ? parseWindowMinutes(tokens[1]) : DEFAULT_WINDOW_MINUTES;
        if (!windowMinutes || tokens.length > 2) return invalidBlocksCommand();
        return parsed(first, undefined, windowMinutes);
    }

    if (first === 'detail') {
        const symbol = normalizeSymbol(tokens[1]);
        const windowMinutes = tokens[2] ? parseWindowMinutes(tokens[2]) : DEFAULT_WINDOW_MINUTES;
        if (!symbol || !windowMinutes || tokens.length > 3) return invalidBlocksCommand();
        return parsed('detail', symbol, windowMinutes);
    }

    const onlyWindow = parseWindowMinutes(tokens[0]);
    if (onlyWindow && tokens.length === 1) return parsed('summary', undefined, onlyWindow);

    const symbol = normalizeSymbol(tokens[0]);
    if (symbol) {
        const windowMinutes = tokens[1] ? parseWindowMinutes(tokens[1]) : DEFAULT_WINDOW_MINUTES;
        if (!windowMinutes || tokens.length > 2) return invalidBlocksCommand();
        return parsed('summary', symbol, windowMinutes);
    }

    return invalidBlocksCommand();
}

function parsed(mode: AegisBlocksReportMode, symbol: string | undefined, windowMinutes: number): ParsedBlocksCommand {
    return {
        valid: true,
        mode,
        symbol,
        windowMinutes: Math.min(windowMinutes, MAX_WINDOW_MINUTES)
    };
}

function invalidBlocksCommand(): InvalidBlocksCommand {
    return { valid: false, help: blocksHelpMessage() };
}

function blocksHelpMessage(): string {
    return [
        'Uso: /blocks [15m|30m|1h|2h|4h|6h|12h|24h]',
        '/blocks SYMBOL [ventana]',
        '/blocks reasons [ventana] | symbols [ventana] | top [ventana]',
        '/blocks detail SYMBOL [ventana]',
        '/blocks near-miss [ventana]'
    ].join('\n');
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

function isBlockRow(row: JsonRecord): boolean {
    const event = stableText(row.event);
    const reason = stableText(row.reason ?? row.metadata?.reason);
    return BLOCK_EVENTS.has(event) || BLOCK_REASONS.has(reason);
}

function extractBlockSample(row: JsonRecord): AegisBlockSample {
    const metadata = row.metadata ?? {};
    const checks = metadata.checks ?? {};
    const event = stableText(row.event);
    const reason = stableText(row.reason ?? metadata.reason ?? metadata.eventRiskReason ?? event);
    return {
        timestamp: timestampText(row),
        symbol: stableText(row.symbol ?? metadata.symbol).toUpperCase(),
        side: normalizeSide(metadata.side ?? row.side ?? row.raw_action ?? row.final_action),
        reason,
        event,
        setupGrade: nullableText(metadata.setupGrade ?? metadata.setup_grade ?? row.setupGrade ?? row.setup_grade),
        turboScore: finiteNumber(metadata.turboScore ?? metadata.turbo_score ?? row.turbo_score ?? checks.turboScore),
        votes: normalizeVotes(metadata.votes ?? row.votes),
        decisionBrain: nullableText(metadata.decisionBrainDecision ?? metadata.decision_brain_decision ?? metadata.decisionBrain ?? metadata.decision_brain?.decision),
        entryQuality: nullableText(metadata.entryQualityRecommendation ?? metadata.entry_quality_recommendation ?? metadata.entryQualityGateAction ?? metadata.action ?? metadata.entryQuality),
        entryQualityScore: finiteNumber(metadata.entryQualityScore ?? metadata.entry_quality_score ?? checks.entryQualityScore),
        tailRiskScore: finiteNumber(metadata.tailRiskScore ?? metadata.tail_risk_score ?? checks.tailRiskScore),
        eventRiskMode: nullableText(metadata.eventRiskMode ?? metadata.event_risk_mode ?? (event.startsWith('EVENT_RISK') ? metadata.mode : undefined)),
        eventRiskReason: nullableText(metadata.eventRiskReason ?? metadata.event_risk_reason ?? (event.startsWith('EVENT_RISK') ? metadata.reason : undefined)),
        eventRiskWouldBlock: nullableBoolean(metadata.eventRiskWouldBlock ?? metadata.event_risk_would_block ?? metadata.wouldBlock ?? checks.eventRiskWouldBlock),
        aPlus: nullableBoolean(metadata.aPlus ?? metadata.is_a_plus ?? checks.aPlus),
        rawWouldExecute: nullableBoolean(metadata.rawWouldExecute ?? metadata.raw_would_execute ?? row.raw_would_execute),
        source: nullableText(metadata.source ?? event),
        tradeId: nullableText(row.trade_id ?? metadata.tradeId ?? metadata.trade_id)
    };
}

function formatBlocksReportMessages(report: AegisBlocksReportOutput, input: AegisBlocksReportInput): string[] {
    const title = titleFor(input);
    const lines: string[] = [`${title}\n`, `Total: ${report.totalBlocks}`];

    if (input.mode === 'detail') {
        appendSideSummary(lines, report.bySide);
        appendSection(lines, 'Razones:', report.byReason, 6);
        lines.push('', 'Últimos relevantes:');
        appendSamples(lines, report.samples);
        appendWarnings(lines, report.warnings);
        return splitTelegramMessage(lines);
    }

    if (input.mode === 'near-miss') {
        lines.push('', 'Estas fueron las bloqueadas más cercanas a pasar.');
        appendNearMisses(lines, report.nearMisses);
        appendWarnings(lines, report.warnings);
        return splitTelegramMessage(lines);
    }

    if (input.mode === 'reasons') {
        appendSection(lines, 'Por razón:', report.byReason, 12);
        appendWarnings(lines, report.warnings);
        return splitTelegramMessage(lines);
    }

    if (input.mode === 'symbols') {
        appendSection(lines, 'Por símbolo:', report.bySymbol, 12);
        appendWarnings(lines, report.warnings);
        return splitTelegramMessage(lines);
    }

    if (input.mode === 'top') {
        appendTop(lines, report.topBlocks);
        appendWarnings(lines, report.warnings);
        return splitTelegramMessage(lines);
    }

    appendSection(lines, 'Por símbolo:', report.bySymbol, 6);
    appendSection(lines, 'Por razón:', report.byReason, 6);
    appendSection(lines, 'Por grade:', report.bySetupGrade, 6);
    appendSection(lines, 'Permitidas en ventana:', report.allowedEvents, 5);
    lines.push('', 'Usa:', '/blocks detail LINKUSDT', `/blocks near-miss ${formatWindow(input.windowMinutes)}`);
    appendWarnings(lines, report.warnings);
    return splitTelegramMessage(lines);
}

function titleFor(input: AegisBlocksReportInput): string {
    const window = formatWindow(input.windowMinutes);
    if (input.mode === 'near-miss') return `🎯 Near-miss Aegis — última ${window}`;
    if (input.mode === 'detail') return `🛡️ Bloqueos ${input.symbol ?? 'Aegis'} — última ${window}`;
    if (input.mode === 'reasons') return `🛡️ Bloqueos Aegis por razón — última ${window}`;
    if (input.mode === 'symbols') return `🛡️ Bloqueos Aegis por símbolo — última ${window}`;
    if (input.mode === 'top') return `🛡️ Top bloqueos Aegis — última ${window}`;
    return input.symbol
        ? `🛡️ Bloqueos ${input.symbol} — última ${window}`
        : `🛡️ Bloqueos Aegis — última ${window}`;
}

function appendSideSummary(lines: string[], bySide: Record<string, number>): void {
    lines.push(`LONG: ${bySide.LONG ?? 0} | SHORT: ${bySide.SHORT ?? 0}`);
}

function appendSection(lines: string[], title: string, counts: Record<string, number>, max: number): void {
    lines.push('', title);
    const rows = topEntries(counts, max);
    if (rows.length === 0) {
        lines.push('• N/D: 0');
        return;
    }
    for (const row of rows) lines.push(`• ${row.key}: ${row.count}`);
}

function appendTop(lines: string[], topBlocks: Array<{ key: string; count: number }>): void {
    lines.push('', 'Top:');
    if (topBlocks.length === 0) {
        lines.push('• N/D: 0');
        return;
    }
    for (const row of topBlocks) lines.push(`• ${row.key}: ${row.count}`);
}

function appendSamples(lines: string[], samples: AegisBlockSample[]): void {
    if (samples.length === 0) {
        lines.push('N/D');
        return;
    }
    samples.slice(0, 5).forEach((sample, index) => {
        lines.push(`${index + 1}) ${sample.side} | Score ${formatPct(sample.turboScore)} | Grade ${sample.setupGrade ?? 'N/D'}`);
        lines.push(`   DB: ${sample.decisionBrain ?? 'N/D'} | EQ: ${sample.entryQuality ?? 'N/D'} | Tail: ${formatPct(sample.tailRiskScore)}`);
        lines.push(`   Motivo: ${formatReason(sample)}`);
        if (index < Math.min(samples.length, 5) - 1) lines.push('');
    });
}

function appendNearMisses(lines: string[], samples: AegisBlockSample[]): void {
    if (samples.length === 0) {
        lines.push('N/D');
        return;
    }
    samples.forEach((sample, index) => {
        lines.push('', `${index + 1}) ${sample.symbol} ${sample.side}`);
        lines.push(`Score: ${formatPct(sample.turboScore)} | Grade ${sample.setupGrade ?? 'N/D'}`);
        lines.push(`DB: ${sample.decisionBrain ?? 'N/D'} | EQ: ${sample.entryQuality ?? 'N/D'} | Tail: ${formatPct(sample.tailRiskScore)}`);
        lines.push(`Bloqueo: ${formatReason(sample)}`);
    });
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

function isNearMiss(sample: AegisBlockSample): boolean {
    return (sample.turboScore ?? 0) >= 0.80
        || sample.setupGrade === 'A'
        || sample.setupGrade === 'A_PLUS'
        || sample.decisionBrain === 'ENTER_NOW'
        || sample.entryQuality === 'ALLOW'
        || sample.entryQuality === 'ALLOW_SHADOW'
        || ((sample.tailRiskScore ?? Number.POSITIVE_INFINITY) <= 0.50);
}

function compareNearMiss(a: AegisBlockSample, b: AegisBlockSample): number {
    const gradeDiff = gradeRank(b.setupGrade) - gradeRank(a.setupGrade);
    if (gradeDiff !== 0) return gradeDiff;
    const scoreDiff = (b.turboScore ?? -1) - (a.turboScore ?? -1);
    if (scoreDiff !== 0) return scoreDiff;
    const eqDiff = entryQualityRank(b.entryQuality) - entryQualityRank(a.entryQuality);
    if (eqDiff !== 0) return eqDiff;
    return (a.tailRiskScore ?? Number.POSITIVE_INFINITY) - (b.tailRiskScore ?? Number.POSITIVE_INFINITY);
}

function gradeRank(value: string | null): number {
    if (value === 'A_PLUS') return 2;
    if (value === 'A') return 1;
    return 0;
}

function entryQualityRank(value: string | null): number {
    if (value === 'ALLOW') return 2;
    if (value === 'ALLOW_SHADOW') return 1;
    return 0;
}

function topEntries(counts: Record<string, number>, max: number): Array<{ key: string; count: number }> {
    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, max)
        .map(([key, count]) => ({ key, count }));
}

function increment(counts: Record<string, number>, key: string): void {
    const safeKey = key || 'N/D';
    counts[safeKey] = (counts[safeKey] ?? 0) + 1;
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

function timestampMsFromRow(row: JsonRecord): number | undefined {
    const value = Date.parse(String(row.timestamp ?? ''));
    return Number.isFinite(value) ? value : undefined;
}

function timestampText(row: JsonRecord): string {
    const timestamp = String(row.timestamp ?? '');
    return Number.isFinite(Date.parse(timestamp)) ? timestamp : new Date(0).toISOString();
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

function nullableBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
}

function normalizeSide(value: unknown): string {
    const text = stableText(value).toUpperCase();
    return text === 'LONG' || text === 'SHORT' ? text : 'N/D';
}

function normalizeVotes(value: unknown): { long?: number; short?: number; neutral?: number } | null {
    if (!value || typeof value !== 'object') return null;
    const votes = value as Record<string, unknown>;
    return {
        long: finiteNumber(votes.long) ?? undefined,
        short: finiteNumber(votes.short) ?? undefined,
        neutral: finiteNumber(votes.neutral) ?? undefined
    };
}

function formatPct(value: number | null): string {
    return value === null ? 'N/D' : `${(value * 100).toFixed(1)}%`;
}

function formatReason(sample: AegisBlockSample): string {
    if (sample.eventRiskMode && sample.eventRiskReason) return `${sample.eventRiskMode} / ${sample.eventRiskReason}`;
    return sample.reason;
}

function formatWindow(windowMinutes: number): string {
    if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
    return `${windowMinutes}m`;
}
