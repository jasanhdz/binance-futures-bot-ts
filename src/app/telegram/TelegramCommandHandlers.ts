import { Side } from '../../domain/types';
import { AegisPredictionResponse, AegisTradingSignal } from '../../domain/services/AegisStrategy';
import {
    AegisAccountMessageInput,
    AegisPositionMessageInput,
    AegisSymbolSignalMessageInput,
    formatAccountMessage,
    formatAllSignalsMessage,
    formatConfigMessage,
    formatPositionsMessage,
    formatSymbolSignalMessage
} from '../messages/AegisMessageFormatter';
import { formatAegisReason } from '../messages/AegisReasonFormatter';
import { analyzeAegisTurboHistory } from '../../tools/analyzeAegisTurboHistory';
import { CONFIG } from '../../infra/config/environment';
import { TelegramCommandHandlerDeps, TelegramCommandHandlersPort } from './TelegramCommandTypes';
import { AegisBlocksReportService } from './AegisBlocksReportService';
import { AegisMomentumReportService } from './AegisMomentumReportService';
import { AegisProbeReportService } from './AegisProbeReportService';

type CloseOrder = {
    type: 'STOP_MARKET' | 'STOP' | 'TAKE_PROFIT_MARKET' | 'TAKE_PROFIT';
    stopPrice: number;
};

type TradeStatusDetails = {
    symbol: string;
    side: Side;
    entryPrice?: number;
    markPrice?: number;
    quantity?: number;
    margin?: number;
    leverage?: number;
    currentRoe?: number;
    currentPnl?: number;
    durationHours?: number;
    tradeId?: string;
    mode?: string;
    peakRoe?: number;
    lowestRoe?: number;
    breakEvenArmed: boolean;
    breakEvenExecuted: boolean;
    lastBreakEvenStop?: number;
    lastStopPrice?: number;
    lastTrailStop?: number;
    trailingActive: boolean;
    trailingActivationRoe?: number;
    protectProfitActive: boolean;
    minPeakRoeToProtect?: number;
    slPrice?: number;
    tpPrice?: number;
    hasSL: boolean;
    hasTP: boolean;
};

function finiteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function formatPct(value?: number, signed = false): string {
    if (!finiteNumber(value)) return 'N/D';
    const pct = value * 100;
    return `${signed && pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function formatUsd(value?: number): string {
    if (!finiteNumber(value)) return 'N/D';
    return value >= 0 ? `$${value.toFixed(2)} USDT` : `-$${Math.abs(value).toFixed(2)} USDT`;
}

function formatPrice(value?: number): string {
    return finiteNumber(value) ? `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'N/D';
}

function formatTradePrice(value?: number): string {
    if (!finiteNumber(value)) return 'N/D';
    const abs = Math.abs(value);
    const digits = abs < 1 ? 6 : abs < 10 ? 4 : abs < 100 ? 3 : 2;
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function formatNumber(value?: number, digits = 3): string {
    return finiteNumber(value) ? value.toFixed(digits) : 'N/D';
}

function boolText(value?: boolean): string {
    return value ? 'Sí' : 'No';
}

function normalizeEventRiskMode(mode?: string): 'NORMAL' | 'CAUTION' | 'RISK_OFF' | 'MANUAL_ONLY' | undefined {
    const normalized = String(mode || '').trim().toUpperCase();
    if (
        normalized === 'NORMAL'
        || normalized === 'CAUTION'
        || normalized === 'RISK_OFF'
        || normalized === 'MANUAL_ONLY'
    ) {
        return normalized;
    }
    return undefined;
}

function todayIsoDate(): string {
    return new Date().toISOString().slice(0, 10);
}

function baseAssetFromSymbol(symbol: string): string {
    const upper = symbol.toUpperCase();
    const quote = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'USD'].find((asset) => upper.endsWith(asset));
    return quote ? upper.slice(0, -quote.length) : upper;
}

function calculateRoe(side: Side, entryPrice: number, markPrice: number, leverage: number): number | undefined {
    if (entryPrice <= 0 || leverage <= 0 || !Number.isFinite(markPrice)) return undefined;
    return side === 'SHORT'
        ? (entryPrice - markPrice) / entryPrice * leverage
        : (markPrice - entryPrice) / entryPrice * leverage;
}

function pnlFromRoe(margin: number | undefined, roe: number | undefined): number | undefined {
    if (!finiteNumber(margin) || !finiteNumber(roe)) return undefined;
    return margin * roe;
}

function formatDurationHours(value?: number): string {
    if (!finiteNumber(value)) return 'N/D';
    if (value < 1) return `${Math.max(0, value * 60).toFixed(0)}m`;
    return `${value.toFixed(2)}h`;
}

function turboFromSignal(signal: AegisTradingSignal): any {
    return signal.metadata?.aegis?.turbo ?? signal.aegis?.turbo;
}

function entryQualityModelFromSignal(signal: AegisTradingSignal): any {
    return signal.metadata?.aegis?.entry_quality_model ?? signal.aegis?.entry_quality_model;
}

function eventRiskAutoFromSignal(signal: AegisTradingSignal): any {
    return signal.metadata?.aegis?.event_risk_auto ?? signal.aegis?.event_risk_auto;
}

function decisionBrainFromSignal(signal: AegisTradingSignal): any {
    return signal.metadata?.aegis?.decision_brain ?? signal.aegis?.decision_brain;
}

function cleanEntryGuardFromSignal(signal: AegisTradingSignal): any {
    return signal.metadata?.aegis?.clean_entry_guard ?? signal.aegis?.clean_entry_guard;
}

function decisionBrainTopProb(brain: any): number | undefined {
    switch (brain?.decision) {
        case 'ENTER_NOW':
            return brain.enter_now_prob;
        case 'WAIT_CONFIRMATION':
            return brain.wait_confirmation_prob;
        case 'MANUAL_ONLY':
            return brain.manual_only_prob;
        case 'DO_NOT_ENTER':
            return brain.do_not_enter_prob;
        default:
            return undefined;
    }
}

