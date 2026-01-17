/**
 * SymbolManager - Dynamic Symbol Hot-Reload
 * 
 * Watches model metadata files and dynamically starts/stops symbol runners
 * when models are trained or vetoed. Uses fs.watch for zero-overhead event-based updates.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BinanceExchange } from '../infra/binance/BinanceExchange';
import { FsStateStore } from '../infra/fs/FsStateStore';
import { FsLogger } from '../infra/fs/FsLogger';
import { CONFIG, BotConfig } from '../infra/config';
import { StrategyRunner } from './strategy-runner';
import { startBot, BotHandle } from './bot';
import { NinjaConfigManager } from './core/NinjaConfigManager';

const MODELS_DIR = '/home/jasan/Develop/trading_system/models/v2_ensemble';
const QUALITY_THRESHOLD = 0.55;
const DEBOUNCE_MS = 5000; // Wait 5 seconds after file change before syncing

export class SymbolManager {
    private runners: Map<string, BotHandle> = new Map();
    private logger: FsLogger;
    private exchange: BinanceExchange;
    private strategy: any;
    private ninjaConfig: NinjaConfigManager;
    private debounceTimer: NodeJS.Timeout | null = null;
    private watcher: fs.FSWatcher | null = null;

    constructor(deps: {
        logger: FsLogger;
        exchange: BinanceExchange;
        strategy: any;
    }) {
        this.logger = deps.logger;
        this.exchange = deps.exchange;
        this.strategy = deps.strategy;
        this.ninjaConfig = new NinjaConfigManager();
    }

    /**
     * Start watching for model changes and initialize active symbols
     */
    start(): void {
        // Initial sync
        this.sync();

        // Watch for metadata changes
        this.startWatching();
    }

    /**
     * Watch models directory for metadata.json changes
     */
    private startWatching(): void {
        try {
            this.watcher = fs.watch(MODELS_DIR, { recursive: true }, (event, filename) => {
                if (filename && filename.endsWith('metadata.json')) {
                    this.logger.info('model_change_detected', { filename, event });
                    this.debouncedSync();
                }
            });

            this.logger.info('symbol_manager_watching', { path: MODELS_DIR });
        } catch (e: any) {
            this.logger.error('symbol_manager_watch_failed', { error: e?.message });
        }
    }

    /**
     * Debounce sync to avoid rapid fire when multiple files change
     */
    private debouncedSync(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.sync();
        }, DEBOUNCE_MS);
    }

    /**
     * Sync running symbols with active symbols from metadata
     */
    sync(): void {
        const activeSymbols = this.getActiveSymbols();
        const runningSymbols = Array.from(this.runners.keys());

        // Find symbols to start
        const toStart = activeSymbols.filter(s => !this.runners.has(s));

        // Find symbols to stop
        const toStop = runningSymbols.filter(s => !activeSymbols.includes(s));

        // Stop removed symbols
        for (const symbol of toStop) {
            this.stopRunner(symbol);
        }

        // Start new symbols
        for (const symbol of toStart) {
            this.startRunner(symbol);
        }

        if (toStart.length > 0 || toStop.length > 0) {
            this.logger.info('symbol_manager_sync', {
                active: activeSymbols.length,
                started: toStart,
                stopped: toStop,
            });
        }
    }

    /**
     * Get symbols that have valid models (not vetoed)
     */
    private getActiveSymbols(): string[] {
        const allSymbols = this.ninjaConfig.getSymbols();
        const active: string[] = [];

        for (const symbol of allSymbols) {
            try {
                const metaPath = path.join(MODELS_DIR, symbol, 'metadata.json');
                if (!fs.existsSync(metaPath)) continue;

                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                if (meta.accuracy >= QUALITY_THRESHOLD) {
                    active.push(symbol);
                }
            } catch {
                // Skip symbols with invalid metadata
            }
        }

        return active;
    }

    /**
     * Start a symbol runner
     */
    private startRunner(symbol: string): void {
        const allocation = this.ninjaConfig.getCapitalAllocation(symbol);
        const leverage = this.ninjaConfig.system.global_leverage_default || 10;
        const trading = this.ninjaConfig.trading;

        const stateScope = CONFIG.IS_TESTNET ? 'testnet' : 'prod';
        const state = new FsStateStore(symbol, stateScope);

        const perSymbolConfig: typeof CONFIG = {
            ...CONFIG,
            SYMBOL: symbol,
            SYMBOL_SHARE: allocation,
            LEVERAGE: leverage,
            CAPITAL_USAGE_PCT: allocation,
            MAX_RISK_PCT: trading.max_risk_pct,
        };

        this.logger.info('symbol_runner_start', {
            symbol,
            capitalUsage: allocation,
            leverage,
            source: 'hot_reload',
        });

        const runner = new StrategyRunner({
            exchange: this.exchange,
            logger: this.logger,
            state,
            strategy: this.strategy,
            config: perSymbolConfig,
        });

        const handle = startBot({
            runner,
            symbol,
            exchange: this.exchange,
            state,
            logger: this.logger,
            config: perSymbolConfig,
            intervalSec: Math.max(5, CONFIG.BOT_INTERVAL_SEC),
            initialDelayMs: this.runners.size * Math.max(500, CONFIG.BOT_STAGGER_MS),
        });

        this.runners.set(symbol, handle);
    }

    /**
     * Stop a symbol runner (does NOT close positions)
     */
    private stopRunner(symbol: string): void {
        const handle = this.runners.get(symbol);
        if (handle) {
            handle.stop();
            this.runners.delete(symbol);
            this.logger.info('symbol_runner_removed', { symbol, reason: 'vetoed_or_no_model' });
        }
    }

    /**
     * Stop all runners and cleanup
     */
    stop(): void {
        if (this.watcher) {
            this.watcher.close();
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        for (const handle of this.runners.values()) {
            handle.stop();
        }
        this.runners.clear();
    }

    /**
     * Get count of running symbols
     */
    getRunningCount(): number {
        return this.runners.size;
    }

    /**
     * Get detailed list of running symbols
     */
    getRunningDetails(): string {
        const details: string[] = [];
        for (const symbol of this.runners.keys()) {
            const allocation = this.ninjaConfig.getCapitalAllocation(symbol);
            // Default leverage, though specific strategies might override it
            const leverage = this.ninjaConfig.system.global_leverage_default || 10;
            details.push(`• *${symbol}*: Cap=${allocation}x | Lev=${leverage}x`);
        }
        return details.join('\n');
    }
}
