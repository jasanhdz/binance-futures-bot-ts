/**
 * TradingService.ts - Intelligent Kamikaze V33.5
 *
 * Objetivo: $20 → $500 (25x) en mínimo tiempo posible
 * Filosofía: Agresividad matemática pura, cero paranoia defensiva
 */
import { Exchange } from '../ports/Exchange';
import { MLService } from '../ports/MLService';
import { Logger } from '../ports/Logger';
import { StateStore } from '../ports/StateStore';
import { Notifier } from '../ports/Notifier';
import { BotState, Side, ShadowPosition } from '../../domain/types';
import {
    PhantomConfig,
    PhantomSignal,
    shouldEnter
} from '../../domain/services/PhantomStrategy';
import {
    evaluateGuardianAction
} from '../../domain/services/ProfitGuardian';
import { NinjaConfigManager } from '../../infra/config/ConfigLoader';
import { LiquidityVoidDetector } from './LiquidityVoidDetector';

// 🎯 CONSTANTES KAMIKAZE
const TARGET_BALANCE = 500;
const INITIAL_BALANCE = 20;
const KAMIKAZE_LEVERAGE = 20;
const MIN_ENTRY_THRESHOLD = 0.55;
const MAX_ENTRY_THRESHOLD = 0.65;
const RESURRECTION_THRESHOLD_BALANCE = 15;

export interface KamikazeConfig {
    threshold: number;
    leverage: number;
    capitalUsage: number;
    tpRoe?: number;
}

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
    phantomConfig?: any;
    guardianConfig?: any;
    tickIntervalMs: number;
    maxTradesPerDay: number;
}

export class TradingService {
    private isRunning = false;
    private tradesToday = 0;
    private lastTradeDayReset = 0;
    private lastErrorTime: Record<string, number> = {};
    private lastLogTime: Record<string, number> = {};
    private lastAlivePulseMs: number = Date.now();
    private hardWatchdogTimer: NodeJS.Timeout | null = null;

    // 🧠 KAMIKAZE STATE
    private consecutiveLosses = 0;
    private lastEntryBalance = INITIAL_BALANCE;
    private resurrectionMultiplier = 1.0;
    private peakBalance = INITIAL_BALANCE;
    private detector: Record<string, LiquidityVoidDetector> = {};

    constructor(
        private deps: TradingServiceDeps,
        private config: TradingServiceConfig
    ) { }

    private getKamikazeConfig(currentBalance: number): KamikazeConfig {
        const progress = Math.max(0, (currentBalance - INITIAL_BALANCE) / (TARGET_BALANCE - INITIAL_BALANCE));
        const aggressionLevel = 1 - progress;
        const baseThreshold = MIN_ENTRY_THRESHOLD + (aggressionLevel * (MAX_ENTRY_THRESHOLD - MIN_ENTRY_THRESHOLD));

        if (currentBalance < RESURRECTION_THRESHOLD_BALANCE && this.consecutiveLosses >= 2) {
            this.resurrectionMultiplier = 0.85;
            return {
                threshold: 0.55,
                leverage: 10,
                capitalUsage: 1.0,
                tpRoe: 0.35
            };
        }

        this.resurrectionMultiplier = 1.0;
        const capitalUsage = progress > 0.8 ? 0.7 : 1.0;
        return {
            threshold: baseThreshold,
            leverage: KAMIKAZE_LEVERAGE,
            capitalUsage: capitalUsage
        };
    }