function formatEntryQualityModelLine(signal: AegisTradingSignal): string {
    const eq = entryQualityModelFromSignal(signal);
    if (!eq) return '';
    return `🧪 EQ: **${formatPct(eq.entry_quality_score)}** | Tail: **${formatPct(eq.tail_risk_score)}** | Rec: **${eq.recommendation ?? 'N/D'}**\n`;
}

function formatEventRiskAutoLine(signal: AegisTradingSignal): string {
    const eventRisk = eventRiskAutoFromSignal(signal);
    if (!eventRisk) return '';
    return `🌐 EventRisk: **${eventRisk.suggested_mode ?? 'N/D'}** ${formatPct(eventRisk.confidence)} | ${Array.isArray(eventRisk.reasons) ? eventRisk.reasons.slice(0, 2).join(', ') : 'N/D'}\n`;
}

function formatDecisionBrainLine(signal: AegisTradingSignal): string {
    const brain = decisionBrainFromSignal(signal);
    if (!brain) return '';
    return `🧠 DecisionBrain: **${brain.decision ?? 'N/D'}** ${formatPct(decisionBrainTopProb(brain))} | Enter ${formatPct(brain.enter_now_prob)} | Wait ${formatPct(brain.wait_confirmation_prob)} | Manual ${formatPct(brain.manual_only_prob)}\n`;
}

function formatCleanEntryGuardLine(signal: AegisTradingSignal): string {
    const guard = cleanEntryGuardFromSignal(signal);
    if (!guard) return '';
    const status = guard.clean === true
        ? 'CLEAN'
        : guard.decision === 'SHADOW_WAIT_CONFIRMATION'
            ? 'WAIT_SHADOW'
            : guard.decision ?? 'N/D';
    const reasons = Array.isArray(guard.reasons) && guard.reasons.length > 0
        ? ` / ${guard.reasons.slice(0, 2).join(' + ')}`
        : '';
    return `🧼 CleanEntry: **${status}**${reasons}\n`;
}

function signalInputFromTurbo(symbol: string, turbo: any): AegisSymbolSignalMessageInput {
    const raw = turbo?.raw ?? turbo;
    const gated = turbo?.gated;
    const freshness = raw?.freshness ?? turbo?.freshness;
    return {
        symbol,
        rawAction: raw?.action ?? turbo?.action ?? 'HOLD',
        rawScore: raw?.turbo_score ?? turbo?.turbo_score,
        gatedAction: gated?.action ?? turbo?.action ?? 'HOLD',
        votes: raw?.votes ?? turbo?.votes,
        reason: gated?.reason ?? raw?.reason ?? turbo?.reason,
        freshnessIsFresh: typeof freshness?.is_fresh === 'boolean'
            ? freshness.is_fresh
            : typeof freshness?.fresh === 'boolean'
                ? freshness.fresh
                : undefined
    };
}

export class TelegramCommandHandlers implements TelegramCommandHandlersPort {
    constructor(private readonly deps: TelegramCommandHandlerDeps) {}

    handleHelp(): string {
        return `🤖 **AEGIS TELEGRAM COMMANDS**\n\n` +
            `🧭 /help - Mostrar comandos\n` +
            `📡 /status - Estado del bot\n` +
            `💰 /account - Cuenta y balances\n` +
            `💼 /positions - Posiciones activas\n` +
            `📌 /trade ETHUSDT - Detalle de operación activa\n` +
            `📋 /trades - Resumen de operaciones activas\n` +
            `⚙️ /config - Configuración efectiva\n` +
            `🛰️ /signal ETHUSDT - Señal de un símbolo\n` +
            `📊 /signals - Señales de símbolos activos\n` +
            `🛡️ /risk - Riesgo y límites\n` +
            `🌐 /riskmode - Ver/cambiar Event Risk\n` +
            `🧷 /brackets - Estado de brackets\n` +
            `📈 /report today - Resumen de hoy\n` +
            `🛡️ /blocks - Bloqueos Aegis bajo demanda\n\n` +
            `🎢 /momentum - Diagnóstico Momentum Ride\n` +
            `🧪 /probe - Auditoría Probe Mode\n\n` +
            `🔒 **Solo lectura**. No abre, cierra ni modifica operaciones.`;
    }

    async handleStatus(): Promise<string> {
        const runtime = this.runtime();
        const symbols = this.getActiveAegisSymbols();
        const symbolModes = this.getConfiguredAegisSymbolModes();
        let apiStatus = 'ERROR';
        try {
            apiStatus = await this.deps.mlService.checkHealth() ? 'OK' : 'ERROR';
        } catch {
            apiStatus = 'ERROR';
        }

        const positions = await this.readActivePositions();
        let lastSignal = 'N/D';
        try {
            const symbol = symbols[0];
            if (symbol) {
                const signal = await this.deps.mlService.getSignal(symbol);
                const turbo = turboFromSignal(signal);
                const raw = turbo?.raw ?? turbo;
                const gated = turbo?.gated;
                lastSignal = `${symbol} | ${gated?.action ?? raw?.action ?? 'HOLD'} | score ${formatPct(raw?.turbo_score ?? turbo?.turbo_score)} | ${formatAegisReason(gated?.reason ?? raw?.reason ?? turbo?.reason)}`;
            }
        } catch {
            lastSignal = 'ERROR';
        }

        return `📡 **Status Aegis**\n\n` +
            `🤖 Bot: **online**\n` +
            `💓 Running: **${boolText(runtime.isRunning)}**\n` +
            `⚡ Trading mode: **${this.deps.tradingMode}**\n` +
            `🟢 Live enabled: **${boolText(this.deps.liveEnabled)}**\n` +
            `🧠 Aegis API: **${apiStatus}**\n` +
            `🪙 Símbolos: **${symbolModes.join(' | ') || symbols.join(', ') || 'N/D'}**\n` +
            `💼 Posiciones abiertas: **${positions.length}**\n` +
            `🛰️ Última señal: **${lastSignal}**`;
    }

