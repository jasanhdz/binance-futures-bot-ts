import { describe, it, expect, beforeEach } from 'vitest';
import { MockExchange } from './MockExchange';
import { Candle } from '../../domain/types';

describe('MockExchange', () => {
    let exchange: MockExchange;
    const baseTime = 1700000000000;

    beforeEach(() => {
        exchange = new MockExchange(100.0); // Start with $100
    });

    function createCandle(price: number, high: number, low: number): Candle {
        return {
            openTime: baseTime,
            timestamp: baseTime,
            open: price,
            high: high,
            low: low,
            close: price,
            volume: 1000, buyVolume: 500,
            closeTime: baseTime + 300000
        };
    }

    it('should open a LONG position correctly', async () => {
        const candle = createCandle(2000, 2010, 1990);
        exchange.setCandle(candle, null);

        await exchange.setLeverage('ETHUSDT', 10);
        await exchange.marketOpen('ETHUSDT', 'LONG', 1.0); // 1 ETH

        const position = await exchange.readActivePosition('ETHUSDT', 'LONG');
        expect(position).toBeDefined();
        expect(position?.entryPrice).toBe(2000);
        expect(position?.qtyAbs).toBe(1.0);
        expect(position?.leverage).toBe(10);
    });

    it('should execute STOP LOSS for LONG position', async () => {
        // 1. Open Long at 2000
        const entryCandle = createCandle(2000, 2005, 1995);
        exchange.setCandle(entryCandle, null);
        await exchange.marketOpen('ETHUSDT', 'LONG', 1.0);
        await exchange.placeStopClose('ETHUSDT', 'LONG', 1990); // SL at 1990

        // 2. Next Candle hits SL (Low 1980)
        const crashCandle = createCandle(1995, 2000, 1980);
        exchange.setCandle(crashCandle, null);
        exchange.recheckOrders();

        // 3. Verify Closure
        const position = await exchange.readActivePosition('ETHUSDT', 'LONG');
        expect(position).toBeNull();

        const trades = exchange.getTrades();
        expect(trades.length).toBe(1);
        expect(trades[0].exitPrice).toBe(1990); // Should execute at SL price
        expect(trades[0].pnl).toBe(-10); // (1990 - 2000) * 1
    });

    it('should execute TAKE PROFIT for SHORT position', async () => {
        // 1. Open Short at 2000
        const entryCandle = createCandle(2000, 2005, 1995);
        exchange.setCandle(entryCandle, null);
        await exchange.marketOpen('ETHUSDT', 'SHORT', 1.0);
        await exchange.placeTpClose('ETHUSDT', 'SHORT', 1950); // TP at 1950

        // 2. Next Candle hits TP (Low 1940)
        const dumpCandle = createCandle(1980, 1990, 1940);
        exchange.setCandle(dumpCandle, null);
        exchange.recheckOrders();

        // 3. Verify Closure
        const position = await exchange.readActivePosition('ETHUSDT', 'SHORT');
        expect(position).toBeNull();

        const trades = exchange.getTrades();
        expect(trades.length).toBe(1);
        expect(trades[0].exitPrice).toBe(1950); // Should execute at TP price
        expect(trades[0].pnl).toBe(50); // (2000 - 1950) * 1
    });

    it('should NOT execute SL if price does not touch it', async () => {
        // 1. Open Long at 2000, SL 1900
        const entryCandle = createCandle(2000, 2005, 1995);
        exchange.setCandle(entryCandle, null);
        await exchange.marketOpen('ETHUSDT', 'LONG', 1.0);
        await exchange.placeStopClose('ETHUSDT', 'LONG', 1900);

        // 2. Next Candle Low is 1950 (Safe)
        const safeCandle = createCandle(1980, 2000, 1950);
        exchange.setCandle(safeCandle, null);
        exchange.recheckOrders();

        // 3. Verify Position Still Open
        const position = await exchange.readActivePosition('ETHUSDT', 'LONG');
        expect(position).toBeDefined();
    });
});
