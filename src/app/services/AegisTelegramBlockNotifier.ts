export type AegisBlockNotificationSide = 'LONG' | 'SHORT';

export type AegisBlockNotificationType =
    | 'FIRST'
    | 'CHANGED'
    | 'REPEATED_AFTER_COOLDOWN'
    | 'SUMMARY'
    | 'SUPPRESSED';

export type AegisBlockNotificationInput = {
    timestamp: number;
    symbol: string;
    side: AegisBlockNotificationSide;
    reason: string;
    eventRiskMode?: string;
    setupGrade?: string;
    decisionBrain?: string;
    entryQuality?: string;
    tailRiskScore?: number;
    turboScore?: number;
    votes?: {
        long?: number;
        short?: number;
        neutral?: number;
    };
    source?: string;
};

export type AegisBlockNotificationConfig = {
    enabled: boolean;
    cooldown_minutes: number;
    summary_threshold: number;
    max_cache_entries: number;
    include_suppressed_count: boolean;
};

export type AegisBlockNotificationDecision = {
    shouldNotify: boolean;
    notificationType: AegisBlockNotificationType;
    dedupeKey: string;
    suppressedCount: number;
    lastNotifiedAt?: number;
    reasonChanged?: boolean;
    importantChange?: boolean;
    message?: string;
};

type CacheEntry = {
    dedupeKey: string;
    subjectKey: string;
    firstSeenAt: number;
    lastSeenAt: number;
    lastNotifiedAt: number;
    suppressedCount: number;
    lastInput: NormalizedBlockNotificationInput;
};

type SubjectEntry = {
    dedupeKey: string;
    lastInput: NormalizedBlockNotificationInput;
};

type NormalizedBlockNotificationInput = Required<Pick<
    AegisBlockNotificationInput,
    'timestamp' | 'symbol' | 'side' | 'reason'
>> & Omit<AegisBlockNotificationInput, 'timestamp' | 'symbol' | 'side' | 'reason'>;

export const DEFAULT_AEGIS_BLOCK_NOTIFICATION_CONFIG: AegisBlockNotificationConfig = {
    enabled: true,
    cooldown_minutes: 15,
    summary_threshold: 25,
    max_cache_entries: 1000,
    include_suppressed_count: true
};

export class AegisTelegramBlockNotifier {
    private readonly cache = new Map<string, CacheEntry>();
    private readonly subjects = new Map<string, SubjectEntry>();

    decide(
        input: AegisBlockNotificationInput,
        partialConfig: Partial<AegisBlockNotificationConfig> = {}
    ): AegisBlockNotificationDecision {
        const config = normalizeConfig(partialConfig);
        const normalized = normalizeInput(input);
        const dedupeKey = buildAegisBlockDedupeKey(normalized);
        const subjectKey = buildSubjectKey(normalized);

        if (!config.enabled) {
            return {
                shouldNotify: true,
                notificationType: 'FIRST',
                dedupeKey,
                suppressedCount: 0,
                lastNotifiedAt: normalized.timestamp,
                message: formatBlockMessage(normalized, 'FIRST', 0, config)
            };
        }

        const existing = this.cache.get(dedupeKey);
        const subject = this.subjects.get(subjectKey);

        if (!existing) {
            const changed = subject !== undefined && subject.dedupeKey !== dedupeKey;
            const decisionType: AegisBlockNotificationType = changed ? 'CHANGED' : 'FIRST';
            const entry: CacheEntry = {
                dedupeKey,
                subjectKey,
                firstSeenAt: normalized.timestamp,
                lastSeenAt: normalized.timestamp,
                lastNotifiedAt: normalized.timestamp,
                suppressedCount: 0,
                lastInput: normalized
            };
            this.cache.set(dedupeKey, entry);
            this.subjects.set(subjectKey, { dedupeKey, lastInput: normalized });
            this.evictOldest(config.max_cache_entries);

            return {
                shouldNotify: true,
                notificationType: decisionType,
                dedupeKey,
                suppressedCount: 0,
                lastNotifiedAt: normalized.timestamp,
                reasonChanged: changed ? subject?.lastInput.reason !== normalized.reason : false,
                importantChange: changed,
                message: formatBlockMessage(normalized, decisionType, 0, config, subject?.lastInput)
            };
        }

        existing.lastSeenAt = normalized.timestamp;
        existing.suppressedCount += 1;
        existing.lastInput = normalized;
        this.subjects.set(subjectKey, { dedupeKey, lastInput: normalized });

        if (existing.suppressedCount >= config.summary_threshold) {
            const count = existing.suppressedCount;
            existing.suppressedCount = 0;
            existing.lastNotifiedAt = normalized.timestamp;
            return {
                shouldNotify: true,
                notificationType: 'SUMMARY',
                dedupeKey,
                suppressedCount: count,
                lastNotifiedAt: normalized.timestamp,
                message: formatBlockMessage(normalized, 'SUMMARY', count, config)
            };
        }

        const cooldownMs = config.cooldown_minutes * 60 * 1000;
        if (normalized.timestamp - existing.lastNotifiedAt >= cooldownMs) {
            const count = existing.suppressedCount;
            existing.suppressedCount = 0;
            existing.lastNotifiedAt = normalized.timestamp;
            return {
                shouldNotify: true,
                notificationType: 'REPEATED_AFTER_COOLDOWN',
                dedupeKey,
                suppressedCount: count,
                lastNotifiedAt: normalized.timestamp,
                message: formatBlockMessage(normalized, 'REPEATED_AFTER_COOLDOWN', count, config)
            };
        }

        return {
            shouldNotify: false,
            notificationType: 'SUPPRESSED',
            dedupeKey,
            suppressedCount: existing.suppressedCount,
            lastNotifiedAt: existing.lastNotifiedAt
        };
    }

