import { Side } from '../../domain/types';
import { formatAegisReason } from './AegisReasonFormatter';

type Votes = {
    long?: number;
    short?: number;
    neutral?: number;
};

type MomentumStartupExample = {
    symbol: string;
    side: Side;
    positionFraction?: number;
};

export interface AegisAccountMessageInput {
    walletBalance?: number;
    equityTotal?: number;
    availableBalance?: number;
}

export interface AegisPositionMessageInput {
    symbol: string;
    side: Side;
    strategy?: string;
    size?: number;
    margin?: number;
    leverage?: number;
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
    aegisTurbo?: {
        enabled?: boolean;
        mode?: string;
        fallbackEnabled?: boolean;
        leverage?: number;
        entryThreshold?: number;
        trailingActivationRoe?: number;
        trailingCallbackRoe?: number;
        stopRoe?: number;
        takeProfitRoe?: number;
        requireBrackets?: boolean;
    };
    momentumRide?: {
        enabled?: boolean;
        mode?: string;
        researchMode?: boolean;
        maxPositionFraction?: number;
        maxOpenMomentumPositions?: number;
        maxMomentumTradesPerDay?: number;
        maxConsecutiveMomentumLosses?: number;
        cooldownAfterLossMinutes?: number;
        requireAegisDirectionConfirmation?: boolean;
        requireBtcEthNotContradicting?: boolean;
        examples?: MomentumStartupExample[];
    };
    regimeEngineV2?: {
        metadataEnabled?: boolean;
        useAsGate?: boolean;
        ignoreForEntry?: boolean;
    };
    probeMode?: {
        enabled?: boolean;
        mode?: string;
        maxOpenProbePositions?: number;
        maxProbeEntriesPerHour?: number;
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

function formatStartupAccount(input: AegisAccountMessageInput): string {
    return `💰 Wallet ${formatUsd(input.walletBalance, false)} | Equity ${formatUsd(input.equityTotal, false)} | Disp. ${formatUsd(input.availableBalance, false)}`;
}

function formatCompactSymbols(symbols: string[]): string {
    const compact = symbols.map(baseAssetFromSymbol).join(' ');
    return `🎯 Símbolos activos (${symbols.length})\n${compact || 'N/D'}`;
}

function formatAegisTurboBlock(input: AegisStartupMessageInput): string {
    const config = input.config;
    const turbo = input.aegisTurbo;
    const mode = turbo?.enabled === false ? 'OFF' : turbo?.mode ?? (input.mode.liveEnabled ? 'LIVE' : 'SHADOW');
    const fallback = turbo?.fallbackEnabled === false ? 'OFF' : 'ON';
    const leverage = turbo?.leverage ?? config.leverage;
    const threshold = turbo?.entryThreshold ?? config.entryThreshold;
    const trailingActivation = turbo?.trailingActivationRoe ?? config.trailingActivationRoe;
    const trailingCallback = turbo?.trailingCallbackRoe ?? config.trailingCallbackRoe;
    const stopRoe = turbo?.stopRoe ?? config.stopRoe;
    const takeProfitRoe = turbo?.takeProfitRoe ?? config.takeProfitRoe;
    const requireBrackets = turbo?.requireBrackets ?? config.requireBrackets;
    const trailing = config.trailingEnabled
        ? formatPct(trailingActivation, true)
        : 'OFF';
    const brackets = requireBrackets ? '✅' : 'No';

    return `🛡️ Aegis Turbo\n` +
        `Mode: ${mode} | Fallback: ${fallback}\n` +
        `Lev base: ${finiteNumber(leverage) ? leverage : 'N/D'}x | Threshold: ${formatPct(threshold)}\n` +
        `SL ${formatPct(stopRoe, true)} | TP ${formatPct(takeProfitRoe, true)} ROE\n` +
        `Trail ${trailing} | Callback ${formatPct(trailingCallback)}\n` +
        `🧷 Brackets obligatorios ${brackets}`;
}

function formatMomentumExamples(examples?: MomentumStartupExample[]): string | undefined {
    if (!examples || examples.length === 0) return undefined;

    const groups = new Map<string, string[]>();
    for (const example of examples.slice(0, 6)) {
        const key = `${example.side} ${formatPct(example.positionFraction)}`;
        const symbols = groups.get(key) ?? [];
        symbols.push(baseAssetFromSymbol(example.symbol));
        groups.set(key, symbols);
    }

    const formatted = Array.from(groups.entries()).map(([key, symbols]) => `${symbols.join('/')} ${key}`);
    return formatted.length > 0 ? `Risk examples: ${formatted.join(' | ')}` : undefined;
}

function formatMomentumRideBlock(input?: AegisStartupMessageInput['momentumRide']): string {
    if (!input || input.enabled === false) {
        return `⚡ Momentum Ride\nMode: OFF`;
    }

    const examples = formatMomentumExamples(input.examples);
    return [
        `⚡ Momentum Ride`,
        `Mode: ${input.mode ?? 'N/D'} | Prioridad: alta`,
        `Max position: ${formatPct(input.maxPositionFraction)} wallet`,
        `Max open momentum: ${finiteNumber(input.maxOpenMomentumPositions) ? input.maxOpenMomentumPositions : 'N/D'} | Max trades/day: ${finiteNumber(input.maxMomentumTradesPerDay) ? input.maxMomentumTradesPerDay : 'N/D'}`,
        `Max consecutive losses: ${finiteNumber(input.maxConsecutiveMomentumLosses) ? input.maxConsecutiveMomentumLosses : 'N/D'} | Cooldown loss: ${finiteNumber(input.cooldownAfterLossMinutes) ? `${input.cooldownAfterLossMinutes}m` : 'N/D'}`,
        `Requires Aegis direction ${input.requireAegisDirectionConfirmation ? '✅' : 'OFF'} | BTC/ETH contradiction block ${input.requireBtcEthNotContradicting ? '✅' : 'OFF'}`,
        input.researchMode ? `Research/experimental mode ON` : undefined,
        examples
    ].filter((line): line is string => Boolean(line)).join('\n');
}

function formatRegimeEngineBlock(input?: AegisStartupMessageInput['regimeEngineV2']): string {
    const metadata = input?.metadataEnabled === false ? 'OFF' : 'ON';
    const gate = input?.useAsGate ? 'ON' : 'OFF';
    const useAsGate = input?.useAsGate === true;
    const ignoreForEntry = input?.ignoreForEntry !== false;

    return `🧭 RegimeEngineV2\n` +
        `Metadata ${metadata} | Gate ${gate}\n` +
        `useAsGate=${String(useAsGate)} | ignoreForEntry=${String(ignoreForEntry)}\n` +
        `Observa régimen, no decide entradas`;
}

function formatProbeModeBlock(input?: AegisStartupMessageInput['probeMode']): string | undefined {
    if (!input?.enabled) return undefined;

    return `🧪 Probe Mode\n` +
        `Mode: ${input.mode ?? 'N/D'} | Max open: ${finiteNumber(input.maxOpenProbePositions) ? input.maxOpenProbePositions : 'N/D'} | Max/hour: ${finiteNumber(input.maxProbeEntriesPerHour) ? input.maxProbeEntriesPerHour : 'N/D'}`;
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
            `Strategy ${position.strategy ?? 'N/D'} | Lev ${finiteNumber(position.leverage) ? `${position.leverage}x` : 'N/D'}`,
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
    const status = `🧠 ${formatStartupMode(input.mode.tradingMode)} | Live ${formatOnOff(input.mode.liveEnabled)} | Shorts ${formatOnOff(input.mode.shortsEnabled)}\n` +
        `Trading mode: ${input.mode.strategy}`;
    const probeMode = formatProbeModeBlock(input.probeMode);

    return [
        `🔥 AEGIS + MOMENTUM LIVE ✅`,
        status,
        formatCompactSymbols(input.mode.activeSymbols),
        formatStartupAccount(input.account),
        formatAegisTurboBlock(input),
        formatMomentumRideBlock(input.momentumRide),
        formatRegimeEngineBlock(input.regimeEngineV2),
        probeMode,
        formatStartupPositions({ activePositions: input.activePositions })
    ].filter((line): line is string => Boolean(line)).join('\n\n');
}
