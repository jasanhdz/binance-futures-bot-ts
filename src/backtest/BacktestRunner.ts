import * as fs from 'fs';
import * as path from 'path';
import { BacktestTradingService } from './BacktestTradingService';
import { MockExchange } from './adapters/MockExchange';
import { BacktestMLAdapter } from './adapters/BacktestMLAdapter';
import { FsLogger } from '../infra/logging/FsLogger';
import { FsStateStore } from '../infra/logging/FsStateStore';
import { Notifier } from '../app/ports/Notifier';
import { NinjaConfigManager } from '../infra/config/ConfigLoader';
import { DEFAULT_PHANTOM_CONFIG, PhantomSignal } from '../domain/services/PhantomStrategy';
import { DEFAULT_GUARDIAN_CONFIG } from '../domain/services/ProfitGuardian';
import { Candle } from '../domain/types';
import { MLService } from '../app/ports/MLService';

// Mock Notifier (Console only)
class ConsoleNotifier implements Notifier {
    async sendMessage(message: string): Promise<void> {
        console.log(`[NOTIFIER] ${message}`);
    }

    async sendAlert(message: string): Promise<void> {
        console.log(`[ALERT] ${message}`);
    }
}

// Wrapper to adapt BacktestMLAdapter to MLService port
class BacktestMLService implements MLService {
    public currentCandles: Candle[] = [];
    public currentBtcCandles: Candle[] = [];
    public currentFeatures: any = null;

    constructor(private adapter: BacktestMLAdapter) { }

    async getSignal(symbol: string): Promise<PhantomSignal> {
        const response = await this.adapter.fetchProbabilities({
            symbol,
            candles: this.currentCandles,
            btcCandles: this.currentBtcCandles,
            precalculated_features: this.currentFeatures
        });

        return {
            symbol,
            action: response.short_prob > 0.5 ? 'SHORT' : 'PASS',
            confidence: response.short_prob,
            longProb: response.long_prob,
            shortProb: response.short_prob,
            neutralProb: response.neutral_prob,
            features: response.features
        };
    }

    async checkHealth(): Promise<boolean> {
        return this.adapter.checkHealth();
    }
}

