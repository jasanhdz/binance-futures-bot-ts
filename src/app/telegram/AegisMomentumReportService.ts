import path from 'path';
import { promises as fs } from 'fs';

export type AegisMomentumReportMode = 'summary' | 'detail' | 'near-miss';

export type AegisMomentumReportInput = {
    symbol?: string;
    windowMinutes: number;
    mode: AegisMomentumReportMode;
};

export type AegisMomentumSample = {
    timestamp: string;
    symbol: string;
    side: string;
    event: string;
    finalDecision: string | null;
    finalStrategy: string | null;
    momentumDecision: string;
    momentumReason: string;
    momentumReasons: string[];
    patternDetected: boolean;
    patternSide: string | null;
    candlesCount: number | null;
    volumeRatio: number | null;
    regimeLabel: string | null;
    regimeConfidence: number | null;
    turboAgreement: boolean | null;
    btcEthAgreement: boolean | null;
    btcEthContradict: boolean | null;
    tailRiskScore: number | null;
    hasRiskProfile: boolean;
    researchMode: boolean | null;
    regimeUsedAsGate: boolean | null;
    regimeIgnoredForEntry: boolean | null;
    regimeIgnoreReason: string | null;
    regimeObserved: string | null;
    regimeMomentumEnvironment: string | null;
    regimeTransitionRisk: string | null;
    eventRiskMode: string | null;
    eventRiskWouldBlock: boolean | null;
    positionFraction: number | null;
    leverage: number | null;
    riskProfileSource: string | null;
    interpretation: string;
};

export type AegisMomentumReportOutput = {
    windowStart: string;
    windowEnd: string;
    totalEvaluations: number;
    patternsDetected: number;
    shadowAllow: number;
    shadowDeny: number;
    enforceAllow: number;
    enforceDeny: number;
    finalStrategyMomentumRide: number;
    aegisFallbackAfterMomentumDeny: number;
    bySymbol: Record<string, number>;
    byReason: Record<string, number>;
    byRegime: Record<string, number>;
    topCandidates: AegisMomentumSample[];
    samples: AegisMomentumSample[];
    warnings: string[];
};

export type ParsedMomentumCommand = AegisMomentumReportInput & {
    valid: true;
};

