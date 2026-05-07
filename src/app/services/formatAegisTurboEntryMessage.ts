import { Side } from '../../domain/types';

export interface AegisTurboEntryAccountSnapshot {
    walletBalance?: number;
    availableBalance?: number;
    equityTotal?: number;
}

export interface AegisTurboEntryMessageInput {
    symbol: string;
    side: Side;
    entryPrice: number;
    quantity: number;
    marginUsed: number;
    walletFallback: number;
    account?: AegisTurboEntryAccountSnapshot;
    leverage: number;
    stopPrice: number;
    tpPrice: number;
    turboScore?: number;
    threshold: number;
    votes?: {
        long?: number;
        short?: number;
        neutral?: number;
    };
    reason?: string;
    stopRoe: number;
    takeProfitRoe: number;
    trailingActivationRoe: number;
    trailingCallbackRoe: number;
    pricePrecision?: number;
    quantityPrecision?: number;
}

const REASON_LABELS: Record<string, string> = {
    raw_recent_long_agreement_2_of_3: 'Acuerdo LONG reciente 2/3',
    raw_recent_short_agreement_2_of_3: 'Acuerdo SHORT reciente 2/3',
    insufficient_recent_model_agreement: 'Sin acuerdo suficiente entre modelos recientes',
    short_disabled_in_turbo_v010: 'SHORT detectado, pero deshabilitado por configuración',
    stale_turbo_snapshot: 'Snapshot Turbo desactualizado',
    turbo_score_below_threshold: 'Score por debajo del threshold',
    allowed_aegis_turbo_micro_live: 'Señal aprobada por gate Aegis Turbo'
};

function compactReasonKey(reason: string): string {
    return reason.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeReasonKey(reason: string): string {
    const spaced = reason
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .replace(/([a-zA-Z])(\d)/g, '$1_$2')
        .replace(/(\d)([a-zA-Z])/g, '$1_$2')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
    return spaced.toLowerCase();
}

function humanizeUnknownReason(reason: string): string {
    const normalized = normalizeReasonKey(reason);
    if (!normalized) return 'Aegis Turbo';

    const phrase = normalized
        .replace(/\blong\b/g, 'LONG')
        .replace(/\bshort\b/g, 'SHORT')
        .replace(/\btp\b/g, 'TP')
        .replace(/\bsl\b/g, 'SL')
        .split('_')
        .join(' ');

    return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

export function formatAegisTurboReason(reason?: string): string {
    if (!reason || !reason.trim()) return 'Aegis Turbo';

    const normalized = normalizeReasonKey(reason);
    if (REASON_LABELS[normalized]) return REASON_LABELS[normalized];

    const compact = compactReasonKey(reason);
    const matched = Object.entries(REASON_LABELS).find(([key]) => compactReasonKey(key) === compact);
    if (matched) return matched[1];

    const rawAgreement = compact.match(/^rawrecent(long|short)agreement(\d+)of(\d+)$/);
    if (rawAgreement) {
        return `Acuerdo ${rawAgreement[1].toUpperCase()} reciente ${rawAgreement[2]}/${rawAgreement[3]}`;
    }

    return humanizeUnknownReason(reason);
}

function finiteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function formatUsd(value?: number): string {
    return finiteNumber(value) ? `$${value.toFixed(2)}` : 'N/D';
}

function formatPrice(value: number, precision = 2): string {
    const digits = Number.isInteger(precision) && precision >= 0 ? precision : 2;
    return `$${value.toFixed(digits)}`;
}

function formatQuantity(value: number, precision = 3): string {
    const digits = Number.isInteger(precision) && precision >= 0 ? precision : 3;
    return value.toFixed(digits);
}

function formatPct(value?: number): string {
    const safe = finiteNumber(value) ? value : 0;
    return `${(safe * 100).toFixed(1)}%`;
}

function formatRoePct(value: number): string {
    const safe = finiteNumber(value) ? value : 0;
    const pct = safe * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function baseAssetFromSymbol(symbol: string): string {
    const upper = symbol.toUpperCase();
    const quote = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'USD'].find((asset) => upper.endsWith(asset));
    return quote ? upper.slice(0, -quote.length) : upper;
}

export function formatAegisTurboEntryMessage(input: AegisTurboEntryMessageInput): string {
    const sideLabel = input.side === 'LONG' ? '📈 LONG' : '📉 SHORT';
    const baseAsset = baseAssetFromSymbol(input.symbol);
    const walletBalance = input.account?.walletBalance ?? input.walletFallback;
    const trailingOn = input.trailingActivationRoe > 0 && input.trailingCallbackRoe > 0;
    const reason = formatAegisTurboReason(input.reason);
    const pricePrecision = input.pricePrecision ?? 2;
    const quantityPrecision = input.quantityPrecision ?? 3;

    return `🔥 AEGIS TURBO ENTRY\n\n` +
        `${input.symbol} | ${sideLabel}\n` +
        `Entrada: ${formatPrice(input.entryPrice, pricePrecision)} | Lev: ${input.leverage}x\n` +
        `Tamaño: ${formatQuantity(input.quantity, quantityPrecision)} ${baseAsset} | Margen: ${formatUsd(input.marginUsed)} USDT\n\n` +
        `💰 CUENTA\n` +
        `Wallet: ${formatUsd(walletBalance)}\n` +
        `Equity total: ${formatUsd(input.account?.equityTotal)}\n` +
        `Disponible: ${formatUsd(input.account?.availableBalance)}\n\n` +
        `🧠 TURBO SIGNAL\n` +
        `Score: ${formatPct(input.turboScore)} / ${formatPct(input.threshold)}\n` +
        `Votes: L=${input.votes?.long ?? 0} | S=${input.votes?.short ?? 0} | N=${input.votes?.neutral ?? 0}\n` +
        `Motivo: ${reason}\n\n` +
        `🛡️ RIESGO / BRACKETS\n` +
        `SL: ${formatPrice(input.stopPrice, pricePrecision)} (${formatRoePct(input.stopRoe)} ROE)\n` +
        `TP: ${formatPrice(input.tpPrice, pricePrecision)} (${formatRoePct(input.takeProfitRoe)} ROE)\n` +
        (trailingOn
            ? `Trailing: ON desde ${formatRoePct(input.trailingActivationRoe)} ROE\n` +
            `Callback: ${formatRoePct(input.trailingCallbackRoe)} ROE\n\n`
            : `Trailing: OFF\n\n`) +
        `✅ Brackets confirmados`;
}
