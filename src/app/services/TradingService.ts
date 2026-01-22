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
     * Start the trading loop
     */
    async start(): Promise<void> {
        const { logger, notifier } = this.deps;

        logger.info('🦅 PHANTOM Trading Bot Starting', {
            symbols: this.config.symbols,
            leverage: this.config.phantomConfig.leverage,
            threshold: this.config.phantomConfig.entryThreshold
        });

        await notifier.sendMessage(
            `🦅 PHANTOM Bot Started\n` +
            `Symbols: ${this.config.symbols.join(', ')}\n` +
            `Leverage: ${this.config.phantomConfig.leverage}x\n` +
            `Threshold: ${(this.config.phantomConfig.entryThreshold * 100).toFixed(0)}%`
        );

        this.isRunning = true;
        await this.runLoop();
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

                // Time Sentinel (Double Confirmation)
                if (this.isForbiddenTime()) {
                    logger.debug('Time Sentinel: Trading paused (Forbidden Hours)');
                    await this.sleep(60000); // Sleep 1 min
                    continue;
                }

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
     * Time Sentinel: Block trading during forbidden hours
     * Matches backtest logic: [1, 4, 5, 10, 13, 18, 19, 23] UTC
     */
    private isForbiddenTime(): boolean {
        const now = new Date();
        const hour = now.getUTCHours();
        const day = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat

        // Forbidden Hours (UTC) from backtest
        const FORBIDDEN_HOURS = [1, 4, 5, 10, 13, 18, 19, 23];

        // Forbidden Days (Tuesday = 2)
        if (day === 2) return true;

        return FORBIDDEN_HOURS.includes(hour);
    }

    /**
     * Process a single symbol
     */
    protected async processSymbol(symbol: string): Promise<void> {
        const { exchange, mlService, logger, state } = this.deps;
        const botState = state.get();

        try {
            // 1. Check if we have an active position
            const hasPosition = botState.mode !== 'IDLE';

            if (hasPosition) {
                // Manage existing position (handles re-entry if position closes)
                await this.managePosition(symbol, botState);
            } else {
                // Look for entry opportunities
                await this.lookForEntry(symbol);
            }

        } catch (error) {
            logger.warn('Symbol processing error', { symbol, error: String(error) });
        }
    }

    /**
     * Look for entry opportunities
     */
    private async lookForEntry(symbol: string): Promise<void> {
        const { mlService, exchange, logger, state, notifier, configManager } = this.deps;

        // DEBUG: Log when lookForEntry is called
        const candle = await exchange.getLastCandle(symbol);
        console.log(`[ENTRY ATTEMPT] Candle timestamp: ${candle?.timestamp}, checking for entry`);

        if (candle && candle.timestamp === 1737324000000) {
            console.log('[PARITY DEBUG] lookForEntry called for Trade 3 candle');
        }

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

        // Get symbol-specific config from YAML
        const regimeConfig = configManager.getRegimeConfig('PHANTOM', symbol);
        const capitalUsage = configManager.getCapitalAllocation(symbol, 'PHANTOM');
        let leverage = regimeConfig.leverage;
        const entryThreshold = regimeConfig.entryThreshold;

        // House Money Rule (Python parity): Reduce leverage after 2x profit
        if (balance >= this.initialBalance * this.houseMoneyMultiplier) {
            leverage = regimeConfig.leverage * this.houseMoneyReduction;
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

        // Get ML signal
        const signal = await mlService.getSignal(symbol);

        // Check if we should enter (using dynamic threshold)
        const phantomConfig: PhantomConfig = {
            leverage,
            entryThreshold,
            hardStopRoe: regimeConfig.hardStopRoe,
            tpRoe: regimeConfig.tpRoe
        };

        // Build PhantomTrigger context from ML features
        // This pre-filter ensures we only trade when CVD confirms distribution
        const currentCandle = await exchange.getLastCandle(symbol);
        const triggerCtx: PhantomTriggerContext | undefined = (signal.features && currentCandle) ? {
            currentCandle,
            cvdSlope: signal.features.cvd_slope ?? 0,
            cvdZ: signal.features.cvd_z ?? 0,
            weaknessScore: signal.features.weakness ?? 0
        } : undefined;

        // DEBUG: Trade 3 Investigation
        if (currentCandle && currentCandle.timestamp === 1737324000000) {  // 2025-01-19 22:00:00
            logger.info('[TS DEBUG Trade 3] shouldEnter check', {
                signal: signal.action,
                confidence: signal.confidence,
                threshold: entryThreshold,
                cvdSlope: signal.features?.cvd_slope,
                cvdZ: signal.features?.cvd_z,
                weakness: signal.features?.weakness,
                hasTriggerCtx: !!triggerCtx
            });
        }

        if (!shouldEnter(signal, phantomConfig, triggerCtx)) {
            // DEBUG: Trade 3 - Log WHY it was rejected
            if (currentCandle && currentCandle.timestamp === 1737324000000) {
                logger.info('[TS DEBUG Trade 3] Entry REJECTED by shouldEnter');
            }
            logger.debug('No entry signal', {
                symbol,
                confidence: signal.confidence,
                threshold: entryThreshold,
                triggerPassed: triggerCtx ? 'checked' : 'skipped'
            });
            return;
        }

        // DEBUG: Trade 3 - Log if entry approved
        if (currentCandle && currentCandle.timestamp === 1737324000000) {
            logger.info('[TS DEBUG Trade 3] Entry APPROVED by shouldEnter');
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

            // Calculate position size using DYNAMIC capital allocation
            // Python parity: position_size = balance * leverage
            const markPrice = await exchange.getMarkPrice(symbol);
            const notional = wallet * capitalUsage * leverage;  // ← Leveraged notional (matches Python)
            const quantity = Math.floor((notional / markPrice) * Math.pow(10, filters.qtyPrecision)) / Math.pow(10, filters.qtyPrecision);

            if (quantity * markPrice < filters.minNotional) {
                logger.warn('Position too small', {
                    symbol,
                    quantity,
                    minNotional: filters.minNotional
                });
                return;
            }

            // Set DYNAMIC leverage from YAML
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
                lastLeverage: leverage,  // ← DYNAMIC
                lastEntryAt: await exchange.getServerTime(), // PARITY FIX: Use exchange time
                peakRoe: 0,
                currentRegime: 'PHANTOM',
                lastPeakPrice: result.avgPrice // Initialize peak price
            });

            // Place brackets (SL/TP) using DYNAMIC config
            const stopPrice = side === 'SHORT'
                ? result.avgPrice * (1 - phantomConfig.hardStopRoe)  // For short: stop above entry
                : result.avgPrice * (1 + phantomConfig.hardStopRoe); // For long: stop below entry

            const tpPrice = side === 'SHORT'
                ? result.avgPrice * (1 - phantomConfig.tpRoe)
                : result.avgPrice * (1 + phantomConfig.tpRoe);

            await exchange.placeStopClose(symbol, side, stopPrice);
            await exchange.placeTpClose(symbol, side, tpPrice);

            this.tradesToday++;

            // Notify
            await notifier.sendMessage(
                `🎯 PHANTOM ENTRY\n` +
                `Symbol: ${symbol}\n` +
                `Side: ${side}\n` +
                `Entry: ${result.avgPrice.toFixed(2)}\n` +
                `SL: ${stopPrice.toFixed(2)}\n` +
                `TP: ${tpPrice.toFixed(2)}\n` +
                `Confidence: ${(signal.confidence * 100).toFixed(1)}%`
            );

            logger.info('✅ Position opened', {
                symbol,
                side,
                entry: result.avgPrice,
                orderId: result.orderId
            });

        } catch (error) {
            logger.error('Entry execution failed', { symbol, error: String(error) });
        }
    }

    /**
     * Manage existing position
     */
    /**
     * Manage existing position
     */
    private async managePosition(symbol: string, botState: BotState): Promise<void> {
        const { exchange, logger, state, notifier } = this.deps;
        const guardianConfig = this.config.guardianConfig;

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

                state.set({ mode: 'IDLE', lastExitAt: Date.now() });
                return;
            }

            // PARITY FIX: Check Time Limit (24h)
            if (botState.lastEntryAt) {
                const now = await exchange.getServerTime();
                const duration = now - botState.lastEntryAt;
                const TIME_LIMIT_MS = 24 * 60 * 60 * 1000; // 24 hours

                if (duration >= TIME_LIMIT_MS) {
                    logger.info('⏳ Time Limit Reached (24h), closing position', { duration: duration / 3600000 });
                    await exchange.closeSideMarketSafe(symbol, side, position.qtyAbs, position.sideMode, 'TIME_LIMIT');

                    state.set({
                        mode: 'IDLE',
                        lastExitAt: now,
                        lastExitReason: 'TIME_LIMIT'
                    });

                    await notifier.sendMessage(`⏳ Time Limit Exit (24h)`);
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

            // PARITY FIX: Update Peak ROE
            if (candle) {
                const currentRoe = side === 'SHORT'
                    ? (entryPrice - candle.low) / entryPrice * (botState.lastLeverage || 1)
                    : (candle.high - entryPrice) / entryPrice * (botState.lastLeverage || 1);

                if (currentRoe > (botState.peakRoe || -999)) {
                    state.set({ peakRoe: currentRoe });
                }
            }

            // Get current SL price (to know if we need to move it)
            const openOrders = await exchange.listCloseOrdersForSide(symbol, side);
            const currentSlOrder = openOrders.find(o => o.type.includes('STOP'));
            const currentSlPrice = currentSlOrder ? Number(currentSlOrder.stopPrice) : undefined;

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
                    await notifier.sendMessage(`🛡️ Guardian Exit: ${action.reason}`);
                    break;
            }

        } catch (error) {
            logger.warn('Position management error', { symbol, error: String(error) });
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
            this.deps.logger.info('Daily trade counter reset', { date: new Date().toISOString() });
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