    size(): number {
        return this.cache.size;
    }

    hasKey(dedupeKey: string): boolean {
        return this.cache.has(dedupeKey);
    }

    private evictOldest(maxCacheEntries: number): void {
        if (this.cache.size <= maxCacheEntries) return;

        const entries = [...this.cache.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt);
        const removeCount = this.cache.size - maxCacheEntries;
        for (const entry of entries.slice(0, removeCount)) {
            this.cache.delete(entry.dedupeKey);
            const subject = this.subjects.get(entry.subjectKey);
            if (subject?.dedupeKey === entry.dedupeKey) {
                this.subjects.delete(entry.subjectKey);
            }
        }
    }
}

export function buildAegisBlockDedupeKey(input: AegisBlockNotificationInput): string {
    const normalized = normalizeInput(input);
    return [
        normalized.symbol,
        normalized.side,
        stableToken(normalized.reason),
        stableToken(normalized.eventRiskMode),
        stableToken(normalized.decisionBrain),
        stableToken(normalized.entryQuality),
        stableToken(normalized.setupGrade)
    ].join('|');
}

function normalizeConfig(config: Partial<AegisBlockNotificationConfig>): AegisBlockNotificationConfig {
    return {
        enabled: config.enabled ?? DEFAULT_AEGIS_BLOCK_NOTIFICATION_CONFIG.enabled,
        cooldown_minutes: positiveNumber(
            config.cooldown_minutes,
            DEFAULT_AEGIS_BLOCK_NOTIFICATION_CONFIG.cooldown_minutes
        ),
        summary_threshold: positiveInteger(
            config.summary_threshold,
            DEFAULT_AEGIS_BLOCK_NOTIFICATION_CONFIG.summary_threshold
        ),
        max_cache_entries: positiveInteger(
            config.max_cache_entries,
            DEFAULT_AEGIS_BLOCK_NOTIFICATION_CONFIG.max_cache_entries
        ),
        include_suppressed_count: config.include_suppressed_count
            ?? DEFAULT_AEGIS_BLOCK_NOTIFICATION_CONFIG.include_suppressed_count
    };
}

function normalizeInput(input: AegisBlockNotificationInput): NormalizedBlockNotificationInput {
    return {
        ...input,
        timestamp: Number.isFinite(input.timestamp) ? input.timestamp : Date.now(),
        symbol: stableToken(input.symbol).toUpperCase(),
        side: input.side,
        reason: stableToken(input.reason)
    };
}

function buildSubjectKey(input: NormalizedBlockNotificationInput): string {
    return `${input.symbol}|${input.side}`;
}

function stableToken(value: unknown): string {
    const token = String(value ?? 'N/D').trim();
    return token.length > 0 ? token : 'N/D';
}

function positiveNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function formatBlockMessage(
    input: NormalizedBlockNotificationInput,
    type: AegisBlockNotificationType,
    suppressedCount: number,
    config: AegisBlockNotificationConfig,
    previous?: NormalizedBlockNotificationInput
): string {
    if (type === 'SUMMARY') {
        return [
            '🛡️ Bloqueos repetidos',
            `${input.symbol} ${input.side}`,
            `Mismo motivo: ${input.reason}`,
            `Repetido ${suppressedCount} veces en ${config.cooldown_minutes}m`,
            `Último estado: ${stableToken(input.setupGrade)} / ${stableToken(input.decisionBrain)} / ${stableToken(input.entryQuality)}`
        ].join('\n');
    }

    const lines = [
        '🛡️ Entrada bloqueada por protección Aegis',
        `${input.symbol} ${input.side}`,
        '',
        `Motivo: ${formatReason(input)}`,
        `Grade: ${stableToken(input.setupGrade)}`,
        `Decision: ${stableToken(input.decisionBrain)}`,
        `EQ: ${stableToken(input.entryQuality)}`,
        `Tail: ${formatPct(input.tailRiskScore)}`,
        `Turbo: ${formatPct(input.turboScore)}`
    ];

    if (type === 'CHANGED' && previous) {
        lines.push(`Cambio: ${formatChange(previous, input)}`);
    }

    if (
        config.include_suppressed_count
        && type === 'REPEATED_AFTER_COOLDOWN'
        && suppressedCount > 0
    ) {
        lines.push('');
        lines.push(`Repeticiones silenciadas: ${suppressedCount} en ${config.cooldown_minutes}m`);
    }

    return lines.join('\n');
}

function formatReason(input: NormalizedBlockNotificationInput): string {
    const eventRiskMode = stableToken(input.eventRiskMode);
    return eventRiskMode !== 'N/D' ? `${eventRiskMode} / ${input.reason}` : input.reason;
}

function formatChange(previous: NormalizedBlockNotificationInput, current: NormalizedBlockNotificationInput): string {
    const fields: Array<[string, string | undefined, string | undefined]> = [
        ['reason', previous.reason, current.reason],
        ['EventRisk', previous.eventRiskMode, current.eventRiskMode],
        ['Decision', previous.decisionBrain, current.decisionBrain],
        ['EQ', previous.entryQuality, current.entryQuality],
        ['Grade', previous.setupGrade, current.setupGrade]
    ];
    const changed = fields
        .filter(([, before, after]) => stableToken(before) !== stableToken(after))
        .map(([name, before, after]) => `${name} ${stableToken(before)} -> ${stableToken(after)}`);
    return changed.length > 0 ? changed.join(' | ') : 'N/D';
}

function formatPct(value: unknown): string {
    return typeof value === 'number' && Number.isFinite(value)
        ? `${(value * 100).toFixed(1)}%`
        : 'N/D';
}
