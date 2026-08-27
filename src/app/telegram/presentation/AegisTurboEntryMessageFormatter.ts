import { Side } from '../../../domain/types';
import { formatAegisReason } from '../../messages/AegisReasonFormatter';

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

export function formatAegisTurboReason(reason?: string): string {
    return formatAegisReason(reason);
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
        `Salida direccional: L=${input.votes?.long ?? 0} | S=${input.votes?.short ?? 0} | N=${input.votes?.neutral ?? 0} (estimador único; no consenso)\n` +
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
