import { Exchange, PositionInfo, TradeFill, SymbolFilters, FundingSnapshot, BasisSnapshot } from '../../app/ports/Exchange';
import { Side, Candle } from '../../domain/types';

export class MockExchange implements Exchange {
    private currentCandle: Candle | null = null;
    private nextCandle: Candle | null = null;
    private walletBalance: number = 20.0; // Initial balance from backtest
    private positions: Map<string, PositionInfo> = new Map();
    private activeOrders: Map<string, any[]> = new Map(); // symbol -> orders
    private leverage: Map<string, number> = new Map();
    private trades: any[] = [];

    // Track Break-Even state per symbol (for TRAILING detection)
    private breakEvenActive: Map<string, boolean> = new Map();
    private previousSlPrice: Map<string, number> = new Map();
    private peakPrices: Map<string, number> = new Map();

    constructor(initialBalance: number = 20.0) {
        this.walletBalance = initialBalance;
    }

    // --- Backtest Control Methods ---

    public setCandle(candle: Candle, nextCandle: Candle | null) {
        // DEBUG: Track candle changes for Trade 3
        if (candle.timestamp === 1737324000000 || candle.timestamp === 1737324300000) {
            console.log(`[MOCK EXCHANGE] setCandle called: ${candle.timestamp} (${new Date(candle.timestamp).toISOString()})`);
        }

        this.currentCandle = candle;
        this.nextCandle = nextCandle;
        this.checkOrders(); // Check if any open orders are filled by current price action
    }

    public getTrades() {
        return this.trades;
    }

    public getBalance() {
        return this.walletBalance;
    }

    public getPositionsMap() {
        return this.positions;
    }

    public recheckOrders() {
        this.checkOrders();
    }

    private checkOrders() {
        if (!this.currentCandle) return;

        this.activeOrders.forEach((orders, symbol) => {
            const position = this.positions.get(symbol);
            if (!position) return;

            const low = this.currentCandle!.low;
            const high = this.currentCandle!.high;

            const slOrder = orders.find(o => o.type.includes('STOP'));
            const tpOrder = orders.find(o => o.type.includes('TAKE_PROFIT') || o.type === 'LIMIT');

            // We need to retrieve the side from our internal storage
            const storedPos = position as any; // Cast to any to access 'side'
            const side = storedPos.side as Side;

            // PARITY FIX: Simulate "Best Case" order (Low before High for SHORT)
            // Python checks BE trigger (Low) before SL (High).
            // If ROE > 10%, assume BE triggered and SL moved to Entry.

            // PARITY FIX: Match Python Order of Operations
            // 1. Update Peak Price & Check BE Trigger (using LOW)
            // 2. Check Trailing Stop (using HIGH)
            // 3. Check Hard SL (using HIGH)

            // 1. Update Peak & BE
            const entryPrice = position.entryPrice;
            let peakPrice = this.peakPrices.get(symbol) || entryPrice;
            if (side === 'SHORT') {
                if (low < peakPrice) peakPrice = low;
            } else {
                if (high > peakPrice) peakPrice = high;
            }
            this.peakPrices.set(symbol, peakPrice);

            let effectiveSlPrice = slOrder ? Number(slOrder.stopPrice) : null;
            let isBeSimulated = false;

            if (side === 'SHORT') {
                const leverage = this.leverage.get(symbol) || 5;
                const roe = (entryPrice - low) / entryPrice * leverage;

                // If we hit 10% ROE, assume BE triggered first
                if (roe >= 0.10) {
                    // console.log(`[MOCK] BE Simulated! ROE=${roe.toFixed(4)}, Low=${low}`);
                    const bePrice = entryPrice * 0.997; // 0.3% profit
                    // Only move SL if it improves
                    if (effectiveSlPrice === null || bePrice < effectiveSlPrice) {
                        effectiveSlPrice = bePrice;
                        isBeSimulated = true;
                    }
                }
            }

            let hardSlHit = false;
            let tpHit = false;
            let trailingHit = false;
            let exitPrice = 0;
            let exitReason = '';

            // 2. Check Trailing (Intra-candle)
            // Python checks Trailing BEFORE Hard SL (if BE is active)
            const isBreakEven = this.breakEvenActive.get(symbol) || isBeSimulated;

            if (isBreakEven) {
                const trailingDev = 0.015; // Hardcoded from config
                let trailingSlPrice = 0;

                // Calculate Trailing Price based on Peak
                if (side === 'SHORT') {
                    trailingSlPrice = peakPrice * (1 + trailingDev);
                    if (high >= trailingSlPrice) {
                        trailingHit = true;
                        exitPrice = trailingSlPrice;
                        exitReason = 'TRAILING';
                    }
                } else { // LONG
                    trailingSlPrice = peakPrice * (1 - trailingDev);
                    if (low <= trailingSlPrice) {
                        trailingHit = true;
                        exitPrice = trailingSlPrice;
                        exitReason = 'TRAILING';
                    }
                }
            }

            // 3. Check Hard SL (including BE if moved)
            if (!trailingHit && effectiveSlPrice) {
                const stopPrice = effectiveSlPrice;
                if (side === 'SHORT') {
                    if (high >= stopPrice) {
                        hardSlHit = true;
                        exitPrice = stopPrice;
                        exitReason = 'STOP_LOSS';
                    }
                } else { // LONG
                    if (low <= stopPrice) {
                        hardSlHit = true;
                        exitPrice = stopPrice;
                        exitReason = 'STOP_LOSS';
                    }
                }
            } else if (!trailingHit && slOrder) {
                // Fallback to original SL order
                const stopPrice = Number(slOrder.stopPrice);
                if (side === 'SHORT') {
                    if (high >= stopPrice) {
                        hardSlHit = true;
                        exitPrice = stopPrice;
                        exitReason = 'STOP_LOSS';
                    }
                } else {
                    if (low <= stopPrice) {
                        hardSlHit = true;
                        exitPrice = stopPrice;
                        exitReason = 'STOP_LOSS';
                    }
                }
            }

            // 4. Check TP (Lowest Priority in Python loop, checked last)
            if (!hardSlHit && !trailingHit && tpOrder) {
                const tpPrice = Number(tpOrder.stopPrice || tpOrder.price);
                if (side === 'SHORT') {
                    if (low <= tpPrice) {
                        tpHit = true;
                        exitPrice = tpPrice;
                        exitReason = 'TAKE_PROFIT';
                    }
                } else {
                    if (high >= tpPrice) {
                        tpHit = true;
                        exitPrice = tpPrice;
                        exitReason = 'TAKE_PROFIT';
                    }
                }
            }

            // EXECUTE
            if (trailingHit) {
                this.closePosition(symbol, position, exitPrice, 'TRAILING');
            } else if (hardSlHit) {
                // console.log(`[MOCK] Closing Position. Reason: STOP_LOSS. SL_Hit: true`);
                this.closePosition(symbol, position, exitPrice, 'STOP_LOSS');
            } else if (tpHit) {
                this.closePosition(symbol, position, exitPrice, 'TAKE_PROFIT');
            }


        });
    }

