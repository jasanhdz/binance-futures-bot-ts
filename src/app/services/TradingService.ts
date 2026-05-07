import { Exchange, PositionInfo, SymbolFilters, USDTAccountSnapshot } from '../ports/Exchange';
import { MLService } from '../ports/MLService';
import { Logger } from '../ports/Logger';
import { StateStore } from '../ports/StateStore';
import { Notifier } from '../ports/Notifier';
import { BotState, Side } from '../../domain/types';
import { evaluateGuardianAction, GuardianConfig } from '../../domain/services/ProfitGuardian';
import { calculateATR } from '../../domain/services/TechnicalIndicators';
import { AegisTradingSignal } from '../../domain/services/AegisStrategy';
import {
    AegisMicroLiveGateDecision,
    buildAegisMicroLiveGateConfigFromEnv,
    shouldEnterAegisTurboMicroLive
} from '../../domain/services/AegisMicroLiveGate';
import { AegisTurboYamlConfig, NinjaConfigManager } from '../../infra/config/ConfigLoader';
import { RegimeConfig } from '../ports/RegimeStrategy';
import { LiquidityVoidDetector } from './LiquidityVoidDetector';
import { CONFIG } from '../../infra/config/environment';
import {
    AegisTurboHistoryLogger,
    generateSignalId,
    generateTradeId,
    getPortfolioSessionId
} from '../../infra/logging/AegisTurboHistoryLogger';
import { formatAegisTurboEntryMessage } from './formatAegisTurboEntryMessage';
import { AegisPositionMessageInput, formatAegisStartupMessage } from '../messages/AegisMessageFormatter';

const INITIAL_BALANCE = 20;
const DEFAULT_AEGIS_MAX_HOLD_MS = 8 * 60 * 60 * 1000;

export interface TradingServiceDeps {
    exchange: Exchange;
    mlService: MLService;
    logger: Logger;
    state: StateStore;
    notifier: Notifier;
    configManager: NinjaConfigManager;
    historyLogger?: AegisTurboHistoryLogger;
}

export interface TradingServiceConfig {
    symbols: string[];
    tickIntervalMs: number;
    maxTradesPerDay: number;
    tradingMode?: string;
}

export interface AegisRuntimeSnapshot {
    tradingMode: string;
    isRunning: boolean;
    tradesToday: number;
    consecutiveLosses: number;
    dailyStartBalance: number | null;
    dailyPnlPct?: number;
    lastTradeDayReset: number;
    liquidityStressBySymbol: Record<string, number>;
}

export class TradingService {
    private isRunning = false;
    private tradesToday = 0;
    private lastTradeDayReset = 0;
    private dailyStartBalance: number | null = null;
    private consecutiveLosses = 0;
    private lastEntryBalance = INITIAL_BALANCE;
    private peakBalance = INITIAL_BALANCE;
    private lastErrorTime: Record<string, number> = {};
    private lastLogTime: Record<string, number> = {};
    private lastAlivePulseMs = Date.now();
    private hardWatchdogTimer: NodeJS.Timeout | null = null;
    private detector: Record<string, LiquidityVoidDetector> = {};
    private readonly historyLogger: AegisTurboHistoryLogger;

    constructor(
        private deps: TradingServiceDeps,
        private config: TradingServiceConfig
    ) {
        this.historyLogger = deps.historyLogger ?? new AegisTurboHistoryLogger({ logger: deps.logger });
    }

    private getTradingMode(): string {
        return this.config.tradingMode || CONFIG.TRADING_MODE;
    }

    private getAegisTurboYamlConfig(): AegisTurboYamlConfig | undefined {
        const manager = this.deps.configManager as any;
        return typeof manager.getAegisTurboConfig === 'function'
            ? manager.getAegisTurboConfig()
            : undefined;
    }

    private getAegisTurboRegimeConfig(symbol?: string): RegimeConfig | undefined {
        const manager = this.deps.configManager as any;
        return typeof manager.getRegimeConfig === 'function'
            ? manager.getRegimeConfig('AEGIS_TURBO', symbol)
            : undefined;
    }

    private getAegisTurboGateConfig(symbol: string) {
        return buildAegisMicroLiveGateConfigFromEnv(
            CONFIG,
            this.getAegisTurboYamlConfig(),
            this.getAegisTurboRegimeConfig(symbol)
        );
    }

    getAegisRuntimeSnapshot(): AegisRuntimeSnapshot {
        const liquidityStressBySymbol: Record<string, number> = {};
        for (const symbol of Object.keys(this.detector)) {
            liquidityStressBySymbol[symbol] = this.detector[symbol]?.getLiquidityStress() ?? 0;
        }
        return {
            tradingMode: this.getTradingMode(),
            isRunning: this.isRunning,
            tradesToday: this.tradesToday,
            consecutiveLosses: this.consecutiveLosses,
            dailyStartBalance: this.dailyStartBalance,
            lastTradeDayReset: this.lastTradeDayReset,
            liquidityStressBySymbol
        };
    }

