import { Side } from '../../domain/types';
import { formatAegisReason } from './AegisReasonFormatter';

type Votes = {
    long?: number;
    short?: number;
    neutral?: number;
};

export interface AegisAccountMessageInput {
    walletBalance?: number;
    equityTotal?: number;
    availableBalance?: number;
}

export interface AegisPositionMessageInput {
    symbol: string;
    side: Side;
    size?: number;
    margin?: number;
    roi?: number;
    pnl?: number;
    durationHours?: number;
    tpPrice?: number;
    slPrice?: number;
    tpRoe?: number;
    slRoe?: number;
    baseAsset?: string;
}

export interface AegisStartupMessageInput {
    mode: {
        tradingMode: string;
        liveEnabled: boolean;
        strategy: string;
        shortsEnabled: boolean;
        activeSymbols: string[];
    };
    account: AegisAccountMessageInput;
    config: {
        leverage: number;
        entryThreshold: number;
        maxHoldHours: number;
        trailingEnabled: boolean;
        trailingActivationRoe?: number;
        trailingCallbackRoe?: number;
        stopRoe?: number;
        takeProfitRoe?: number;
        maxTradesPerDay?: number;
        dailyLossStopPct?: number;
        maxConsecutiveLosses?: number;
        requireBrackets?: boolean;
    };
    initialRadar?: {
        symbol: string;
        rawAction?: string;
        rawScore?: number;
        gatedAction?: string;
        votes?: Votes;
        reason?: string;
        freshnessIsFresh?: boolean;
        featureTimestamp?: string | number;
    };
    activePositions: AegisPositionMessageInput[];
}

export interface AegisSymbolSignalMessageInput {
    symbol: string;
    rawAction?: string;
    rawScore?: number;
    gatedAction?: string;
    votes?: Votes;
    reason?: string;
    freshnessIsFresh?: boolean;
}

function finiteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function formatUsd(value?: number, suffix = true): string {
    return finiteNumber(value) ? `$${value.toFixed(2)}${suffix ? ' USDT' : ''}` : 'N/D';
}

