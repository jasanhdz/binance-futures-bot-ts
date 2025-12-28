import path from 'path';
import Database from 'better-sqlite3';

import { COLORS } from '../../infra/fs/FsLogger';
import { atr } from '../../core/indicators/atr';
import { MlProbabilityServiceClient } from '../../ml/ml_probability_service';
import { roundToTick } from '../../core/risk/stop';

// --- Configuration ---
const DB_PATH = path.resolve(__dirname, '../../../../data/market_data_v2.db');
const ATR_PERIOD = 14;
const GUARDIAN_ATR_MULT = 3.0; // Base multiplier
const GUARDIAN_MIN_ROE = 0.05; // Lock breakeven after 5%
const ORACLE_PANIC_THRESHOLD = 0.70; // Exit if counter-prob > 70%
const WATCHER_OBI_PANIC = -0.3; // Exit if OBI drops below -0.3 (for Long)
const WATCHER_DEPTH_DROP = 0.5; // 50% drop in depth

export class SageExitGuard {
    private static instance: SageExitGuard;
    private mlClient: MlProbabilityServiceClient;
    private db: Database.Database | null = null;

    private constructor() {
        this.mlClient = new MlProbabilityServiceClient();
        try {
            this.db = new Database(DB_PATH, { readonly: true, timeout: 1000 });
        } catch (e) {
            console.error('SageExitGuard: Failed to open DB', e);
        }
    }

    static getInstance(): SageExitGuard {
        if (!SageExitGuard.instance) {
            SageExitGuard.instance = new SageExitGuard();
        }
        return SageExitGuard.instance;
    }

    private getLatestOrderBookMetrics(symbol: string): any {
        if (!this.db) return null;
        try {
            // Normalize symbol for DB (ADAUSDT -> ADA/USDT:USDT)
            // This is a heuristic, might need adjustment based on how collector stores it
            // For now assuming exact match or simple transformation
            const stmt = this.db.prepare(`
        SELECT * FROM orderbook_metrics 
        WHERE symbol LIKE ? 
        ORDER BY timestamp DESC LIMIT 1
      `);
            // Try fuzzy match
            return stmt.get(`%${symbol}%`);
        } catch (e) {
            return null;
        }
    }

    async check(deps: {
        symbol: string;
        exchange: any;
        state: any;
        logger: any;
        config: any;
    }): Promise<void> {
        const { symbol, exchange, state, logger, config } = deps;
        const st = await state.get();

        if (!st || st.mode === 'IDLE' || !st.lastSide || !st.lastEntryPrice) {
            return;
        }

        const pos = await exchange.readActivePosition(symbol, st.lastSide);
        if (!pos || !pos.qtyAbs) return;

        const currentPrice = await exchange.getMarkPrice(symbol);
        const filters = await exchange.getSymbolFilters(symbol, st.lastLeverage || 1);

        // Calculate ROE
        const direction = st.lastSide === 'LONG' ? 1 : -1;
        const pnl = (currentPrice - st.lastEntryPrice) * pos.qtyAbs * direction;
        const margin = (st.lastEntryPrice * pos.qtyAbs) / (st.lastLeverage || 1);
        const roe = margin > 0 ? pnl / margin : 0;

        // 1. Guardian (Dynamic ATR Trailing)
        const candles = await exchange.getCandles(symbol, '15m', 50); // Use 15m for volatility
        const currentAtr = atr(candles, ATR_PERIOD);

        if (!Number.isNaN(currentAtr)) {
            let mult = GUARDIAN_ATR_MULT;

            // Tighten if ROE is high
            if (roe > 0.20) mult = 2.0;
            if (roe > 0.50) mult = 1.5;

            let stopPrice: number;
            if (st.lastSide === 'LONG') {
                stopPrice = currentPrice - (currentAtr * mult);
                // Breakeven lock
                if (roe > GUARDIAN_MIN_ROE) {
                    stopPrice = Math.max(stopPrice, st.lastEntryPrice * 1.002); // Entry + 0.2% fees
                }
            } else {
                stopPrice = currentPrice + (currentAtr * mult);
                // Breakeven lock
                if (roe > GUARDIAN_MIN_ROE) {
                    stopPrice = Math.min(stopPrice, st.lastEntryPrice * 0.998); // Entry - 0.2% fees
                }
            }

            stopPrice = roundToTick(stopPrice, filters.tickSize, filters.pricePrecision);

            // Update Stop Loss if it improves
            const currentStop = await exchange.openStopForSide(symbol, st.lastSide);
            let shouldUpdate = false;

            if (st.lastSide === 'LONG') {
                if (!currentStop || stopPrice > currentStop.stopPrice) shouldUpdate = true;
            } else {
                if (!currentStop || stopPrice < currentStop.stopPrice) shouldUpdate = true;
            }

            if (shouldUpdate) {
                if (currentStop) await exchange.cancelOrderById(symbol, currentStop.orderId);
                await exchange.placeStopClose(symbol, st.lastSide, stopPrice);
                logger?.info('sage_guardian_update', { roe, atr: currentAtr, newStop: stopPrice });
            }
        }

        // 2. Oracle (ML Predictive Exit)
        try {
            const mlResp = await this.mlClient.fetchProbabilities({ symbol });
            const counterProb = st.lastSide === 'LONG' ? mlResp.short_prob : mlResp.long_prob;
            const supportProb = st.lastSide === 'LONG' ? mlResp.long_prob : mlResp.short_prob;

            // Panic Exit
            if (counterProb > ORACLE_PANIC_THRESHOLD) {
                logger?.warn('sage_oracle_panic', { counterProb, threshold: ORACLE_PANIC_THRESHOLD });
                await exchange.closeSideMarketSafe(symbol, st.lastSide, pos.qtyAbs, pos.sideMode);
                st.mode = 'IDLE';
                st.lastExitReason = 'sage_oracle_panic';
                await state.set(st);
                return;
            }

            // Sniper Logic (Cancel TP if strong trend)
            if (supportProb > 0.80) {
                // Check if we have a TP close
                // This requires listing orders, which might be expensive. 
                // For now, we assume if we are here, we are riding.
                // We could cancel TP here if we implemented that logic.
            }

        } catch (e) {
            // Ignore ML errors, fallback to Guardian
        }

        // 3. Watcher (Order Book Imbalance)
        const obMetrics = this.getLatestOrderBookMetrics(symbol);
        if (obMetrics) {
            const obi = obMetrics.obi_20; // Assuming column name

            // Panic if OBI flips against us strongly
            let panic = false;
            if (st.lastSide === 'LONG' && obi < WATCHER_OBI_PANIC) panic = true;
            if (st.lastSide === 'SHORT' && obi > -WATCHER_OBI_PANIC) panic = true;

            if (panic) {
                logger?.warn('sage_watcher_panic', { obi, threshold: WATCHER_OBI_PANIC });
                await exchange.closeSideMarketSafe(symbol, st.lastSide, pos.qtyAbs, pos.sideMode);
                st.mode = 'IDLE';
                st.lastExitReason = 'sage_watcher_panic';
                await state.set(st);
                return;
            }
        }
    }
}

export const sageExit = SageExitGuard.getInstance();