    async start(startLoop = true): Promise<void> {
        const { logger, notifier, mlService, state, configManager, exchange } = this.deps;
        const tradingMode = this.getTradingMode();
        const isTurbo = tradingMode === 'AEGIS_TURBO_MICRO_LIVE';
        let startupWalletBalance: number | null = null;
        try {
            startupWalletBalance = await exchange.getUSDTBalance();
        } catch (error) {
            logger.warn('startup_wallet_balance_unavailable', { error });
        }
        const startupAccount = await this.readEntryAccountSnapshot(startupWalletBalance ?? undefined);

        logger.info(isTurbo ? '⚡ AEGIS TURBO MICRO-LIVE MODE' : '🛡️ AEGIS SHADOW MODE', {
            initial: INITIAL_BALANCE,
            walletBalance: startupWalletBalance,
            mode: tradingMode,
            liveEnabled: CONFIG.AEGIS_LIVE_ENABLED,
            yamlLiveEnabled: this.getAegisTurboYamlConfig()?.live_enabled === true
        });

        const firstSymbol = this.config.symbols[0];
        const gateConfig = this.getAegisTurboGateConfig(firstSymbol);
        const regimeConfig = this.getAegisTurboRegimeConfig(firstSymbol);
        const entryThreshold = gateConfig.minScore;
        const maxHoldMs = (gateConfig as any).maxHoldMs ?? regimeConfig?.maxHoldMs ?? DEFAULT_AEGIS_MAX_HOLD_MS;
        const trailingActivation = (gateConfig as any).trailingActivationRoe ?? regimeConfig?.trailingActivationRoe ?? 0.15;
        const trailingCallback = (gateConfig as any).trailingCallbackRoe ?? regimeConfig?.trailingCallbackRoe ?? 0.08;

        let signal: AegisTradingSignal | null = null;
        for (let i = 0; i < 5; i++) {
            try {
                signal = await mlService.getSignal(firstSymbol);
                break;
            } catch (e) {
                logger.info(`Waiting for Aegis API (${i + 1}/5)`);
                await this.sleep(3000);
            }
        }

        const turbo = signal?.aegis?.turbo ?? signal?.metadata?.aegis?.turbo;
        const turboRaw = turbo?.raw as any;
        const turboGated = turbo?.gated;
        const freshness = turboRaw?.freshness ?? (turbo as any)?.freshness;
        const startupPositions: AegisPositionMessageInput[] = [];

        const botState = state.get();
        if (botState.mode !== 'IDLE') {
            const side = botState.lastSide as Side;
            const markPrice = await exchange.getMarkPrice(firstSymbol);
            const position = await exchange.readActivePosition(firstSymbol, side);
            const entryPrice = botState.lastEntryPrice || position?.entryPrice || markPrice;
            const leverage = botState.lastLeverage || position?.leverage || gateConfig.leverageCap;
            const qtyAbs = botState.lastEntryQty || position?.qtyAbs || 0;
            const marginUsed = botState.lastEntryMargin
                || position?.isolatedMargin
                || (entryPrice > 0 && leverage > 0 && qtyAbs > 0 ? (entryPrice * qtyAbs) / leverage : 0);
            const durationMs = botState.lastEntryAt ? Date.now() - botState.lastEntryAt : 0;
            const roi = side === 'SHORT'
                ? (entryPrice - markPrice) / entryPrice * leverage
                : (markPrice - entryPrice) / entryPrice * leverage;
            const pnl = typeof position?.unrealizedPnl === 'number' && Number.isFinite(position.unrealizedPnl)
                ? position.unrealizedPnl
                : this.pnlFromRoe(marginUsed, roi);
            const approximateBalance = startupWalletBalance !== null ? startupWalletBalance + marginUsed + pnl : null;
            const openOrders = await exchange.listCloseOrdersForSide(firstSymbol, side);
            const tpOrder = openOrders.find(order => order.type.includes('TAKE_PROFIT'));
            const slOrder = openOrders.find(order => order.type.includes('STOP'));
            const stopRoe = botState.lastStopRoe ?? regimeConfig?.hardStopRoe ?? -0.15;
            const takeProfitRoe = botState.lastTakeProfitRoe ?? regimeConfig?.tpRoe ?? 0.25;

            startupPositions.push({
                symbol: firstSymbol,
                side,
                size: qtyAbs,
                margin: marginUsed,
                roi,
                pnl,
                durationHours: durationMs / 3600000,
                tpPrice: tpOrder?.stopPrice,
                slPrice: slOrder?.stopPrice,
                tpRoe: takeProfitRoe,
                slRoe: stopRoe
            });
            await this.logAegisAccountSnapshot({
                symbol: firstSymbol,
                walletBalance: startupAccount.walletBalance ?? startupWalletBalance ?? undefined,
                availableBalance: startupAccount.availableBalance,
                unrealizedPnl: pnl,
                positionOpen: true,
                side,
                entryPrice,
                markPrice,
                roe: roi,
                marginUsed,
                quantity: qtyAbs,
                leverage,
                metadata: { event: 'startup' }
            });
            if (approximateBalance !== null && startupAccount.equityTotal === undefined) {
                logger.debug('startup_approximate_balance', { symbol: firstSymbol, approximateBalance });
            }
        } else {
            await this.logAegisAccountSnapshot({
                symbol: firstSymbol,
                walletBalance: startupAccount.walletBalance ?? startupWalletBalance ?? undefined,
                availableBalance: startupAccount.availableBalance,
                positionOpen: false,
                metadata: { event: 'startup' }
            });
        }

        const startupMsg = formatAegisStartupMessage({
            mode: {
                tradingMode,
                liveEnabled: CONFIG.AEGIS_LIVE_ENABLED === true && this.getAegisTurboYamlConfig()?.live_enabled === true,
                strategy: 'AEGIS_TURBO',
                shortsEnabled: gateConfig.allowShort === true,
                activeSymbols: this.config.symbols
            },
            account: {
                walletBalance: startupAccount.walletBalance ?? startupWalletBalance ?? undefined,
                equityTotal: startupAccount.equityTotal,
                availableBalance: startupAccount.availableBalance
            },
            config: {
                leverage: gateConfig.leverageCap,
                entryThreshold: Number(entryThreshold),
                maxHoldHours: Number(maxHoldMs) / 3600000,
                trailingEnabled: trailingActivation > 0,
                trailingActivationRoe: trailingActivation,
                trailingCallbackRoe: trailingCallback,
                stopRoe: gateConfig.stopRoe,
                takeProfitRoe: gateConfig.takeProfitRoe,
                maxTradesPerDay: gateConfig.maxTradesPerDay,
                dailyLossStopPct: gateConfig.dailyLossStopPct,
                maxConsecutiveLosses: gateConfig.maxConsecutiveLosses,
                requireBrackets: gateConfig.requireBrackets
            },
            initialRadar: {
                symbol: firstSymbol,
                rawAction: turboRaw?.action ?? 'HOLD',
                rawScore: turboRaw?.turbo_score,
                gatedAction: turboGated?.action ?? 'HOLD',
                votes: turboRaw?.votes,
                reason: turboGated?.reason ?? turboRaw?.reason,
                freshnessIsFresh: typeof freshness?.is_fresh === 'boolean'
                    ? freshness.is_fresh
                    : typeof freshness?.fresh === 'boolean'
                        ? freshness.fresh
                        : undefined,
                featureTimestamp: freshness?.feature_timestamp ?? freshness?.timestamp
            },
            activePositions: startupPositions
        });
        await notifier.sendMessage(startupMsg);
        for (const symbol of this.config.symbols) {
            this.deps.exchange.subscribeToCandles(symbol);
            this.detector[symbol] = new LiquidityVoidDetector(this.deps.logger);
            if (this.deps.exchange.subscribeToPartialDepth) {
                this.deps.exchange.subscribeToPartialDepth(symbol, 50, '100ms', (depth: any) => {
                    if (!depth?.bids || !depth?.asks) return;
                    const mapper = (arr: any[]) => arr.map(row => Array.isArray(row)
                        ? { price: Number(row[0]), qty: Number(row[1]) }
                        : { price: Number(row.price), qty: Number(row.quantity) });
                    this.detector[symbol].processDepthUpdate({
                        bidDepth: mapper(depth.bids),
                        askDepth: mapper(depth.asks)
                    });
                });
            }
        }

        this.isRunning = true;
        this.hardWatchdogTimer = setInterval(() => {
            if (this.isRunning && (Date.now() - this.lastAlivePulseMs > 180000)) {
                this.deps.logger.error('system_deadlock_detected');
                process.exit(1);
            }
        }, 10000);

        if (startLoop) await this.runLoop();
    }

    stop(): void {
        this.isRunning = false;
        this.deps.logger.info('Aegis bot stopped');
        if (this.hardWatchdogTimer) clearInterval(this.hardWatchdogTimer);
    }

    async tick(symbol: string): Promise<void> {
        await this.processSymbol(symbol);
    }

    private async runLoop(): Promise<void> {
        while (this.isRunning) {
            try {
                this.checkDailyReset();
                for (const symbol of this.config.symbols) {
                    if (!this.isRunning) break;
                    await this.processSymbol(symbol);
                }
                await this.sleep(this.config.tickIntervalMs);
            } catch (error) {
                this.deps.logger.error('Loop error', { error: String(error) });
                await this.sleep(1000);
            }
        }
    }

    private async processSymbol(symbol: string): Promise<void> {
        this.lastAlivePulseMs = Date.now();
        const botState = this.deps.state.get();

        try {
            if (botState.mode !== 'IDLE') {
                await this.managePosition(symbol, botState);
                if (this.deps.state.get().mode === 'IDLE') {
                    await this.lookForEntry(symbol);
                }
            } else {
                await this.lookForEntry(symbol);
            }
        } catch (error) {
            this.deps.logger.warn('Process error', { symbol, error: String(error) });
        }
    }

    private logAegisScan(symbol: string, signal: AegisTradingSignal): void {
        const aegis = signal.metadata?.aegis ?? signal.aegis;
        this.deps.logger.info('aegis_scan', {
            symbol,
            mode: this.getTradingMode(),
            safeAction: aegis?.shadow?.action,
            safeReason: aegis?.shadow?.reason,
            turboRawAction: aegis?.turbo?.raw?.action,
            turboRawScore: aegis?.turbo?.raw?.turbo_score,
            turboRawWouldExecute: aegis?.turbo?.raw?.would_execute,
            turboGatedAction: aegis?.turbo?.gated?.action,
            turboGatedReason: aegis?.turbo?.gated?.reason,
            turboBlockedBy: aegis?.turbo?.gated?.blocked_by,
            execute: aegis?.turbo?.execute,
            smartLeverage: signal.smart_leverage ?? 0,
            prodExecute: aegis?.prod?.execute
        });
    }

    private async logAegisTurboSignal(
        symbol: string,
        signal: AegisTradingSignal,
        extras: {
            signalId?: string;
            tradeId?: string;
            price?: number;
            gate?: AegisMicroLiveGateDecision;
            executed?: boolean;
            metadata?: Record<string, unknown>;
        } = {}
    ): Promise<void> {
        const aegis = signal.metadata?.aegis ?? signal.aegis;
        const turbo = aegis?.turbo as any;
        const raw = turbo?.raw;
        const gated = turbo?.gated;
        await this.historyLogger.logSignal({
            signal_id: extras.signalId ?? generateSignalId(symbol),
            portfolio_session_id: getPortfolioSessionId(),
            symbol,
            strategy: 'AEGIS_TURBO',
            mode: this.getTradingMode(),
            price: extras.price,
            raw_action: raw?.action,
            gated_action: gated?.action,
            final_action: turbo?.action ?? gated?.action ?? raw?.action,
            reason: turbo?.reason ?? gated?.reason ?? raw?.reason,
            turbo_score: raw?.turbo_score ?? turbo?.turbo_score ?? extras.gate?.turboScore,
            confidence: typeof signal.confidence === 'number' ? `${signal.confidence}` : undefined,
            votes: raw?.votes ?? extras.gate?.votes,
            recent_scores: raw?.recent_scores ?? turbo?.recent_scores,
            freshness: raw?.freshness ?? turbo?.freshness,
            gate_allowed: extras.gate?.allowed,
            gate_reason: extras.gate?.reason,
            gated_blocked_by: extras.gate?.gatedBlockedBy,
            executed: extras.executed ?? false,
            trade_id: extras.tradeId,
            leverage: extras.gate?.leverage,
            position_fraction: extras.gate?.positionFraction,
            stop_roe: extras.gate?.stopRoe,
            take_profit_roe: extras.gate?.takeProfitRoe,
            trailing_activation_roe: extras.gate?.trailingActivationRoe,
            trailing_callback_roe: extras.gate?.trailingCallbackRoe,
            metadata: {
                source: signal.source,
                safe_action: aegis?.shadow?.action,
                safe_reason: aegis?.shadow?.reason,
                prod_execute: aegis?.prod?.execute,
                ...extras.metadata
            }
        });
    }