    private closePosition(symbol: string, position: PositionInfo, price: number, reason: string) {
        const qty = Math.abs(position.qtyAbs);
        const entryPrice = position.entryPrice;
        const exitPrice = Number(price);
        const storedPos = position as any;
        const side = storedPos.side as Side;
        const entryTime = storedPos.entryTime as number;

        let pnl = 0;
        if (side === 'LONG') {
            pnl = (exitPrice - entryPrice) * qty;
        } else {
            pnl = (entryPrice - exitPrice) * qty;
        }

        const fee = 0; // DISABLED TO MATCH PYTHON BACKTEST PARITY
        const netPnl = pnl - fee;

        this.walletBalance += netPnl;

        this.trades.push({
            symbol,
            side,
            entryPrice,
            exitPrice,
            qty,
            pnl: netPnl,
            reason,
            timestamp: this.currentCandle?.timestamp, // Exit Time
            entryTime // Entry Time
        });

        this.positions.delete(symbol);
        this.activeOrders.set(symbol, []);
        this.breakEvenActive.delete(symbol);  // Clean up BE state
        this.previousSlPrice.delete(symbol);  // Clean up SL tracking
        this.peakPrices.delete(symbol);       // Clean up Peak Price tracking
    }

    // --- Exchange Interface Implementation ---

    async getServerTime(): Promise<number> {
        return this.currentCandle ? this.currentCandle.timestamp : Date.now();
    }