    async handleAccount(): Promise<string> {
        const runtime = this.runtime();
        const account = await this.readAccount();
        const dailyPnlPct = runtime.dailyPnlPct
            ?? (finiteNumber(account.walletBalance) && finiteNumber(runtime.dailyStartBalance) && runtime.dailyStartBalance > 0
                ? (account.walletBalance - runtime.dailyStartBalance) / runtime.dailyStartBalance
                : undefined);
        return `${formatAccountMessage(account)}\n` +
            `📈 Unrealized PnL: **${formatUsd(account.unrealizedPnlTotal)}**\n` +
            `📆 Trades hoy: **${runtime.tradesToday ?? 0}**\n` +
            `🔻 Pérdidas consecutivas: **${runtime.consecutiveLosses ?? 0}**\n` +
            `📊 Daily PnL: **${formatPct(dailyPnlPct, true)}**`;
    }

    async handlePositions(): Promise<string> {
        return formatPositionsMessage({ activePositions: await this.readActivePositions() });
    }

    async handleTrade(symbol?: string): Promise<string> {
        const normalized = this.normalizeSymbol(symbol);
        if (!normalized) return `Uso: /trade ETHUSDT`;

        const status = await this.readTradeStatus(normalized);
        if (!status) return `No hay posición activa para ${normalized}`;

        return this.formatTradeStatus(status);
    }

    async handleTrades(): Promise<string> {
        const statuses = await this.readOpenTradeStatuses();
        if (statuses.length === 0) return `📋 **Trades activos**\n🟢 **Sin posiciones activas**`;

        const lines = statuses.map((status) => {
            const protection = [
                `BE ${status.breakEvenExecuted ? 'exec' : status.breakEvenArmed ? 'arm' : 'no'}`,
                `Prot ${status.protectProfitActive ? 'sí' : 'no'}`,
                `Tr ${status.trailingActive ? 'sí' : 'no'}`
            ].join(' | ');
            return `${status.symbol} | ${status.side} | ROE ${formatPct(status.currentRoe, true)} | Peak ${formatPct(status.peakRoe, true)} | Worst ${formatPct(status.lowestRoe, true)} | PnL ${formatUsd(status.currentPnl)} | ${protection}`;
        });

        return `📋 **Trades activos**\n${lines.join('\n')}`;
    }

    async handleConfig(): Promise<string> {
        const symbol = this.getActiveAegisSymbols()[0];
        const regime = this.regimeConfig(symbol);
        const turbo = this.turboConfig();
        const portfolioRisk = this.portfolioRiskConfig();
        const shortGate = this.shortGateConfig();
        const eventRisk = this.eventRiskConfig();
        const maxHoldMs = regime?.maxHoldMs ?? 0;
        const portfolioRiskLine = portfolioRisk?.enabled
            ? `🧱 Portfolio risk: **ON** | max pos ${portfolioRisk?.max_open_positions ?? 'N/D'} | same dir ${portfolioRisk?.max_same_direction_positions ?? 'N/D'} | margin ${formatPct(portfolioRisk?.max_margin_used_pct)} | notional/equity ${formatNumber(portfolioRisk?.max_notional_to_equity, 1)}x\n`
            : `🧱 Portfolio risk: **OFF**\n`;

        const configMessage = formatConfigMessage({
            leverage: regime?.leverage ?? 0,
            entryThreshold: regime?.entryThreshold ?? 0,
            maxHoldHours: maxHoldMs / 3600000,
            trailingEnabled: (regime?.trailingActivationRoe ?? 0) > 0,
            trailingActivationRoe: regime?.trailingActivationRoe,
            trailingCallbackRoe: regime?.trailingCallbackRoe,
            stopRoe: regime?.hardStopRoe,
            takeProfitRoe: regime?.tpRoe,
            maxTradesPerDay: turbo?.max_trades_per_day,
            dailyLossStopPct: turbo?.daily_loss_stop_pct,
            maxConsecutiveLosses: turbo?.max_consecutive_losses,
            requireBrackets: turbo?.require_brackets
        });

        return `${configMessage}\n` +
            `✅ Aegis enabled: **${boolText(turbo?.enabled)}**\n` +
            `🟢 Aegis live enabled: **${boolText(turbo?.live_enabled)}**\n` +
            `🧭 Symbol modes: **${this.getConfiguredAegisSymbolModes().join(' | ') || 'N/D'}**\n` +
            `📉 Allow short: **${boolText(turbo?.allow_short)}**\n` +
            `💼 Position fraction cap: **${formatPct(turbo?.position_fraction_cap)}**\n` +
            portfolioRiskLine +
            this.formatEventRiskConfigLine(eventRisk) +
            `🎯 Short gate: **${boolText(shortGate?.enabled)}** | ${shortGate?.mode ?? 'N/D'} | canonical current-brain | size x${formatNumber(shortGate?.position_fraction_multiplier, 2)} | max lev ${shortGate?.max_leverage ?? 'N/D'}x\n` +
            `⛔ Short blocked: **${shortGate?.block_symbols?.join(', ') || 'Ninguno'}**\n` +
            `⏲️ Cooldown: **${finiteNumber(turbo?.min_cooldown_ms) ? `${(turbo.min_cooldown_ms / 60000).toFixed(1)} min` : 'N/D'}**\n` +
            `🧯 Close if bracket fails: **${boolText(turbo?.close_if_bracket_fails)}**`;
    }

    async handleSignal(symbol?: string): Promise<string> {
        const normalized = this.normalizeSymbol(symbol || this.getActiveAegisSymbols()[0]);
        if (!normalized) return `Uso: /signal ETHUSDT`;

        try {
            const signal = await this.readSignal(normalized);
            const turbo = turboFromSignal(signal);
            const raw = turbo?.raw ?? turbo;
            const gated = turbo?.gated;
            const freshness = raw?.freshness ?? turbo?.freshness;
            const threshold = this.regimeConfig(normalized)?.entryThreshold;
            return `${formatSymbolSignalMessage(signalInputFromTurbo(normalized, turbo))}\n` +
                `🎚️ Threshold: **${formatPct(threshold)}**\n` +
                `✅ Production allowed: **${boolText(signal.metadata?.aegis?.prod?.allowed ?? signal.aegis?.prod?.allowed ?? turbo?.production_allowed)}**\n` +
                `🐍 Execute Python: **${boolText(turbo?.execute ?? turbo?.would_execute ?? raw?.would_execute)}**\n` +
                formatEntryQualityModelLine(signal) +
                formatEventRiskAutoLine(signal) +
                formatDecisionBrainLine(signal) +
                formatCleanEntryGuardLine(signal) +
                `🕒 Feature timestamp: **${freshness?.feature_timestamp ?? freshness?.timestamp ?? 'N/D'}**\n` +
                `🧾 Reason raw: **${formatAegisReason(gated?.reason ?? raw?.reason ?? turbo?.reason)}**`;
        } catch (error) {
            this.deps.logger?.warn('telegram_signal_failed', { symbol: normalized, error: String(error) });
            return `🛰️ **Signal ${normalized}**\n❌ **ERROR**`;
        }
    }

