import { Exchange, PositionInfo, SymbolFilters } from '../ports/Exchange';
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

const INITIAL_BALANCE = 20;
const DEFAULT_AEGIS_MAX_HOLD_MS = 8 * 60 * 60 * 1000;

export interface TradingServiceDeps {
    exchange: Exchange;
    mlService: MLService;
    logger: Logger;
    state: StateStore;
    notifier: Notifier;
    configManager: NinjaConfigManager;
}

export interface TradingServiceConfig {
    symbols: string[];
    tickIntervalMs: number;
    maxTradesPerDay: number;
    tradingMode?: string;
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

    constructor(
        private deps: TradingServiceDeps,
        private config: TradingServiceConfig
    ) { }

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
        const entryThreshold = (gateConfig as any).entryThreshold ?? regimeConfig?.entryThreshold ?? 0.55;
        const maxHoldMs = (gateConfig as any).maxHoldMs ?? regimeConfig?.maxHoldMs ?? DEFAULT_AEGIS_MAX_HOLD_MS;
        const trailingActivation = (gateConfig as any).trailingActivationRoe ?? regimeConfig?.trailingActivationRoe ?? 0.15;
        const trailingCallback = (gateConfig as any).trailingCallbackRoe ?? regimeConfig?.trailingCallbackRoe ?? 0.08;
        const circuitBreakerState = this.deps.configManager.system.enable_sentinel ? 'ACTIVE' : 'DISABLED';
        let startupMsg = `🔥 ${isTurbo ? 'AEGIS TURBO MICRO-LIVE LAUNCHED' : 'AEGIS SHADOW MODE'} 🎯\n`;
        startupMsg += `💰 Wallet Actual: ${startupWalletBalance !== null ? `$${startupWalletBalance.toFixed(2)} USDT` : 'N/D'}\n`;
        startupMsg += `⚡ Leverage: ${gateConfig.leverageCap}x (LOCKED)\n`;
        startupMsg += `🧠 Threshold Real: ${Number(entryThreshold).toFixed(2)}\n`;
        startupMsg += `⏱️ Time Limit: ${(Number(maxHoldMs) / 3600000).toFixed(1)} horas\n`;
        startupMsg += `🛡️ Circuit Breaker: ${circuitBreakerState}\n`;
        startupMsg += `🔁 Trailing: ${trailingActivation > 0 ? 'ON' : 'OFF'} (${trailingActivation.toFixed(2)} / ${trailingCallback.toFixed(2)})\n`;

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

        if (signal) {
            startupMsg += `\n🛰️ ESCANEO INICIAL (Radar):\n`;
            const turbo = signal.aegis?.turbo ?? signal.metadata?.aegis?.turbo;
            if (isTurbo && turbo?.raw) {
                startupMsg += `⚡ Turbo Raw: ${turbo.raw.action ?? 'HOLD'} / ${(turbo.raw.turbo_score ?? 0).toFixed(3)}\n`;
                startupMsg += `⚡ Turbo Gated: ${turbo.gated?.action ?? 'HOLD'}\n`;
                startupMsg += `⚡ Votes: L=${turbo.raw.votes?.long ?? 0} S=${turbo.raw.votes?.short ?? 0} N=${turbo.raw.votes?.neutral ?? 0}\n`;
                startupMsg += `⚡ Reason: ${turbo.gated?.reason ?? turbo.raw.reason ?? 'unknown'}\n`;
            } else {
                const trend =
                    (signal.longProb || 0) > (signal.shortProb || 0)
                        ? '📈 ALCISTA'
                        : (signal.shortProb || 0) > (signal.longProb || 0)
                            ? '📉 BAJISTA'
                            : '🧘 NEUTRA';
                startupMsg += `📈 Long: ${((signal.longProb || 0) * 100).toFixed(1)}%\n`;
                startupMsg += `📉 Short: ${((signal.shortProb || 0) * 100).toFixed(1)}%\n`;
                startupMsg += `🧘 Idle: ${((signal.neutralProb || 0) * 100).toFixed(1)}%\n`;
                startupMsg += `🚪 Close: ${((signal.closeProb || 0) * 100).toFixed(1)}%\n`;
                startupMsg += `🧭 Tendencia: ${trend}\n`;
            }
        }

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

