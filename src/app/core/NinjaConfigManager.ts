/**
 * NinjaConfigManager
 * 
 * Loads and manages configuration from regime_config.json
 * Provides typed access to regime settings with symbol-level overrides
 */

import * as fs from 'fs';
import * as path from 'path';
import { RegimeType, RegimeConfig } from '../regimes/RegimeStrategy';

// ═══════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS (Mirror the JSON structure)
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

export interface RegimeJsonConfig {
    leverage: number;
    entry_threshold: number;
    hard_stop_roe: number;
    tp_roe: number;
    max_hold_ms?: number;
    trailing_activation_roe?: number;
}

export interface NinjaConfigJson {
    SYSTEM: SystemConfig;
    REGIME_DETECTOR: RegimeDetectorConfig;
    IMMUNE_SYSTEM: ImmuneSystemConfig;
    REGIMES: {
        BLOODBATH: RegimeJsonConfig;
        WHALE: RegimeJsonConfig;
        MONK: RegimeJsonConfig;
        BUNKER: RegimeJsonConfig;
    };
    SYMBOL_OVERRIDES?: {
        [symbol: string]: {
            [regime: string]: Partial<RegimeJsonConfig>;
        };
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG MANAGER CLASS
// ═══════════════════════════════════════════════════════════════════════════

export class NinjaConfigManager {
    private config: NinjaConfigJson;
    private configPath: string;
    private lastLoadTime: number = 0;
    private readonly RELOAD_INTERVAL_MS = 30000; // Check for changes every 30s

    constructor(configPath?: string) {
        // ═══════════════════════════════════════════════════════════════════════════
        // ISOLATION SYSTEM: "Búnker vs Arena" (Grid Search Safety)
        // Priority: 1. REGIME_CONFIG env var (.live.json for bot)
        //           2. Constructor argument (for tests)
        //           3. Default (regime_config.json - sandbox for grid search)
        // ═══════════════════════════════════════════════════════════════════════════
        const envPath = process.env.REGIME_CONFIG;

        if (envPath) {
            // Bot is reading the LIVE file (protected from grid search)
            this.configPath = path.resolve(envPath);
            console.log(`[NinjaConfig] Using LIVE config from env: ${this.configPath}`);
        } else if (configPath) {
            // Explicit path provided (for tests or scripts)
            this.configPath = path.resolve(configPath);
        } else {
            // Default: sandbox file (grid search can modify this)
            this.configPath = path.resolve(__dirname, '../../..', 'regime_config.json');
        }

        this.config = this.loadConfig();
    }

    /**
     * Load configuration from JSON file
     */
    private loadConfig(): NinjaConfigJson {
        try {
            const rawData = fs.readFileSync(this.configPath, 'utf-8');
            this.lastLoadTime = Date.now();
            return JSON.parse(rawData) as NinjaConfigJson;
        } catch (error) {
            console.error(`[NinjaConfig] Failed to load config from ${this.configPath}:`, error);
            // Return safe defaults
            return this.getDefaultConfig();
        }
    }

    /**
     * Hot-reload config if file was modified (call periodically)
     */
    reloadIfNeeded(): boolean {
        if (Date.now() - this.lastLoadTime < this.RELOAD_INTERVAL_MS) {
            return false;
        }

        try {
            const stats = fs.statSync(this.configPath);
            if (stats.mtimeMs > this.lastLoadTime) {
                this.config = this.loadConfig();
                console.log('[NinjaConfig] Configuration reloaded');
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

    /**
     * Get configuration for a specific regime, with optional symbol override
     */
    getRegimeConfig(regime: RegimeType, symbol?: string): RegimeConfig {
        // 1. Get base config for the regime
        const baseConfig = this.config.REGIMES[regime];

        // 2. Check for symbol-specific override
        let overrides: Partial<RegimeJsonConfig> = {};
        if (symbol && this.config.SYMBOL_OVERRIDES?.[symbol]?.[regime]) {
            overrides = this.config.SYMBOL_OVERRIDES[symbol][regime];
        }

        // 3. Merge and convert to RegimeConfig interface
        const merged: RegimeJsonConfig = {
            ...baseConfig,
            ...overrides
        };

        return this.jsonToRegimeConfig(merged);
    }

    /**
     * Convert JSON config format to internal RegimeConfig interface
     */
    private jsonToRegimeConfig(json: RegimeJsonConfig): RegimeConfig {
        return {
            leverage: json.leverage,
            entryThreshold: json.entry_threshold,
            hardStopRoe: json.hard_stop_roe,
            tpRoe: json.tp_roe,
            maxHoldMs: json.max_hold_ms,
            trailingActivationRoe: json.trailing_activation_roe
        };
    }

    /**
     * Safe default configuration (used if JSON fails to load)
     */
    private getDefaultConfig(): NinjaConfigJson {
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
                BLOODBATH: {
                    leverage: 10, // Safe default, not 15
                    entry_threshold: 0.30,
                    hard_stop_roe: -0.015,
                    tp_roe: 0.005,
                    max_hold_ms: 120000
                },
                WHALE: {
                    leverage: 5,
                    entry_threshold: 0.50,
                    hard_stop_roe: -0.20,
                    tp_roe: 999.0,
                    trailing_activation_roe: 0.03
                },
                MONK: {
                    leverage: 10,
                    entry_threshold: 0.40,
                    hard_stop_roe: -0.05,
                    tp_roe: 0.02
                },
                BUNKER: {
                    leverage: 0,
                    entry_threshold: 999.0,
                    hard_stop_roe: 0.0,
                    tp_roe: 0.0
                }
            }
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE (Optional - for easy access across modules)
// ═══════════════════════════════════════════════════════════════════════════

let _instance: NinjaConfigManager | null = null;

export function getNinjaConfig(): NinjaConfigManager {
    if (!_instance) {
        _instance = new NinjaConfigManager();
    }
    return _instance;
}