    async handleSignals(): Promise<string> {
        const rows: string[] = [];
        for (const symbol of this.getActiveAegisSymbols()) {
            try {
                const signal = await this.readSignal(symbol);
                const turbo = turboFromSignal(signal);
                const raw = turbo?.raw ?? turbo;
                const gated = turbo?.gated;
                const freshness = raw?.freshness ?? turbo?.freshness;
                const fresh = (freshness?.is_fresh ?? freshness?.fresh) === true ? 'fresco' : 'N/D';
                const votes = raw?.votes ?? turbo?.votes ?? {};
                const eq = entryQualityModelFromSignal(signal);
                const eqText = eq
                    ? ` | EQ ${formatPct(eq.entry_quality_score)} Tail ${formatPct(eq.tail_risk_score)} ${eq.recommendation ?? 'N/D'}`
                    : '';
                const eventRisk = eventRiskAutoFromSignal(signal);
                const eventRiskText = eventRisk
                    ? ` | ER ${eventRisk.suggested_mode ?? 'N/D'} ${formatPct(eventRisk.confidence)}`
                    : '';
                const brain = decisionBrainFromSignal(signal);
                const brainText = brain
                    ? ` | DB ${brain.decision ?? 'N/D'} ${formatPct(decisionBrainTopProb(brain))}`
                    : '';
                rows.push(`${symbol} | ${gated?.action ?? raw?.action ?? 'HOLD'} | score ${formatPct(raw?.turbo_score ?? turbo?.turbo_score)} | salida única L=${votes.long ?? 0} S=${votes.short ?? 0} N=${votes.neutral ?? 0} (sin consenso) | ${fresh}${eqText}${eventRiskText}${brainText}`);
            } catch {
                rows.push(`${symbol} | ERROR`);
            }
        }
        return rows.length > 0 ? `🛰️ **Señales**\n${rows.join('\n')}` : formatAllSignalsMessage({ signals: [] });
    }

    async handleRisk(): Promise<string> {
        const runtime = this.runtime();
        const account = await this.readAccount();
        const symbol = this.getActiveAegisSymbols()[0];
        const turbo = this.turboConfig();
        const state = this.stateForSymbol(symbol).get();
        const portfolioRisk = this.portfolioRiskConfig();
        const shortGate = this.shortGateConfig();
        const eventRisk = this.eventRiskConfig();
        const positions = await this.readPositionsWithOrders();
        const longCount = positions.filter((row) => row.position.side === 'LONG').length;
        const shortCount = positions.filter((row) => row.position.side === 'SHORT').length;
        const marginUsed = positions.reduce((sum, row) => sum + (row.position.margin ?? 0), 0);
        const notional = positions.reduce((sum, row) => sum + (row.position.notional ?? 0), 0);
        const equityBase = finiteNumber(account.equityTotal) && account.equityTotal > 0
            ? account.equityTotal
            : account.walletBalance;
        const marginUsedPct = finiteNumber(equityBase) && equityBase > 0 ? marginUsed / equityBase : undefined;
        const notionalToEquity = finiteNumber(equityBase) && equityBase > 0 ? notional / equityBase : undefined;
        const portfolioRiskLines = portfolioRisk?.enabled
            ? `🧱 Portfolio risk: **ON**\n` +
                `💼 Open positions: **${positions.length} / ${portfolioRisk?.max_open_positions ?? 'N/D'}**\n` +
                `📈 LONG/SHORT: **${longCount}/${shortCount}** | max same direction **${portfolioRisk?.max_same_direction_positions ?? 'N/D'}**\n` +
                `🧮 Margin used: **${formatPct(marginUsedPct)} / ${formatPct(portfolioRisk?.max_margin_used_pct)}**\n` +
                `⚖️ Notional/equity: **${formatNumber(notionalToEquity, 2)}x / ${formatNumber(portfolioRisk?.max_notional_to_equity, 1)}x**\n`
            : `🧱 Portfolio risk: **OFF**\n` +
                `💼 Open positions: **${positions.length}**\n` +
                `📈 LONG/SHORT: **${longCount}/${shortCount}**\n` +
                `🧮 Margin used: **${formatPct(marginUsedPct)}**\n` +
                `⚖️ Notional/equity: **${formatNumber(notionalToEquity, 2)}x**\n`;
        const cooldownMs = turbo?.min_cooldown_ms;
        const sinceExitMs = state.lastExitAt ? Date.now() - state.lastExitAt : undefined;
        const cooldownActive = finiteNumber(cooldownMs) && finiteNumber(sinceExitMs) && sinceExitMs < cooldownMs;
        const liquidity = symbol ? runtime.liquidityStressBySymbol?.[symbol] : undefined;
        const dailyPnlPct = runtime.dailyPnlPct
            ?? (finiteNumber(account.walletBalance) && finiteNumber(runtime.dailyStartBalance) && runtime.dailyStartBalance > 0
                ? (account.walletBalance - runtime.dailyStartBalance) / runtime.dailyStartBalance
                : undefined);

        return `🛡️ **Riesgo Aegis**\n\n` +
            `📆 Trades hoy: **${runtime.tradesToday ?? 0} / ${turbo?.max_trades_per_day ?? 'N/D'}**\n` +
            `🔻 Pérdidas consecutivas: **${runtime.consecutiveLosses ?? 0} / ${turbo?.max_consecutive_losses ?? 'N/D'}**\n` +
            `📊 Daily PnL: **${formatPct(dailyPnlPct, true)}**\n` +
            `🚨 Daily loss stop: **${formatPct(turbo?.daily_loss_stop_pct)}**\n` +
            `⏲️ Cooldown: **${cooldownActive ? 'ACTIVO' : 'OK'}**\n` +
            `🌊 Liquidity stress: **${finiteNumber(liquidity) ? formatPct(liquidity) : 'N/D'}**\n` +
            portfolioRiskLines +
            this.formatEventRiskRiskBlock(eventRisk) +
            `🎯 Short gate: **${shortGate?.mode ?? 'N/D'}** | canonical current-brain | max lev **${shortGate?.max_leverage ?? 'N/D'}x** | size **${formatNumber(shortGate?.position_fraction_multiplier, 2)}x**\n` +
            `⛔ Short blocked: **${shortGate?.block_symbols?.join(', ') || 'Ninguno'}**\n` +
            `🧷 Require brackets: **${boolText(turbo?.require_brackets)}**\n` +
            `🧯 Close if bracket fails: **${boolText(turbo?.close_if_bracket_fails)}**\n` +
            `📉 Shorts: **${turbo?.allow_short ? 'ON' : 'OFF'}**`;
    }