export type InvalidMomentumCommand = {
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

const MOMENTUM_DIAGNOSTIC_REASONS = new Set([
    'momentum_regime_not_confirmed',
    'momentum_turbo_not_confirmed',
    'momentum_turbo_contradict',
    'momentum_side_contradict',
    'momentum_btc_eth_contradict',
    'momentum_btc_eth_not_confirmed',
    'momentum_tail_risk_high',
    'momentum_safety_cap_exceeded',
    'momentum_override_reserved_not_active',
    'momentum_safety_same_symbol_position',
    'momentum_safety_total_open_positions',
    'momentum_safety_daily_trades',
    'momentum_safety_consecutive_losses',
    'momentum_safety_loss_cooldown',
    'regime_observed_allow',
    'regime_observed_watch',
    'regime_observed_avoid',
    'regime_observed_unknown',
    'regime_observed_avoid_ignored_by_research_mode',
    'regime_observed_unknown_ignored_by_research_mode'
]);

export class AegisMomentumReportService {
    private readonly baseDir: string;
    private readonly now: () => Date;

    constructor(options: { baseDir?: string; now?: () => Date } = {}) {
        this.baseDir = options.baseDir ?? path.join(process.cwd(), 'logs', 'aegis');
        this.now = options.now ?? (() => new Date());
    }

    parseCommand(args: string[]): ParsedMomentumCommand | InvalidMomentumCommand {
        return parseMomentumCommand(args);
    }

    async buildTelegramMessages(args: string[]): Promise<string[]> {
        const parsed = this.parseCommand(args);
        if (!parsed.valid) return [parsed.help];

        const report = await this.buildReport(parsed);
        return formatMomentumReportMessages(report, parsed);
    }

    async buildReport(input: AegisMomentumReportInput): Promise<AegisMomentumReportOutput> {
        const windowMinutes = Math.min(input.windowMinutes, MAX_WINDOW_MINUTES);
        const windowEndDate = this.now();
        const windowStartDate = new Date(windowEndDate.getTime() - windowMinutes * 60 * 1000);
        const warnings: string[] = [];
        const rows = await this.readRows(windowStartDate, windowEndDate, warnings);
        const symbolFilter = input.symbol?.toUpperCase();
        const samples: AegisMomentumSample[] = [];

        for (const row of rows) {
            const timestampMs = timestampMsFromRow(row);
            if (timestampMs === undefined || timestampMs < windowStartDate.getTime() || timestampMs > windowEndDate.getTime()) {
                continue;
            }

            const sample = extractMomentumSample(row);
            if (!sample) continue;
            if (symbolFilter && sample.symbol !== symbolFilter) continue;
            samples.push(sample);
        }

        const bySymbol: Record<string, number> = {};
        const byReason: Record<string, number> = {};
        const byRegime: Record<string, number> = {};

        for (const sample of samples) {
            increment(bySymbol, sample.symbol);
            increment(byRegime, sample.regimeLabel ?? 'UNKNOWN');
            const reasons = sample.momentumReasons.filter((reason) => MOMENTUM_DIAGNOSTIC_REASONS.has(reason));
            if (reasons.length === 0 && MOMENTUM_DIAGNOSTIC_REASONS.has(sample.momentumReason)) {
                reasons.push(sample.momentumReason);
            }
            for (const reason of reasons) increment(byReason, reason);
        }

        const sortedSamples = [...samples].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
        const topCandidates = [...samples]
            .filter((sample) => sample.patternDetected || sample.momentumDecision === 'SHADOW_ALLOW' || sample.momentumDecision === 'ALLOW')
            .sort(compareMomentumCandidate)
            .slice(0, 5);

        return {
            windowStart: windowStartDate.toISOString(),
            windowEnd: windowEndDate.toISOString(),
            totalEvaluations: samples.length,
            patternsDetected: samples.filter((sample) => sample.patternDetected).length,
            shadowAllow: samples.filter((sample) => sample.momentumDecision === 'SHADOW_ALLOW').length,
            shadowDeny: samples.filter((sample) => sample.momentumDecision === 'SHADOW_DENY').length,
            enforceAllow: samples.filter((sample) => sample.momentumDecision === 'ALLOW').length,
            enforceDeny: samples.filter((sample) => sample.momentumDecision === 'DENY').length,
            finalStrategyMomentumRide: samples.filter((sample) => sample.finalStrategy === 'momentum_ride').length,
            aegisFallbackAfterMomentumDeny: samples.filter(isAegisFallbackAfterMomentumDeny).length,
            bySymbol,
            byReason,
            byRegime,
            topCandidates,
            samples: sortedSamples.slice(0, 10),
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

export function parseMomentumCommand(args: string[]): ParsedMomentumCommand | InvalidMomentumCommand {
    const tokens = args.map((arg) => arg.trim()).filter(Boolean);
    if (tokens.length === 0) return parsed('summary', undefined, DEFAULT_WINDOW_MINUTES);

    const first = tokens[0]?.toLowerCase();
    if (first === 'near-miss') {
        const windowMinutes = tokens[1] ? parseWindowMinutes(tokens[1]) : DEFAULT_WINDOW_MINUTES;
        if (!windowMinutes || tokens.length > 2) return invalidMomentumCommand();
        return parsed('near-miss', undefined, windowMinutes);
    }

    if (first === 'detail') {
        const symbol = normalizeSymbol(tokens[1]);
        const windowMinutes = tokens[2] ? parseWindowMinutes(tokens[2]) : DEFAULT_WINDOW_MINUTES;
        if (!symbol || !windowMinutes || tokens.length > 3) return invalidMomentumCommand();
        return parsed('detail', symbol, windowMinutes);
    }

    const onlyWindow = parseWindowMinutes(tokens[0]);
    if (onlyWindow && tokens.length === 1) return parsed('summary', undefined, onlyWindow);

    const symbol = normalizeSymbol(tokens[0]);
    if (symbol) {
        const windowMinutes = tokens[1] ? parseWindowMinutes(tokens[1]) : DEFAULT_WINDOW_MINUTES;
        if (!windowMinutes || tokens.length > 2) return invalidMomentumCommand();
        return parsed('summary', symbol, windowMinutes);
    }

    return invalidMomentumCommand();
}

function extractMomentumSample(row: JsonRecord): AegisMomentumSample | undefined {
    const metadata = row.metadata ?? {};
    const trace = metadata.trace ?? {};
    const traceMomentumGuard = trace.guards?.momentum_ride ?? {};
    const traceMomentumMetadata = traceMomentumGuard.metadata ?? {};
    const strategyCandidates = metadata.strategyCandidates ?? trace.strategyCandidates ?? {};
    const momentumCandidate = strategyCandidates.momentum_ride ?? {};
    const momentumRide = metadata.momentumRide
        ?? traceMomentumMetadata.momentumRide
        ?? metadata.momentum_ride
        ?? {};
    const finalStrategy = nullableText(metadata.finalStrategy ?? trace.finalStrategy ?? row.finalStrategy);
    const finalDecision = nullableText(metadata.finalDecision ?? trace.finalDecision ?? row.finalDecision);
    const momentumDecision = stableText(
        metadata.momentumDecision
            ?? momentumCandidate.decision
            ?? traceMomentumGuard.decision
            ?? row.momentumDecision
    );
    const rawReason = stableText(
        metadata.momentumReason
            ?? momentumCandidate.reason
            ?? traceMomentumGuard.reason
            ?? (stableText(row.event) === 'MOMENTUM_RIDE_DIAGNOSTIC' ? row.reason : undefined)
            ?? firstReason(momentumRide.reasons)
    );
    const event = stableText(row.event);
    const hasMomentum = event === 'MOMENTUM_RIDE_DIAGNOSTIC'
        || Object.keys(momentumCandidate).length > 0
        || Object.keys(traceMomentumGuard).length > 0
        || Object.keys(momentumRide).length > 0;
    if (!hasMomentum) return undefined;

    const regimeContext = metadata.regimeContext
        ?? traceMomentumMetadata.regimeContext
        ?? metadata.regime
        ?? {};
    const regimeEngineV2 = momentumRide.regimeEngineV2
        ?? traceMomentumMetadata.regimeObserved
        ?? traceMomentumMetadata.regimeEngineV2
        ?? metadata.regimeEngineV2
        ?? {};
    const riskProfile = metadata.riskProfile
        ?? trace.riskProfile
        ?? momentumCandidate.riskProfile
        ?? traceMomentumMetadata.riskProfile
        ?? {};
    const reasons = Array.isArray(momentumRide.reasons)
        ? momentumRide.reasons.map((reason: unknown) => stableText(reason)).filter((reason: string) => reason !== 'N/D')
        : rawReason !== 'N/D' ? [rawReason] : [];
    const symbol = stableText(row.symbol ?? metadata.symbol ?? trace.symbol).toUpperCase();
    const side = normalizeSide(metadata.side ?? trace.side ?? row.side ?? momentumRide.patternSide);
    const sample: AegisMomentumSample = {
        timestamp: timestampText(row),
        symbol,
        side,
        event,
        finalDecision,
        finalStrategy,
        momentumDecision,
        momentumReason: rawReason,
        momentumReasons: reasons,
        patternDetected: nullableBoolean(momentumRide.patternDetected) === true,
        patternSide: nullableText(momentumRide.patternSide),
        candlesCount: finiteNumber(momentumRide.candlesCount),
        volumeRatio: finiteNumber(momentumRide.volumeRatio),
        regimeLabel: nullableText(regimeContext.label ?? regimeContext.regime),
        regimeConfidence: finiteNumber(regimeContext.confidence),
        turboAgreement: nullableBoolean(momentumRide.turboAgreement),
        btcEthAgreement: nullableBoolean(momentumRide.btcEthAgreement),
        btcEthContradict: nullableBoolean(momentumRide.btcEthContradict),
        tailRiskScore: finiteNumber(metadata.tailRiskScore ?? metadata.tail_risk_score ?? metadata.entryPolicy?.tailRiskScore),
        hasRiskProfile: Object.keys(riskProfile).length > 0,
        researchMode: nullableBoolean(momentumRide.researchMode),
        regimeUsedAsGate: nullableBoolean(momentumRide.regimeUsedAsGate ?? traceMomentumMetadata.regimeUsedAsGate),
        regimeIgnoredForEntry: nullableBoolean(momentumRide.regimeIgnoredForEntry ?? traceMomentumMetadata.regimeIgnoredForEntry),
        regimeIgnoreReason: nullableText(momentumRide.regimeIgnoreReason ?? traceMomentumMetadata.regimeIgnoreReason),
        regimeObserved: nullableText(regimeEngineV2.technicalRegime),
        regimeMomentumEnvironment: nullableText(regimeEngineV2.momentumEnvironment),
        regimeTransitionRisk: nullableText(regimeEngineV2.transitionRisk),
        eventRiskMode: nullableText(traceMomentumMetadata.eventRiskMode ?? metadata.eventRiskMode ?? metadata.entryPolicy?.eventRiskMode),
        eventRiskWouldBlock: nullableBoolean(traceMomentumMetadata.eventRiskWouldBlock ?? metadata.eventRiskWouldBlock ?? metadata.entryPolicy?.eventRiskWouldBlock),
        positionFraction: finiteNumber(riskProfile.positionFraction),
        leverage: finiteNumber(riskProfile.leverage),
        riskProfileSource: nullableText(riskProfile.source ?? riskProfile.positionFractionSource),
        interpretation: 'Diagnóstico Momentum'
    };
    return {
        ...sample,
        interpretation: interpretationFor(sample)
    };
}

function formatMomentumReportMessages(report: AegisMomentumReportOutput, input: AegisMomentumReportInput): string[] {
    const lines: string[] = [`${titleFor(input)}\n`];

    if (input.mode === 'detail') {
        lines.push(`Total evaluaciones Momentum: ${report.totalEvaluations}`);
        appendSection(lines, 'Por razón Momentum:', report.byReason, 8);
        appendSection(lines, 'Por régimen:', report.byRegime, 8);
        lines.push('', 'Últimas evaluaciones:');
        appendMomentumSamples(lines, report.samples);
        appendWarnings(lines, report.warnings);
        return splitTelegramMessage(lines);
    }

    if (input.mode === 'near-miss') {
        lines.push(`Total evaluaciones Momentum: ${report.totalEvaluations}`, '', 'Top candidatos:');
        appendMomentumSamples(lines, report.topCandidates);
        appendWarnings(lines, report.warnings);
        return splitTelegramMessage(lines);
    }

    lines.push(
        `Total evaluaciones Momentum: ${report.totalEvaluations}`,
        `Patrones detectados: ${report.patternsDetected}`,
        `Shadow allow: ${report.shadowAllow}`,
        `Shadow deny: ${report.shadowDeny}`,
        `Enforce allow: ${report.enforceAllow}`,
        `Enforce deny: ${report.enforceDeny}`,
        `Final strategy momentum_ride: ${report.finalStrategyMomentumRide}`,
        `Final strategy aegis_turbo después de momentum deny: ${report.aegisFallbackAfterMomentumDeny}`
    );
    appendSection(lines, 'Por símbolo:', report.bySymbol, 6);
    appendSection(lines, 'Por razón Momentum:', report.byReason, 8);
    appendSection(lines, 'Por régimen:', report.byRegime, 6);
    lines.push('', 'Top candidatos:');
    appendMomentumSamples(lines, report.topCandidates);
    appendWarnings(lines, report.warnings);
    return splitTelegramMessage(lines);
}

function appendMomentumSamples(lines: string[], samples: AegisMomentumSample[]): void {
    if (samples.length === 0) {
        lines.push('N/D');
        return;
    }
    samples.slice(0, 5).forEach((sample, index) => {
        lines.push(`${index + 1}) ${sample.symbol} ${sample.side}`);
        lines.push(`Pattern: ${sample.candlesCount ?? 'N/D'} candles | Vol: ${formatRatio(sample.volumeRatio)} | Regime: ${sample.regimeLabel ?? 'UNKNOWN'} | Turbo: ${sample.turboAgreement === true ? 'confirmed' : 'not_confirmed'} | Tail: ${formatNumber(sample.tailRiskScore)} | Decision: ${sample.momentumDecision}`);
        lines.push(`   Research: ${sample.researchMode === true ? 'ON' : sample.researchMode === false ? 'OFF' : 'N/D'} | Regime gate: ${sample.regimeIgnoredForEntry === true ? 'ignored' : sample.regimeUsedAsGate === true ? 'active' : 'N/D'} | Regime observed: ${sample.regimeMomentumEnvironment ?? sample.regimeObserved ?? 'UNKNOWN'} | EventRisk: ${sample.eventRiskMode ?? 'N/D'}${sample.eventRiskWouldBlock === true ? ' would_block' : ''}`);
        lines.push(`   Risk: position_fraction ${formatPercent(sample.positionFraction)} | leverage ${formatNumber(sample.leverage)} | source ${sample.riskProfileSource ?? 'N/D'}`);
        lines.push(`   ${sample.interpretation}`);
        if (sample.momentumReason !== 'N/D') lines.push(`   Reason: ${sample.momentumReason}`);
        if (index < Math.min(samples.length, 5) - 1) lines.push('');
    });
}

function parsed(mode: AegisMomentumReportMode, symbol: string | undefined, windowMinutes: number): ParsedMomentumCommand {
    return {
        valid: true,
        mode,
        symbol,
        windowMinutes: Math.min(windowMinutes, MAX_WINDOW_MINUTES)
    };
}

function invalidMomentumCommand(): InvalidMomentumCommand {
    return { valid: false, help: momentumHelpMessage() };
}

function momentumHelpMessage(): string {
    return [
        'Uso: /momentum [15m|30m|1h|2h|4h|6h|12h|24h]',
        '/momentum SYMBOL [ventana]',
        '/momentum detail SYMBOL [ventana]',
        '/momentum near-miss [ventana]'
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

function titleFor(input: AegisMomentumReportInput): string {
    const window = formatWindow(input.windowMinutes);
    if (input.mode === 'detail') return `🎢 Momentum Ride ${input.symbol ?? 'Aegis'} — última ${window}`;
    if (input.mode === 'near-miss') return `🎢 Momentum Ride near-miss — última ${window}`;
    return input.symbol
        ? `🎢 Momentum Ride ${input.symbol} — última ${window}`
        : `🎢 Momentum Ride — última ${window}`;
}

function isAegisFallbackAfterMomentumDeny(sample: AegisMomentumSample): boolean {
    return sample.finalStrategy === 'aegis_turbo'
        && (sample.momentumDecision === 'DENY' || sample.momentumDecision === 'SHADOW_DENY');
}

function interpretationFor(sample: AegisMomentumSample): string {
    if (sample.finalStrategy === 'momentum_ride') return 'Entrada Momentum real';
    if (isAegisFallbackAfterMomentumDeny(sample)) return 'Momentum no aplicó, Aegis siguió';
    if (sample.momentumDecision === 'SHADOW_ALLOW') return 'Oportunidad hipotética en shadow';
    if (sample.momentumDecision === 'ALLOW' && sample.finalDecision !== 'ALLOW') return 'Momentum permitió, pero EntryPolicy final no abrió';
    if (sample.momentumDecision === 'DENY' || sample.momentumDecision === 'SHADOW_DENY') return 'Momentum no aplicó';
    return 'Diagnóstico Momentum';
}

function compareMomentumCandidate(a: AegisMomentumSample, b: AegisMomentumSample): number {
    const decisionDiff = momentumDecisionRank(b.momentumDecision) - momentumDecisionRank(a.momentumDecision);
    if (decisionDiff !== 0) return decisionDiff;
    const patternDiff = Number(b.patternDetected) - Number(a.patternDetected);
    if (patternDiff !== 0) return patternDiff;
    const volumeDiff = (b.volumeRatio ?? -1) - (a.volumeRatio ?? -1);
    if (volumeDiff !== 0) return volumeDiff;
    return (a.tailRiskScore ?? Number.POSITIVE_INFINITY) - (b.tailRiskScore ?? Number.POSITIVE_INFINITY);
}

function momentumDecisionRank(decision: string): number {
    if (decision === 'ALLOW') return 4;
    if (decision === 'SHADOW_ALLOW') return 3;
    if (decision === 'DENY') return 2;
    if (decision === 'SHADOW_DENY') return 1;
    return 0;
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

function firstReason(value: unknown): string | undefined {
    return Array.isArray(value) ? value.map(stableText).find((reason) => reason !== 'N/D') : undefined;
}

function formatRatio(value: number | null): string {
    return value === null ? 'N/D' : `${value.toFixed(2)}x`;
}

function formatNumber(value: number | null): string {
    return value === null ? 'N/D' : value.toFixed(2);
}

function formatPercent(value: number | null): string {
    return value === null ? 'N/D' : `${(value * 100).toFixed(2)}%`;
}

function formatWindow(windowMinutes: number): string {
    if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
    return `${windowMinutes}m`;
}
