/**
 * TradingService - Application Layer Use Case
 * 
 * Main trading orchestration service.
 * Coordinates between domain services and infrastructure adapters.
 * 
 * @see binance-futures-bot-ts-clone/src/app/strategy-runner.ts for reference
 */

import { Exchange, PositionInfo } from '../ports/Exchange';
import { MLService } from '../ports/MLService';
import { Logger } from '../ports/Logger';
import { StateStore } from '../ports/StateStore';
import { Notifier } from '../ports/Notifier';
import { BotState, Side, Signal } from '../../domain/types';
import {
    PhantomConfig,
    PhantomSignal,
    PhantomTriggerContext,
    DEFAULT_PHANTOM_CONFIG,
    shouldEnter,
    toTradeSignal
} from '../../domain/services/PhantomStrategy';
import {
    GuardianConfig,
    DEFAULT_GUARDIAN_CONFIG,
    evaluateGuardianAction
} from '../../domain/services/ProfitGuardian';
import { NinjaConfigManager } from '../../infra/config/ConfigLoader';

export interface TradingServiceDeps {
    exchange: Exchange;
    mlService: MLService;
    logger: Logger;
    state: StateStore;
    notifier: Notifier;
    configManager: NinjaConfigManager;  // ← NEW: Dynamic config loader
}

export interface TradingServiceConfig {
    symbols: string[];
    phantomConfig: PhantomConfig;
    guardianConfig: GuardianConfig;
    tickIntervalMs: number;
    maxTradesPerDay: number;
}

export class TradingService {
    private isRunning = false;
    private tradesToday = 0;
    private lastTradeDayReset = 0;
    private lastErrorTime: Record<string, number> = {}; // Error Rate Limiting
    private lastLogTime: Record<string, number> = {}; // Adaptive Logging State

    // House Money & Circuit Breaker (Python parity)
    private readonly initialBalance = 20.0;  // Must match BacktestRunner
    private peakBalance = 20.0;
    private circuitBreakerUntil: number | null = null;  // Candle index
    private readonly houseMoneyMultiplier = 2.0;
    private readonly houseMoneyReduction = 1.0; // PARITY FIX: 100% Reinvestment (All-in)
    private readonly circuitBreakerDD = 1.0;    // PARITY FIX: Disabled (was 0.15)
    private readonly circuitBreakerCandles = 288;  // 24h

    constructor(
        private deps: TradingServiceDeps,
        private config: TradingServiceConfig
    ) { }

    /**
     * Helper to send error notifications with rate limiting (1 hour)
     */
    private async notifyError(symbol: string, type: string, error: any): Promise<void> {
        const key = `${symbol}|${type}`;
        const now = Date.now();
        const last = this.lastErrorTime[key] || 0;
        const COOLDOWN = 60 * 60 * 1000; // 1 Hour

        if (now - last > COOLDOWN) {
            const msg = (error?.message || String(error)).substring(0, 200); // Truncate long errors
            await this.deps.notifier.sendMessage(
                `⚠️ **${type}**\n` +
                `Symbol: ${symbol}\n` +
                `Error: ${msg}`
            );
            this.lastErrorTime[key] = now;
        }
    }

    /**
     * Start the trading loop
     */
    async start(startLoop = true): Promise<void> {
        const { logger, notifier } = this.deps;

        logger.info('🦅 PHANTOM Trading Bot Starting', {
            symbols: this.config.symbols
        });

        let startupMsg = `🦅 **PHANTOM Bot Started**\n\n`;

        // Log effective config for each symbol
        for (const symbol of this.config.symbols) {
            const effectiveConfig = this.deps.configManager.getRegimeConfig('PHANTOM', symbol);
            const trailing = effectiveConfig.trailingActivationRoe ?? 999;

            logger.info(`🔧 Effective Config for ${symbol}`, {
                leverage: effectiveConfig.leverage,
                threshold: effectiveConfig.entryThreshold,
                hardStop: effectiveConfig.hardStopRoe,
                tp: effectiveConfig.tpRoe,
                trailing: trailing
            });

            startupMsg += `🔹 **${symbol}**\n`;
            startupMsg += `   Lev: ${effectiveConfig.leverage}x\n`;
            startupMsg += `   SL: ${(effectiveConfig.hardStopRoe * 100).toFixed(2)}%\n`;
            startupMsg += `   TP: ${(effectiveConfig.tpRoe * 100).toFixed(0)}%\n`;
            startupMsg += `   Trail: ${trailing > 100 ? 'OFF' : 'ON'}\n\n`;

            // 🔌 Phoenix Protocol: Subscribe to WS Candles
            this.deps.exchange.subscribeToCandles(symbol);
        }

        await notifier.sendMessage(startupMsg);

        this.isRunning = true;
        if (startLoop) {
            await this.runLoop();
        }
    }