    handleRiskMode(mode?: string): string {
        const current = this.eventRiskConfig();
        const nextMode = normalizeEventRiskMode(mode);
        if (!mode) {
            return `🌐 **Event Risk Mode**\n\n` +
                `Mode: **${current.mode ?? 'NORMAL'}**\n` +
                `Enabled: **${boolText(current.enabled)}**\n` +
                `Enforce: **${boolText(current.enforce)}**\n` +
                `Manual override: **${boolText(current.manual_override_enabled)}**\n\n` +
                `Uso: /riskmode NORMAL | CAUTION | RISK_OFF | MANUAL_ONLY`;
        }

        if (!nextMode) {
            return `Modo inválido. Usa: NORMAL, CAUTION, RISK_OFF o MANUAL_ONLY.`;
        }

        if (current.manual_override_enabled !== true) {
            return `Event Risk manual override está desactivado. Cambia el modo por YAML.`;
        }

        const manager = this.deps.configManager as any;
        if (typeof manager.setAegisEventRiskMode !== 'function') {
            return `Event Risk solo lectura en este runtime. Cambia el modo por YAML.`;
        }

        const previousMode = current.mode ?? 'NORMAL';
        const updated = manager.setAegisEventRiskMode(nextMode);
        this.deps.logger?.warn('EVENT_RISK_MODE_CHANGED', {
            previousMode,
            mode: updated?.mode ?? nextMode,
            enabled: updated?.enabled,
            enforce: updated?.enforce
        });

        return `🌐 **Event Risk Mode Changed**\n\n` +
            `Anterior: **${previousMode}**\n` +
            `Nuevo: **${updated?.mode ?? nextMode}**\n` +
            `Enforce: **${boolText(updated?.enforce)}**`;
    }

    async handleBrackets(): Promise<string> {
        const positions = await this.readPositionsWithOrders();
        if (positions.length === 0) return `🛡️ **Brackets**\n🟢 **Sin posiciones activas**`;

        const blocks = positions.map(({ position, orders }) => {
            const sl = orders.find((order) => order.type.includes('STOP'));
            const tp = orders.find((order) => order.type.includes('TAKE_PROFIT'));
            const alert = !sl || !tp ? '\n🚨 **ALERTA:** bracket faltante' : '';
            return `🛡️ **${position.symbol}** | **${position.side}**\n` +
                `🛑 SL activo: **${sl ? 'Sí' : 'No'}** ${sl ? formatPrice(sl.stopPrice) : ''}\n` +
                `🎯 TP activo: **${tp ? 'Sí' : 'No'}** ${tp ? formatPrice(tp.stopPrice) : ''}${alert}`;
        });
        return blocks.join('\n\n');
    }

    async handleReportToday(): Promise<string> {
        try {
            const report = await analyzeAegisTurboHistory({
                date: todayIsoDate(),
                allSymbols: true,
                writeReports: false
            });
            const summary: any = report.summary ?? {};
            if (!summary.total_trades && !summary.closed_trades) return 'No hay trades registrados hoy.';
            const symbols = Object.keys(report.by_symbol ?? {});
            return `📊 **Reporte Aegis hoy**\n\n` +
                `📈 Trades: **${summary.total_trades ?? 0}**\n` +
                `✅ Cerrados: **${summary.closed_trades ?? 0}**\n` +
                `🏆 Win rate: **${finiteNumber(summary.win_rate) ? `${summary.win_rate.toFixed(1)}%` : 'N/D'}**\n` +
                `💵 Net PnL: **${finiteNumber(summary.net_pnl) ? `$${summary.net_pnl.toFixed(2)} USDT` : 'N/D'}**\n` +
                `⚖️ Profit factor: **${finiteNumber(summary.profit_factor) ? summary.profit_factor.toFixed(2) : 'N/D'}**\n` +
                `🚀 Best ROE: **${finiteNumber(summary.best_trade_roe) ? `${summary.best_trade_roe.toFixed(1)}%` : 'N/D'}**\n` +
                `🧯 Worst ROE: **${finiteNumber(summary.worst_trade_roe) ? `${summary.worst_trade_roe.toFixed(1)}%` : 'N/D'}**\n` +
                `🪙 Symbols: **${symbols.join(', ') || 'N/D'}**`;
        } catch (error) {
            this.deps.logger?.warn('telegram_report_today_failed', { error: String(error) });
            return 'No hay trades registrados hoy.';
        }
    }

    async handleBlocks(args: string[] = []): Promise<string | string[]> {
        try {
            const service = this.deps.blocksReportService ?? new AegisBlocksReportService();
            return await service.buildTelegramMessages(args);
        } catch (error) {
            this.deps.logger?.warn('telegram_blocks_report_failed', { error: String(error) });
            return 'No se pudo generar el reporte de bloqueos.';
        }
    }