async function runBacktest() {
    console.log('🦅 STARTING TS BACKTEST RUNNER 🦅');

    // 1. Load Data
    const dataPath = path.resolve(__dirname, '../../../data/phantom_backtest_candles.json');
    const btcDataPath = path.resolve(__dirname, '../../../data/phantom_backtest_btc_candles.json');

    if (!fs.existsSync(dataPath) || !fs.existsSync(btcDataPath)) {
        console.error(`❌ Data files not found: ${dataPath} or ${btcDataPath}`);
        process.exit(1);
    }

    const rawData = fs.readFileSync(dataPath, 'utf-8');
    const rawCandles: any[] = JSON.parse(rawData);
    const candles: Candle[] = rawCandles.map(c => ({
        openTime: c.timestamp,
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        closeTime: c.timestamp + 300000 - 1
    }));

    const rawBtcData = fs.readFileSync(btcDataPath, 'utf-8');
    const rawBtcCandles: any[] = JSON.parse(rawBtcData);
    const btcCandles: Candle[] = rawBtcCandles.map(c => ({
        openTime: c.timestamp,
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        closeTime: c.timestamp + 300000 - 1
    }));

    console.log(`📊 Loaded ${candles.length} ETH candles and ${btcCandles.length} BTC candles`);

    // 1.1 Load Features
    const featuresPath = path.resolve(__dirname, '../../../data/phantom_features.csv');
    const featuresMap = new Map<number, any>();
    if (fs.existsSync(featuresPath)) {
        const rawFeatures = fs.readFileSync(featuresPath, 'utf-8');
        const lines = rawFeatures.split('\n');
        const headers = lines[0].split(',');

        // Find indices
        const idxTs = headers.indexOf('timestamp');
        const idxSlope = headers.indexOf('cvd_slope');
        const idxZ = headers.indexOf('cvd_z');
        const idxWeakness = headers.indexOf('weakness_score');
        const idxClose = headers.indexOf('close_eth');
        const idxOpen = headers.indexOf('open_eth');

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const cols = line.split(',');

            // Parse timestamp (CSV format: "YYYY-MM-DD HH:MM:SS" which is UTC)
            // Append 'Z' to treat as UTC and convert to milliseconds
            const tsStr = cols[idxTs].replace(' ', 'T') + 'Z';
            const ts = new Date(tsStr).getTime();

            featuresMap.set(ts, {
                cvd_slope: parseFloat(cols[idxSlope]),
                cvd_z: parseFloat(cols[idxZ]),
                weakness_score: parseFloat(cols[idxWeakness]),
                close: parseFloat(cols[idxClose]),
                open: parseFloat(cols[idxOpen])
            });
        }
        console.log(`📊 Loaded ${featuresMap.size} precalculated features`);
    } else {
        console.warn('⚠️ Features CSV not found, using service calculation');
    }

    // 2. Initialize Adapters
    const exchange = new MockExchange(20.0); // Initial Balance $20 (matches Python backtest)
    const mlAdapter = new BacktestMLAdapter({ baseUrl: 'http://127.0.0.1:8002' });
    const mlService = new BacktestMLService(mlAdapter);
    const logger = new FsLogger();
    const state = new FsStateStore();
    const notifier = new ConsoleNotifier();
    const configManager = new NinjaConfigManager();

    // 3. Initialize Service
    const tradingService = new BacktestTradingService(
        { exchange, mlService, logger, state, notifier, configManager },
        {
            symbols: ['ETHUSDT'],
            phantomConfig: DEFAULT_PHANTOM_CONFIG,
            guardianConfig: DEFAULT_GUARDIAN_CONFIG,
            tickIntervalMs: 0,
            maxTradesPerDay: 9999
        }
    );

    // 4. Run Loop
    const HORIZON = 288;
    const START_IDX = 200; // Match Python backtest start index
    const END_IDX = candles.length - HORIZON;
    let lastTradeCount = 0; // Track trade count to detect new exits
    let skipUntilIdx = 0;   // Skip candles until this index after trade exit (Python parity)

    console.log(`🚀 Running from index ${START_IDX} to ${END_IDX}...`);

    for (let i = START_IDX; i < END_IDX; i++) {
        const currentCandle = candles[i];
        const nextCandle = candles[i + 1];

        // Feed Exchange
        exchange.setCandle(currentCandle, nextCandle);

        // PARITY FIX: Skip candles if we're in a trade cooldown period
        if (i < skipUntilIdx) {
            // Still process position management (BE/Trailing), just no new entries
            await tradingService.tick('ETHUSDT');
            exchange.recheckOrders();
            continue;
        }

        // Feed ML Service (Historical Context)
        // Need enough history for EMA-200 to converge (at least 3x span = 600, safe 1000)
        const startHistoryIdx = Math.max(0, i - 999);
        const history = candles.slice(startHistoryIdx, i + 1);
        const btcHistory = btcCandles.slice(startHistoryIdx, i + 1);

        mlService.currentCandles = history;
        mlService.currentBtcCandles = btcHistory;
        mlService.currentFeatures = featuresMap.get(currentCandle.timestamp);

        // 5. Check if we have enough trades (e.g. 30 for parity check)
        // 5. Check if we have enough trades (e.g. 30 for parity check)
        const trades = exchange.getTrades();
        // if (trades.length >= 30) {
        //     console.log(`\nReached 30 trades. Stopping backtest.`);
        //     break;
        // }

        // DEBUG: Trade 3 Investigation (index 1100)
        if (i === 1100) {
            console.log(`\n[TS DEBUG Trade 3] Index: ${i}, Timestamp: ${new Date(currentCandle.timestamp).toISOString()}`);
            const signal = await mlService.getSignal('ETHUSDT');
            console.log(`  Action: ${signal.action}, Confidence: ${signal.confidence.toFixed(4)}`);
            console.log(`  Short Prob: ${signal.shortProb.toFixed(4)}, Neutral: ${signal.neutralProb.toFixed(4)}\n`);
        }

        // DEBUG: Investigate Missing Trade #1 (2025-01-16 20:35:00 UTC = 1737059700000)
        if (currentCandle.timestamp === 1737059700000) {
            console.log(`\n[TS DEBUG MISSING TRADE] Index: ${i}, Timestamp: ${new Date(currentCandle.timestamp).toISOString()}`);
            const feat = featuresMap.get(currentCandle.timestamp);
            console.log(`  Features Found: ${!!feat}`);
            if (feat) console.log(`  Features: Slope=${feat.cvd_slope}, Z=${feat.cvd_z}`);

            const signal = await mlService.getSignal('ETHUSDT');
            console.log(`  Action: ${signal.action}, Confidence: ${signal.confidence.toFixed(4)}`);
            console.log(`  Short Prob: ${signal.shortProb.toFixed(4)}\n`);
        }

        // DEBUG: Check Price at Divergence (20:50 = Index 222)
        if (i >= 220 && i <= 222) {
            console.log(`\n[TS DEBUG PRICE CHECK] Index: ${i}, Timestamp: ${new Date(currentCandle.timestamp).toISOString()}`);
            console.log(`  High: ${currentCandle.high}, Low: ${currentCandle.low}, Close: ${currentCandle.close}`);
        }

        // Run Tick
        await tradingService.tick('ETHUSDT');

        // PARITY FIX: Do NOT re-check orders immediately. 
        // Entry is at Close, so High/Low of current candle are in the past.
        // We must wait for the NEXT candle to check for exits.
        // exchange.recheckOrders();

        // PARITY FIX: If a new trade was closed, skip until this candle + HORIZON
        const currentTradeCount = exchange.getTrades().length;
        if (currentTradeCount > lastTradeCount) {
            // A trade just closed. Skip until current index (no further skip needed, 
            // Python simulates trade inline so it effectively advances past the trade)
            // Actually Python simulates the ENTIRE trade within one loop iteration,
            // so let's NOT skip - the trade is already done by simulate_trade.
            // The issue is TS re-enters on SAME candle after exit.
            // Solution: Don't skip, but prevent re-entry until next iteration.
            // This is already handled by hasPosition check in TradingService.
            // The real issue might be that Python only calls service once per entry,
            // but TS calls it every candle even during trade (which is wasted but harmless).
            // Let me NOT add skip logic - the trade count difference might be due to 
            // something else. Let me check the exact trade count first.
            lastTradeCount = currentTradeCount;
        }

        if (i % 100 === 0) {
            const progress = ((i - START_IDX) / (END_IDX - START_IDX) * 100).toFixed(1);
            process.stdout.write(`\r⏳ Progress: ${progress}% | Candle: ${i}/${END_IDX}`);
        }
    }

    console.log('\n🏁 Backtest Complete');

    // 5. Results
    const trades = exchange.getTrades();
    const finalBalance = exchange.getBalance();

    console.log(`\n💰 Final Balance: $${finalBalance.toFixed(2)}`);
    console.log(`🔫 Total Trades: ${trades.length}`);

    // Save results
    fs.writeFileSync(
        'reports/ts_backtest_results.json',
        JSON.stringify({ balance: finalBalance, trades }, null, 2)
    );
    console.log('📄 Results saved to reports/ts_backtest_results.json');
}

// Run
runBacktest().catch(console.error);