    /**
     * Stop the trading loop
     */
    stop(): void {
        this.isRunning = false;
        this.deps.logger.info('Trading bot stopped');
    }

    /**
     * Main trading loop
     */
    private async runLoop(): Promise<void> {
        const { logger } = this.deps;

        while (this.isRunning) {
            try {
                // Reset daily trade counter
                this.checkDailyReset();

                // Process each symbol
                for (const symbol of this.config.symbols) {
                    if (!this.isRunning) break;
                    await this.processSymbol(symbol);
                }

                // Wait for next tick
                await this.sleep(this.config.tickIntervalMs);

            } catch (error) {
                logger.error('Trading loop error', { error: String(error) });
                await this.sleep(5000); // Wait before retry
            }
        }
    }

    /**
     * Public tick method for external drivers (e.g. Backtest Runner)
     */
    public async tick(symbol: string): Promise<void> {
        await this.processSymbol(symbol);
    }

    /**
     * Process a single symbol
     */
    protected async processSymbol(symbol: string): Promise<void> {
        const { exchange, mlService, logger, state, configManager } = this.deps;
        const botState = state.get();

        try {
            // 0. Time Sentinel (Dynamic from Config)
            const regimeConfig = configManager.getRegimeConfig('PHANTOM', symbol);
            const now = await exchange.getServerTime(); // Support Backtest Time

            // 1. Check if we have an active position
            const hasPosition = botState.mode !== 'IDLE';

            if (hasPosition) {
                // Manage existing position (handles re-entry if position closes)
                await this.managePosition(symbol, botState);

                // PARITY FIX: Re-entry Check
                // If position closed (IDLE), check for entry immediately (same candle)
                const newState = state.get();
                if (newState.mode === 'IDLE') {
                    // Re-check forbidden time for re-entry
                    if (!this.checkForbiddenTime(now, regimeConfig)) {
                        await this.lookForEntry(symbol);
                    }
                }
            } else {
                // Look for entry opportunities
                // Check Time Sentinel (Forbidden Hours) ONLY for new entries
                if (this.checkForbiddenTime(now, regimeConfig)) {
                    return;
                }
                await this.lookForEntry(symbol);
            }

        } catch (error) {
            logger.warn('Symbol processing error', { symbol, error: String(error) });
            await this.notifyError(symbol, 'SYSTEM ERROR', error);
        }
    }

    /**
     * Check if current time is forbidden based on config
     */
    private checkForbiddenTime(timestamp: number, config: any): boolean {
        if (!config.forbiddenHours && !config.forbiddenDays) return false;

        const date = new Date(timestamp);
        const hour = date.getUTCHours();
        const day = date.getUTCDay(); // 0=Sun, 1=Mon...

        if (config.forbiddenDays && config.forbiddenDays.includes(day)) return true;
        if (config.forbiddenHours && config.forbiddenHours.includes(hour)) return true;

        return false;
    }