    async handleMomentum(args: string[] = []): Promise<string | string[]> {
        try {
            const service = this.deps.momentumReportService ?? new AegisMomentumReportService();
            return await service.buildTelegramMessages(args);
        } catch (error) {
            this.deps.logger?.warn('telegram_momentum_report_failed', { error: String(error) });
            return 'No se pudo generar el reporte de Momentum Ride.';
        }
    }

    async handleProbe(args: string[] = []): Promise<string | string[]> {
        try {
            const service = this.deps.probeReportService ?? new AegisProbeReportService();
            return await service.buildTelegramMessages(args);
        } catch (error) {
            this.deps.logger?.warn('telegram_probe_report_failed', { error: String(error) });
            return 'No se pudo generar el reporte de Probe Mode.';
        }
    }

    getActiveAegisSymbols(): string[] {
        const manager = this.deps.configManager as any;
        const configured = typeof manager.getActiveAegisSymbols === 'function'
            ? manager.getActiveAegisSymbols()
            : this.deps.getActiveSymbols?.()
                ?? (typeof manager.getActiveSymbols === 'function'
                    ? manager.getActiveSymbols()
                    : undefined);
        const symbols = Array.isArray(configured) && configured.length > 0
            ? configured
            : CONFIG.SYMBOLS?.length ? CONFIG.SYMBOLS : ['ETHUSDT'];
        return [...new Set(symbols.map((symbol) => this.normalizeSymbol(symbol)).filter(Boolean))];
    }

    private getConfiguredAegisSymbolModes(): string[] {
        const manager = this.deps.configManager as any;
        if (typeof manager.getAegisSymbolConfigs === 'function') {
            const configs = Object.values(manager.getAegisSymbolConfigs() || {}) as Array<{ symbol: string; mode: string }>;
            return configs
                .filter((config) => config?.symbol)
                .map((config) => `${this.normalizeSymbol(config.symbol)} ${config.mode || 'SHADOW'}`);
        }

        return this.getActiveAegisSymbols().map((symbol) => {
            const mode = typeof manager.getSymbolMode === 'function' ? manager.getSymbolMode(symbol) : 'LIVE';
            return `${symbol} ${mode}`;
        });
    }

    private async readAccount(): Promise<AegisAccountMessageInput & { unrealizedPnlTotal?: number }> {
        const snapshot = typeof this.deps.exchange.getUSDTAccountSnapshot === 'function'
            ? await this.deps.exchange.getUSDTAccountSnapshot()
            : undefined;
        const wallet = snapshot?.walletBalance ?? await this.safeWalletBalance();
        return {
            walletBalance: wallet,
            equityTotal: snapshot?.equityTotal,
            availableBalance: snapshot?.availableBalance,
            unrealizedPnlTotal: snapshot?.unrealizedPnlTotal
        };
    }

    private async safeWalletBalance(): Promise<number | undefined> {
        try {
            return await this.deps.exchange.getUSDTBalance();
        } catch {
            return undefined;
        }
    }

    private async readActivePositions(): Promise<AegisPositionMessageInput[]> {
        const rows = await this.readPositionsWithOrders();
        return rows.map(({ position, markPrice, orders }) => {
            const tp = orders.find((order) => order.type.includes('TAKE_PROFIT'));
            const sl = orders.find((order) => order.type.includes('STOP'));
            return {
                symbol: position.symbol,
                side: position.side,
                size: position.qtyAbs,
                margin: position.margin,
                roi: position.roe,
                pnl: position.pnl,
                durationHours: position.durationHours,
                tpPrice: tp?.stopPrice,
                slPrice: sl?.stopPrice,
                tpRoe: position.tpRoe,
                slRoe: position.slRoe,
                baseAsset: baseAssetFromSymbol(position.symbol)
            };
        });
    }

    private async readPositionsWithOrders(): Promise<Array<{
        position: {
            symbol: string;
            side: Side;
            qtyAbs?: number;
            margin?: number;
            notional?: number;
            roe?: number;
            pnl?: number;
            durationHours?: number;
            tpRoe?: number;
            slRoe?: number;
        };
        markPrice?: number;
        orders: CloseOrder[];
    }>> {
        const output: Array<{ position: any; markPrice?: number; orders: CloseOrder[] }> = [];
        for (const symbol of this.getActiveAegisSymbols()) {
            const state = this.stateForSymbol(symbol).get();
            for (const side of ['LONG', 'SHORT'] as Side[]) {
                const position = await this.deps.exchange.readActivePosition(symbol, side).catch(() => null);
                if (!position) continue;
                const markPrice = await this.deps.exchange.getMarkPrice(symbol).catch(() => undefined);
                const margin = position.isolatedMargin
                    ?? (position.entryPrice > 0 && position.leverage > 0 ? (position.entryPrice * position.qtyAbs) / position.leverage : undefined);
                const notional = finiteNumber(markPrice)
                    ? markPrice * position.qtyAbs
                    : position.entryPrice * position.qtyAbs;
                const roe = finiteNumber(position.roePct)
                    ? position.roePct / 100
                    : finiteNumber(markPrice)
                        ? calculateRoe(side, position.entryPrice, markPrice, position.leverage)
                        : undefined;
                const orders = await this.deps.exchange.listCloseOrdersForSide(symbol, side).catch(() => []);
                const sameStatePosition = state.lastSide === side
                    && (state.mode === 'LONG_RIDE' || state.mode === 'SHORT_RIDE');
                output.push({
                    position: {
                        symbol,
                        side,
                        qtyAbs: position.qtyAbs,
                        margin,
                        notional,
                        roe,
                        pnl: position.unrealizedPnl ?? pnlFromRoe(margin, roe),
                        durationHours: sameStatePosition && state.lastEntryAt ? (Date.now() - state.lastEntryAt) / 3600000 : undefined,
                        tpRoe: sameStatePosition ? state.lastTakeProfitRoe : undefined,
                        slRoe: sameStatePosition ? state.lastStopRoe : undefined
                    },
                    markPrice,
                    orders
                });
            }
        }
        return output;
    }