    async start(startLoop = true): Promise<void> {
        const { logger, notifier } = this.deps;
        logger.info('🔥 KAMIKAZE PHANTOM V33.5 ACTIVATED', {
            target: TARGET_BALANCE,
            initial: INITIAL_BALANCE,
            leverage: KAMIKAZE_LEVERAGE,
            mode: 'INTELLIGENT_AGGRESSION'
        });

        let startupMsg = `🔥 **KAMIKAZE V33.5 LAUNCHED**\n\n`;
        startupMsg += `🎯 Target: $${INITIAL_BALANCE} → $${TARGET_BALANCE}\n`;
        startupMsg += `⚡ Leverage: ${KAMIKAZE_LEVERAGE}x (LOCKED)\n`;
        startupMsg += `🧠 Threshold: ${MIN_ENTRY_THRESHOLD}-${MAX_ENTRY_THRESHOLD} (Adaptive)\n`;
        startupMsg += `🛡️ Circuit Breaker: DISABLED\n`;
        startupMsg += `🛑 Sentinel: ELIMINATED\n\n`;
        startupMsg += `⚠️ *Pure CVD Tensor Navigation*`;

        for (const symbol of this.config.symbols) {
            this.deps.exchange.subscribeToCandles(symbol);
            this.detector[symbol] = new LiquidityVoidDetector(this.deps.logger);

            if (this.deps.exchange.subscribeToPartialDepth) {
                this.deps.exchange.subscribeToPartialDepth(symbol, 50, '100ms', (depth: any) => {
                    if (depth && depth.bids && depth.asks) {
                        const mapper = (arr: any[]) => arr.map(row => {
                            if (Array.isArray(row)) {
                                return { price: Number(row[0]), qty: Number(row[1]) };
                            }
                            return { price: Number(row.price), qty: Number(row.quantity) };
                        });
                        this.detector[symbol].processDepthUpdate({
                            bidDepth: mapper(depth.bids),
                            askDepth: mapper(depth.asks)
                        });
                    }
                });
            }
        }

        await notifier.sendMessage(startupMsg);
        this.isRunning = true;

        this.hardWatchdogTimer = setInterval(() => {
            if (this.isRunning && (Date.now() - this.lastAlivePulseMs > 180000)) {
                this.deps.logger.error('💀 SYSTEM DEADLOCK DETECTED: No pulse in 3 minutes. Committing suicide to trigger PM2 restart.');
                process.exit(1);
            }
        }, 10000);

        if (startLoop) {
            await this.runLoop();
        }
    }