    /**
     * Look for entry opportunities
     */
    private async lookForEntry(symbol: string): Promise<void> {
        const { mlService, exchange, logger, state, notifier, configManager } = this.deps;

        try {
            // Get current balance and update peak
            const balance = await exchange.getUSDTBalance();

            if (balance > this.peakBalance) {
                this.peakBalance = balance;
            }

            // Circuit Breaker check (Python parity - check BEFORE entry)
            if (this.circuitBreakerUntil !== null) {
                // PARITY FIX: Use exchange time for backtest compatibility
                const now = await exchange.getServerTime();
                if (now < this.circuitBreakerUntil) {
                    logger.debug('Circuit breaker active', { until: new Date(this.circuitBreakerUntil).toISOString() });
                    return;
                } else {
                    // CB period expired
                    this.circuitBreakerUntil = null;
                    logger.info('🔓 Circuit Breaker expired, resuming trading');
                }
            }

            // Get symbol-specific config from YAML (Base Config)
            const regimeConfig = configManager.getRegimeConfig('PHANTOM', symbol);
            const capitalUsage = configManager.getCapitalAllocation(symbol, 'PHANTOM');

            // Get ML signal (Moved UP for Dynamic Leverage)
            const signal = await mlService.getSignal(symbol);

            // Determine Leverage: Static (Config) vs Dynamic (Agent)
            let leverage = regimeConfig.leverage;
            let entryThreshold = regimeConfig.entryThreshold;

            // [PURE V30 MODE] Hybrid Logic Removed
            // Proceed directly to leverage/entry checks



            if (signal.smart_leverage && signal.smart_leverage > 0) {
                leverage = signal.smart_leverage;
                logger.info('⚖️ Dynamic Leverage Applied', {
                    base: regimeConfig.leverage,
                    dynamic: leverage,
                    conf: signal.confidence
                });
            }

            // House Money Rule (Python parity): Reduce leverage after 2x profit
            if (balance >= this.initialBalance * this.houseMoneyMultiplier) {
                const houseLev = regimeConfig.leverage * this.houseMoneyReduction;
                // Only reduce if Dynamic hasn't already reduced it further?
                // House Money usually implies "Play Safe".
                leverage = Math.min(leverage, houseLev);

                logger.debug('House Money active', {
                    originalLeverage: regimeConfig.leverage,
                    reducedLeverage: leverage,
                    balance,
                    threshold: this.initialBalance * this.houseMoneyMultiplier
                });
            }

            // Check daily trade limit
            if (this.tradesToday >= this.config.maxTradesPerDay) {
                logger.debug('Daily trade limit reached', { trades: this.tradesToday });
                return;
            }

            // Build PhantomTrigger context from ML features
            const currentCandle = await exchange.getLastCandle(symbol);
            const triggerCtx: PhantomTriggerContext | undefined = (signal.features && currentCandle) ? {
                currentCandle,
                cvdSlope: signal.features.cvd_slope ?? 0,
                cvdZ: signal.features.cvd_z ?? 0,
                weaknessScore: signal.features.weakness ?? 0
            } : undefined;

            // --- HEARTBEAT LOG (Tick by Tick) ---
            let pnlLog: number | undefined;
            let roeLog: number | undefined;

            if (state.get().mode !== 'IDLE') {
                const currentBalance = await exchange.getUSDTBalance();
                const entryBalance = state.get().lastEntryWallet || currentBalance;
                pnlLog = currentBalance - entryBalance;

                if (state.get().lastEntryQty && state.get().lastLeverage && state.get().lastEntryPrice) {
                    const margin = (state.get().lastEntryPrice! * state.get().lastEntryQty!) / state.get().lastLeverage!;
                    roeLog = (pnlLog / margin) * 100;
                }
            }

            // --- ADAPTIVE SAMPLING (Noise Reduction) ---
            const nowMs = Date.now();
            const lastLog = this.lastLogTime[symbol] || 0;
            const prob = signal.shortProb || 0;
            const isIdle = state.get().mode === 'IDLE';
            let shouldLog = true;

            if (isIdle) {
                // If idle, log less frequently unless prob is high
                if (signal.confidence < 0.10 && (nowMs - lastLog) < 60000) {
                    shouldLog = false;
                }
            }

            if (shouldLog) {
                logger.info('phantom_tick', {
                    symbol,
                    price: currentCandle?.close,
                    action: signal.action,
                    conf: signal.confidence,
                    cvdSlope: signal.features?.cvd_slope,
                    cvdZ: signal.features?.cvd_z,
                    weakness: signal.features?.weakness,
                    pnl: pnlLog,
                    roe: roeLog,
                    longProb: signal.longProb,
                    shortProb: signal.shortProb,
                    neutralProb: signal.neutralProb,
                    threshold: entryThreshold,
                    flags: signal.features
                });
                this.lastLogTime[symbol] = nowMs;
            }

            // Check if we should enter
            const phantomConfig: PhantomConfig = {
                leverage,
                entryThreshold,
                hardStopRoe: regimeConfig.hardStopRoe,
                tpRoe: regimeConfig.tpRoe
            };




            if (!shouldEnter(signal, phantomConfig, triggerCtx)) {
                logger.debug('No entry signal', {
                    symbol,
                    confidence: signal.confidence,
                    threshold: entryThreshold
                });
                return;
            }

            // Execute entry
            logger.info('📈 Entry signal detected', {
                symbol,
                side: signal.action,
                confidence: `${(signal.confidence * 100).toFixed(1)}%`,
                leverage: `${leverage}x`,
                allocation: `${(capitalUsage * 100).toFixed(0)}%`
            });

            try {
                // Get wallet balance
                const wallet = await exchange.getUSDTBalance();
                const filters = await exchange.getSymbolFilters(symbol, leverage);

                // Apply Fee Buffer
                const feeBufferPct = this.deps.configManager.trading.fee_buffer_pct;
                const effectiveWallet = wallet * (1 - feeBufferPct);

                // Calculate position size
                const markPrice = await exchange.getMarkPrice(symbol);
                const notional = effectiveWallet * capitalUsage * leverage;

                // DIAGNOSTIC LOG: Margin Check
                logger.info('💰 Pre-Entry Margin Check', {
                    wallet: wallet,
                    effectiveWallet: effectiveWallet,
                    feeBuffer: feeBufferPct,
                    capitalUsage: capitalUsage,
                    leverage: leverage,
                    maxNotional: notional,
                    estPrice: markPrice
                });
                const quantity = Math.floor((notional / markPrice) * Math.pow(10, filters.qtyPrecision)) / Math.pow(10, filters.qtyPrecision);

                if (quantity * markPrice < filters.minNotional) {
                    logger.warn('Position too small', { symbol, quantity, minNotional: filters.minNotional });
                    return;
                }

                // Set Leverage
                await exchange.setLeverage(symbol, leverage);
                await exchange.ensureMarginType(symbol, 'ISOLATED');

                // Open position
                const side: Side = signal.action === 'SHORT' ? 'SHORT' : 'LONG';
                const result = await exchange.marketOpen(symbol, side, quantity);

                // Update state
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

                // Place brackets (SL/TP) using DYNAMIC config
                // PARITY FIX: Round prices to tickSize to avoid "Precision is over the maximum" error
                const tickSize = filters.tickSize;
                const roundToTick = (price: number) => {
                    const inverse = 1 / tickSize;
                    return Math.floor(price * inverse) / inverse;
                };

                let stopPrice = side === 'SHORT'
                    ? result.avgPrice * (1 - phantomConfig.hardStopRoe)
                    : result.avgPrice * (1 + phantomConfig.hardStopRoe);

                let tpPrice = side === 'SHORT'
                    ? result.avgPrice * (1 - phantomConfig.tpRoe)
                    : result.avgPrice * (1 + phantomConfig.tpRoe);

                // Apply rounding
                stopPrice = roundToTick(stopPrice);
                tpPrice = roundToTick(tpPrice);

                try {
                    await exchange.placeStopClose(symbol, side, stopPrice, quantity);
                    await exchange.placeTpClose(symbol, side, tpPrice, quantity);
                } catch (bracketError) {
                    logger.error('Bracket placement failed', { symbol, error: String(bracketError) });
                    await this.deps.notifier.sendMessage(
                        `⚠️ **BRACKET FAILED**\n` +
                        `Symbol: ${symbol}\n` +
                        `Error: ${String(bracketError)}\n` +
                        `ACTION REQUIRED: Check Open Orders!`
                    );
                }

                this.tradesToday++;

                // Notify
                await notifier.sendMessage(
                    `🎯 PHANTOM ENTRY\n` +
                    `Symbol: ${symbol}\n` +
                    `Side: ${side}\n` +
                    `Entry: ${result.avgPrice.toFixed(2)}\n` +
                    `Size: ${quantity} ETH ($${(quantity * result.avgPrice).toFixed(2)})\n` +
                    `Balance: $${wallet.toFixed(2)}\n` +
                    `SL: ${stopPrice.toFixed(2)}\n` +
                    `TP: ${tpPrice.toFixed(2)}\n` +
                    `Confidence: ${(signal.confidence * 100).toFixed(1)}%`
                );

                logger.info('✅ Position opened', { symbol, side, entry: result.avgPrice, orderId: result.orderId });

            } catch (entryError) {
                logger.error('Entry execution failed', { symbol, error: String(entryError) });
                await this.notifyError(symbol, 'ENTRY FAILED', entryError);
            }

        } catch (error) {
            logger.error('LookForEntry error', { symbol, error: String(error) });
        }
    }

