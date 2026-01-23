import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { Candle } from '../domain/types';

// Config
const LEVERAGE = 20.0;
const INITIAL_BALANCE = 20.0;
const SL_PCT = 0.025;
const INFERENCE_URL = 'http://localhost:5000/predict';

interface TradeResult {
    time: number;
    pnl: number;
    balance: number;
    reason: string;
    peak_roe: number;
    final_roe: number;
    duration: number;
}

async function runBacktest() {
    console.log('👻 STARTING PHANTOM V9 TS REPLICATION (GOD MODE) 👻');

    // 1. Load Data
    const dataPath = path.resolve(__dirname, '../../../data/phantom_v9_ts_data.json');
    if (!fs.existsSync(dataPath)) {
        console.error(`❌ Data file not found: ${dataPath}`);
        process.exit(1);
    }

    console.log('Loading candles...');
    const rawData = fs.readFileSync(dataPath, 'utf-8');
    const records: any[] = JSON.parse(rawData);

    // Convert to Candles (ensure timestamp is number)
    const candles: Candle[] = records.map(r => ({
        openTime: r.timestamp,
        timestamp: r.timestamp, // Already ms from export script
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        closeTime: r.timestamp + 300000 - 1
    }));

    console.log(`📊 Loaded ${candles.length} candles`);

    // 2. State
    let balance = INITIAL_BALANCE;
    const trades: TradeResult[] = [];
    let balanceLockedUntil = 0;

    // Filter Config (Match Python)
    const FORBIDDEN_HOURS = [0, 1, 22, 23];
    const FORBIDDEN_DAYS = [2]; // Tuesday (0=Sun, 1=Mon, 2=Tue)

    function isForbiddenTime(timestamp: number): boolean {
        const date = new Date(timestamp);
        const day = date.getUTCDay();
        const hour = date.getUTCHours();
        return FORBIDDEN_DAYS.includes(day) || FORBIDDEN_HOURS.includes(hour);
    }

    // 3. Run Loop
    // Python iterates candidates. Here we iterate all candles but query server.
    // Server implements the filter logic.

    const START_IDX = 0;
    const END_IDX = candles.length - 49; // Leave room for horizon

    console.log(`🚀 Running from index ${START_IDX} to ${END_IDX}...`);

    for (let i = START_IDX; i < END_IDX; i++) {
        const candle = candles[i];

        // 0. Check Forbidden Time
        if (isForbiddenTime(candle.timestamp)) {
            continue;
        }

        // Capital Lock Check
        if (balanceLockedUntil > 0) {
            if (candle.timestamp < balanceLockedUntil) {
                continue;
            } else {
                balanceLockedUntil = 0;
            }
        }

        // Call Inference
        try {
            const response = await axios.post(INFERENCE_URL, { timestamp: candle.timestamp });
            const { action, confidence } = response.data;

            if (i < START_IDX + 10) {
                console.log(`[DEBUG] TS: ${candle.timestamp} -> Response:`, response.data);
            }

            if (action === 1 && confidence > 0.55) {
                // EXECUTE TRADE
                const entry = candle.close;
                const future = candles.slice(i + 1, i + 49); // 48 candles (4 hours)

                let exitPrice = future[future.length - 1].close;
                let exitReason = "TIME";
                let peakRoe = -999.0;
                let candlesHeld = 0;
                let tradeActive = true;

                for (const fCandle of future) {
                    candlesHeld++;

                    // 1. Check Hard SL
                    if (fCandle.high > entry * (1 + SL_PCT)) {
                        exitPrice = entry * (1 + SL_PCT);
                        exitReason = "SL";
                        tradeActive = false;
                        break;
                    }

                    // 2. Update Peak ROE (Short)
                    const currentRoe = (entry - fCandle.low) / entry * LEVERAGE;
                    if (currentRoe > peakRoe) {
                        peakRoe = currentRoe;
                    }
                }

                // Calculate Result
                // Python: final_roe = (entry - exit_price) / entry * LEVERAGE
                const finalRoe = (entry - exitPrice) / entry * LEVERAGE;
                const pnlPct = (entry - exitPrice) / entry;
                const netPnl = balance * pnlPct * LEVERAGE; // No Fees

                // Lock Capital
                const tradeDurationMs = candlesHeld * 5 * 60 * 1000;
                balanceLockedUntil = candle.timestamp + tradeDurationMs;

                balance += netPnl;

                trades.push({
                    time: candle.timestamp,
                    pnl: netPnl,
                    balance: balance,
                    reason: exitReason,
                    peak_roe: peakRoe,
                    final_roe: finalRoe,
                    duration: candlesHeld
                });

                if (balance <= 0) {
                    console.log("💀 BROKE!");
                    break;
                }
            }

        } catch (error) {
            // If 400/404/500, just continue (maybe not a candidate)
            // console.error(`Error at ${candle.timestamp}:`, error.message);
        }

        if (i % 1000 === 0) {
            const progress = ((i - START_IDX) / (END_IDX - START_IDX) * 100).toFixed(1);
            process.stdout.write(`\r⏳ Progress: ${progress}% | Candle: ${i}/${END_IDX} | Balance: $${balance.toFixed(2)}`);
        }
    }

    console.log('\n🏁 Backtest Complete');
    console.log(`\n💰 Final Balance: $${balance.toFixed(2)}`);
    console.log(`🔫 Total Trades: ${trades.length}`);

    // Save results
    fs.writeFileSync(
        'reports/ts_phantom_v9_results.json',
        JSON.stringify({ balance, trades }, null, 2)
    );
    console.log('📄 Results saved to reports/ts_phantom_v9_results.json');
}

runBacktest().catch(console.error);
