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
import { calculateATR } from '../../domain/services/TechnicalIndicators';
import {
    AegisMicroLiveGateDecision,
    buildAegisMicroLiveGateConfigFromEnv,
    shouldEnterAegisTurboMicroLive
} from '../../domain/services/AegisMicroLiveGate';
import { NinjaConfigManager } from '../../infra/config/ConfigLoader';
import { LiquidityVoidDetector } from './LiquidityVoidDetector';
import { CONFIG } from '../../infra/config/environment';

// 🎯 CONSTANTES KAMIKAZE
const TARGET_BALANCE = 500;
const INITIAL_BALANCE = 20;
const KAMIKAZE_LEVERAGE = 20;

// Umbrales de Confianza Híbridos:
// Live Bot (Real) = 55% (Muy seguro/conservador)
// Paper Trading (Testnet) = 43% (Balanceado/Velocidad V31 Original)
const MIN_ENTRY_THRESHOLD = CONFIG.IS_TESTNET ? 0.33 : 0.33;
const MAX_ENTRY_THRESHOLD = CONFIG.IS_TESTNET ? 0.43 : 0.33;
const RESURRECTION_THRESHOLD_BALANCE = 15;

export interface KamikazeConfig {
    threshold: number;
    leverage: number;
    capitalUsage: number;
    tpRoe?: number;
    lastAtrValue?: number;
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
    tradingMode?: string;
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

    private getTradingMode(): string {
        return this.config.tradingMode || CONFIG.TRADING_MODE;
    }

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
        const { logger, notifier, mlService, state, configManager, exchange } = this.deps;
        const tradingMode = this.getTradingMode();
        const isPhantomLegacy = tradingMode === 'PHANTOM_LEGACY';
        const isAegisTurbo = tradingMode === 'AEGIS_TURBO_MICRO_LIVE';
        const aegisModeTitle = isAegisTurbo
            ? '⚡ AEGIS TURBO MICRO-LIVE MODE'
            : '🛡️ AEGIS SHADOW MODE';
        logger.info(isPhantomLegacy ? '🔥 KAMIKAZE PHANTOM V33.5 ACTIVATED' : aegisModeTitle, {
            target: TARGET_BALANCE,
            initial: INITIAL_BALANCE,
            leverage: isPhantomLegacy ? KAMIKAZE_LEVERAGE : 0,
            mode: tradingMode,
            liveEnabled: CONFIG.AEGIS_LIVE_ENABLED
        });

        let startupMsg = isPhantomLegacy
            ? `🔥 **KAMIKAZE V33.5 LAUNCHED**\n\n`
            : `${isAegisTurbo ? '⚡' : '🛡️'} **${isAegisTurbo ? 'AEGIS TURBO MICRO-LIVE MODE' : 'AEGIS SHADOW MODE'}**\n\n`;
        if (isPhantomLegacy) {
            startupMsg += `🎯 Target: $${INITIAL_BALANCE} → $${TARGET_BALANCE}\n`;
            startupMsg += `⚡ Leverage: ${KAMIKAZE_LEVERAGE}x (LOCKED)\n`;
        } else {
            startupMsg += `No live entries\n`;
            startupMsg += `Aegis API integrated\n`;
            startupMsg += `AEGIS_LIVE_ENABLED=${CONFIG.AEGIS_LIVE_ENABLED}\n`;
            if (isAegisTurbo) {
                startupMsg += `Live requires AEGIS_LIVE_ENABLED=true and is not implemented in Phase 1\n`;
            }
        }
        
        const firstSymbol = this.config.symbols[0];
        const regimeConfigStartup = configManager.getRegimeConfig('PHANTOM', firstSymbol);
        
        const currentThreshold = regimeConfigStartup.entryThreshold;
        const maxDurationMs = regimeConfigStartup.maxHoldMs;
        const maxDurationH = maxDurationMs ? (maxDurationMs / 3600000).toFixed(1) : "N/A";
        
        if (isPhantomLegacy) {
            startupMsg += `🧠 Threshold Real: **${currentThreshold}**\n`;
            startupMsg += `👻 Threshold Shadow: **0.33**\n`;
            startupMsg += `⏱️ Time Limit: **${maxDurationH} horas**\n`;
            startupMsg += `🛡️ Circuit Breaker: ACTIVE\n\n`;
        }
        