    /**
     * Manage existing position
     */
    private async managePosition(symbol: string, botState: BotState): Promise<void> {
        const { exchange, logger, state, notifier, configManager } = this.deps;
        // DYNAMIC CONFIG: Load Guardian settings with symbol overrides
        const guardianConfig = configManager.getGuardianConfig('PHANTOM', symbol);

        const side = botState.lastSide!;
        const entryPrice = botState.lastEntryPrice!;

        try {
            // Get current position
            const position = await exchange.readActivePosition(symbol, side);

            if (!position) {
                // Position was closed externally (SL/TP hit)
                logger.info('Position closed externally', { symbol, side });

                // Update peak balance and check Circuit Breaker (Python parity)
                const balance = await exchange.getUSDTBalance();
                if (balance > this.peakBalance) {
                    this.peakBalance = balance;
                }



                // Check for circuit breaker trigger AFTER trade closes
                const currentDD = this.peakBalance > 0 ? (this.peakBalance - balance) / this.peakBalance : 0;
                if (currentDD >= this.circuitBreakerDD && this.circuitBreakerUntil === null) {
                    // PARITY FIX: Start CB from ENTRY TIME (matches Python)
                    // Python uses 'idx' (Entry Index) for duration.
                    const cbStartTime = botState.lastEntryAt || await exchange.getServerTime();
                    this.circuitBreakerUntil = cbStartTime + (this.circuitBreakerCandles * 5 * 60 * 1000);  // 24h

                    logger.warn('🚨 Circuit Breaker Activated!', {
                        peakBalance: this.peakBalance,
                        currentBalance: balance,
                        drawdown: `${(currentDD * 100).toFixed(2)}%`,
                        until: new Date(this.circuitBreakerUntil).toISOString()
                    });
                    await notifier.sendMessage(`🚨 Circuit Breaker Activated! DD: ${(currentDD * 100).toFixed(2)}%`);
                }

                await this.notifyExit(symbol, side, 'SL/TP', botState);
                state.set({ mode: 'IDLE', lastExitAt: Date.now() });
                return;
            }

            // PARITY FIX: Check Time Limit (Configurable)
            if (botState.lastEntryAt) {
                const now = await exchange.getServerTime();
                const duration = now - botState.lastEntryAt;

                // Load maxHoldMs from config (default to 4h if missing)
                const regimeConfig = configManager.getRegimeConfig('PHANTOM', symbol);
                const TIME_LIMIT_MS = regimeConfig.maxHoldMs || 4 * 60 * 60 * 1000;

                if (duration >= TIME_LIMIT_MS) {
                    logger.info('⏳ Time Limit Reached, closing position', { duration: duration / 3600000 });
                    await exchange.closeSideMarketSafe(symbol, side, position.qtyAbs, position.sideMode, 'TIME_LIMIT');

                    state.set({
                        mode: 'IDLE',
                        lastExitAt: now,
                        lastExitReason: 'TIME_LIMIT'
                    });

                    await this.notifyExit(symbol, side, 'TIME_LIMIT', botState);
                    return;
                }
            }

            // Get current price
            const markPrice = await exchange.getMarkPrice(symbol);
            const candle = await exchange.getLastCandle(symbol); // PARITY FIX: Need Low/High for Peak

            // Update Peak Price (for Trailing)
            // Python uses Low for Short, High for Long
            let peakPrice = botState.lastPeakPrice || entryPrice;
            if (candle) {
                if (side === 'SHORT') {
                    peakPrice = Math.min(peakPrice, candle.low);
                } else {
                    peakPrice = Math.max(peakPrice, candle.high);
                }
            } else {
                // Fallback if no candle (should not happen in backtest)
                if (side === 'SHORT') {
                    peakPrice = Math.min(peakPrice, markPrice);
                } else {
                    peakPrice = Math.max(peakPrice, markPrice);
                }
            }

            if (peakPrice !== botState.lastPeakPrice) {
                state.set({ lastPeakPrice: peakPrice });
            }

            // --- ANXIETY EXIT (Smart Re-evaluation) ---
            // Ask the model: "Do you still like this trade?"
            const nowTime = Date.now();
            if (nowTime - (botState.lastCheckAt || 0) > 60000) { // Check every 1 minute
                try {
                    // PARITY FIX: Use standard ML Service port
                    const latestSignal = await this.deps.mlService.getSignal(symbol);

                    // 1. Check for PASS (Idle) signal - Agent wants out
                    // Only exit if Agent is CONFIDENT outcome is PASS (Hold/Flat)
                    if (latestSignal.action === 'PASS' && latestSignal.confidence > 0.50) {
                        logger.info('🧠 Smart Exit Triggered: Agent signaled PASS', {
                            conf: latestSignal.confidence
                        });
                        await exchange.closeSideMarketSafe(symbol, side, position.qtyAbs, position.sideMode, 'AGENT_EXIT');
                        state.set({ mode: 'IDLE', lastExitAt: nowTime, lastExitReason: 'AGENT_EXIT' });
                        await this.notifyExit(symbol, side, 'AGENT_EXIT (PASS)', botState);
                        return;
                    }

                    // 2. Check for Reversal (Flip)
                    // If we are LONG and signal is SHORT (with confidence), or vice versa
                    if (side === 'SHORT' && latestSignal.action === 'LONG' && latestSignal.confidence > 0.55) {
                        logger.warn('🧠 Smart Exit Triggered: Agent flipped LONG', {
                            conf: latestSignal.confidence
                        });
                        // Close immediately (and potentially re-enter on next tick via normal logic)
                        await exchange.closeSideMarketSafe(symbol, side, position.qtyAbs, position.sideMode, 'AGENT_FLIP');
                        state.set({ mode: 'IDLE', lastExitAt: nowTime, lastExitReason: 'AGENT_FLIP' });
                        await this.notifyExit(symbol, side, 'AGENT_FLIP (LONG)', botState);
                        return;
                    }

                    if (side === 'LONG' && latestSignal.action === 'SHORT' && latestSignal.confidence > 0.55) {
                        logger.warn('🧠 Smart Exit Triggered: Agent flipped SHORT', {
                            conf: latestSignal.confidence
                        });
                        await exchange.closeSideMarketSafe(symbol, side, position.qtyAbs, position.sideMode, 'AGENT_FLIP');
                        state.set({ mode: 'IDLE', lastExitAt: nowTime, lastExitReason: 'AGENT_FLIP' });
                        await this.notifyExit(symbol, side, 'AGENT_FLIP (SHORT)', botState);
                        return;
                    }

                    // 3. Lost Conviction (Confidence Drop)
                    // If confidence drops below threshold substantially
                    // (Optional: V30 might handle this by switching to PASS, but good safeguard)
                    if (latestSignal.confidence < 0.30) {
                        logger.warn('🧠 Smart Exit Triggered: Lost Conviction', {
                            conf: latestSignal.confidence
                        });
                        await exchange.closeSideMarketSafe(symbol, side, position.qtyAbs, position.sideMode, 'See_Ya');
                        state.set({ mode: 'IDLE', lastExitAt: nowTime, lastExitReason: 'LOST_CONVICTION' });
                        await this.notifyExit(symbol, side, 'LOST_CONVICTION', botState);
                        return;
                    }

                    // Update heartbeat check time
                    state.set({ lastCheckAt: nowTime });

                } catch (infError) {
                    logger.warn('Smart Exit check failed (ignoring)', { error: String(infError) });
                }
            }

            // PARITY FIX: Update Peak ROE
            if (candle) {
                const currentRoe = side === 'SHORT'
                    ? (entryPrice - candle.low) / entryPrice * (botState.lastLeverage || 1)
                    : (candle.high - entryPrice) / entryPrice * (botState.lastLeverage || 1);

                if (currentRoe > (botState.peakRoe || -999)) {
                    state.set({ peakRoe: currentRoe });
                }

                // --- HEARTBEAT LOG (RIDE) ---
                const currentBalance = await exchange.getUSDTBalance();
                const entryBalance = botState.lastEntryWallet || currentBalance;
                const pnlLog = currentBalance - entryBalance;

                logger.info('phantom_tick', {
                    symbol,
                    price: candle.close,
                    action: side, // LONG or SHORT
                    conf: botState.lastMlProb || 0, // Show original entry conf
                    cvdSlope: 0, // Not checking ML during ride
                    cvdZ: 0,
                    weakness: 0,
                    pnl: pnlLog,
                    roe: currentRoe * 100
                });
                // -----------------------------
            }

            // Get current SL price (to know if we need to move it)
            const openOrders = await exchange.listCloseOrdersForSide(symbol, side);
            const currentSlOrder = openOrders.find(o => o.type.includes('STOP'));
            const currentSlPrice = currentSlOrder ? Number(currentSlOrder.stopPrice) : undefined;
            const currentTpOrder = openOrders.find(o => o.type.includes('TAKE_PROFIT'));

            // ═══════════════════════════════════════════════════════════════════════════
            // 🛡️ BRACKET RESTORATION (Auto-Heal)
            // If SL or TP are missing (manually deleted?), restore them immediately.
            // ═══════════════════════════════════════════════════════════════════════════

            const filters = await exchange.getSymbolFilters(symbol, botState.lastLeverage || 10);
            const tickSize = filters.tickSize;
            const roundToTick = (price: number) => {
                const inverse = 1 / tickSize;
                return Math.floor(price * inverse) / inverse;
            };

            // 1. Restore Stop Loss
            if (!currentSlOrder) {
                logger.warn('⚠️ Missing Stop Loss detected! Restoring...', { symbol });

                let restoreSlPrice = side === 'SHORT'
                    ? entryPrice * (1 + Math.abs(guardianConfig.beTriggerRoe)) // Fallback safe default? No, use hardStop
                    : entryPrice * (1 - Math.abs(guardianConfig.beTriggerRoe));

                // Better: Use Regime Hard Stop
                const regimeConfig = configManager.getRegimeConfig('PHANTOM', symbol);
                restoreSlPrice = side === 'SHORT'
                    ? entryPrice * (1 - regimeConfig.hardStopRoe) // hardStopRoe is negative (-0.015) -> 1 - (-0.015) = 1.015
                    : entryPrice * (1 + regimeConfig.hardStopRoe); // 1 + (-0.015) = 0.985

                restoreSlPrice = roundToTick(restoreSlPrice);

                try {
                    await exchange.placeStopClose(symbol, side, restoreSlPrice, position.qtyAbs);
                    logger.info('✅ Stop Loss Restored', { price: restoreSlPrice });
                    await notifier.sendMessage(`🛡️ **SL Restored** for ${symbol} @ ${restoreSlPrice}`);
                } catch (e) {
                    logger.error('Failed to restore SL', { error: String(e) });
                }
            }

            // 2. Restore Take Profit
            // 2. Restore Take Profit
            if (!currentTpOrder) {
                logger.warn('⚠️ Missing Take Profit detected! Restoring...', { symbol });

                const regimeConfig = configManager.getRegimeConfig('PHANTOM', symbol);
                let restoreTpPrice: number;

                if (side === 'SHORT') {
                    // Prevent negative price for >100% profit targets
                    // If tpRoe is 10 (1000%), 1 - 10 = -9 (Invalid)
                    // Logic: If ROE implies price < 0, cap at 0.0001 (or 99.9% drop)
                    const targetFactor = 1 - regimeConfig.tpRoe;
                    if (targetFactor <= 0) {
                        restoreTpPrice = entryPrice * 0.01; // 99% drop target (Max realistic)
                    } else {
                        restoreTpPrice = entryPrice * targetFactor;
                    }
                } else {
                    restoreTpPrice = entryPrice * (1 + regimeConfig.tpRoe);
                }

                // Validation
                if (!entryPrice || entryPrice <= 0 || !regimeConfig.tpRoe) {
                    logger.error('Cannot restore TP: Invalid inputs', { entryPrice, tpRoe: regimeConfig.tpRoe });
                    return; // Stop here
                }

                restoreTpPrice = roundToTick(restoreTpPrice);

                if (isNaN(restoreTpPrice) || restoreTpPrice <= 0) {
                    logger.error('Cannot restore TP: Invalid calculated price', { restoreTpPrice, entryPrice, roe: regimeConfig.tpRoe });
                    return;
                }

                try {
                    logger.info('Attempting to restore TP', { symbol, side, price: restoreTpPrice, qty: position.qtyAbs });
                    await exchange.placeTpClose(symbol, side, restoreTpPrice, position.qtyAbs);
                    logger.info('✅ Take Profit Restored', { price: restoreTpPrice });
                    await notifier.sendMessage(`💰 **TP Restored** for ${symbol} @ ${restoreTpPrice}`);
                } catch (e) {
                    logger.error('Failed to restore TP', { error: String(e) });
                }
            }

            // Evaluate Guardian Action

            const action = evaluateGuardianAction(
                {
                    entryPrice,
                    currentPrice: markPrice,
                    peakPrice,
                    positionSide: side,
                    leverage: botState.lastLeverage || 1,
                    peakRoe: botState.peakRoe // PARITY FIX: Pass Peak ROE
                },
                guardianConfig,
                currentSlPrice
            );

            // Execute Action
            switch (action.type) {
                case 'MOVE_SL_BE':
                    logger.info('🛡️ Moving SL to Break-Even', { symbol, price: action.price });
                    await exchange.placeStopClose(symbol, side, action.price);
                    await notifier.sendMessage(`🛡️ Break-Even Triggered: SL moved to ${action.price.toFixed(2)}`);
                    break;

                case 'MOVE_SL_TRAILING':
                    logger.info('🛡️ Updating Trailing SL', { symbol, price: action.price });
                    await exchange.placeStopClose(symbol, side, action.price);
                    break;

                case 'CLOSE_MARKET':
                    logger.info('🛡️ Guardian Force Close', { symbol, reason: action.reason });
                    await exchange.closeSideMarketSafe(symbol, side, position.qtyAbs, position.sideMode);
                    state.set({ mode: 'IDLE', lastExitAt: Date.now(), lastExitReason: action.reason });
                    await this.notifyExit(symbol, side, action.reason, botState);
                    break;
            }

        } catch (error) {
            logger.warn('Position management error', { symbol, error: String(error) });
            await this.notifyError(symbol, 'MANAGEMENT ERROR', error);
        }
    }