    private async logAegisTradeEvent(
        symbol: string,
        event: string,
        input: {
            tradeId?: string;
            price?: number;
            roe?: number;
            oldStop?: number;
            newStop?: number;
            oldTp?: number;
            newTp?: number;
            reason?: string;
            metadata?: Record<string, unknown>;
        } = {}
    ): Promise<void> {
        await this.historyLogger.logTradeEvent({
            trade_id: input.tradeId,
            portfolio_session_id: getPortfolioSessionId(),
            symbol,
            strategy: 'AEGIS_TURBO',
            mode: this.getTradingMode(),
            event,
            price: input.price,
            roe: input.roe,
            old_stop: input.oldStop,
            new_stop: input.newStop,
            old_tp: input.oldTp,
            new_tp: input.newTp,
            reason: input.reason,
            metadata: input.metadata
        });
    }

    private async logAegisAccountSnapshot(input: {
        symbol?: string;
        walletBalance?: number;
        availableBalance?: number;
        unrealizedPnl?: number;
        dailyPnlPct?: number;
        positionOpen?: boolean;
        side?: Side;
        entryPrice?: number;
        markPrice?: number;
        roe?: number;
        marginUsed?: number;
        quantity?: number;
        leverage?: number;
        metadata?: Record<string, unknown>;
    } = {}): Promise<void> {
        const notional = input.entryPrice && input.quantity
            ? input.entryPrice * input.quantity
            : undefined;
        await this.historyLogger.logAccountSnapshot({
            portfolio_session_id: getPortfolioSessionId(),
            mode: this.getTradingMode(),
            wallet_balance: input.walletBalance,
            available_balance: input.availableBalance ?? input.walletBalance,
            unrealized_pnl: input.unrealizedPnl,
            daily_pnl_pct: input.dailyPnlPct,
            trades_today: this.tradesToday,
            consecutive_losses: this.consecutiveLosses,
            open_positions_count: input.positionOpen ? 1 : 0,
            total_margin_used: input.marginUsed,
            total_notional: notional,
            symbols: input.symbol ? [{
                symbol: input.symbol,
                position_open: input.positionOpen,
                side: input.side,
                entry_price: input.entryPrice,
                mark_price: input.markPrice,
                roe: input.roe,
                unrealized_pnl: input.unrealizedPnl,
                margin_used: input.marginUsed,
                notional
            }] : undefined,
            portfolio_exposure: {
                long_symbols: input.positionOpen && input.side === 'LONG' ? 1 : 0,
                short_symbols: input.positionOpen && input.side === 'SHORT' ? 1 : 0,
                total_symbols: input.positionOpen ? 1 : 0,
                total_margin_used: input.marginUsed,
                total_notional: notional
            },
            metadata: input.metadata
        });
    }

    private evaluateAegisTurboGate(
        symbol: string,
        signal: AegisTradingSignal,
        dailyPnlPct?: number
    ): AegisMicroLiveGateDecision {
        const botState = this.deps.state.get();
        const timeSinceLastExitMs = Date.now() - (botState.lastExitAt || 0);
        const liquidityStress = this.detector[symbol]?.getLiquidityStress() || 0;

        return shouldEnterAegisTurboMicroLive(
            {
                symbol,
                signal: { aegis: signal.metadata?.aegis ?? signal.aegis },
                hasOpenPosition: botState.mode !== 'IDLE',
                tradesToday: this.tradesToday,
                consecutiveLosses: this.consecutiveLosses,
                timeSinceLastExitMs,
                liquidityStress,
                dailyPnlPct
            },
            this.getAegisTurboGateConfig(symbol)
        );
    }

    private async lookForEntry(symbol: string): Promise<void> {
        const { mlService, exchange, logger, state } = this.deps;
        const tradingMode = this.getTradingMode();

        try {
            const signal = await mlService.getSignal(symbol);
            const signalId = generateSignalId(symbol);
            this.logAegisScan(symbol, signal);
            await this.logAegisTradeEvent(symbol, 'SIGNAL_RECEIVED', { metadata: { signalId } });

            if (tradingMode === 'AEGIS_SHADOW') {
                await this.logAegisTurboSignal(symbol, signal, { signalId, executed: false });
                return;
            }
            if (tradingMode !== 'AEGIS_TURBO_MICRO_LIVE') {
                logger.warn('aegis_unknown_trading_mode', { symbol, tradingMode });
                await this.logAegisTurboSignal(symbol, signal, {
                    signalId,
                    executed: false,
                    metadata: { ignored_reason: 'unknown_trading_mode' }
                });
                return;
            }

            const balance = await exchange.getUSDTBalance();
            if (this.dailyStartBalance === null || this.dailyStartBalance <= 0) {
                this.dailyStartBalance = balance;
            }
            const dailyPnlPct = this.dailyStartBalance > 0
                ? (balance - this.dailyStartBalance) / this.dailyStartBalance
                : undefined;
            const gateConfig = this.getAegisTurboGateConfig(symbol);
            const gateDecision = this.evaluateAegisTurboGate(symbol, signal, dailyPnlPct);
            if (!gateDecision.allowed) {
                await this.logAegisTurboSignal(symbol, signal, { signalId, gate: gateDecision, executed: false });
                await this.logAegisTradeEvent(symbol, 'GATE_DENIED', {
                    reason: gateDecision.reason,
                    metadata: {
                        turboScore: gateDecision.turboScore,
                        votes: gateDecision.votes,
                        gatedReason: gateDecision.gatedReason,
                        gatedBlockedBy: gateDecision.gatedBlockedBy
                    }
                });
                await this.logAegisAccountSnapshot({
                    symbol,
                    walletBalance: balance,
                    availableBalance: balance,
                    dailyPnlPct,
                    positionOpen: false,
                    metadata: { reason: gateDecision.reason }
                });
                logger.info('aegis_micro_live_gate_denied', {
                    symbol,
                    reason: gateDecision.reason,
                    turboScore: gateDecision.turboScore,
                    votes: gateDecision.votes,
                    rawReason: gateDecision.rawReason,
                    gatedReason: gateDecision.gatedReason,
                    gatedBlockedBy: gateDecision.gatedBlockedBy,
                    liveEnabled: CONFIG.AEGIS_LIVE_ENABLED,
                    yamlLiveEnabled: this.getAegisTurboYamlConfig()?.live_enabled === true,
                    balance,
                    dailyStartBalance: this.dailyStartBalance,
                    dailyPnlPct,
                    dailyLossStopPct: gateConfig.dailyLossStopPct,
                    tradingMode
                });
                return;
            }

            if (CONFIG.AEGIS_LIVE_ENABLED !== true) {
                this.logAllowedDryRun(symbol, gateDecision);
                await this.logAegisTurboSignal(symbol, signal, { signalId, gate: gateDecision, executed: false });
                await this.logAegisTradeEvent(symbol, 'GATE_ALLOWED', {
                    reason: gateDecision.reason,
                    metadata: {
                        dryRun: true,
                        side: gateDecision.side,
                        leverage: gateDecision.leverage,
                        positionFraction: gateDecision.positionFraction,
                        stopRoe: gateDecision.stopRoe,
                        takeProfitRoe: gateDecision.takeProfitRoe,
                        trailingActivationRoe: gateDecision.trailingActivationRoe,
                        trailingCallbackRoe: gateDecision.trailingCallbackRoe
                    }
                });
                return;
            }

            if (this.getAegisTurboYamlConfig()?.live_enabled !== true) {
                await this.logAegisTurboSignal(symbol, signal, {
                    signalId,
                    gate: { ...gateDecision, allowed: false, reason: 'aegis_turbo_yaml_live_disabled' },
                    executed: false
                });
                await this.logAegisTradeEvent(symbol, 'GATE_DENIED', {
                    reason: 'aegis_turbo_yaml_live_disabled',
                    metadata: {
                        turboScore: gateDecision.turboScore,
                        votes: gateDecision.votes,
                        gatedReason: gateDecision.gatedReason,
                        gatedBlockedBy: gateDecision.gatedBlockedBy
                    }
                });
                logger.info('aegis_micro_live_gate_denied', {
                    symbol,
                    reason: 'aegis_turbo_yaml_live_disabled',
                    turboScore: gateDecision.turboScore,
                    votes: gateDecision.votes,
                    rawReason: gateDecision.rawReason,
                    gatedReason: gateDecision.gatedReason,
                    gatedBlockedBy: gateDecision.gatedBlockedBy,
                    liveEnabled: CONFIG.AEGIS_LIVE_ENABLED,
                    yamlLiveEnabled: false,
                    balance,
                    dailyStartBalance: this.dailyStartBalance,
                    dailyPnlPct,
                    dailyLossStopPct: gateConfig.dailyLossStopPct,
                    tradingMode
                });
                return;
            }

            if (!gateDecision.side || state.get().mode !== 'IDLE') return;
            if (this.tradesToday >= gateConfig.maxTradesPerDay) return;
            if (await exchange.hasOpenPosition(symbol, 'ANY')) {
                logger.warn('aegis_real_position_already_open', { symbol });
                return;
            }

            const tradeId = generateTradeId(symbol);
            await this.logAegisTurboSignal(symbol, signal, { signalId, tradeId, gate: gateDecision, executed: true });
            await this.logAegisTradeEvent(symbol, 'GATE_ALLOWED', {
                tradeId,
                reason: gateDecision.reason,
                metadata: {
                    side: gateDecision.side,
                    leverage: gateDecision.leverage,
                    positionFraction: gateDecision.positionFraction,
                    stopRoe: gateDecision.stopRoe,
                    takeProfitRoe: gateDecision.takeProfitRoe,
                    trailingActivationRoe: gateDecision.trailingActivationRoe,
                    trailingCallbackRoe: gateDecision.trailingCallbackRoe
                }
            });
            await this.openAegisTurboPosition(symbol, signal, gateDecision, tradeId);
        } catch (error) {
            if (this.shouldLogError(symbol, 'AEGIS_LOOK_FOR_ENTRY', 60000)) {
                logger.error('Aegis lookForEntry error', { error: String(error) });
            }
            await this.notifyError(symbol, 'AEGIS LOOK FOR ENTRY', error);
        }
    }

