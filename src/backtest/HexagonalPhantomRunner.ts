import * as fs from 'fs';
import * as path from 'path';
import { MockExchange } from './adapters/MockExchange';
import { MockMLService } from './adapters/MockMLService';
import { MockLogger, MockNotifier, MockStateStore } from './adapters/Mocks';
import { TradingService } from '../app/services/TradingService'; // Use Production Service
import { NinjaConfigManager } from '../infra/config/ConfigLoader';
import { Candle } from '../domain/types';

export async function runHexagonalBacktest(injectedCandles?: Candle[], symbolOverride?: string) {
    console.log('👻 STARTING HEXAGONAL PHANTOM V9 BACKTEST (PRODUCTION CORE) 👻');

    // 1. Load Config
    const configPath = path.resolve(__dirname, '../../regime_config.live.yaml');
    process.env.REGIME_CONFIG = configPath;
    const configManager = new NinjaConfigManager(configPath);

    // Force reload to ensure we have the latest
    configManager.reloadIfNeeded();

    const SYMBOL = symbolOverride || 'ETHUSDT';
    const regimeConfig = configManager.getRegimeConfig('PHANTOM', SYMBOL);
    const guardianConfig = configManager.getGuardianConfig('PHANTOM');

    console.log('Configuration Loaded:');
    console.log(`- Leverage: ${regimeConfig.leverage}x`);
    console.log(`- Entry Threshold: ${regimeConfig.entryThreshold}`);
    console.log(`- Hard Stop: ${(regimeConfig.hardStopRoe * 100).toFixed(2)}%`);
    console.log(`- Take Profit: ${(regimeConfig.tpRoe * 100).toFixed(2)}%`);
    console.log(`- Breakeven: ${regimeConfig.trailingActivationRoe ? 'Enabled' : 'Disabled'}`);

    // 2. Setup Dependencies
    const exchange = new MockExchange(20.0); // Initial Balance $20
    const mlService = new MockMLService(exchange);
    const logger = new MockLogger();
    const notifier = new MockNotifier();
    const state = new MockStateStore();

    // 3. Initialize Service (Production Class)
    const service = new TradingService(
        {
            exchange,
            mlService,
            logger,
            state,
            notifier,
            configManager
        },
        {
            symbols: [SYMBOL],
            phantomConfig: regimeConfig,
            guardianConfig: guardianConfig,
            tickIntervalMs: 0, // Not used in backtest
            maxTradesPerDay: 1000
        }
    );

    // Start service (initializes logs etc)
    await service.start(false);

    // 4. Load Data
    let candles: Candle[] = [];

    if (injectedCandles) {
        candles = injectedCandles;
        console.log(`📊 Using ${candles.length} injected candles`);
    } else {
        const dataPath = path.resolve(__dirname, '../../../data/phantom_v9_ts_data_2026.json');
        if (!fs.existsSync(dataPath)) {
            console.error(`❌ Data file not found: ${dataPath}`);
            process.exit(1);
        }

        console.log('Loading candles...');
        const rawData = fs.readFileSync(dataPath, 'utf-8');
        const records: any[] = JSON.parse(rawData);

        // Convert to Candles
        candles = records.map(r => ({
            openTime: r.timestamp,
            timestamp: r.timestamp,
            open: r.open,
            high: r.high,
            low: r.low,
            close: r.close,
            volume: r.volume,
            buyVolume: r.buyVolume || (r.volume / 2),
            closeTime: r.timestamp + 300000 - 1
        }));
        console.log(`📊 Loaded ${candles.length} candles`);
    }

    // 5. Run Simulation Loop
    console.log('🚀 Running Simulation...');
    const startTime = Date.now();

    for (let i = 0; i < candles.length - 1; i++) {
        const candle = candles[i];
        const nextCandle = candles[i + 1];

        // Update Exchange State
        exchange.setCandle(candle, nextCandle);

        // Check if we have an active position
        const hasPosition = await exchange.hasOpenPosition(SYMBOL, 'ANY');

        if (hasPosition) {
            const originalClose = candle.close;
            const mode = state.get().mode;
            const side = mode === 'SHORT_RIDE' ? 'SHORT' : 'LONG';

            // Simulation Order: Worst Case -> Best Case -> Final Close (PESSIMISTIC PARITY)
            const steps = side === 'SHORT'
                ? [candle.high, candle.low, originalClose]
                : [candle.low, candle.high, originalClose];

            for (const price of steps) {
                candle.close = price;

                // Only run Strategy Logic (Time Exit, Entry) on Final Close
                if (price === originalClose) {
                    await service.tick(SYMBOL);
                }

                // Trigger MockExchange to check orders against the simulated price (SL/TP)
                exchange.recheckOrders();

                // If position closed, break loop (unless re-entry happened? No, re-entry happens in tick)
                // If tick() triggered re-entry, mode might be RIDE again.
                // But if SL/TP hit (recheckOrders), mode becomes IDLE.
                if (state.get().mode === 'IDLE') break;
            }
            candle.close = originalClose; // Restore close
        } else {
            // No position: Just tick once
            await service.tick(SYMBOL);
        }

        // Progress Log
        if (i % 5000 === 0) {
            const progress = (i / candles.length * 100).toFixed(1);
            const balance = exchange.getBalance();
            console.log(`⏳ Progress: ${progress}% | Candle: ${i}/${candles.length} | Balance: $${balance.toFixed(2)}`);
        }
    }

    const duration = (Date.now() - startTime) / 1000;
    console.log(`🏁 Simulation Complete in ${duration.toFixed(2)}s`);

    // 6. Results
    const finalBalance = exchange.getBalance();
    const trades = exchange.getTrades();
    const wins = trades.filter(t => t.pnl > 0).length;
    const losses = trades.filter(t => t.pnl <= 0).length;
    const winRate = trades.length > 0 ? (wins / trades.length * 100).toFixed(2) : '0.00';

    console.log('\n📊 HEXAGONAL BACKTEST RESULTS');
    console.log(`💰 Final Balance: $${finalBalance.toFixed(2)}`);
    console.log(`🔫 Total Trades: ${trades.length}`);
    console.log(`✅ Wins: ${wins}`);
    console.log(`❌ Losses: ${losses}`);
    console.log(`🎯 Win Rate: ${winRate}%`);

    // Save Report
    const reportPath = path.resolve(__dirname, '../../reports/hexagonal_phantom_v9_results.json');
    fs.writeFileSync(reportPath, JSON.stringify(trades, null, 2));
    console.log(`📄 Report saved to ${reportPath}`);

    service.stop();

    return { finalBalance, trades };
}

if (require.main === module) {
    runHexagonalBacktest().catch(console.error);
}