        // Fetch Initial Scan for Startup Report (With Retry Logic)
        let signal: PhantomSignal | null = null;
        for (let i = 0; i < 5; i++) {
            try {
                signal = await mlService.getSignal(firstSymbol) as PhantomSignal;
                if (signal && signal.confidence !== undefined) break; // IA lista
            } catch (e) {
                logger.info(`⏳ Esperando a que el servidor de IA despierte (Intento ${i + 1}/5)...`);
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }

        if (signal) {
            startupMsg += `🛰️ **ESCANEO INICIAL (Radar):**\n`;
            startupMsg += `📈 Long:  ${((signal.longProb || 0) * 100).toFixed(1)}%\n`;
            startupMsg += `📉 Short: ${((signal.shortProb || 0) * 100).toFixed(1)}%\n`;
            startupMsg += `🧘 Idle:  ${((signal.neutralProb || 0) * 100).toFixed(1)}%\n`;
            startupMsg += `🚪 Close: ${((signal.closeProb || 0) * 100).toFixed(1)}%\n\n`;
            
            const trend = (signal.shortProb || 0) > (signal.longProb || 0) ? '📉 BAJISTA' : '📈 ALCISTA';
            startupMsg += `🧭 Tendencia: ${trend}\n`;
            
            const botState = state.get();
            if (botState.mode !== 'IDLE') {
                const markPrice = await exchange.getMarkPrice(firstSymbol);
                const entryPrice = botState.lastEntryPrice || markPrice;
                const leverage = botState.lastLeverage || 20;
                const side = botState.lastSide as string;
                
                const roi = side === 'SHORT'
                    ? (entryPrice - markPrice) / entryPrice * leverage
                    : (markPrice - entryPrice) / entryPrice * leverage;
                
                const pnlUsd = (botState.lastEntryQty || 0) * (markPrice - entryPrice) * (side === 'SHORT' ? -1 : 1);
                
                // Fetch exact margin from Binance API to avoid discrepancy
                const activePos = await exchange.readActivePosition(firstSymbol, side as any);
                const marginUsed = activePos?.isolatedMargin || botState.lastEntryMargin || ((botState.lastEntryQty || 0) * entryPrice / leverage);
                const durationH = botState.lastEntryAt ? ((Date.now() - botState.lastEntryAt) / 3600000).toFixed(1) : '0';
                
                startupMsg += `💼 **POSICIÓN ACTIVA:** ${side}\n`;
                startupMsg += `📦 Tamaño: **${(botState.lastEntryQty || 0).toFixed(3)} ETH**\n`;
                startupMsg += `💸 Margen: **$${marginUsed.toFixed(2)} USDT**\n`;
                startupMsg += `💰 ROI: **${(roi * 100).toFixed(2)}%** | PnL: **$${pnlUsd.toFixed(2)}**\n`;
                startupMsg += `⏱️ Duración: ${durationH} horas\n\n`;
                
                // Brackets Info
                try {
                    const openOrders = await exchange.listCloseOrdersForSide(firstSymbol, side as any);

                    if (openOrders.length > 0) {
                        startupMsg += `🎯 **BRACKETS (Binance):**\n`;
                        for (const order of openOrders) {
                            const orderPrice = (order as any).price || (order as any).stopPrice;
                            if (orderPrice) {
                                const dist = ((Math.abs(orderPrice - markPrice) / markPrice) * 100).toFixed(1);
                                const isSL = side === 'SHORT' ? (orderPrice > entryPrice) : (orderPrice < entryPrice);
                                startupMsg += `• ${isSL ? 'SL 🛑' : 'TP 🎯'}: $${orderPrice} (${dist}% dist)\n`;
                            }
                        }
                    } else {
                        startupMsg += `⚠️ No se detectaron SL/TP activos en Binance.\n`;
                    }
                } catch (e) {
                    startupMsg += `⚠️ Error leyendo brackets.\n`;
                }
            } else {
                startupMsg += `💼 Posición: NINGUNA (Flat)\n`;
            }
        } else {
            startupMsg += `🛰️ **ESCANEO INICIAL:**\n`;
            startupMsg += `⚠️ El servidor de IA está tardando en responder. El Radar se actualizará automáticamente en el primer tick de mercado.`;
        }

        startupMsg += isPhantomLegacy
            ? `\n⚠️ *Pure CVD Tensor Navigation*`
            : `\n⚠️ *Shadow observation only*`;

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
        const { state } = this.deps;
        const botState = state.get();

        try {
            const hasPosition = botState.mode !== 'IDLE';
            const shadowPos = state.get().shadowPos;
            const tradingMode = this.getTradingMode();

            if (tradingMode === 'PHANTOM_LEGACY' && shadowPos && shadowPos.active) {
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

    private logAegisScan(symbol: string, signal: PhantomSignal): void {
        const aegis = signal.metadata?.aegis;
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

    private evaluateAegisTurboGateDryRun(
        symbol: string,
        signal: PhantomSignal,
        balance: number | null
    ): AegisMicroLiveGateDecision {
        const botState = this.deps.state.get();
        const timeSinceLastExitMs = Date.now() - (botState.lastExitAt || 0);
        const liquidityStress = this.detector[symbol]?.getLiquidityStress() || 0;
        const dailyPnlPct = balance !== null && this.peakBalance > 0
            ? (balance - this.peakBalance) / this.peakBalance
            : undefined;

        return shouldEnterAegisTurboMicroLive(
            {
                symbol,
                signal: { aegis: signal.metadata?.aegis },
                hasOpenPosition: botState.mode !== 'IDLE',
                tradesToday: this.tradesToday,
                consecutiveLosses: this.consecutiveLosses,
                timeSinceLastExitMs,
                liquidityStress,
                dailyPnlPct
            },
            buildAegisMicroLiveGateConfigFromEnv(CONFIG)
        );
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
            const tradingMode = this.getTradingMode();
            if (tradingMode === 'AEGIS_SHADOW') {
                const signal = await mlService.getSignal(symbol) as PhantomSignal;
                this.logAegisScan(symbol, signal);
                return;
            }

            if (tradingMode === 'AEGIS_TURBO_MICRO_LIVE') {
                const signal = await mlService.getSignal(symbol) as PhantomSignal;
                this.logAegisScan(symbol, signal);
                const gateDecision = this.evaluateAegisTurboGateDryRun(symbol, signal, null);

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
                        tradingMode
                    });
                    return;
                }

                logger.warn('aegis_micro_live_gate_allowed_dry_run', {
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
                    message: 'Gate allowed but execution is intentionally disabled in Phase 3'
                });
                return;
            }

            const balance = await exchange.getUSDTBalance();
            const regimeConfig = configManager.getRegimeConfig('PHANTOM', symbol);

            const kamikazeConfig = this.getKamikazeConfig(balance);
            const kamikazeThreshold = kamikazeConfig.threshold;
            const leverage = kamikazeConfig.leverage;

            if (this.tradesToday >= this.config.maxTradesPerDay) {
                return;
            }

            const botState = state.get();
            const timeSinceLastExit = Date.now() - (botState.lastExitAt || 0);
            if (timeSinceLastExit < 15 * 60 * 1000) { // 15 minutos de Cooldown
                return; // Esperamos a que el mercado respire (evita entrar en agotamiento/sobreventa)
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
                entryThreshold: regimeConfig.entryThreshold ?? kamikazeThreshold,
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
            if (tradingMode === 'PHANTOM_LEGACY' && !shadowPos && signal.confidence && signal.confidence >= 0.33) {
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
            if (regimeConfig.useExitAgent !== false) {
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
                const quantityRaw = Math.floor((notional / markPrice) * Math.pow(10, filters.qtyPrecision)) / Math.pow(10, filters.qtyPrecision);
                const quantity = Number(quantityRaw.toFixed(filters.qtyPrecision));

                if (quantity * markPrice < filters.minNotional) {
                    logger.warn('Position too small', { quantity, minNotional: filters.minNotional });
                    return;
                }

                await exchange.setLeverage(symbol, leverage);
                await exchange.ensureMarginType(symbol, 'ISOLATED');

                const side = signal.action === 'SHORT' ? 'SHORT' : 'LONG';
                const result = await exchange.marketOpen(symbol, side, quantity);

                // Wait 500ms to allow Binance to process the order before fetching the true margin
                await new Promise(resolve => setTimeout(resolve, 500));
                const positionData = await exchange.readActivePosition(symbol, side);
                const marginUsed = positionData?.isolatedMargin || ((quantity * result.avgPrice) / leverage);

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
                    lastEntryMargin: marginUsed,
                    lastEntryQty: quantity,
                    lastMlProb: signal.confidence
                });

                this.tradesToday++;
                this.lastEntryBalance = wallet;

                await notifier.sendMessage(`🔥 **KAMIKAZE ENTRY**\n` +
                    `${symbol} | ${side === 'LONG' ? '📈 LONG' : '📉 SHORT'}\n` +
                    `Precio: $${result.avgPrice.toFixed(2)}\n` +
                    `📦 Tamaño: **${quantity.toFixed(3)} ETH**\n` +
                    `💸 Margen: **$${marginUsed.toFixed(2)} USDT**\n\n` +
                    `**PROBABILIDADES IA:**\n` +
                    `🟢 Long:  ${((signal.longProb || 0) * 100).toFixed(1)}%\n` +
                    `🔴 Short: ${((signal.shortProb || 0) * 100).toFixed(1)}%\n` +
                    `🧘 Idle:  ${((signal.neutralProb || 0) * 100).toFixed(1)}%\n` +
                    `🚪 Close: ${((signal.closeProb || 0) * 100).toFixed(1)}%\n\n` +
                    `💰 Wallet: $${wallet.toFixed(2)}\n` +
                    `⚙️ Threshold: ${phantomConfig.entryThreshold}`);

                // 📝 AUDIT LOG: Registro local del mensaje enviado (Solo real)
                logger.info('📱 [TELEGRAM_REPORT] ENTRY SENT', { message: `🔥 **KAMIKAZE ENTRY**\n${symbol} | ${side}\n...probs: L:${((signal.longProb || 0) * 100).toFixed(1)}% S:${((signal.shortProb || 0) * 100).toFixed(1)}%` });
            } catch (entryError) {
                logger.error('Entry failed', { error: String(entryError) });
                this.consecutiveLosses++;
                await this.notifyError(symbol, 'ENTRY FAILED', entryError);
            }
        } catch (error) {
            if (this.shouldLogError(symbol, 'LOOKFOR_ENTRY', 60000)) {
                logger.error('LookForEntry error', { error: String(error) });
            }
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

                const isLong = side === 'LONG';
                const markPrice = await exchange.getMarkPrice(symbol);
                const exitPrice = markPrice; // Best estimate of where it closed
                const finalRoe = isLong ? (exitPrice - entryPrice) / entryPrice * (botState.lastLeverage || 20)
                                       : (entryPrice - exitPrice) / entryPrice * (botState.lastLeverage || 20);

                let closeDetail = "";
                if (botState.lastTrailStop) {
                    const distToTrail = Math.abs(exitPrice - botState.lastTrailStop) / exitPrice;
                    if (distToTrail < 0.001) closeDetail = " [EJECUTADO POR TRAILING] 🛡️";
                }

                const closeType = pnl >= 0 ? `🎯 TAKE PROFIT (TP)${closeDetail}` : `🛑 STOP LOSS (SL)${closeDetail}`;
                const emoji = pnl >= 0 ? '💰' : '💸';

                await notifier.sendMessage(
                    `${emoji} **${closeType}**\n` +
                    `${symbol} | ${side}\n` +
                    `Entrada: $${entryPrice.toFixed(2)} → Salida: $${exitPrice.toFixed(2)}\n` +
                    `ROE Final: **${(finalRoe * 100).toFixed(2)}%**\n` +
                    `PnL: **$${pnl.toFixed(2)}**\n` +
                    `Balance: **$${balance.toFixed(2)}** (${((balance / TARGET_BALANCE) * 100).toFixed(1)}% de meta)`
                );
                
                // 📝 AUDIT LOG: Registro local del mensaje enviado (Solo real)
                logger.info('📱 [TELEGRAM_REPORT] EXIT SENT', { message: `💰 **${closeType}** PnL: $${pnl.toFixed(2)} Balance: $${balance.toFixed(2)}` });

                state.set({ mode: 'IDLE', lastExitAt: Date.now() });
                return;
            }

            // SAFETY NET: Ensure brackets (SL/TP) exist on Binance, recreate if missing
            const openOrders = await exchange.listCloseOrdersForSide(symbol, side);
            const hasSL = openOrders.some(o => o.type.includes('STOP'));
            const hasTP = openOrders.some(o => o.type.includes('TAKE_PROFIT'));

            if (!hasSL || !hasTP) {
                try {
                    const regimeConfig = configManager.getRegimeConfig('PHANTOM');
                    const hardStopPricePct = Math.abs(regimeConfig.hardStopRoe) / (botState.lastLeverage || 20);
                    const tpPricePct = Math.abs(regimeConfig.tpRoe || 1.5) / (botState.lastLeverage || 20);

                    if (!hasSL) {
                        let newStopPrice = side === 'SHORT'
                            ? entryPrice * (1 + hardStopPricePct)
                            : entryPrice * (1 - hardStopPricePct);
                        newStopPrice = Number(newStopPrice.toFixed(2));
                        await exchange.placeStopClose(symbol, side, newStopPrice);
                        logger.info(`Recreated missing SL for ${symbol}`, { newStopPrice });
                    }

                    if (!hasTP) {
                        let newTpPrice = side === 'SHORT'
                            ? entryPrice * (1 - tpPricePct)
                            : entryPrice * (1 + tpPricePct);
                        newTpPrice = Number(newTpPrice.toFixed(2));
                        await exchange.placeTpClose(symbol, side, newTpPrice);
                        logger.info(`Recreated missing TP for ${symbol}`, { newTpPrice });
                    }
                } catch (error) {
                    logger.error('Management error: Failed to recreate brackets', { symbol, error: String(error) });
                }
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
            const serverNow = await exchange.getServerTime();
            const tradeDuration = botState.lastEntryAt ? (serverNow - botState.lastEntryAt) : 0;
            if (tradeDuration > maxDurationMs) {
                if (currentRoe > 0.02) { // 🛡️ Buffer de 2% para evitar cierres en negativo por slippage
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

                // 🧠 BOTÓN DE PÁNICO (V3 o V31)
                try {
                    const signalV31 = await mlService.getSignal(symbol) as PhantomSignal;

                    if (regimeConfig.useExitAgent !== false) {
                        // Usa IA Especializada de Salida (V3)
                        const durationMinutes = tradeDuration > 0 ? tradeDuration / 60000 : 0;
                        const exitV3 = await mlService.getExitSignal({
                            symbol,
                            entry_price: entryPrice,
                            current_pnl: currentRoe,
                            mfe: updatedPeakRoe,
                            mae: updatedLowestRoe,
                            duration_minutes: durationMinutes,
                            leverage: botState.lastLeverage || 20
                        });

                        if (exitV3.action === 'CLOSE' && exitV3.confidence && exitV3.confidence > 0.60) {
                            logger.warn(`🤖 AI PANIC CLOSE Triggered V3`, {
                                v3Conf: (exitV3.confidence * 100).toFixed(1) + '%',
                                v31CloseProb: ((signalV31.closeProb || 0) * 100).toFixed(1) + '%',
                                currentRoe: (currentRoe * 100).toFixed(2) + '%'
                            });

                            await exchange.closeSideMarketSafe(symbol, side, position.qtyAbs, position.sideMode, 'AI_PANIC_CLOSE');

                            const exitBalance = await exchange.getUSDTBalance();
                            const pnlUsd = exitBalance - (botState.lastEntryWallet || exitBalance);
                            const emoji = pnlUsd >= 0 ? '✅' : '🚨';

                            await notifier.sendMessage(
                                `${emoji} **AI EXIT V3 EXECUTED** 🤖\n` +
                                `${symbol} | ${side}\n` +
                                `V3 Confianza Cierre: ${(exitV3.confidence * 100).toFixed(1)}%\n` +
                                `ROE: ${(currentRoe * 100).toFixed(2)}%\n` +
                                `PnL: $${pnlUsd.toFixed(2)}\n` +
                                `Balance: $${exitBalance.toFixed(2)}`
                            );

                            state.set({ mode: 'IDLE', lastExitAt: Date.now(), lastExitReason: 'AI_PANIC_CLOSE' });
                            return;
                        }
                    } else {
                        // Delega el cierre al Agente de Entradas Original (V31)
                        if (signalV31.closeProb && signalV31.closeProb > 0.60) {
                            logger.warn(`🤖 AI PANIC CLOSE Triggered V31 (Fallback)`, {
                                v31CloseProb: (signalV31.closeProb * 100).toFixed(1) + '%',
                                currentRoe: (currentRoe * 100).toFixed(2) + '%'
                            });

                            await exchange.closeSideMarketSafe(symbol, side, position.qtyAbs, position.sideMode, 'V31_PANIC_CLOSE');

                            const exitBalance = await exchange.getUSDTBalance();
                            const pnlUsd = exitBalance - (botState.lastEntryWallet || exitBalance);
                            const emoji = pnlUsd >= 0 ? '✅' : '🚨';

                            await notifier.sendMessage(
                                `${emoji} **AI EXIT V31 EXECUTED** 🤖\n` +
                                `${symbol} | ${side}\n` +
                                `V31 Confianza Cierre: ${(signalV31.closeProb * 100).toFixed(1)}%\n` +
                                `ROE: ${(currentRoe * 100).toFixed(2)}%\n` +
                                `PnL: $${pnlUsd.toFixed(2)}\n` +
                                `Balance: $${exitBalance.toFixed(2)}`
                            );

                            state.set({ mode: 'IDLE', lastExitAt: Date.now(), lastExitReason: 'V31_PANIC_CLOSE' });
                            return;
                        }
                    }
                } catch (err) {
                    logger.warn('Failed to fetch ML Exit signals', { error: String(err) });
                }
            }

            // 📊 FETCH DYNAMIC ATR FOR TRAILING STOP (Cache for 60 seconds)
            let currentAtr = botState.lastAtrValue;
            if (now - (botState.lastAtrFetchedAt || 0) > 60000) {
                try {
                    const klines = await exchange.getCandles(symbol, '5m', 15);
                    const atr = calculateATR(klines, 14);
                    if (atr) {
                        currentAtr = atr;
                        state.set({ lastAtrFetchedAt: now, lastAtrValue: atr });
                    }
                } catch (e) {
                    // Fail silently, Guardian uses default trailing logic
                }
            }

            const action = evaluateGuardianAction({
                entryPrice,
                currentPrice: markPrice,
                peakPrice,
                positionSide: side,
                leverage: botState.lastLeverage || 20,
                peakRoe: updatedPeakRoe,
                atrValue: currentAtr
            }, guardianConfig, undefined);

            switch (action.type) {
                case 'MOVE_SL_TRAILING':
                    const trailingPrice = Number(action.price!.toFixed(2));
                    let blockUpdate = false;
                    if (botState.lastTrailStop !== undefined) {
                        if (botState.lastTrailStop === trailingPrice) {
                            blockUpdate = true;
                        } else if (side === 'LONG' && trailingPrice < botState.lastTrailStop) {
                            blockUpdate = true; // Never lower stop loss for Long
                        } else if (side === 'SHORT' && trailingPrice > botState.lastTrailStop) {
                            blockUpdate = true; // Never raise stop loss for Short
                        }
                    }

                    if (blockUpdate) {
                        break;
                    }
                    if (typeof (exchange as any).cancelStopOrdersForSide === 'function') {
                        await (exchange as any).cancelStopOrdersForSide(symbol, side);
                    }
                    
                    await exchange.placeStopClose(symbol, side, trailingPrice);

                    // 📱 NOTIFICACIÓN DE TRAILING (NUEVO)
                    const protectedRoe = side === 'SHORT'
                        ? (entryPrice - trailingPrice) / entryPrice * (botState.lastLeverage || 20)
                        : (trailingPrice - entryPrice) / entryPrice * (botState.lastLeverage || 20);

                    await notifier.sendMessage(
                        `🛡️ **TRAILING ACTUALIZADO** 🚀\n` +
                        `${symbol} | ${side}\n` +
                        `Nuevo SL: **$${trailingPrice}**\n` +
                        `ROI Protegido: **${(protectedRoe * 100).toFixed(2)}%**\n` +
                        `Precio Actual: $${markPrice.toFixed(2)}`
                    );

                    logger.info(`📱 [TELEGRAM_REPORT] TRAILING MOVE`, { message: `🛡️ **TRAILING ACTUALIZADO** SL: $${trailingPrice} ROI: ${(protectedRoe * 100).toFixed(2)}%` });

                    state.set({ lastTrailStop: trailingPrice });
                    break;
                case 'CLOSE_MARKET': {
                    await exchange.closeSideMarketSafe(symbol, side, position.qtyAbs, position.sideMode, action.reason!);

                    const exitBalance = await exchange.getUSDTBalance();
                    const pnlUsd = exitBalance - (botState.lastEntryWallet || exitBalance);
                    const roePct = (currentRoe * 100).toFixed(2);

                    let emoji = pnlUsd > 0 ? '✅' : '❌';
                    if (action.reason === 'TRAILING_SAFETY_NET') emoji = '🛡️';

                    // Fetch AI opinions for analytics
                    let aiOpinions = '';
                    try {
                        const durationMin = tradeDuration > 0 ? tradeDuration / 60000 : 0;
                        const [exitV3, signalV31] = await Promise.all([
                            mlService.getExitSignal({
                                symbol,
                                entry_price: entryPrice,
                                current_pnl: currentRoe,
                                mfe: updatedPeakRoe,
                                mae: updatedLowestRoe,
                                duration_minutes: durationMin,
                                leverage: botState.lastLeverage || 20
                            }),
                            mlService.getSignal(symbol)
                        ]);
                        aiOpinions = `\nV3 Exit: ${exitV3.action} (${((exitV3.confidence || 0) * 100).toFixed(1)}%)` +
                            `\nV31 Close Prob: ${(((signalV31 as PhantomSignal).closeProb || 0) * 100).toFixed(1)}%`;
                    } catch (_) { /* non-critical */ }

                    await notifier.sendMessage(`${emoji} **CIERRE DE GUARDIAN (${action.reason})**\n` +
                        `${symbol} | ${side}\n` +
                        `Entry: $${entryPrice.toFixed(2)} → Exit: $${markPrice.toFixed(2)}\n` +
                        `ROE: ${roePct}%\n` +
                        `PnL: $${pnlUsd.toFixed(2)}\n` +
                        `MFE Pico: ${(updatedPeakRoe * 100).toFixed(2)}%\n` +
                        `Balance: $${exitBalance.toFixed(2)}` +
                        aiOpinions);

                    // 📝 AUDIT LOG: Registro local del mensaje enviado (Solo real)
                    logger.info('📱 [TELEGRAM_REPORT] GUARDIAN EXIT SENT', { message: `🛡️ **CIERRE DE GUARDIAN (${action.reason})** PnL: $${pnlUsd.toFixed(2)} ROE: ${roePct}%` });

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

    private shouldLogError(symbol: string, type: string, intervalMs: number): boolean {
        const now = Date.now();
        const logKey = `${symbol}:${type}`;
        if (this.lastLogTime[logKey] && now - this.lastLogTime[logKey] < intervalMs) {
            return false;
        }
        this.lastLogTime[logKey] = now;
        return true;
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
                const signalV31 = await this.deps.mlService.getSignal(symbol) as PhantomSignal;
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
                    await this.closeShadowPosition(markPrice, '🤖 AI EXIT', {
                        v3Conf: exitSignal.confidence,
                        v31Conf: signalV31.closeProb
                    });
                }
            } catch (e) {
                // Ignore errors for shadow AI exit
            }
        }
    }

    private async closeShadowPosition(exitPrice: number, reason: string, confs?: { v3Conf?: number, v31Conf?: number }): Promise<void> {
        const shadowPos = this.deps.state.get().shadowPos;
        if (!shadowPos) return;

        const pnlUsd = shadowPos.side === 'LONG'
            ? (exitPrice - shadowPos.entryPrice) * shadowPos.quantity
            : (shadowPos.entryPrice - exitPrice) * shadowPos.quantity;

        let confMsg = `Initial Conf: ${(shadowPos.confidence * 100).toFixed(0)}%`;
        if (confs) {
            confMsg += `\nV3 Exit Conf: ${((confs.v3Conf || 0) * 100).toFixed(1)}%\nV31 Close Prob: ${((confs.v31Conf || 0) * 100).toFixed(1)}%`;
        }

        await this.deps.notifier.sendMessage(
            `👻 **SHADOW TRADE CLOSED** (${reason})\n` +
            `${shadowPos.symbol} | ${shadowPos.side}\n` +
            `Entry: $${shadowPos.entryPrice.toFixed(2)} → Exit: $${exitPrice.toFixed(2)}\n` +
            `Fake PnL: $${pnlUsd.toFixed(2)}\n` +
            confMsg
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