    private logAllowedDryRun(symbol: string, gateDecision: AegisMicroLiveGateDecision): void {
        this.deps.logger.warn('aegis_micro_live_gate_allowed_dry_run', {
            symbol,
            side: gateDecision.side,
            leverage: gateDecision.leverage,
            positionFraction: gateDecision.positionFraction,
            stopRoe: gateDecision.stopRoe,
            takeProfitRoe: gateDecision.takeProfitRoe,
            trailingActivationRoe: gateDecision.trailingActivationRoe,
            trailingCallbackRoe: gateDecision.trailingCallbackRoe,
            turboScore: gateDecision.turboScore,
            votes: gateDecision.votes,
            rawReason: gateDecision.rawReason,
            gatedReason: gateDecision.gatedReason,
            gatedBlockedBy: gateDecision.gatedBlockedBy,
            dryRun: true,
            message: 'Gate allowed but live execution is disabled by env'
        });
    }

    private async openAegisTurboPosition(
        symbol: string,
        signal: AegisTradingSignal,
        gate: AegisMicroLiveGateDecision,
        tradeId: string
    ): Promise<void> {
        const { exchange, logger, state, notifier, configManager } = this.deps;
        const yaml = this.getAegisTurboYamlConfig();
        let opened = false;
        let openedSide: Side | null = null;

        try {
            if (!gate.allowed || (gate.side !== 'LONG' && gate.side !== 'SHORT')) return;
            const leverage = gate.leverage;
            const positionFraction = gate.positionFraction;
            if (leverage <= 0 || positionFraction <= 0) return;

            const wallet = await exchange.getUSDTBalance();
            const entryAccount = await this.readEntryAccountSnapshot(wallet);
            const feeBufferPct = configManager.trading?.fee_buffer_pct ?? CONFIG.FEE_BUFFER_PCT ?? 0.05;
            const effectiveWallet = wallet * (1 - feeBufferPct);
            const markPrice = await exchange.getMarkPrice(symbol);
            const filters = await exchange.getSymbolFilters(symbol, leverage);
            const margin = effectiveWallet * positionFraction;
            const notional = margin * leverage;
            const quantity = this.roundQuantity(notional / markPrice, filters);

            if (quantity <= 0 || quantity * markPrice < filters.minNotional) {
                logger.warn('aegis_position_too_small', {
                    symbol,
                    quantity,
                    markPrice,
                    notional: quantity * markPrice,
                    minNotional: filters.minNotional
                });
                return;
            }

            await exchange.setLeverage(symbol, leverage);
            await exchange.ensureMarginType(symbol, 'ISOLATED');

            const side = gate.side;
            await this.logAegisTradeEvent(symbol, 'ORDER_SUBMITTED', {
                tradeId,
                price: markPrice,
                metadata: {
                    side,
                    quantity,
                    leverage,
                    positionFraction,
                    marginEstimated: margin,
                    notionalEstimated: notional
                }
            });
            const result = await exchange.marketOpen(symbol, side, quantity);
            opened = true;
            openedSide = side;

            const positionData = await this.confirmAegisPositionWithRetries(symbol, side);
            if (!positionData) {
                logger.error('aegis_position_verify_failed_after_market_open', {
                    symbol,
                    side,
                    quantity,
                    avgPrice: result?.avgPrice,
                    orderId: result?.orderId
                });
                await this.emergencyCloseUnverifiedAegisPosition(symbol, side, quantity, 'AEGIS_POSITION_VERIFY_FAILED', tradeId);
                throw new Error('AEGIS_POSITION_VERIFY_FAILED_AFTER_MARKET_OPEN');
            }
            await this.logAegisTradeEvent(symbol, 'POSITION_CONFIRMED', {
                tradeId,
                price: positionData.entryPrice || result.avgPrice,
                metadata: {
                    side,
                    quantity: positionData.qtyAbs || quantity,
                    sideMode: positionData.sideMode,
                    orderId: result?.orderId
                }
            });

            const entryPrice = positionData.entryPrice || result.avgPrice;
            const marginUsed = positionData.isolatedMargin || margin;
            const stopPrice = this.roundPrice(this.bracketPrice(side, entryPrice, gate.stopRoe, leverage, 'STOP'), filters);
            const tpPrice = this.roundPrice(this.bracketPrice(side, entryPrice, gate.takeProfitRoe, leverage, 'TP'), filters);

            const requireBrackets = yaml?.require_brackets !== false;
            const closeIfBracketFails = yaml?.close_if_bracket_fails !== false;
            let slOk = false;
            let tpOk = false;
            try {
                slOk = await exchange.placeStopClose(symbol, side, stopPrice);
                if (requireBrackets && !slOk) throw new Error('AEGIS_STOP_BRACKET_REJECTED');
                tpOk = await exchange.placeTpClose(symbol, side, tpPrice);
                if (requireBrackets && !tpOk) throw new Error('AEGIS_TP_BRACKET_REJECTED');
            } catch (bracketError) {
                logger.error('aegis_bracket_creation_failed', {
                    symbol,
                    side,
                    stopPrice,
                    tpPrice,
                    slOk,
                    tpOk,
                    error: String(bracketError)
                });
                await this.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_ATTEMPT', {
                    tradeId,
                    reason: String(bracketError).includes('TP') ? 'TAKE_PROFIT_BRACKET_FAILED' : 'STOP_BRACKET_FAILED',
                    metadata: { stopPrice, tpPrice, slOk, tpOk, error: String(bracketError) }
                });
                if (closeIfBracketFails) {
                    await exchange.closeSideMarketSafe(symbol, side, positionData.qtyAbs, positionData.sideMode, 'AEGIS_BRACKET_FAILED');
                    await this.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_SUCCESS', {
                        tradeId,
                        reason: 'AEGIS_BRACKET_FAILED',
                        metadata: { stopPrice, tpPrice, slOk, tpOk }
                    });
                    state.set({
                        mode: 'IDLE',
                        lastExitAt: Date.now(),
                        lastExitReason: 'AEGIS_BRACKET_FAILED',
                        lastBracketStatus: 'FAILED_CLOSED'
                    });
                    await notifier.sendMessage(
                        `⚠️ **BRACKET FAILED**\n` +
                        `Symbol: ${symbol}\n` +
                        `Error: ${String(bracketError)}\n` +
                        `ACTION REQUIRED: Check Open Orders!`
                    );
                    return;
                }
                throw bracketError;
            }

            const bracketStatus = requireBrackets
                ? await this.validateAegisBrackets(symbol, side)
                : { hasSL: slOk, hasTP: tpOk };

            if (requireBrackets && (!slOk || !tpOk || !bracketStatus.hasSL || !bracketStatus.hasTP)) {
                logger.error('aegis_bracket_validation_failed', {
                    symbol,
                    side,
                    stopPrice,
                    tpPrice,
                    slOk,
                    tpOk,
                    hasSL: bracketStatus.hasSL,
                    hasTP: bracketStatus.hasTP
                });
                await this.logAegisTradeEvent(symbol, 'BRACKET_MISSING', {
                    tradeId,
                    reason: 'AEGIS_REQUIRED_BRACKETS_MISSING',
                    metadata: { stopPrice, tpPrice, slOk, tpOk, bracketStatus }
                });
                if (closeIfBracketFails) {
                    await exchange.closeSideMarketSafe(symbol, side, positionData.qtyAbs, positionData.sideMode, 'AEGIS_BRACKET_FAILED');
                    await this.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_SUCCESS', {
                        tradeId,
                        reason: 'AEGIS_BRACKET_FAILED',
                        metadata: { stopPrice, tpPrice, slOk, tpOk, bracketStatus }
                    });
                    state.set({
                        mode: 'IDLE',
                        lastExitAt: Date.now(),
                        lastExitReason: 'AEGIS_BRACKET_FAILED',
                        lastBracketStatus: 'FAILED_CLOSED'
                    });
                    await notifier.sendMessage(
                        `⚠️ **BRACKET FAILED**\n` +
                        `Symbol: ${symbol}\n` +
                        `Error: AEGIS_REQUIRED_BRACKETS_MISSING\n` +
                        `ACTION REQUIRED: Check Open Orders!`
                    );
                    return;
                }
                throw new Error('AEGIS_REQUIRED_BRACKETS_MISSING');
            }

            await this.logAegisTradeEvent(symbol, 'BRACKETS_CONFIRMED', {
                tradeId,
                metadata: { stopPrice, tpPrice, slOk, tpOk, bracketStatus }
            });
            const openedAtMs = await exchange.getServerTime();
            state.set({
                mode: side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE',
                lastSide: side,
                lastEntryPrice: entryPrice,
                lastLeverage: leverage,
                lastEntryAt: openedAtMs,
                peakRoe: 0,
                lowestRoe: 0,
                currentRegime: 'AEGIS_TURBO',
                lastStrategy: 'AEGIS_TURBO',
                lastTradeId: tradeId,
                lastPeakPrice: entryPrice,
                lastEntryWallet: wallet,
                lastEntryMargin: marginUsed,
                lastEntryQty: positionData.qtyAbs || quantity,
                lastMlProb: gate.turboScore,
                lastAegisTurboScore: gate.turboScore,
                lastAegisRawReason: gate.rawReason,
                lastAegisGatedReason: gate.gatedReason,
                lastAegisGatedBlockedBy: gate.gatedBlockedBy,
                lastStopRoe: gate.stopRoe,
                lastTakeProfitRoe: gate.takeProfitRoe,
                lastTrailingActivationRoe: gate.trailingActivationRoe,
                lastTrailingCallbackRoe: gate.trailingCallbackRoe,
                lastPositionFraction: positionFraction,
                lastRequestedLeverage: gate.leverage,
                lastActualLeverage: leverage,
                lastBracketStatus: 'OK'
            });
            await this.historyLogger.logTradeOpen({
                trade_id: tradeId,
                portfolio_session_id: getPortfolioSessionId(),
                symbol,
                strategy: 'AEGIS_TURBO',
                mode: this.getTradingMode(),
                side,
                opened_at: new Date(openedAtMs).toISOString(),
                entry_price: entryPrice,
                quantity: positionData.qtyAbs || quantity,
                leverage,
                position_fraction: positionFraction,
                margin_estimated: marginUsed,
                notional_estimated: (positionData.qtyAbs || quantity) * entryPrice,
                turbo_score: gate.turboScore,
                votes: gate.votes,
                stop_roe: gate.stopRoe,
                take_profit_roe: gate.takeProfitRoe,
                trailing_activation_roe: gate.trailingActivationRoe,
                trailing_callback_roe: gate.trailingCallbackRoe,
                sl_price: stopPrice,
                tp_price: tpPrice,
                brackets_confirmed: true,
                status: 'OPEN',
                metadata: {
                    rawReason: gate.rawReason,
                    gatedReason: gate.gatedReason,
                    gatedBlockedBy: gate.gatedBlockedBy,
                    orderId: result?.orderId,
                    estimated: true
                }
            });
            await this.logAegisAccountSnapshot({
                symbol,
                walletBalance: entryAccount.walletBalance ?? wallet,
                availableBalance: entryAccount.availableBalance,
                unrealizedPnl: entryAccount.unrealizedPnlTotal,
                positionOpen: true,
                side,
                entryPrice,
                markPrice,
                marginUsed,
                quantity: positionData.qtyAbs || quantity,
                leverage,
                metadata: { event: 'trade_open', tradeId }
            });

            this.tradesToday++;
            this.lastEntryBalance = wallet;
            if (wallet > this.peakBalance) this.peakBalance = wallet;

            logger.warn('aegis_turbo_micro_live_entry', {
                symbol,
                side,
                entryPrice,
                quantity: positionData.qtyAbs || quantity,
                margin: marginUsed,
                leverage,
                positionFraction,
                turboScore: gate.turboScore,
                votes: gate.votes,
                rawReason: gate.rawReason
            });
            logger.info('aegis_turbo_brackets_created', { symbol, side, stopPrice, tpPrice });

            await notifier.sendMessage(
                this.buildAegisEntryMessage({
                    symbol,
                    side,
                    entryPrice,
                    quantity: positionData.qtyAbs || quantity,
                    marginUsed,
                    wallet,
                    account: entryAccount,
                    leverage,
                    stopPrice,
                    tpPrice,
                    gate,
                    filters
                })
            );
            logger.info('📱 [TELEGRAM_REPORT] AEGIS ENTRY SENT', {
                message: `🔥 AEGIS TURBO ENTRY\n${symbol} | ${side}\n...score: ${this.formatScore(gate.turboScore)}`
            });
        } catch (error) {
            logger.error('aegis_entry_error_closed', { symbol, error: String(error) });
            if (opened && openedSide) {
                try {
                    const position = await exchange.readActivePosition(symbol, openedSide);
                    if (position) {
                        await exchange.closeSideMarketSafe(symbol, openedSide, position.qtyAbs, position.sideMode, 'AEGIS_ENTRY_ERROR_CLOSED');
                        await this.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_SUCCESS', {
                            tradeId,
                            reason: 'AEGIS_ENTRY_ERROR_CLOSED',
                            metadata: { error: String(error), qtyAbs: position.qtyAbs }
                        });
                        state.set({ mode: 'IDLE', lastExitAt: Date.now(), lastExitReason: 'AEGIS_ENTRY_ERROR_CLOSED' });
                        await notifier.sendMessage(
                            `⚠️ **AEGIS ENTRY FAILED**\n` +
                            `Symbol: ${symbol}\n` +
                            `Error: ${String(error).slice(0, 180)}`
                        );
                    }
                } catch (closeError) {
                    logger.error('aegis_entry_error_close_failed', { symbol, error: String(closeError) });
                    await this.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_FAILED', {
                        tradeId,
                        reason: 'AEGIS_ENTRY_ERROR_CLOSED',
                        metadata: { error: String(closeError) }
                    });
                }
            }
        }
    }

    private async confirmAegisPositionWithRetries(
        symbol: string,
        side: Side,
        attempts = 3
    ): Promise<PositionInfo | null> {
        const delays = [300, 500, 1000];
        for (let i = 0; i < attempts; i++) {
            await this.sleep(delays[i] ?? delays[delays.length - 1]);
            this.deps.logger.info('aegis_position_confirm_retry', {
                symbol,
                side,
                attempt: i + 1
            });
            const position = await this.deps.exchange.readActivePosition(symbol, side);
            if (position) return position;
        }
        return null;
    }

    private async emergencyCloseUnverifiedAegisPosition(
        symbol: string,
        side: Side,
        quantity: number,
        reason: string,
        tradeId?: string
    ): Promise<void> {
        const { exchange, logger, notifier } = this.deps;
        logger.error('aegis_emergency_close_attempt', { symbol, side, quantity, reason });
        await this.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_ATTEMPT', {
            tradeId,
            reason,
            metadata: { side, quantity }
        });
        try {
            const position = await exchange.readActivePosition(symbol, side);
            const qtyAbs = position?.qtyAbs ?? quantity;
            const sideMode = position?.sideMode ?? 'BOTH';
            await exchange.closeSideMarketSafe(symbol, side, qtyAbs, sideMode, reason);
            logger.error('aegis_emergency_close_success', { symbol, side, qtyAbs, sideMode, reason });
            await this.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_SUCCESS', {
                tradeId,
                reason,
                metadata: { side, qtyAbs, sideMode }
            });
            await notifier.sendMessage(
                `⚠️ **AEGIS EMERGENCY CLOSE**\n` +
                `Symbol: ${symbol}\n` +
                `Side: ${side}\n` +
                `Reason: ${reason}\n` +
                `Qty: ${qtyAbs}`
            );
        } catch (error) {
            logger.error('aegis_emergency_close_failed', { symbol, side, quantity, reason, error: String(error) });
            await this.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_FAILED', {
                tradeId,
                reason,
                metadata: { side, quantity, error: String(error) }
            });
            await notifier.sendMessage(
                `⚠️ **AEGIS EMERGENCY CLOSE FAILED**\n` +
                `Symbol: ${symbol}\n` +
                `Side: ${side}\n` +
                `Reason: ${reason}\n` +
                `Error: ${String(error).slice(0, 180)}`
            );
            throw error;
        }
    }

    private async validateAegisBrackets(symbol: string, side: Side): Promise<{ hasSL: boolean; hasTP: boolean }> {
        const orders = await this.deps.exchange.listCloseOrdersForSide(symbol, side);
        return {
            hasSL: orders.some(order => order.type.includes('STOP')),
            hasTP: orders.some(order => order.type.includes('TAKE_PROFIT'))
        };
    }

    private async managePosition(symbol: string, botState: BotState): Promise<void> {
        const { exchange, logger, state, notifier } = this.deps;
        const side = botState.lastSide as Side;
        const entryPrice = botState.lastEntryPrice || 0;
        const leverage = botState.lastLeverage || this.getAegisTurboGateConfig(symbol).leverageCap;

        try {
            const position = await exchange.readActivePosition(symbol, side);
            if (!position) {
                const balance = await exchange.getUSDTBalance();
                const markPrice = await exchange.getMarkPrice(symbol);
                const finalRoe = this.calculateRoe(side, botState.lastEntryPrice || markPrice, markPrice, leverage);
                const pnl = this.pnlFromRoe(this.entryMargin(botState), finalRoe);
                this.consecutiveLosses = pnl < 0 ? this.consecutiveLosses + 1 : 0;
                logger.info('aegis_position_closed', {
                    symbol,
                    pnl: pnl.toFixed(2),
                    balance: balance.toFixed(2),
                    consecutiveLosses: this.consecutiveLosses
                });
                await this.notifyExit(symbol, side, 'SL/TP', botState, { exitPrice: markPrice, finalRoe, pnl });
                state.set({ mode: 'IDLE', lastExitAt: Date.now() });
                return;
            }

            if (this.getAegisTurboYamlConfig()?.require_brackets !== false) {
                try {
                    await this.ensureAegisBrackets(symbol, side, entryPrice, leverage, position);
                } catch (bracketError) {
                    logger.error('aegis_bracket_recreate_failed', { symbol, side, error: String(bracketError) });
                    await notifier.sendAlert(
                        'AEGIS BRACKET RECREATE FAILED',
                        `${symbol} | ${side}\n${String(bracketError).slice(0, 180)}`
                    );
                }
            }

            const markPrice = await exchange.getMarkPrice(symbol);
            const candle = await exchange.getLastCandle(symbol);
            let peakPrice = botState.lastPeakPrice || entryPrice;
            if (candle) {
                peakPrice = side === 'SHORT' ? Math.min(peakPrice, candle.low) : Math.max(peakPrice, candle.high);
            }
            if (peakPrice !== botState.lastPeakPrice) state.set({ lastPeakPrice: peakPrice });

            const currentRoe = side === 'SHORT'
                ? (entryPrice - markPrice) / entryPrice * leverage
                : (markPrice - entryPrice) / entryPrice * leverage;
            const updatedPeakRoe = Math.max(botState.peakRoe || 0, currentRoe);
            const updatedLowestRoe = Math.min(botState.lowestRoe || 0, currentRoe);
            if (updatedPeakRoe !== botState.peakRoe || updatedLowestRoe !== botState.lowestRoe) {
                state.set({ peakRoe: updatedPeakRoe, lowestRoe: updatedLowestRoe });
            }

            const serverNow = await exchange.getServerTime();
            const tradeDuration = botState.lastEntryAt ? serverNow - botState.lastEntryAt : 0;
            const regimeConfig = this.getAegisTurboRegimeConfig(symbol);
            const maxHoldMs = regimeConfig?.maxHoldMs ?? DEFAULT_AEGIS_MAX_HOLD_MS;
            if (tradeDuration > maxHoldMs && currentRoe > 0.02) {
                await exchange.closeSideMarketSafe(symbol, side, position.qtyAbs, position.sideMode, 'AEGIS_TIME_LIMIT');
                state.set({ mode: 'IDLE', lastExitAt: Date.now(), lastExitReason: 'AEGIS_TIME_LIMIT' });
                await this.notifyExit(symbol, side, 'TIME_LIMIT', botState);
                return;
            }

            const now = Date.now();
            let currentAtr = botState.lastAtrValue;
            if (now - (botState.lastAtrFetchedAt || 0) > 60000) {
                try {
                    const klines = await exchange.getCandles(symbol, '5m', 15);
                    const atr = calculateATR(klines, 14);
                    if (atr) {
                        currentAtr = atr;
                        state.set({ lastAtrFetchedAt: now, lastAtrValue: atr });
                    }
                } catch { }
            }

            const guardianConfig: GuardianConfig = {
                beTriggerRoe: 0.10,
                beOffsetPct: 0.003,
                trailingDev: 0.015,
                trailingActivationRoe: botState.lastTrailingActivationRoe ?? regimeConfig?.trailingActivationRoe ?? 0.15,
                trailingCallbackRoe: botState.lastTrailingCallbackRoe ?? regimeConfig?.trailingCallbackRoe ?? 0.08,
                useAtrTrailing: true,
                atrMultiplier: 1.5
            };
            const previousPeakRoe = botState.peakRoe ?? 0;
            if (previousPeakRoe < guardianConfig.beTriggerRoe && updatedPeakRoe >= guardianConfig.beTriggerRoe) {
                await this.logAegisTradeEvent(symbol, 'BREAK_EVEN_ARMED', {
                    tradeId: botState.lastTradeId,
                    price: markPrice,
                    roe: currentRoe,
                    metadata: { peakRoe: updatedPeakRoe }
                });
            }
            if (
                guardianConfig.trailingActivationRoe !== undefined
                && previousPeakRoe < guardianConfig.trailingActivationRoe
                && updatedPeakRoe >= guardianConfig.trailingActivationRoe
            ) {
                await this.logAegisTradeEvent(symbol, 'TRAILING_ACTIVATED', {
                    tradeId: botState.lastTradeId,
                    price: markPrice,
                    roe: currentRoe,
                    metadata: { peakRoe: updatedPeakRoe }
                });
            }
            const action = evaluateGuardianAction({
                entryPrice,
                currentPrice: markPrice,
                peakPrice,
                positionSide: side,
                leverage,
                peakRoe: updatedPeakRoe,
                atrValue: currentAtr
            }, guardianConfig, undefined);

            if (action.type === 'MOVE_SL_TRAILING' && action.price) {
                const filters = await exchange.getSymbolFilters(symbol, leverage);
                const trailingPrice = this.roundPrice(action.price, filters);
                if (this.isBetterStop(side, trailingPrice, botState.lastTrailStop)) {
                    if (typeof (exchange as any).cancelStopOrdersForSide === 'function') {
                        await (exchange as any).cancelStopOrdersForSide(symbol, side);
                    }
                    await exchange.placeStopClose(symbol, side, trailingPrice);
                    state.set({ lastTrailStop: trailingPrice });
                    logger.info('aegis_trailing_stop_updated', { symbol, side, trailingPrice });
                    await this.logAegisTradeEvent(symbol, 'SL_MOVED', {
                        tradeId: botState.lastTradeId,
                        price: markPrice,
                        roe: currentRoe,
                        oldStop: botState.lastTrailStop,
                        newStop: trailingPrice,
                        reason: 'MOVE_SL_TRAILING'
                    });
                }
            } else if (action.type === 'CLOSE_MARKET') {
                await exchange.closeSideMarketSafe(symbol, side, position.qtyAbs, position.sideMode, action.reason);
                state.set({ mode: 'IDLE', lastExitAt: Date.now(), lastExitReason: action.reason });
                const pnl = this.pnlFromRoe(this.entryMargin(botState), currentRoe);
                await this.notifyExit(symbol, side, action.reason, botState, { exitPrice: markPrice, finalRoe: currentRoe, pnl });
            }
        } catch (error) {
            logger.warn('Aegis management error', { symbol, error: String(error) });
        }
    }

    private async notifyExit(
        symbol: string,
        side: Side,
        reason: string,
        botState: BotState,
        exit?: { exitPrice?: number; finalRoe?: number; pnl?: number }
    ): Promise<void> {
        const { exchange, notifier, logger } = this.deps;
        const currentBalance = await exchange.getUSDTBalance();
        const entryPrice = botState.lastEntryPrice || 0;
        const leverage = botState.lastLeverage || botState.lastActualLeverage || this.getAegisTurboGateConfig(symbol).leverageCap;
        const exitPrice = exit?.exitPrice ?? await exchange.getMarkPrice(symbol);
        const finalRoe = exit?.finalRoe ?? this.calculateRoe(side, entryPrice || exitPrice, exitPrice, leverage);
        const pnl = exit?.pnl ?? this.pnlFromRoe(this.entryMargin(botState), finalRoe);
        const durationMs = Date.now() - (botState.lastEntryAt || Date.now());
        const durationHrs = (durationMs / 3600000).toFixed(2);
        const exitType = this.describeAegisExit(reason, pnl, botState, side, exitPrice);
        const margin = this.entryMargin(botState);
        const pnlStr = this.formatSignedUsd(pnl);
        const tradeId = botState.lastTradeId ?? generateTradeId(symbol, new Date(botState.lastEntryAt ?? Date.now()));
        const durationMinutes = durationMs / 60000;

        await this.historyLogger.logTradeClose({
            trade_id: tradeId,
            portfolio_session_id: getPortfolioSessionId(),
            symbol,
            strategy: 'AEGIS_TURBO',
            mode: this.getTradingMode(),
            side,
            opened_at: botState.lastEntryAt ? new Date(botState.lastEntryAt).toISOString() : undefined,
            closed_at: new Date().toISOString(),
            entry_price: entryPrice || undefined,
            exit_price: exitPrice,
            quantity: botState.lastEntryQty,
            leverage,
            position_fraction: botState.lastPositionFraction,
            exit_reason: reason,
            pnl_usdt: pnl,
            roe: finalRoe,
            fees_estimated: botState.lastCommissionEstimate,
            duration_minutes: durationMinutes,
            mfe_roe: botState.peakRoe,
            mae_roe: botState.lowestRoe,
            max_drawdown_roe: botState.lowestRoe,
            status: 'CLOSED',
            metadata: {
                estimated: true,
                exit_type: exitType.title,
                reason_detail: exitType.reason
            }
        });
        await this.logAegisTradeEvent(symbol, 'TRADE_CLOSED', {
            tradeId,
            price: exitPrice,
            roe: finalRoe,
            reason,
            metadata: { pnl, exitType: exitType.title }
        });
        await this.logAegisAccountSnapshot({
            symbol,
            walletBalance: currentBalance,
            availableBalance: currentBalance,
            unrealizedPnl: 0,
            positionOpen: false,
            side,
            entryPrice,
            markPrice: exitPrice,
            roe: finalRoe,
            marginUsed: margin,
            quantity: botState.lastEntryQty,
            leverage,
            metadata: { event: 'trade_close', tradeId, exitReason: reason }
        });

        await notifier.sendMessage(
            `${exitType.emoji} **${exitType.title}**\n` +
            `${symbol} | ${side}\n` +
            `Entrada: $${entryPrice.toFixed(2)} → Salida: $${exitPrice.toFixed(2)}\n` +
            `ROE Final: **${this.formatRoe(finalRoe)}**\n` +
            `PnL: **${pnlStr}**\n` +
            `Margen: **$${margin.toFixed(2)} USDT**\n` +
            `Duración: ${durationHrs}h\n` +
            `MFE Pico: ${this.formatRoe(botState.peakRoe || 0)}\n` +
            `MAE: ${this.formatRoe(botState.lowestRoe || 0)}\n` +
            `Balance: **$${currentBalance.toFixed(2)}**\n` +
            `Razón: ${exitType.reason}`
        );
        logger.info('📱 [TELEGRAM_REPORT] AEGIS EXIT SENT', {
            message: `${exitType.emoji} **${exitType.title}** PnL: ${pnlStr} ROE: ${this.formatRoe(finalRoe)}`
        });
    }

    private async ensureAegisBrackets(
        symbol: string,
        side: Side,
        entryPrice: number,
        leverage: number,
        position: PositionInfo
    ): Promise<void> {
        const { exchange, logger } = this.deps;
        const openOrders = await exchange.listCloseOrdersForSide(symbol, side);
        const hasSL = openOrders.some(order => order.type.includes('STOP'));
        const hasTP = openOrders.some(order => order.type.includes('TAKE_PROFIT'));
        if (hasSL && hasTP) return;
        await this.logAegisTradeEvent(symbol, 'BRACKET_MISSING', {
            tradeId: this.deps.state.get().lastTradeId,
            reason: !hasSL && !hasTP ? 'SL_AND_TP_MISSING' : !hasSL ? 'SL_MISSING' : 'TP_MISSING',
            metadata: { hasSL, hasTP }
        });

        const filters = await exchange.getSymbolFilters(symbol, leverage);
        const regimeConfig = this.getAegisTurboRegimeConfig(symbol);
        if (!hasSL) {
            const stopPrice = this.roundPrice(
                this.bracketPrice(
                    side,
                    entryPrice,
                    this.deps.state.get().lastStopRoe ?? regimeConfig?.hardStopRoe ?? -0.15,
                    leverage,
                    'STOP'
                ),
                filters
            );
            await exchange.placeStopClose(symbol, side, stopPrice, position.qtyAbs);
            logger.info('aegis_turbo_brackets_created', { symbol, side, stopPrice, recreated: true });
            await this.logAegisTradeEvent(symbol, 'BRACKET_RECREATED', {
                tradeId: this.deps.state.get().lastTradeId,
                newStop: stopPrice,
                reason: 'SL_RECREATED'
            });
        }
        if (!hasTP) {
            const tpPrice = this.roundPrice(
                this.bracketPrice(
                    side,
                    entryPrice,
                    this.deps.state.get().lastTakeProfitRoe ?? regimeConfig?.tpRoe ?? 0.25,
                    leverage,
                    'TP'
                ),
                filters
            );
            await exchange.placeTpClose(symbol, side, tpPrice, position.qtyAbs);
            logger.info('aegis_turbo_brackets_created', { symbol, side, tpPrice, recreated: true });
            await this.logAegisTradeEvent(symbol, 'BRACKET_RECREATED', {
                tradeId: this.deps.state.get().lastTradeId,
                newTp: tpPrice,
                reason: 'TP_RECREATED'
            });
        }
    }

    private bracketPrice(side: Side, entryPrice: number, roe: number, leverage: number, kind: 'STOP' | 'TP'): number {
        const move = Math.abs(roe) / leverage;
        if (kind === 'STOP') {
            return side === 'LONG' ? entryPrice * (1 - move) : entryPrice * (1 + move);
        }
        return side === 'LONG' ? entryPrice * (1 + move) : entryPrice * (1 - move);
    }

    private buildAegisEntryMessage(input: {
        symbol: string;
        side: Side;
        entryPrice: number;
        quantity: number;
        marginUsed: number;
        wallet: number;
        account?: USDTAccountSnapshot;
        leverage: number;
        stopPrice: number;
        tpPrice: number;
        gate: AegisMicroLiveGateDecision;
        filters?: SymbolFilters;
    }): string {
        const { symbol, side, entryPrice, quantity, marginUsed, wallet, account, leverage, stopPrice, tpPrice, gate, filters } = input;
        const threshold = this.getAegisTurboGateConfig(symbol).minScore;
        return formatAegisTurboEntryMessage({
            symbol,
            side,
            entryPrice,
            quantity,
            marginUsed,
            walletFallback: wallet,
            account,
            leverage,
            stopPrice,
            tpPrice,
            turboScore: gate.turboScore,
            threshold,
            votes: gate.votes,
            reason: gate.gatedReason ?? gate.rawReason ?? gate.reason,
            stopRoe: gate.stopRoe,
            takeProfitRoe: gate.takeProfitRoe,
            trailingActivationRoe: gate.trailingActivationRoe,
            trailingCallbackRoe: gate.trailingCallbackRoe,
            pricePrecision: filters?.pricePrecision,
            quantityPrecision: filters?.qtyPrecision
        });
    }

    private async readEntryAccountSnapshot(walletFallback?: number): Promise<USDTAccountSnapshot> {
        const reader = this.deps.exchange.getUSDTAccountSnapshot;
        if (typeof reader !== 'function') {
            return walletFallback !== undefined ? { walletBalance: walletFallback } : {};
        }

        try {
            const snapshot = await reader.call(this.deps.exchange);
            return {
                walletBalance: this.finiteOrUndefined(snapshot.walletBalance) ?? walletFallback,
                availableBalance: this.finiteOrUndefined(snapshot.availableBalance),
                unrealizedPnlTotal: this.finiteOrUndefined(snapshot.unrealizedPnlTotal),
                equityTotal: this.finiteOrUndefined(snapshot.equityTotal)
            };
        } catch (error) {
            this.deps.logger.warn('aegis_entry_account_snapshot_unavailable', { error: String(error) });
            return walletFallback !== undefined ? { walletBalance: walletFallback } : {};
        }
    }

    private finiteOrUndefined(value: unknown): number | undefined {
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    }

    private calculateRoe(side: Side, entryPrice: number, markPrice: number, leverage: number): number {
        if (entryPrice <= 0 || leverage <= 0) return 0;
        return side === 'SHORT'
            ? (entryPrice - markPrice) / entryPrice * leverage
            : (markPrice - entryPrice) / entryPrice * leverage;
    }

    private entryMargin(botState: BotState): number {
        if (typeof botState.lastEntryMargin === 'number' && Number.isFinite(botState.lastEntryMargin)) {
            return botState.lastEntryMargin;
        }
        if (botState.lastEntryPrice && botState.lastEntryQty && botState.lastLeverage) {
            return (botState.lastEntryPrice * botState.lastEntryQty) / botState.lastLeverage;
        }
        return 0;
    }

    private pnlFromRoe(margin: number, roe: number): number {
        if (!Number.isFinite(margin) || !Number.isFinite(roe)) return 0;
        return margin * roe;
    }

    private formatScore(value?: number): string {
        const score = typeof value === 'number' && Number.isFinite(value) ? value : 0;
        return `${(score * 100).toFixed(1)}%`;
    }

    private formatRoe(value: number): string {
        const roe = Number.isFinite(value) ? value * 100 : 0;
        return `${roe >= 0 ? '+' : ''}${roe.toFixed(2)}% ROE`;
    }

    private formatSignedUsd(value: number): string {
        const safe = Number.isFinite(value) ? value : 0;
        return safe >= 0 ? `+$${safe.toFixed(2)}` : `-$${Math.abs(safe).toFixed(2)}`;
    }

    private formatBracketLine(price: number | undefined, roe: number): string {
        const priceText = typeof price === 'number' && Number.isFinite(price)
            ? `$${price.toFixed(2)}`
            : '$—';
        return `${priceText} (${this.formatRoe(roe)})`;
    }

    private describeAegisExit(
        reason: string,
        pnl: number,
        botState: BotState,
        side: Side,
        exitPrice: number
    ): { emoji: string; title: string; reason: string } {
        const normalized = String(reason || '').toUpperCase();
        if (normalized.includes('TIME_LIMIT')) {
            return { emoji: '⏰', title: 'TIME LIMIT EXIT', reason: 'Cierre por límite de tiempo con posición en ganancia' };
        }
        if (normalized.includes('BREAK') || normalized.includes('BE_')) {
            return { emoji: '🟰', title: 'BREAK EVEN EXIT', reason: 'Cierre por protección de break even' };
        }
        if (normalized.includes('TRAIL') || normalized.includes('CALLBACK')) {
            return { emoji: '🛡️', title: 'TRAILING / CALLBACK EXIT', reason: `Cierre por trailing/callback (${reason})` };
        }
        if (normalized.includes('AI') || normalized.includes('IA') || normalized.includes('GUARDIAN') || normalized.includes('SMART') || normalized.includes('CLOSE')) {
            return { emoji: '🤖', title: 'IA EXIT', reason: `Cierre decidido por IA/guardian (${reason})` };
        }
        if (normalized.includes('BRACKET') || normalized.includes('EMERGENCY') || normalized.includes('FAILED')) {
            return { emoji: '⚠️', title: 'RISK CONTROL EXIT', reason: `Cierre por control de riesgo (${reason})` };
        }

        const entryPrice = botState.lastEntryPrice || 0;
        const leverage = botState.lastLeverage || botState.lastActualLeverage || 20;
        const stopRoe = botState.lastStopRoe ?? -0.15;
        const takeProfitRoe = botState.lastTakeProfitRoe ?? 0.25;
        const stopPrice = entryPrice > 0 ? this.bracketPrice(side, entryPrice, stopRoe, leverage, 'STOP') : undefined;
        const tpPrice = entryPrice > 0 ? this.bracketPrice(side, entryPrice, takeProfitRoe, leverage, 'TP') : undefined;
        const near = (target?: number) =>
            typeof target === 'number' && target > 0 && Math.abs(exitPrice - target) / target < 0.004;

        if (near(botState.lastTrailStop)) {
            return { emoji: '🛡️', title: 'TRAILING STOP EXIT', reason: 'Cierre por trailing stop ejecutado' };
        }
        if (near(tpPrice)) {
            return { emoji: '💰', title: 'TAKE PROFIT (TP)', reason: 'Cierre por take profit' };
        }
        if (near(stopPrice)) {
            return { emoji: '💸', title: 'STOP LOSS (SL)', reason: 'Cierre por stop loss' };
        }
        if (pnl >= 0) {
            return { emoji: '💰', title: 'TAKE PROFIT (TP)', reason: 'Cierre en ganancia; no se pudo distinguir TP/trailing con precisión' };
        }
        return { emoji: '💸', title: 'STOP LOSS (SL)', reason: 'Cierre en pérdida; no se pudo distinguir SL/trailing con precisión' };
    }

    private roundQuantity(quantity: number, filters: SymbolFilters): number {
        const scale = 10 ** filters.qtyPrecision;
        return Number((Math.floor(quantity * scale) / scale).toFixed(filters.qtyPrecision));
    }

    private roundPrice(price: number, filters: SymbolFilters): number {
        const precision = Number.isInteger(filters.pricePrecision) ? filters.pricePrecision : 2;
        return Number(price.toFixed(precision));
    }

    private isBetterStop(side: Side, next: number, previous?: number): boolean {
        if (previous === undefined) return true;
        return side === 'LONG' ? next > previous : next < previous;
    }

    private checkDailyReset(): void {
        const today = Math.floor(Date.now() / 86400000);
        if (today > this.lastTradeDayReset) {
            this.tradesToday = 0;
            this.dailyStartBalance = null;
            this.lastTradeDayReset = today;
        }
    }

    private async notifyError(symbol: string, type: string, error: unknown): Promise<void> {
        const now = Date.now();
        const errorKey = `${symbol}:${type}`;
        if (this.lastErrorTime[errorKey] && now - this.lastErrorTime[errorKey] < 3600000) return;
        this.lastErrorTime[errorKey] = now;
        try {
            await this.deps.notifier.sendMessage(`🚨 **${type}**\nSymbol: ${symbol}\nError: \`${String(error).slice(0, 150)}\``);
        } catch (e) {
            this.deps.logger.error('Failed to notify error', { error: String(e) });
        }
    }

    private shouldLogError(symbol: string, type: string, intervalMs: number): boolean {
        const now = Date.now();
        const logKey = `${symbol}:${type}`;
        if (this.lastLogTime[logKey] && now - this.lastLogTime[logKey] < intervalMs) return false;
        this.lastLogTime[logKey] = now;
        return true;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
