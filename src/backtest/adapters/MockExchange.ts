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

    constructor(initialBalance: number = 20.0) {
        this.walletBalance = initialBalance;
    }

    // --- Backtest Control Methods ---

    public setCandle(candle: Candle, nextCandle: Candle | null) {
        this.currentCandle = candle;
        this.nextCandle = nextCandle;
        // Do NOT auto-check orders here. Let the Runner/Service trigger recheckOrders()
        // to support intra-candle simulation.
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

            // Use whatever price is currently set in the candle (might be mutated for simulation)
            const low = this.currentCandle!.low;
            const high = this.currentCandle!.high;

            const slOrder = orders.find(o => o.type.includes('STOP'));
            const tpOrder = orders.find(o => o.type.includes('TAKE_PROFIT') || o.type === 'LIMIT');

            const storedPos = position as any;
            const side = storedPos.side as Side;

            let hardSlHit = false;
            let tpHit = false;
            let exitPrice = 0;
            let exitReason = '';

            // 1. Check Stop Loss
            if (slOrder) {
                const stopPrice = Number(slOrder.stopPrice);
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
            }

            // 2. Check Take Profit
            if (!hardSlHit && tpOrder) {
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
            if (hardSlHit) {
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

    subscribeToCandles(symbol: string): void {
        // Mock implementation: do nothing
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
            qtyPrecision: 20, // PARITY FIX: High precision to match Python floats
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