            startupMsg += `📊 Balance Aprox.: ${approximateBalance !== null ? `~$${approximateBalance.toFixed(2)} USDT` : 'N/D'}\n`;
            startupMsg += `\n💼 POSICIÓN ACTIVA: ${side}\n`;
            startupMsg += `📦 Tamaño: ${qtyAbs.toFixed(3)} ETH\n`;
            startupMsg += `💸 Margen: $${marginUsed.toFixed(2)} USDT\n`;
            startupMsg += `💰 ROI: ${(roi * 100).toFixed(2)}% | PnL: ${this.formatSignedUsd(pnl)}\n`;
            startupMsg += `⏱️ Duración: ${(durationMs / 3600000).toFixed(1)} horas\n`;
            startupMsg += `🎯 BRACKETS (Binance):\n`;
            startupMsg += `• TP 🎯: ${this.formatBracketLine(tpOrder?.stopPrice, takeProfitRoe)}\n`;
            startupMsg += `• SL 🛑: ${this.formatBracketLine(slOrder?.stopPrice, stopRoe)}\n`;
        } else {
            startupMsg += `📊 Balance Aprox.: ${startupWalletBalance !== null ? `~$${startupWalletBalance.toFixed(2)} USDT` : 'N/D'}\n`;
            startupMsg += `\n💼 POSICIÓN ACTIVA: FLAT\n`;
        }

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
            this.logAegisScan(symbol, signal);

            if (tradingMode === 'AEGIS_SHADOW') return;
            if (tradingMode !== 'AEGIS_TURBO_MICRO_LIVE') {
                logger.warn('aegis_unknown_trading_mode', { symbol, tradingMode });
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
                return;
            }

            if (this.getAegisTurboYamlConfig()?.live_enabled !== true) {
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

            await this.openAegisTurboPosition(symbol, signal, gateDecision);
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
        gate: AegisMicroLiveGateDecision
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
                await this.emergencyCloseUnverifiedAegisPosition(symbol, side, quantity, 'AEGIS_POSITION_VERIFY_FAILED');
                throw new Error('AEGIS_POSITION_VERIFY_FAILED_AFTER_MARKET_OPEN');
            }

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
                if (closeIfBracketFails) {
                    await exchange.closeSideMarketSafe(symbol, side, positionData.qtyAbs, positionData.sideMode, 'AEGIS_BRACKET_FAILED');
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
                if (closeIfBracketFails) {
                    await exchange.closeSideMarketSafe(symbol, side, positionData.qtyAbs, positionData.sideMode, 'AEGIS_BRACKET_FAILED');
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

            state.set({
                mode: side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE',
                lastSide: side,
                lastEntryPrice: entryPrice,
                lastLeverage: leverage,
                lastEntryAt: await exchange.getServerTime(),
                peakRoe: 0,
                lowestRoe: 0,
                currentRegime: 'AEGIS_TURBO',
                lastStrategy: 'AEGIS_TURBO',
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
                    leverage,
                    stopPrice,
                    tpPrice,
                    signal,
                    gate
                })
            );
            logger.info('📱 [TELEGRAM_REPORT] AEGIS ENTRY SENT', {
                message: `🔥 **AEGIS TURBO ENTRY**\n${symbol} | ${side}\n...score: ${this.formatScore(gate.turboScore)}`
            });
        } catch (error) {
            logger.error('aegis_entry_error_closed', { symbol, error: String(error) });
            if (opened && openedSide) {
                try {
                    const position = await exchange.readActivePosition(symbol, openedSide);
                    if (position) {
                        await exchange.closeSideMarketSafe(symbol, openedSide, position.qtyAbs, position.sideMode, 'AEGIS_ENTRY_ERROR_CLOSED');
                        state.set({ mode: 'IDLE', lastExitAt: Date.now(), lastExitReason: 'AEGIS_ENTRY_ERROR_CLOSED' });
                        await notifier.sendMessage(
                            `⚠️ **AEGIS ENTRY FAILED**\n` +
                            `Symbol: ${symbol}\n` +
                            `Error: ${String(error).slice(0, 180)}`
                        );
                    }
                } catch (closeError) {
                    logger.error('aegis_entry_error_close_failed', { symbol, error: String(closeError) });
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
        reason: string
    ): Promise<void> {
        const { exchange, logger, notifier } = this.deps;
        logger.error('aegis_emergency_close_attempt', { symbol, side, quantity, reason });
        try {
            const position = await exchange.readActivePosition(symbol, side);
            const qtyAbs = position?.qtyAbs ?? quantity;
            const sideMode = position?.sideMode ?? 'BOTH';
            await exchange.closeSideMarketSafe(symbol, side, qtyAbs, sideMode, reason);
            logger.error('aegis_emergency_close_success', { symbol, side, qtyAbs, sideMode, reason });
            await notifier.sendMessage(
                `⚠️ **AEGIS EMERGENCY CLOSE**\n` +
                `Symbol: ${symbol}\n` +
                `Side: ${side}\n` +
                `Reason: ${reason}\n` +
                `Qty: ${qtyAbs}`
            );
        } catch (error) {
            logger.error('aegis_emergency_close_failed', { symbol, side, quantity, reason, error: String(error) });
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
        leverage: number;
        stopPrice: number;
        tpPrice: number;
        signal: AegisTradingSignal;
        gate: AegisMicroLiveGateDecision;
    }): string {
        const { symbol, side, entryPrice, quantity, marginUsed, wallet, leverage, stopPrice, tpPrice, signal, gate } = input;
        const sideLabel = side === 'LONG' ? '📈 LONG' : '📉 SHORT';
        const threshold = this.getAegisTurboGateConfig(symbol).minScore;
        const trailingOn = gate.trailingActivationRoe > 0 && gate.trailingCallbackRoe > 0;
        return `🔥 **AEGIS TURBO ENTRY**\n` +
            `${symbol} | ${sideLabel}\n` +
            `Precio: $${entryPrice.toFixed(2)}\n` +
            `📦 Tamaño: **${quantity.toFixed(3)} ETH**\n` +
            `💸 Margen: **$${marginUsed.toFixed(2)} USDT**\n` +
            `⚡ Leverage: **${leverage}x**\n\n` +
            `**RIESGO / BRACKETS:**\n` +
            `🛑 SL: **$${stopPrice.toFixed(2)}** (${this.formatRoe(gate.stopRoe)})\n` +
            `🎯 TP: **$${tpPrice.toFixed(2)}** (${this.formatRoe(gate.takeProfitRoe)})\n` +
            `🔁 Trailing: ${trailingOn ? 'ON' : 'OFF'} (${this.formatRoe(gate.trailingActivationRoe)} / ${this.formatRoe(gate.trailingCallbackRoe)} callback)\n\n` +
            `**PROBABILIDADES IA:**\n` +
            `🟢 Long:  ${this.formatScore(signal.longProb)}\n` +
            `🔴 Short: ${this.formatScore(signal.shortProb)}\n` +
            `🧘 Idle:  ${this.formatScore(signal.neutralProb)}\n` +
            `🚪 Close: ${this.formatScore(signal.closeProb || 0)}\n\n` +
            `**TURBO:**\n` +
            `⚡ Score: **${this.formatScore(gate.turboScore)}**\n` +
            `🗳️ Votes: L=${gate.votes?.long ?? 0} S=${gate.votes?.short ?? 0} N=${gate.votes?.neutral ?? 0}\n` +
            `🧠 Reason: ${gate.gatedReason ?? gate.rawReason ?? 'aegis_turbo'}\n` +
            `💰 Wallet: $${wallet.toFixed(2)}\n` +
            `⚙️ Threshold: ${threshold.toFixed(2)}`;
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