    private async readOpenTradeStatuses(): Promise<TradeStatusDetails[]> {
        const statuses: TradeStatusDetails[] = [];
        for (const symbol of this.getActiveAegisSymbols()) {
            const status = await this.readTradeStatus(symbol);
            if (status) statuses.push(status);
        }
        return statuses;
    }

    private async readTradeStatus(symbol: string): Promise<TradeStatusDetails | null> {
        const stateStore = this.stateForSymbol(symbol);
        const state = stateStore.get();
        const preferredSides: Side[] = state.lastSide === 'SHORT'
            ? ['SHORT', 'LONG']
            : ['LONG', 'SHORT'];

        for (const side of preferredSides) {
            const position = await this.deps.exchange.readActivePosition(symbol, side).catch(() => null);
            if (!position) continue;

            const markPrice = await this.deps.exchange.getMarkPrice(symbol).catch(() => undefined);
            const entryPrice = position.entryPrice;
            const leverage = position.leverage;
            const quantity = position.qtyAbs;
            const margin = position.isolatedMargin
                ?? (entryPrice > 0 && leverage > 0 && quantity > 0 ? (entryPrice * quantity) / leverage : undefined);
            const currentRoe = finiteNumber(position.roePct)
                ? position.roePct / 100
                : finiteNumber(markPrice)
                    ? calculateRoe(side, entryPrice, markPrice, leverage)
                    : undefined;
            const currentPnl = position.unrealizedPnl ?? pnlFromRoe(margin, currentRoe);
            const sameStatePosition = state.lastSide === side
                && (state.mode === 'LONG_RIDE' || state.mode === 'SHORT_RIDE');
            const durationHours = sameStatePosition && state.lastEntryAt
                ? (Date.now() - state.lastEntryAt) / 3600000
                : undefined;
            const orders = await this.deps.exchange.listCloseOrdersForSide(symbol, side).catch(() => []);
            const sl = orders.find((order) => order.type.includes('STOP'));
            const tp = orders.find((order) => order.type.includes('TAKE_PROFIT'));
            const regime = this.regimeConfig(symbol);
            const profitProtection = this.profitProtectionConfig();
            const peakRoe = sameStatePosition ? state.peakRoe : undefined;
            const lowestRoe = sameStatePosition ? state.lowestRoe : undefined;
            const trailingActivationRoe = state.lastTrailingActivationRoe
                ?? regime?.trailingActivationRoe
                ?? 0.15;
            const trailingActive = finiteNumber(state.lastTrailStop)
                || (finiteNumber(currentRoe) && currentRoe >= trailingActivationRoe)
                || (finiteNumber(peakRoe) && peakRoe >= trailingActivationRoe);
            const protectProfitEligible = profitProtection.enabled === true
                && profitProtection.protect_profit_enabled === true
                && finiteNumber(peakRoe)
                && peakRoe >= profitProtection.min_peak_roe_to_protect;

            return {
                symbol,
                side,
                entryPrice,
                markPrice,
                quantity,
                margin,
                leverage,
                currentRoe,
                currentPnl,
                durationHours,
                tradeId: sameStatePosition ? state.lastTradeId : undefined,
                mode: state.mode,
                peakRoe,
                lowestRoe,
                breakEvenArmed: state.breakEvenArmed === true,
                breakEvenExecuted: state.breakEvenExecuted === true,
                lastBreakEvenStop: state.lastBreakEvenStop,
                lastStopPrice: state.lastStopPrice,
                lastTrailStop: state.lastTrailStop,
                trailingActive,
                trailingActivationRoe,
                protectProfitActive: protectProfitEligible,
                minPeakRoeToProtect: profitProtection.min_peak_roe_to_protect,
                slPrice: sl?.stopPrice,
                tpPrice: tp?.stopPrice,
                hasSL: Boolean(sl),
                hasTP: Boolean(tp)
            };
        }

        return null;
    }

    private formatTradeStatus(status: TradeStatusDetails): string {
        const bracketWarning = !status.hasSL || !status.hasTP
            ? `\n🚨 **WARNING:** bracket faltante`
            : '';
        const beText = status.breakEvenExecuted
            ? 'ejecutado'
            : status.breakEvenArmed
                ? 'armado'
                : 'no';
        const protectText = status.protectProfitActive
            ? `activo (peak >= ${formatPct(status.minPeakRoeToProtect, true)})`
            : `no (min ${formatPct(status.minPeakRoeToProtect, true)})`;
        const trailingText = status.trailingActive
            ? `activo (desde ${formatPct(status.trailingActivationRoe, true)})`
            : `no (desde ${formatPct(status.trailingActivationRoe, true)})`;

        return `📌 **Trade Status**\n` +
            `${status.symbol} **${status.side}**\n\n` +
            `Entrada: **${formatTradePrice(status.entryPrice)}**\n` +
            `Mark: **${formatTradePrice(status.markPrice)}**\n` +
            `Cantidad: **${formatNumber(status.quantity, 6)}**\n` +
            `Margen: **${formatUsd(status.margin)}**\n` +
            `Leverage: **${finiteNumber(status.leverage) ? `${status.leverage}x` : 'N/D'}**\n` +
            `ROE actual: **${formatPct(status.currentRoe, true)}**\n` +
            `PnL: **${formatUsd(status.currentPnl)}**\n\n` +
            `**Picos:**\n` +
            `Peak: **${formatPct(status.peakRoe, true)}**\n` +
            `Worst: **${formatPct(status.lowestRoe, true)}**\n` +
            `MFE/MAE: **${formatPct(status.peakRoe, true)} / ${formatPct(status.lowestRoe, true)}**\n\n` +
            `**Protección:**\n` +
            `BE: **${beText}**\n` +
            `Last BE stop: **${formatTradePrice(status.lastBreakEvenStop)}**\n` +
            `Protect: **${protectText}**\n` +
            `Trailing: **${trailingText}**\n` +
            `Last SL state: **${formatTradePrice(status.lastStopPrice)}**\n` +
            `Last trail stop: **${formatTradePrice(status.lastTrailStop)}**\n\n` +
            `**Brackets:**\n` +
            `SL: **${status.hasSL ? formatTradePrice(status.slPrice) : 'FALTA'}**\n` +
            `TP: **${status.hasTP ? formatTradePrice(status.tpPrice) : 'FALTA'}**${bracketWarning}\n\n` +
            `Duración: **${formatDurationHours(status.durationHours)}**\n` +
            `Trade ID: **${status.tradeId ?? 'N/D'}**\n` +
            `State: **${status.mode ?? 'N/D'}**`;
    }