    /**
     * Reset daily trade counter at midnight
     */
    private checkDailyReset(): void {
        const now = Date.now();
        const today = Math.floor(now / 86400000);

        if (today > this.lastTradeDayReset) {
            this.tradesToday = 0;
            this.lastTradeDayReset = today;
            this.tradesToday = 0;
            this.lastTradeDayReset = today;
        }
    }

    private async notifyExit(
        symbol: string,
        side: Side,
        reason: string,
        botState: BotState
    ): Promise<void> {
        const { exchange, notifier } = this.deps;
        const currentBalance = await exchange.getUSDTBalance();
        const entryBalance = botState.lastEntryWallet || currentBalance;
        const pnl = currentBalance - entryBalance;
        const durationMs = Date.now() - (botState.lastEntryAt || Date.now());
        const durationHrs = (durationMs / 3600000).toFixed(2);

        // ROE Calculation
        let roeStr = "N/A";
        if (botState.lastEntryQty && botState.lastLeverage && botState.lastEntryPrice) {
            const margin = (botState.lastEntryPrice * botState.lastEntryQty) / botState.lastLeverage;
            const roe = (pnl / margin) * 100;
            roeStr = `${roe.toFixed(2)}%`;
        }

        const emoji = pnl >= 0 ? '🤑' : '🩸';
        const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;

        await notifier.sendMessage(
            `${emoji} **TRADE FINISHED**\n` +
            `Symbol: ${symbol}\n` +
            `Side: ${side}\n` +
            `Reason: ${reason}\n` +
            `Duration: ${durationHrs}h\n` +
            `PnL: ${pnlStr} (${roeStr})\n` +
            `Balance: $${currentBalance.toFixed(2)}`
        );
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
