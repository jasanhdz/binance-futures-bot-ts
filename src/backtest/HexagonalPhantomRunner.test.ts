import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHexagonalBacktest } from './HexagonalPhantomRunner';
import { Candle } from '../domain/types';
import axios from 'axios';

// Mock Axios
vi.mock('axios');

describe('HexagonalPhantomRunner', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should execute a short trade when ML signal is strong', async () => {
        // 1. Create Synthetic Candles (Safe Time: Wed Nov 15 2023 12:00:00 UTC)
        const baseTime = 1700049600000;
        const candles: Candle[] = [];
        let price = 2000;

        // Generate 60 candles (5 hours) to ensure Time Limit (4h) is hit if TP/SL isn't
        for (let i = 0; i < 60; i++) {
            // Drop price after index 10 to simulate profit for SHORT
            if (i > 10) price = 1900;

            candles.push({
                openTime: baseTime + i * 300000,
                timestamp: baseTime + i * 300000,
                open: price,
                high: price + 10,
                low: price - 10,
                close: price,
                volume: 1000,
                buyVolume: 500,
                closeTime: baseTime + i * 300000 + 299999
            });
        }

        // 2. Mock ML Service Response
        // Default: PASS
        (axios.post as any).mockResolvedValue({
            data: { action: 0, confidence: 0.1 }
        });

        // At index 5, trigger SHORT signal
        (axios.post as any).mockImplementation(async (url: string, body: any) => {
            if (body.timestamp === candles[5].timestamp) {
                return {
                    data: {
                        action: 1, // SHORT
                        confidence: 0.8,
                        features: { cvd_slope: -10 }
                    }
                };
            }
            return {
                data: { action: 0, confidence: 0.1 }
            };
        });

        // 3. Run Backtest
        const result = await runHexagonalBacktest(candles);

        // 4. Assertions
        expect(result).toBeDefined();
        if (result) {
            // Should have at least one closed trade
            expect(result.trades.length).toBeGreaterThan(0);

            const trade = result.trades[0];
            expect(trade.entryTime).toBe(candles[5].timestamp);
            expect(trade.side).toBe('SHORT');
            expect(trade.pnl).toBeGreaterThan(0); // Should be profitable (2000 -> 1900)
        }
    });

    it('should activate TRAILING STOP when price moves in favor', async () => {
        // 1. Setup: Short Trade
        // Entry: 2000. Trailing Activation: 15% ROE.
        const baseTime = 1700049600000; // Safe Time
        const candles: Candle[] = [];
        let price = 2000;

        // Candle 0-4: Flat at 2000
        for (let i = 0; i < 5; i++) {
            candles.push({
                openTime: baseTime + i * 300000,
                timestamp: baseTime + i * 300000,
                open: 2000, high: 2005, low: 1995, close: 2000, volume: 1000, buyVolume: 0,
                closeTime: baseTime + i * 300000 + 299999
            });
        }

        // Candle 5: Entry Signal (Short)
        // Candle 6-15: Price dumps to 1900 (5% gain -> 25% ROE @ 5x) -> Should trigger Trailing (>15%)
        // Candle 16-20: Price bounces to 1950 -> Should hit Trailing Stop (Calculated at 1930)
        for (let i = 5; i < 25; i++) {
            if (i > 5 && i <= 15) price = 1900; // Dump (Profit)
            if (i > 15) price = 1950; // Bounce to trigger stop

            candles.push({
                openTime: baseTime + i * 300000,
                timestamp: baseTime + i * 300000,
                open: price, high: price + 5, low: price - 5, close: price, volume: 1000, buyVolume: 500,
                closeTime: baseTime + i * 300000 + 299999
            });
        }

        // Mock ML Signal (Short)
        (axios.post as any).mockImplementation(async (url: string, body: any) => {
            if (body.timestamp === candles[5].timestamp) {
                return {
                    data: { action: 1, confidence: 0.8, features: { cvd_slope: -10 } } // 1 = SHORT
                };
            }
            return { data: { action: 0, confidence: 0.1 } };
        });

        // Run Backtest with TESTUSDT to avoid ETHUSDT overrides (which disable trailing)
        const result = await runHexagonalBacktest(candles, 'TESTUSDT');

        // Assertions
        expect(result).toBeDefined();
        if (result) {
            expect(result.trades.length).toBeGreaterThan(0);
            const trade = result.trades[0];

            // If trailing worked, we should have exited at a profit
            expect(trade.pnl).toBeGreaterThan(0);
        }
    });

    it('should NOT activate TRAILING STOP when disabled in config (ETHUSDT God Mode)', async () => {
        // 1. Setup: Short Trade (Same as above)
        // Entry: 2000. 
        // Config: ETHUSDT (God Mode) -> Trailing Disabled (999)
        const baseTime = 1700049600000;
        const candles: Candle[] = [];
        let price = 2000;

        // Candle 0-4: Flat at 2000
        for (let i = 0; i < 5; i++) {
            candles.push({
                openTime: baseTime + i * 300000,
                timestamp: baseTime + i * 300000,
                open: 2000, high: 2005, low: 1995, close: 2000, volume: 1000, buyVolume: 0,
                closeTime: baseTime + i * 300000 + 299999
            });
        }

        // Candle 5: Entry Signal (Short)
        // Candle 6-15: Price dumps to 1900 (5% gain) -> Would trigger trailing if enabled
        // Candle 16-20: Price bounces to 1950 -> Would hit trailing if enabled
        // Candle 21-25: Price bounces to 1980 -> Still safe from Hard SL (2070)
        for (let i = 5; i < 25; i++) {
            if (i > 5 && i <= 15) price = 1900; // Dump
            if (i > 15) price = 1950; // Bounce

            candles.push({
                openTime: baseTime + i * 300000,
                timestamp: baseTime + i * 300000,
                open: price, high: price + 5, low: price - 5, close: price, volume: 1000, buyVolume: 500,
                closeTime: baseTime + i * 300000 + 299999
            });
        }

        // Mock ML Signal (Short)
        (axios.post as any).mockImplementation(async (url: string, body: any) => {
            if (body.timestamp === candles[5].timestamp) {
                return {
                    data: { action: 1, confidence: 0.8, features: { cvd_slope: -10 } } // 1 = SHORT
                };
            }
            return { data: { action: 0, confidence: 0.1 } };
        });

        // Run Backtest with ETHUSDT (Default) -> Should load God Mode config (Trailing Disabled)
        const result = await runHexagonalBacktest(candles, 'ETHUSDT');

        // Assertions
        expect(result).toBeDefined();
        if (result) {
            // Trade should still be OPEN because trailing is disabled and Hard SL/TP wasn't hit
            expect(result.trades.length).toBe(0);
        }
    });
});