function formatPrice(value?: number): string {
    return finiteNumber(value) ? `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'N/D';
}

function formatNumber(value?: number, digits = 3): string {
    return finiteNumber(value) ? value.toFixed(digits) : 'N/D';
}

function formatPct(value?: number, signed = false): string {
    if (!finiteNumber(value)) return 'N/D';
    const pct = value * 100;
    return `${signed && pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function formatBool(value?: boolean): string {
    return value ? 'Sí' : 'No';
}

function formatOnOff(value?: boolean): string {
    return value ? 'ON' : 'OFF';
}

function formatStartupMode(value: string): string {
    if (value === 'AEGIS_TURBO_MICRO_LIVE') return 'MICRO-LIVE';
    if (value === 'AEGIS_SHADOW') return 'SHADOW';
    return value.replace(/^AEGIS_TURBO_/, '').replace(/^AEGIS_/, '').replace(/_/g, '-');
}

function baseAssetFromSymbol(symbol: string): string {
    const upper = symbol.toUpperCase();
    const quote = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'USD'].find((asset) => upper.endsWith(asset));
    return quote ? upper.slice(0, -quote.length) : upper;
}

function formatPnl(value?: number): string {
    if (!finiteNumber(value)) return 'N/D';
    return value >= 0 ? `+$${value.toFixed(2)}` : `-$${Math.abs(value).toFixed(2)}`;
}

function formatVotes(votes?: Votes): string {
    return `L=${votes?.long ?? 0} | S=${votes?.short ?? 0} | N=${votes?.neutral ?? 0}`;
}

function snapshotLabel(isFresh?: boolean): string {
    if (isFresh === true) return 'fresco ✅';
    if (isFresh === false) return 'desactualizado ⚠️';
    return 'N/D';
}

function formatFeatureTimestamp(value?: string | number): string | undefined {
    if (typeof value === 'string' && value.length > 0) {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) {
            return formatUtcTime(date);
        }
        return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return formatUtcTime(new Date(value));
    return undefined;
}

function formatUtcTime(date: Date): string {
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const min = String(date.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${min} UTC`;
}

function formatStartupAccount(input: AegisAccountMessageInput): string {
    return `💰 Wallet ${formatUsd(input.walletBalance, false)} | Equity ${formatUsd(input.equityTotal, false)} | Disp. ${formatUsd(input.availableBalance, false)}`;
}

function formatStartupConfig(input: AegisStartupMessageInput['config']): string {
    const trailing = input.trailingEnabled
        ? formatPct(input.trailingActivationRoe, true)
        : 'OFF';
    const brackets = input.requireBrackets ? '✅' : 'No';

    return `⚙️ Lev ${finiteNumber(input.leverage) ? input.leverage : 'N/D'}x | Th ${formatPct(input.entryThreshold)} | Max ${finiteNumber(input.maxHoldHours) ? input.maxHoldHours.toFixed(1) : 'N/D'}h\n` +
        `🛡️ SL ${formatPct(input.stopRoe, true)} | TP ${formatPct(input.takeProfitRoe, true)} ROE\n` +
        `🔁 Trail ${trailing} | Callback ${formatPct(input.trailingCallbackRoe)}\n` +
        `🚨 Daily stop ${formatPct(input.dailyLossStopPct)} | Max losses ${finiteNumber(input.maxConsecutiveLosses) ? input.maxConsecutiveLosses : 'N/D'}\n` +
        `🧷 Brackets obligatorios ${brackets}`;
}

function formatStartupRadar(input?: AegisStartupMessageInput['initialRadar']): string {
    if (!input) return `🛰️ Radar\nN/D`;

    const rawAction = input.rawAction ?? 'HOLD';
    const gatedAction = input.gatedAction ?? rawAction;
    const actionLabel = rawAction !== gatedAction ? `${gatedAction} (raw ${rawAction})` : gatedAction;
    const feature = formatFeatureTimestamp(input.featureTimestamp);
    const votes = input.votes ?? {};
    const snapshot = `Snapshot ${snapshotLabel(input.freshnessIsFresh)}`;
    return [
        `🛰️ Radar ${input.symbol}`,
        `${actionLabel} | Score ${formatPct(input.rawScore)} | L=${votes.long ?? 0} S=${votes.short ?? 0} N=${votes.neutral ?? 0}`,
        formatAegisReason(input.reason),
        feature ? `${snapshot} | Feature ${feature}` : snapshot
    ].filter((line): line is string => Boolean(line)).join('\n');
}

function formatStartupPositions(input: { activePositions: AegisPositionMessageInput[] }): string {
    if (input.activePositions.length === 0) {
        return `💼 Posiciones\nNinguna`;
    }

    return input.activePositions.map((position) => {
        const baseAsset = position.baseAsset ?? baseAssetFromSymbol(position.symbol);
        const sideIcon = position.side === 'LONG' ? '📈' : '📉';
        return [
            `💼 ${position.symbol} ${position.side} ${sideIcon}`,
            `ROI ${formatPct(position.roi, true)} | PnL ${formatPnl(position.pnl)} | ${finiteNumber(position.durationHours) ? `${position.durationHours.toFixed(1)}h` : 'N/D'}`,
            `Size ${formatNumber(position.size)} ${baseAsset} | Margin ${formatUsd(position.margin, false)}`,
            `TP ${formatPrice(position.tpPrice)} | SL ${formatPrice(position.slPrice)}`
        ].join('\n');
    }).join('\n\n');
}

export function formatAccountMessage(input: AegisAccountMessageInput): string {
    return `💰 **Cuenta**\n` +
        `👛 Wallet: **${formatUsd(input.walletBalance)}**\n` +
        `🏦 Equity total: **${formatUsd(input.equityTotal)}**\n` +
        `💵 Disponible: **${formatUsd(input.availableBalance)}**`;
}

export function formatPositionsMessage(input: { activePositions: AegisPositionMessageInput[] }): string {
    if (input.activePositions.length === 0) {
        return `💼 **Posiciones activas**\n🟢 **Ninguna**`;
    }

    const title = input.activePositions.length === 1 ? '💼 **Posición activa**' : '💼 **Posiciones activas**';
    const positions = input.activePositions.map((position) => {
        const baseAsset = position.baseAsset ?? baseAssetFromSymbol(position.symbol);
        const header = `**${position.symbol}** | ${position.side === 'LONG' ? '📈 **LONG**' : '📉 **SHORT**'}`;
        const body = [
            `📦 Tamaño: **${formatNumber(position.size)} ${baseAsset}**`,
            `💳 Margen: **${formatUsd(position.margin)}**`,
            `📊 ROI: **${formatPct(position.roi)}**`,
            `💸 PnL: **${formatPnl(position.pnl)}**`,
            `⏱️ Duración: **${finiteNumber(position.durationHours) ? `${position.durationHours.toFixed(1)} horas` : 'N/D'}**`,
            '',
            `🛡️ **Brackets**`,
            `🎯 TP: **${formatPrice(position.tpPrice)}** (${formatPct(position.tpRoe, true)} ROE)`,
            `🛑 SL: **${formatPrice(position.slPrice)}** (${formatPct(position.slRoe, true)} ROE)`
        ].join('\n');
        return `${header}\n${body}`;
    }).join('\n\n');
    return `${title}\n${positions}`;
}

export function formatConfigMessage(input: AegisStartupMessageInput['config']): string {
    const trailing = input.trailingEnabled
        ? `ON desde ${formatPct(input.trailingActivationRoe, true)} ROE`
        : 'OFF';

    return `⚙️ **Configuración**\n` +
        `⚖️ Leverage: **${finiteNumber(input.leverage) ? input.leverage : 'N/D'}x**\n` +
        `🎚️ Entry threshold: **${formatPct(input.entryThreshold)}**\n` +
        `⏳ Max hold: **${finiteNumber(input.maxHoldHours) ? input.maxHoldHours.toFixed(1) : 'N/D'} horas**\n` +
        `🛡️ Trailing: **${trailing}**\n` +
        `↩️ Callback: **${formatPct(input.trailingCallbackRoe)} ROE**\n` +
        `🛑 SL: **${formatPct(input.stopRoe, true)} ROE**\n` +
        `🎯 TP: **${formatPct(input.takeProfitRoe, true)} ROE**\n` +
        `📆 Max trades/día: **${finiteNumber(input.maxTradesPerDay) ? input.maxTradesPerDay : 'N/D'}**\n` +
        `🚨 Daily loss stop: **${formatPct(input.dailyLossStopPct)}**\n` +
        `🔻 Max consecutive losses: **${finiteNumber(input.maxConsecutiveLosses) ? input.maxConsecutiveLosses : 'N/D'}**\n` +
        `🧷 Brackets required: **${formatBool(input.requireBrackets)}**`;
}

export function formatSymbolSignalMessage(input: AegisSymbolSignalMessageInput): string {
    const lines = [
        `🛰️ **Radar inicial**`,
        `🪙 Símbolo: **${input.symbol}**`,
        `⚙️ Turbo raw: **${input.rawAction ?? 'HOLD'}** / **${formatPct(input.rawScore)}**`,
        `🚦 Turbo gated: **${input.gatedAction ?? 'HOLD'}**`,
        `🗳️ Votes: **${formatVotes(input.votes)}**`,
        `🧠 Motivo: **${formatAegisReason(input.reason)}**`,
        `📸 Snapshot: **${snapshotLabel(input.freshnessIsFresh)}**`
    ];
    return lines.join('\n');
}

export function formatAllSignalsMessage(input: { signals: AegisSymbolSignalMessageInput[] }): string {
    if (input.signals.length === 0) return `🛰️ **Señales**\n⚪ **N/D**`;
    return input.signals.map(formatSymbolSignalMessage).join('\n\n');
}

export function formatAegisStartupMessage(input: AegisStartupMessageInput): string {
    const symbols = input.mode.activeSymbols.join(', ') || 'N/D';
    const status = `🧠 ${formatStartupMode(input.mode.tradingMode)} | Live ${formatOnOff(input.mode.liveEnabled)} | Shorts ${formatOnOff(input.mode.shortsEnabled)}\n` +
        `🎯 ${input.mode.strategy} | ${symbols}`;

    return `🔥 AEGIS TURBO MICRO-LIVE ✅\n\n` +
        `${status}\n\n` +
        `${formatStartupAccount(input.account)}\n\n` +
        `${formatStartupConfig(input.config)}\n\n` +
        `${formatStartupRadar(input.initialRadar)}\n\n` +
        `${formatStartupPositions({ activePositions: input.activePositions })}`;
}