    private async readSignal(symbol: string): Promise<AegisTradingSignal> {
        if (typeof this.deps.mlService.getAegisPrediction === 'function') {
            const prediction = await this.deps.mlService.getAegisPrediction(symbol);
            return this.signalFromPrediction(symbol, prediction);
        }
        return this.deps.mlService.getSignal(symbol);
    }

    private signalFromPrediction(symbol: string, prediction: AegisPredictionResponse): AegisTradingSignal {
        return {
            symbol,
            action: 'PASS',
            confidence: 0,
            source: 'AEGIS_TURBO',
            longProb: prediction.long_prob ?? 0,
            shortProb: prediction.short_prob ?? 0,
            neutralProb: prediction.neutral_prob ?? 0,
            closeProb: prediction.close_prob,
            smart_leverage: prediction.smart_leverage,
            features: prediction.features,
            aegis: prediction.aegis,
            metadata: { aegis: prediction.aegis, meta_verdict: prediction.meta_verdict, rawPrediction: prediction }
        };
    }

    private regimeConfig(symbol?: string) {
        return typeof (this.deps.configManager as any).getRegimeConfig === 'function'
            ? (this.deps.configManager as any).getRegimeConfig('AEGIS_TURBO', symbol)
            : undefined;
    }

    private turboConfig() {
        return typeof (this.deps.configManager as any).getAegisTurboConfig === 'function'
            ? (this.deps.configManager as any).getAegisTurboConfig()
            : undefined;
    }

    private portfolioRiskConfig() {
        return typeof (this.deps.configManager as any).getAegisPortfolioRiskConfig === 'function'
            ? (this.deps.configManager as any).getAegisPortfolioRiskConfig()
            : { enabled: false };
    }

    private shortGateConfig() {
        return typeof (this.deps.configManager as any).getAegisShortGateConfig === 'function'
            ? (this.deps.configManager as any).getAegisShortGateConfig()
            : { enabled: false, block_symbols: [] };
    }

    private eventRiskConfig() {
        return typeof (this.deps.configManager as any).getAegisEventRiskConfig === 'function'
            ? (this.deps.configManager as any).getAegisEventRiskConfig()
            : {
                enabled: false,
                mode: 'NORMAL',
                enforce: false,
                manual_override_enabled: false,
                caution: {
                    min_quality_score: 0.65,
                    max_tail_risk_score: 0.45,
                    require_btc_eth_confirmation: true
                },
                risk_off: {
                    min_quality_score: 0.75,
                    max_tail_risk_score: 0.35,
                    allow_only_a_plus: true
                },
                manual_only: {
                    block_new_entries: false
                }
            };
    }

    private profitProtectionConfig() {
        return typeof (this.deps.configManager as any).getAegisProfitProtectionConfig === 'function'
            ? (this.deps.configManager as any).getAegisProfitProtectionConfig()
            : {
                enabled: true,
                protect_profit_enabled: true,
                min_peak_roe_to_protect: 0.08,
                protect_giveback_roe: 0.05,
                min_locked_roe: 0.01,
                be_offset_pct: 0.003,
                immediate_trigger_buffer_pct: 0.001
            };
    }

    private formatEventRiskConfigLine(eventRisk: any): string {
        return `🌐 Event Risk: **${boolText(eventRisk?.enabled)}** | mode **${eventRisk?.mode ?? 'NORMAL'}** | enforce **${boolText(eventRisk?.enforce)}** | manual **${boolText(eventRisk?.manual_override_enabled)}**\n` +
            `🌐 Event Risk rules: CAUTION Q>=${formatPct(eventRisk?.caution?.min_quality_score)} Tail<=${formatPct(eventRisk?.caution?.max_tail_risk_score)} BTC/ETH ${boolText(eventRisk?.caution?.require_btc_eth_confirmation)} | RISK_OFF Q>=${formatPct(eventRisk?.risk_off?.min_quality_score)} Tail<=${formatPct(eventRisk?.risk_off?.max_tail_risk_score)} A+ ${boolText(eventRisk?.risk_off?.allow_only_a_plus)} | MANUAL block ${boolText(eventRisk?.manual_only?.block_new_entries)}\n`;
    }

    private formatEventRiskRiskBlock(eventRisk: any): string {
        return `🌐 Event Risk: **${eventRisk?.mode ?? 'NORMAL'}** | enabled **${boolText(eventRisk?.enabled)}** | enforce **${boolText(eventRisk?.enforce)}** | manual override **${boolText(eventRisk?.manual_override_enabled)}**\n` +
            `🧪 CAUTION: Q>=**${formatPct(eventRisk?.caution?.min_quality_score)}** Tail<=**${formatPct(eventRisk?.caution?.max_tail_risk_score)}** BTC/ETH **${boolText(eventRisk?.caution?.require_btc_eth_confirmation)}**\n` +
            `🚫 RISK_OFF: Q>=**${formatPct(eventRisk?.risk_off?.min_quality_score)}** Tail<=**${formatPct(eventRisk?.risk_off?.max_tail_risk_score)}** A+ **${boolText(eventRisk?.risk_off?.allow_only_a_plus)}**\n` +
            `🧑‍💻 MANUAL_ONLY block entries: **${boolText(eventRisk?.manual_only?.block_new_entries)}**\n`;
    }

    private stateForSymbol(symbol?: string) {
        const normalized = this.normalizeSymbol(symbol);
        const state = this.deps.state as any;
        return normalized && typeof state.forSymbol === 'function'
            ? state.forSymbol(normalized)
            : this.deps.state;
    }

    private runtime() {
        return this.deps.getRuntimeSnapshot?.() ?? { tradingMode: this.deps.tradingMode };
    }

    private normalizeSymbol(symbol?: string): string {
        return String(symbol || '').trim().toUpperCase();
    }
}
