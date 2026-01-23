/**
 * NinjaConfigManager v4.0 (YAML Edition)
 * 
 * Loads configuration from 'regime_config.yaml'.
 * Supports symbol-specific overrides for each regime.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { RegimeType, RegimeConfig } from '../../app/ports/RegimeStrategy';

// ═══════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

export interface SystemConfig {
    tick_interval_ms: number;
    max_trades_per_day: number;
    global_leverage_default: number;
}

export interface RegimeDetectorConfig {
    volatility_spread_low: number;
    volatility_spread_high: number;
    bias_strength_threshold: number;
    obi_confirmation_threshold: number;
}

export interface ImmuneSystemConfig {
    alpha_slow_rise: number;
    alpha_fast_fall: number;
    panic_exit_threshold: number;
}

export interface TradingConfig {
    capital_usage_default: number;
    min_wallet_reserve_usdt: number;
    fee_buffer_pct: number;
    max_risk_pct: number;
    low_funds_threshold: number;
    reenter_on_tp: boolean;
    post_exit_timeout_ms: number;
    vol_factor_reenter: number;
}

export interface RegimeYamlConfig {
    leverage: number;
    entry_threshold: number;
    hard_stop_roe: number;
    tp_roe: number;
    max_hold_ms?: number;
    be_roe?: number;        // Break-Even Trigger ROE
    trailing_step?: number; // Price-based Trailing Deviation
    trailing_activation_roe?: number;
    trailing_callback_roe?: number;
    forbidden_hours?: number[];
    forbidden_days?: number[];
}

export interface NinjaYamlConfig {
    SYMBOLS?: {
        [symbol: string]: number;  // Capital allocation (0-1)
    };
    TRADING?: TradingConfig;
    SYSTEM: SystemConfig;
    REGIME_DETECTOR: RegimeDetectorConfig;
    IMMUNE_SYSTEM: ImmuneSystemConfig;
    REGIMES: {
        PHANTOM: RegimeYamlConfig;
    };
    SYMBOL_OVERRIDES?: {
        [symbol: string]: {
            [regime: string]: Partial<RegimeYamlConfig> & { capital_usage?: number };
        };
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG MANAGER CLASS
// ═══════════════════════════════════════════════════════════════════════════

export class NinjaConfigManager {
    private config: NinjaYamlConfig;
    private configPath: string;
    private lastLoadTime: number = 0;
    private readonly RELOAD_INTERVAL_MS = 30000;

    constructor(configPath?: string) {
        // ═══════════════════════════════════════════════════════════════════════════
        // ISOLATION SYSTEM: "Búnker vs Arena"
        // Priority: 1. REGIME_CONFIG env var (.live.yaml for bot)
        //           2. Constructor argument (for tests)
        //           3. Default (regime_config.yaml - sandbox)
        // ═══════════════════════════════════════════════════════════════════════════
        const envPath = process.env.REGIME_CONFIG;

        if (envPath) {
            this.configPath = path.resolve(envPath);
            console.log(`[NinjaConfig] Using LIVE config from env: ${this.configPath}`);
        } else if (configPath) {
            this.configPath = path.resolve(configPath);
        } else {
            this.configPath = path.resolve(__dirname, '../../..', 'regime_config.yaml');
        }

        this.config = this.loadConfig();
    }

    /**
     * Load configuration from YAML file
     */
    private loadConfig(): NinjaYamlConfig {
        try {
            const rawData = fs.readFileSync(this.configPath, 'utf-8');
            this.lastLoadTime = Date.now();

            const parsed = yaml.load(rawData) as NinjaYamlConfig;
            const regimeCount = Object.keys(parsed.REGIMES || {}).length;
            const symbolCount = Object.keys(parsed.SYMBOL_OVERRIDES || {}).length;

            console.log(`[NinjaConfig] Loaded ${regimeCount} regimes, ${symbolCount} symbol overrides`);

            return parsed;
        } catch (error) {
            console.error(`[NinjaConfig] Failed to load config from ${this.configPath}:`, error);
            return this.getDefaultConfig();
        }
    }

    /**
     * Hot-reload config if file was modified
     */
    reloadIfNeeded(): boolean {
        if (Date.now() - this.lastLoadTime < this.RELOAD_INTERVAL_MS) {
            return false;
        }

        try {
            const stats = fs.statSync(this.configPath);
            if (stats.mtimeMs > this.lastLoadTime) {
                this.config = this.loadConfig();
                console.log('[NinjaConfig] Configuration reloaded (YAML)');
                return true;
            }
        } catch (e) {
            // File might not exist, ignore
        }
        return false;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // GETTERS
    // ═══════════════════════════════════════════════════════════════════════════

    get system(): SystemConfig {
        return this.config.SYSTEM;
    }

    get regimeDetector(): RegimeDetectorConfig {
        return this.config.REGIME_DETECTOR;
    }

    get immuneSystem(): ImmuneSystemConfig {
        return this.config.IMMUNE_SYSTEM;
    }

    get trading(): TradingConfig {
        return this.config.TRADING || {
            capital_usage_default: 1.0,
            min_wallet_reserve_usdt: 0,
            fee_buffer_pct: 0.0004,
            max_risk_pct: 0,
            low_funds_threshold: 2,
            reenter_on_tp: true,
            post_exit_timeout_ms: 60000,
            vol_factor_reenter: 1.5,
        };
    }

    /**
     * Get list of ALL symbols from YAML config (for reference)
     */
    getSymbols(): string[] {
        if (!this.config.SYMBOLS) return [];
        return Object.keys(this.config.SYMBOLS);
    }

    /**
     * Get list of ACTIVE symbols (have model + not vetoed)
     * Filters by checking metadata.json for each symbol
     */
    getActiveSymbols(): string[] {
        const allSymbols = this.getSymbols();
        const MODELS_DIR = '/home/jasan/Develop/trading_system/models/v2_ensemble';
        const QUALITY_THRESHOLD = 0.55;

        const activeSymbols: string[] = [];

        for (const symbol of allSymbols) {
            try {
                const metaPath = `${MODELS_DIR}/${symbol}/metadata.json`;
                if (!fs.existsSync(metaPath)) {
                    continue; // No model exists
                }

                const metaRaw = fs.readFileSync(metaPath, 'utf-8');
                const meta = JSON.parse(metaRaw);

                if (meta.accuracy >= QUALITY_THRESHOLD) {
                    activeSymbols.push(symbol);
                }
            } catch (e) {
                // Skip symbols with invalid/missing metadata
            }
        }

        console.log(`[NinjaConfig] Active symbols: ${activeSymbols.length}/${allSymbols.length} (threshold: ${QUALITY_THRESHOLD * 100}%)`);
        return activeSymbols;
    }

    /**
     * Get capital allocation for a symbol (with optional regime override)
     */
    getCapitalAllocation(symbol: string, regime?: string): number {
        const DEFAULT_ALLOCATION = this.trading.capital_usage_default;

        // Check regime-specific override first
        if (regime && this.config.SYMBOL_OVERRIDES?.[symbol]?.[regime.toUpperCase()]?.capital_usage !== undefined) {
            return this.config.SYMBOL_OVERRIDES[symbol][regime.toUpperCase()].capital_usage!;
        }

        // Then check symbol-level allocation
        if (this.config.SYMBOLS?.[symbol] !== undefined) {
            return this.config.SYMBOLS[symbol];
        }

        return DEFAULT_ALLOCATION;
    }

    /**
     * Get all symbol allocations as a record
     */
    getSymbolAllocations(): Record<string, number> {
        return this.config.SYMBOLS ? { ...this.config.SYMBOLS } : {};
    }

    /**
     * Get Guardian Config from Regime settings
     */
    getGuardianConfig(regime: RegimeType): { beTriggerRoe: number; beOffsetPct: number; trailingDev: number } {
        const regimeKey = regime.toUpperCase() as keyof typeof this.config.REGIMES;
        const baseRegime = this.config.REGIMES?.[regimeKey] || this.getDefaultRegimeConfig(regime);

        return {
            beTriggerRoe: baseRegime.be_roe || 0.10,
            beOffsetPct: 0.003, // Hardcoded 0.3% offset for now (standard fee cover)
            trailingDev: baseRegime.trailing_step || 0.015,
            trailingActivationRoe: baseRegime.trailing_activation_roe,
            trailingCallbackRoe: baseRegime.trailing_callback_roe
        };
    }

    /**
     * THE MAGIC: Merges Base Regime Config + Symbol-Specific Overrides
     */
    getRegimeConfig(regime: RegimeType, symbol?: string): RegimeConfig {
        const regimeKey = regime.toUpperCase() as keyof typeof this.config.REGIMES;

        // 1. Load Base Regime Configuration
        const baseRegime = this.config.REGIMES?.[regimeKey];

        if (!baseRegime) {
            console.warn(`[NinjaConfig] No base config for regime: ${regime}, using defaults`);
            return this.getDefaultRegimeConfig(regime);
        }

        // Start with base values
        let mergedConfig = { ...baseRegime };

        // 2. Apply Symbol-Specific Overrides
        if (symbol && this.config.SYMBOL_OVERRIDES?.[symbol]?.[regimeKey]) {
            const overrides = this.config.SYMBOL_OVERRIDES[symbol][regimeKey];
            mergedConfig = { ...mergedConfig, ...overrides };
        }

        // 3. Convert to RegimeConfig interface
        return {
            leverage: mergedConfig.leverage,
            hardStopRoe: mergedConfig.hard_stop_roe,
            tpRoe: mergedConfig.tp_roe,
            entryThreshold: mergedConfig.entry_threshold,
            maxHoldMs: mergedConfig.max_hold_ms,
            trailingActivationRoe: mergedConfig.trailing_activation_roe,
            trailingCallbackRoe: mergedConfig.trailing_callback_roe,
            forbiddenHours: mergedConfig.forbidden_hours,
            forbiddenDays: mergedConfig.forbidden_days
        };
    }

    /**
     * Check if a symbol has any overrides defined
     */
    hasSymbolOverrides(symbol: string): boolean {
        return !!this.config.SYMBOL_OVERRIDES?.[symbol];
    }

    /**
     * Get list of symbols with overrides
     */
    getSymbolsWithOverrides(): string[] {
        return Object.keys(this.config.SYMBOL_OVERRIDES || {});
    }

    /**
     * Default regime config (fallback)
     */
    private getDefaultRegimeConfig(regime: RegimeType): RegimeConfig {
        const defaults: Record<RegimeType, RegimeConfig> = {
            PHANTOM: { leverage: 3, entryThreshold: 0.55, hardStopRoe: -0.015, tpRoe: 0.06, maxHoldMs: 21600000 }
        };
        return defaults[regime] || defaults.PHANTOM;
    }

    /**
     * Safe default configuration (used if YAML fails to load)
     */
    private getDefaultConfig(): NinjaYamlConfig {
        return {
            SYSTEM: {
                tick_interval_ms: 5000,
                max_trades_per_day: 100,
                global_leverage_default: 10
            },
            REGIME_DETECTOR: {
                volatility_spread_low: 0.0008,
                volatility_spread_high: 0.0015,
                bias_strength_threshold: 0.20,
                obi_confirmation_threshold: 0.10
            },
            IMMUNE_SYSTEM: {
                alpha_slow_rise: 0.15,
                alpha_fast_fall: 0.70,
                panic_exit_threshold: 0.70
            },
            REGIMES: {
                PHANTOM: {
                    leverage: 5,
                    entry_threshold: 0.55,
                    hard_stop_roe: -0.015,
                    tp_roe: 0.06,
                    max_hold_ms: 21600000
                }
            },
            SYMBOL_OVERRIDES: {}
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════

let _instance: NinjaConfigManager | null = null;

export function getNinjaConfig(): NinjaConfigManager {
    if (!_instance) {
        _instance = new NinjaConfigManager();
    }
    return _instance;
}