    async getCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
        return this.currentCandle ? [this.currentCandle] : [];
    }

    async getMarkPrice(symbol: string): Promise<number> {
        if (!this.currentCandle) throw new Error("No candle set");
        return this.currentCandle.close;
    }

    async getLastCandle(symbol: string): Promise<Candle | null> {
        return this.currentCandle;
    }

    async getFundingRate(symbol: string): Promise<FundingSnapshot> {
        return { rate: 0.0001, nextFundingTime: Date.now() + 3600000 };
    }

    async getBasisSnapshot(symbol: string): Promise<BasisSnapshot> {
        return { markPrice: this.currentCandle?.close || 0, indexPrice: this.currentCandle?.close || 0, basisPct: 0 };
    }

    async readLiquidationPrice(symbol: string, side: Side): Promise<number | null> {
        return null;
    }

    async getUSDTBalance(): Promise<number> {
        return this.walletBalance;
    }

    async getSymbolFilters(symbol: string, leverage: number): Promise<SymbolFilters> {
        return {
            tickSize: 0.01,
            stepSize: 0.001,
            pricePrecision: 2,
            qtyPrecision: 3,
            minNotional: 0.0,
            notionalCap: 1000000
        };
    }

    async setLeverage(symbol: string, leverage: number): Promise<void> {
        this.leverage.set(symbol, leverage);
    }

    async ensureMarginType(symbol: string, type: 'ISOLATED' | 'CROSSED' = 'ISOLATED'): Promise<void> {
        // No-op
    }

    async hasOpenPosition(symbol: string, side: 'LONG' | 'SHORT' | 'ANY'): Promise<boolean> {
        const pos = this.positions.get(symbol);
        if (!pos) return false;
        const storedPos = pos as any;
        if (side === 'ANY') return true;
        return storedPos.side === side;
    }

    async marketOpen(symbol: string, side: Side, quantity: number): Promise<{ avgPrice: number; orderId: string }> {
        const price = this.currentCandle!.close;
        const entryTime = this.currentCandle!.timestamp;

        const position: PositionInfo = {
            qtyAbs: quantity,
            entryPrice: price,
            leverage: this.leverage.get(symbol) || 1,
            sideMode: 'BOTH', // Default
            unrealizedPnl: 0,
            roePct: 0
        };

        // Store side and entryTime internally
        (position as any).side = side;
        (position as any).entryTime = entryTime;

        this.positions.set(symbol, position);

        return {
            avgPrice: price,
            orderId: Math.floor(Math.random() * 1000000).toString()
        };
    }

    async placeStopClose(symbol: string, side: Side, stopPrice: number, qty?: number): Promise<boolean> {
        const orders = this.activeOrders.get(symbol) || [];
        const newOrders = orders.filter(o => !o.type.includes('STOP'));

        // Detect if this is a Break-Even or Trailing SL update
        const previousSl = this.previousSlPrice.get(symbol);
        const position = this.positions.get(symbol);

        if (position) {
            const storedPos = position as any;
            const positionSide = storedPos.side as Side;
            const entryPrice = position.entryPrice;

            // Check if SL is at or better than entry (Break-Even activated)
            const bePrice = positionSide === 'SHORT' ? entryPrice * 0.997 : entryPrice * 1.003;
            const isAtBreakEven = positionSide === 'SHORT'
                ? stopPrice <= bePrice
                : stopPrice >= bePrice;

            if (isAtBreakEven) {
                this.breakEvenActive.set(symbol, true);
            }
        }

        this.previousSlPrice.set(symbol, stopPrice);

        newOrders.push({
            type: 'STOP_MARKET',
            side: side === 'LONG' ? 'SHORT' : 'LONG',
            stopPrice,
            reduceOnly: true
        });

        this.activeOrders.set(symbol, newOrders);
        return true;
    }

    async placeTpClose(symbol: string, side: Side, triggerPrice: number, qty?: number): Promise<boolean> {
        const orders = this.activeOrders.get(symbol) || [];
        const newOrders = orders.filter(o => !o.type.includes('TAKE_PROFIT'));

        newOrders.push({
            type: 'TAKE_PROFIT_MARKET',
            side: side === 'LONG' ? 'SHORT' : 'LONG',
            stopPrice: triggerPrice,
            reduceOnly: true
        });

        this.activeOrders.set(symbol, newOrders);
        return true;
    }

    async readActivePosition(symbol: string, sideHint: Side): Promise<PositionInfo | null> {
        const pos = this.positions.get(symbol);
        if (!pos) return null;
        const storedPos = pos as any;
        if (storedPos.side !== sideHint) return null;
        return pos;
    }

    async listCloseOrdersForSide(symbol: string, side: Side): Promise<any[]> {
        return this.activeOrders.get(symbol) || [];
    }

    async closeSideMarketSafe(symbol: string, side: Side, qtyAbs: number, sideMode: 'BOTH' | 'LONG' | 'SHORT', reason?: string): Promise<void> {
        const pos = this.positions.get(symbol);
        if (pos) {
            this.closePosition(symbol, pos, this.currentCandle!.close, reason || 'MARKET_CLOSE');
        }
    }

    async openStopForSide(symbol: string, side: Side): Promise<{ stopPrice: number; orderId: string } | null> {
        return null;
    }

    async cancelOrderById(symbol: string, orderId: string): Promise<void> {
        // No-op
    }

    async getRecentFills(symbol: string, startTime?: number, limit?: number): Promise<TradeFill[]> {
        return [];
    }

    // Missing methods from Exchange interface
    async getPositionMode(): Promise<'ONE_WAY' | 'HEDGE'> {
        return 'ONE_WAY';
    }

    async getPositionRisk(symbol: string): Promise<any[]> {
        return [];
    }

    async getAccountInfo(): Promise<any> {
        return {};
    }

    async getExchangeInfo(): Promise<any> {
        return {};
    }

    async getOrder(symbol: string, orderId: string): Promise<any> {
        return null;
    }

    async cancelAllOrders(symbol: string): Promise<void> {
        this.activeOrders.set(symbol, []);
    }
}