    stop(): void {
        this.isRunning = false;
        this.deps.logger.info('Kamikaze bot stopped');
        if (this.hardWatchdogTimer) {
            clearInterval(this.hardWatchdogTimer);
        }
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

    async tick(symbol: string): Promise<void> {
        await this.processSymbol(symbol);
    }

    private async processSymbol(symbol: string): Promise<void> {
        this.lastAlivePulseMs = Date.now();
        const { exchange, state, configManager } = this.deps;
        const botState = state.get();

        try {
            const hasPosition = botState.mode !== 'IDLE';
            const shadowPos = state.get().shadowPos;

            if (shadowPos && shadowPos.active) {
                await this.manageShadowPosition(symbol);
            }

            if (hasPosition) {
                await this.managePosition(symbol, botState);
                const newState = state.get();
                if (newState.mode === 'IDLE') {
                    await this.lookForEntry(symbol);
                }
            } else {
                await this.lookForEntry(symbol);
            }
        } catch (error) {
            this.deps.logger.warn('Process error', { symbol, error: String(error) });
        }
    }

    private checkForbiddenTime(timestamp: number, config: any): boolean {
        if (!config.forbiddenHours && !config.forbiddenDays) return false;
        const date = new Date(timestamp);
        const hour = date.getUTCHours();
        const day = date.getUTCDay();
        if (config.forbiddenDays && config.forbiddenDays.includes(day)) return true;
        if (config.forbiddenHours && config.forbiddenHours.includes(hour)) return true;
        return false;
    }

    private async lookForEntry(symbol: string): Promise<void> {
        const { mlService, exchange, logger, state, notifier, configManager } = this.deps;
        try {
            const balance = await exchange.getUSDTBalance();
            const regimeConfig = configManager.getRegimeConfig('PHANTOM', symbol);

            const kamikazeConfig = this.getKamikazeConfig(balance);
            const kamikazeThreshold = kamikazeConfig.threshold;
            const leverage = kamikazeConfig.leverage;

            if (this.tradesToday >= this.config.maxTradesPerDay) {
                return;
            }

            const now = await exchange.getServerTime();
            if (this.checkForbiddenTime(now, regimeConfig)) return;

            if (balance > this.peakBalance) {
                this.peakBalance = balance;
            }

            const signal = await mlService.getSignal(symbol) as PhantomSignal;
            const currentCandle = await exchange.getLastCandle(symbol);

            const triggerCtx = (signal.features && currentCandle) ? {
                currentCandle,
                cvdSlope: signal.features.cvd_slope ?? 0,
                cvdZ: signal.features.cvd_z ?? 0,
                weaknessScore: signal.features.weakness ?? 0
            } : undefined;

            const phantomConfig: PhantomConfig = {
                leverage,
                entryThreshold: kamikazeThreshold,
                hardStopRoe: regimeConfig.hardStopRoe,
                tpRoe: kamikazeConfig.tpRoe ?? regimeConfig.tpRoe
            };

            if (signal.confidence && signal.confidence > 0.30) {
                logger.info('kamikaze_scan', {
                    symbol,
                    price: currentCandle?.close,
                    balance,
                    targetProgress: `${((balance / TARGET_BALANCE) * 100).toFixed(1)}%`,
                    threshold: kamikazeThreshold.toFixed(2),
                    signalConf: signal.confidence.toFixed(2),
                    cvdZ: signal.features?.cvd_z?.toFixed(2),
                    cvdSlope: signal.features?.cvd_slope?.toFixed(3),
                    action: signal.action
                });
            }

            const shadowPos = state.get().shadowPos;
            if (!shadowPos && signal.confidence && signal.confidence >= 0.55) {
                // Abre fantasma automáticamente, sin importar si el Real Bot entra o no.
                await this.openShadowTrade(symbol, signal, currentCandle, kamikazeConfig, regimeConfig, balance);
            }

            if (!shouldEnter(signal, phantomConfig, triggerCtx)) {
                return;
            }

            const stress = this.detector[symbol]?.getLiquidityStress() || 0;
            if (stress > 0.7) {
                logger.warn('🚫 KAMIKAZE VETO: Liquidity Stress detected', { symbol, stress: stress.toFixed(2), action: signal.action });
                return;
            }

            // --- DOUBLE CONFIRMATION / IA VETO ONLY FOR REAL BOT ---
            try {
                const currentPrice = currentCandle?.close || (await exchange.getMarkPrice(symbol));
                const exitVeto = await mlService.getExitSignal({
                    symbol,
                    entry_price: currentPrice,
                    current_pnl: 0,
                    mfe: 0,
                    mae: 0,
                    duration_minutes: 0,
                    leverage: 20
                });

                if (exitVeto.action === 'CLOSE') {
                    logger.warn('🚫 AI EXIT VETO: Rejected Real Entry due to Exit IA forecasting immediate close.', {
                        symbol,
                        action: signal.action,
                        confidence: (exitVeto.confidence ?? 0).toFixed(2)
                    });
                    return;
                }
            } catch (e) {
                logger.warn('AI Exit Veto check failed', { error: String(e) });
            }

            logger.info('🔥 KAMIKAZE ENTRY TRIGGERED', {
                symbol,
                side: signal.action,
                confidence: (signal.confidence ?? 0).toFixed(2),
                threshold: kamikazeThreshold.toFixed(2),
                balance: balance.toFixed(2),
                progress: `${((balance / TARGET_BALANCE) * 100).toFixed(1)}%`
            });

            try {
                const wallet = await exchange.getUSDTBalance();
                const filters = await exchange.getSymbolFilters(symbol, leverage);
                const capitalUsage = kamikazeConfig.capitalUsage;
                const feeBufferPct = (this.deps.configManager as any).trading?.fee_buffer_pct || 0.05;
                const effectiveWallet = wallet * (1 - feeBufferPct);
                const markPrice = await exchange.getMarkPrice(symbol);
                const notional = effectiveWallet * capitalUsage * leverage;
                const quantity = Math.floor((notional / markPrice) * Math.pow(10, filters.qtyPrecision)) / Math.pow(10, filters.qtyPrecision);

                if (quantity * markPrice < filters.minNotional) {
                    logger.warn('Position too small', { quantity, minNotional: filters.minNotional });
                    return;
                }

                await exchange.setLeverage(symbol, leverage);
                await exchange.ensureMarginType(symbol, 'ISOLATED');

                const side = signal.action === 'SHORT' ? 'SHORT' : 'LONG';
                const result = await exchange.marketOpen(symbol, side, quantity);

                state.set({
                    mode: side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE',
                    lastSide: side,
                    lastEntryPrice: result.avgPrice,
                    lastLeverage: leverage,
                    lastEntryAt: await exchange.getServerTime(),
                    peakRoe: 0,
                    currentRegime: 'PHANTOM',
                    lastPeakPrice: result.avgPrice,
                    lastEntryWallet: wallet,
                    lastEntryQty: quantity,
                    lastMlProb: signal.confidence
                });

                const tickSize = filters.tickSize;
                const tickDecimals = Math.max(0, Math.round(-Math.log10(tickSize)));
                const roundToTick = (price: number) => {
                    const rounded = Math.floor(price / tickSize) * tickSize;
                    return parseFloat(rounded.toFixed(tickDecimals));
                };

                const hardStopPricePct = Math.abs(regimeConfig.hardStopRoe) / leverage;
                const tpPricePct = Math.abs(regimeConfig.tpRoe) / leverage;

                const stopPrice = side === 'SHORT'
                    ? roundToTick(result.avgPrice * (1 + hardStopPricePct))
                    : roundToTick(result.avgPrice * (1 - hardStopPricePct));
                const tpPrice = side === 'SHORT'
                    ? roundToTick(result.avgPrice * (1 - tpPricePct))
                    : roundToTick(result.avgPrice * (1 + tpPricePct));

                try {
                    await exchange.placeStopClose(symbol, side, stopPrice, quantity);
                    await exchange.placeTpClose(symbol, side, tpPrice, quantity);
                    logger.info('Brackets placed', { stopPrice, tpPrice, tickSize, tickDecimals });
                } catch (bracketError) {
                    logger.error('Bracket failed', { error: String(bracketError), stopPrice, tpPrice });
                }

                this.tradesToday++;
                this.lastEntryBalance = wallet;

                await notifier.sendMessage(`🔥 **KAMIKAZE ENTRY**\n` +
                    `${symbol} | ${side}\n` +
                    `Entry: $${result.avgPrice.toFixed(2)}\n` +
                    `Size: ${quantity} ETH ($${(quantity * result.avgPrice).toFixed(0)})\n` +
                    `Balance: $${wallet.toFixed(2)} (${((wallet / TARGET_BALANCE) * 100).toFixed(1)}% to target)\n` +
                    `Leverage: ${leverage}x\n` +
                    `Conf: ${((signal.confidence ?? 0) * 100).toFixed(0)}% (thresh: ${(kamikazeThreshold * 100).toFixed(0)}%)\n` +
                    `CVD-Z: ${signal.features?.cvd_z?.toFixed(1)}`);
            } catch (entryError) {
                logger.error('Entry failed', { error: String(entryError) });
                this.consecutiveLosses++;
                await this.notifyError(symbol, 'ENTRY FAILED', entryError);
            }
        } catch (error) {
            logger.error('LookForEntry error', { error: String(error) });
            await this.notifyError(symbol, 'LOOKFOR ENTRY', error);
        }
    }

    private async managePosition(symbol: string, botState: BotState): Promise<void> {
        const { exchange, logger, state, notifier, configManager, mlService } = this.deps;
        const guardianConfig = configManager.getGuardianConfig('PHANTOM', symbol);
        const side = botState.lastSide as Side;
        const entryPrice = botState.lastEntryPrice || 0;

        try {
            const position = await exchange.readActivePosition(symbol, side);

            if (!position) {
                const balance = await exchange.getUSDTBalance();
                const pnl = balance - (botState.lastEntryWallet || balance);

                if (pnl < 0) {
                    this.consecutiveLosses++;
                } else {
                    this.consecutiveLosses = 0;
                }

                logger.info('Position closed', {
                    symbol,
                    pnl: pnl.toFixed(2),
                    balance: balance.toFixed(2),
                    consecutiveLosses: this.consecutiveLosses
                });

                if (this.consecutiveLosses >= 3) {
                    logger.error('🚨 EMERGENCY STOP: 3 consecutive losses', {
                        consecutiveLosses: this.consecutiveLosses,
                        balance: balance.toFixed(2)
                    });
                    await notifier.sendMessage(`🚨🚨🚨 **EMERGENCY STOP** 🚨🚨🚨\n` +
                        `3 pérdidas consecutivas detectadas\n` +
                        `Balance: $${balance.toFixed(2)}\n` +
                        `Pérdidas seguidas: ${this.consecutiveLosses}\n` +
                        `Bot DETENIDO para proteger capital\n` +
                        `Revisa los logs y reinicia manualmente`);
                    this.isRunning = false;
                    state.set({ mode: 'IDLE' });
                    return;
                }

                const closeType = pnl >= 0 ? '🎯 TAKE PROFIT (TP)' : '🛑 STOP LOSS (SL)';
                await notifier.sendMessage(`${pnl >= 0 ? '💰' : '💸'} **${closeType}**\n` +
                    `${symbol} | PnL: $${pnl.toFixed(2)}\n` +
                    `Balance: $${balance.toFixed(2)} (${((balance / TARGET_BALANCE) * 100).toFixed(1)}% to target)`);
                state.set({ mode: 'IDLE', lastExitAt: Date.now() });
                return;
            }

            const markPrice = await exchange.getMarkPrice(symbol);
            const candle = await exchange.getLastCandle(symbol);
            let peakPrice = botState.lastPeakPrice || entryPrice;

            if (candle) {
                peakPrice = side === 'SHORT'
                    ? Math.min(peakPrice, candle.low)
                    : Math.max(peakPrice, candle.high);
            }
            if (peakPrice !== botState.lastPeakPrice) {
                state.set({ lastPeakPrice: peakPrice });
            }

            const currentRoe = side === 'SHORT'
                ? (entryPrice - markPrice) / entryPrice * (botState.lastLeverage || 20)
                : (markPrice - entryPrice) / entryPrice * (botState.lastLeverage || 20);

            // Track peak/lowest ROE for trailing safety net
            const updatedPeakRoe = Math.max(botState.peakRoe || 0, currentRoe);
            const updatedLowestRoe = Math.min(botState.lowestRoe || 0, currentRoe);
            if (updatedPeakRoe !== botState.peakRoe || updatedLowestRoe !== botState.lowestRoe) {
                state.set({ peakRoe: updatedPeakRoe, lowestRoe: updatedLowestRoe });
            }

            // ⏰ Max Trade Duration Check (only close if in PROFIT)
            const regimeConfig = configManager.getRegimeConfig('PHANTOM', symbol);
            const maxDurationMs = regimeConfig.maxHoldMs || 28800000; // default 8h
            const tradeDuration = botState.lastEntryAt ? (Date.now() - botState.lastEntryAt) : 0;
            if (tradeDuration > maxDurationMs) {
                if (currentRoe > 0) {
                    // In profit → close and lock in gains
                    logger.warn('⏰ MAX DURATION reached (in profit → closing)', {
                        symbol,
                        durationH: (tradeDuration / 3600000).toFixed(1),
                        maxH: (maxDurationMs / 3600000).toFixed(1),
                        currentRoe: (currentRoe * 100).toFixed(2) + '%'
                    });
                    await exchange.closeSideMarketSafe(symbol, side, position.qtyAbs, position.sideMode, 'TIME_LIMIT');
                    const exitBalance = await exchange.getUSDTBalance();
                    const pnlUsd = exitBalance - (botState.lastEntryWallet || exitBalance);
                    await notifier.sendMessage(
                        `⏰ **TIME LIMIT EXIT** ✅\n` +
                        `${symbol} | ${side}\n` +
                        `Duración: ${(tradeDuration / 3600000).toFixed(1)}h (max: ${(maxDurationMs / 3600000).toFixed(1)}h)\n` +
                        `ROE: ${(currentRoe * 100).toFixed(2)}%\n` +
                        `PnL: $${pnlUsd.toFixed(2)}\n` +
                        `Balance: $${exitBalance.toFixed(2)}`
                    );
                    state.set({ mode: 'IDLE', lastExitAt: Date.now(), lastExitReason: 'TIME_LIMIT' });
                    return;
                } else {
                    // In loss → DO NOT close, let SL/AI/manual handle it
                    logger.info('⏰ MAX DURATION passed but in LOSS → holding (SL/AI will decide)', {
                        symbol,
                        durationH: (tradeDuration / 3600000).toFixed(1),
                        currentRoe: (currentRoe * 100).toFixed(2) + '%'
                    });
                }
            }

            const now = Date.now();
            if (now - (botState.lastCheckAt || 0) > 60000) {
                state.set({ lastCheckAt: now });
                // El Real Bot ya no consulta a la IA de Salida para cerrar la operación.
                // Se confía explícitamente en el ProfitGuardian (Trailing) y los Brackets duros.
            }

            const action = evaluateGuardianAction({
                entryPrice,
                currentPrice: markPrice,
                peakPrice,
                positionSide: side,
                leverage: botState.lastLeverage || 20,
                peakRoe: updatedPeakRoe
            }, guardianConfig, undefined);

            switch (action.type) {
                case 'MOVE_SL_TRAILING':
                    await exchange.placeStopClose(symbol, side, action.price!);
                    break;
                case 'CLOSE_MARKET': {
                    await exchange.closeSideMarketSafe(symbol, side, position.qtyAbs, position.sideMode, action.reason!);

                    const exitBalance = await exchange.getUSDTBalance();
                    const pnlUsd = exitBalance - (botState.lastEntryWallet || exitBalance);
                    const roePct = (currentRoe * 100).toFixed(2);

                    let emoji = pnlUsd > 0 ? '✅' : '❌';
                    if (action.reason === 'TRAILING_SAFETY_NET') emoji = '🛡️';

                    await notifier.sendMessage(`${emoji} **CIERRE DE GUARDIAN (${action.reason})**\n` +
                        `${symbol} | ${side}\n` +
                        `Entry: $${entryPrice.toFixed(2)} → Exit: $${markPrice.toFixed(2)}\n` +
                        `ROE: ${roePct}%\n` +
                        `PnL: $${pnlUsd.toFixed(2)}\n` +
                        `MFE Pico: ${(updatedPeakRoe * 100).toFixed(2)}%\n` +
                        `Balance: $${exitBalance.toFixed(2)}`);

                    logger.info(`Guardian closed position: ${action.reason}`, {
                        symbol,
                        pnl: pnlUsd.toFixed(2),
                        reason: action.reason
                    });

                    state.set({ mode: 'IDLE', lastExitAt: Date.now(), lastExitReason: action.reason });
                    break;
                }
            }
        } catch (error) {
            logger.warn('Management error', { symbol, error: String(error) });
        }
    }

    private checkDailyReset(): void {
        const now = Date.now();
        const today = Math.floor(now / 86400000);
        if (today > this.lastTradeDayReset) {
            this.tradesToday = 0;
            this.lastTradeDayReset = today;
        }
    }

    private async notifyError(symbol: string, type: string, error: unknown): Promise<void> {
        const now = Date.now();
        const errorKey = `${symbol}:${type}`;
        if (this.lastErrorTime[errorKey] && now - this.lastErrorTime[errorKey] < 3600000) {
            return;
        }
        this.lastErrorTime[errorKey] = now;
        const msg = String(error).substring(0, 150);
        try {
            await this.deps.notifier.sendMessage(`🚨 **${type}**\nSymbol: ${symbol}\nError: \`${msg}\``);
        } catch (e) {
            this.deps.logger.error('Failed to notify error', { error: String(e) });
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private async manageShadowPosition(symbol: string): Promise<void> {
        const shadowPos = this.deps.state.get().shadowPos;
        if (!shadowPos || !shadowPos.active) return;

        const { exchange, logger, configManager } = this.deps;
        const pos = { ...shadowPos };
        const markPrice = await exchange.getMarkPrice(symbol);
        const candle = await exchange.getLastCandle(symbol);

        if (candle) {
            pos.peakPrice = pos.side === 'SHORT'
                ? Math.min(pos.peakPrice, candle.low!)
                : Math.max(pos.peakPrice, candle.high!);
            pos.lowestPrice = pos.side === 'SHORT'
                ? Math.max(pos.lowestPrice, candle.high!)
                : Math.min(pos.lowestPrice, candle.low!);
        }

        const currentRoe = pos.side === 'SHORT'
            ? (pos.entryPrice - markPrice) / pos.entryPrice * pos.leverage
            : (markPrice - pos.entryPrice) / pos.entryPrice * pos.leverage;

        // Track peak ROE for trailing (mirror real bot)
        pos.peakRoe = Math.max(pos.peakRoe || 0, currentRoe);
        this.deps.state.set({ shadowPos: pos });

        // 1. Hard Stop Loss
        if ((pos.side === 'LONG' && markPrice <= pos.hardStopPrice) ||
            (pos.side === 'SHORT' && markPrice >= pos.hardStopPrice)) {
            await this.closeShadowPosition(markPrice, '🛑 SL Hit');
            return;
        }

        // 2. Take Profit
        if ((pos.side === 'LONG' && markPrice >= pos.tpPrice) ||
            (pos.side === 'SHORT' && markPrice <= pos.tpPrice)) {
            await this.closeShadowPosition(markPrice, '🎯 TP Hit');
            return;
        }

        // Shadow Trade is strictly controlled by TP, SL, and the new AI Exit Agent V2
        // 5. AI Exit Signal (every 60s)
        const now = Date.now();
        if (now - pos.entryAt > 60000) {
            const durationMinutes = (now - pos.entryAt) / 60000;
            const peakRoe = pos.side === 'LONG'
                ? (pos.peakPrice - pos.entryPrice) / pos.entryPrice * pos.leverage
                : (pos.entryPrice - pos.peakPrice) / pos.entryPrice * pos.leverage;
            const lowestRoe = pos.side === 'LONG'
                ? (pos.lowestPrice - pos.entryPrice) / pos.entryPrice * pos.leverage
                : (pos.entryPrice - pos.lowestPrice) / pos.entryPrice * pos.leverage;

            try {
                const exitSignal = await this.deps.mlService.getExitSignal({
                    symbol,
                    entry_price: pos.entryPrice,
                    current_pnl: currentRoe,
                    mfe: peakRoe,
                    mae: lowestRoe,
                    duration_minutes: durationMinutes,
                    leverage: pos.leverage
                });

                if (exitSignal.action === 'CLOSE' && exitSignal.confidence && exitSignal.confidence > 0.6) {
                    await this.closeShadowPosition(markPrice, '🤖 AI EXIT');
                }
            } catch (e) {
                // Ignore errors for shadow AI exit
            }
        }
    }

    private async closeShadowPosition(exitPrice: number, reason: string): Promise<void> {
        const shadowPos = this.deps.state.get().shadowPos;
        if (!shadowPos) return;

        const pnlUsd = shadowPos.side === 'LONG'
            ? (exitPrice - shadowPos.entryPrice) * shadowPos.quantity
            : (shadowPos.entryPrice - exitPrice) * shadowPos.quantity;

        await this.deps.notifier.sendMessage(
            `👻 **SHADOW TRADE CLOSED** (${reason})\n` +
            `${shadowPos.symbol} | ${shadowPos.side}\n` +
            `Entry: $${shadowPos.entryPrice.toFixed(2)} → Exit: $${exitPrice.toFixed(2)}\n` +
            `Fake PnL: $${pnlUsd.toFixed(2)}\n` +
            `Initial Conf: ${(shadowPos.confidence * 100).toFixed(0)}%`
        );
        this.deps.state.set({ shadowPos: null });
    }

    private async openShadowTrade(symbol: string, signal: PhantomSignal, candle: any, kamikazeConfig: KamikazeConfig, regimeConfig: any, balance: number): Promise<void> {
        if (!candle) return;
        const entryPrice = candle.close;
        const side = signal.action === 'SHORT' ? 'SHORT' : 'LONG';
        const hardStopPricePct = Math.abs(regimeConfig.hardStopRoe) / kamikazeConfig.leverage;
        const tpPricePct = Math.abs(kamikazeConfig.tpRoe ?? regimeConfig.tpRoe) / kamikazeConfig.leverage;

        const stopPrice = side === 'SHORT'
            ? entryPrice * (1 + hardStopPricePct)
            : entryPrice * (1 - hardStopPricePct);
        const tpPrice = side === 'SHORT'
            ? entryPrice * (1 - tpPricePct)
            : entryPrice * (1 + tpPricePct);

        const notional = balance * kamikazeConfig.capitalUsage * kamikazeConfig.leverage;
        const quantity = Math.floor(notional / entryPrice * 1000) / 1000;
        const conf = signal.confidence ?? 0;

        const newShadowPos: ShadowPosition = {
            active: true,
            symbol,
            side: side as Side,
            entryPrice,
            initialBalance: balance,
            confidence: conf,
            quantity,
            leverage: kamikazeConfig.leverage,
            hardStopPrice: stopPrice,
            tpPrice: tpPrice,
            entryAt: Date.now(),
            peakPrice: entryPrice,
            lowestPrice: entryPrice,
            peakRoe: 0
        };

        this.deps.state.set({ shadowPos: newShadowPos });

        await this.deps.notifier.sendMessage(
            `👻 **SHADOW ENTRY OBSCURED**\n` +
            `${symbol} | ${side}\n` +
            `Fake Entry: $${entryPrice.toFixed(2)}\n` +
            `Fake Size: ${quantity.toFixed(4)} ETH ($${(quantity * entryPrice).toFixed(0)})\n` +
            `Conf: ${(conf * 100).toFixed(0)}% (below ${Math.round(kamikazeConfig.threshold * 100)}% real limit)\n` +
            `Tracking stealthily...`
        );
    }
}
