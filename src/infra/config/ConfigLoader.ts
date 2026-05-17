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
import { EventRiskMode } from '../../domain/services/AegisEventRiskOverlay';
import { AegisDecisionEnforcementMode } from '../../domain/services/AegisDecisionEnforcement';

// ═══════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

export interface SystemConfig {
    tick_interval_ms: number;
    max_trades_per_day: number;
    global_leverage_default: number;
    enable_sentinel: boolean;
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
    max_trade_duration_ms?: number;
    be_roe?: number;        // Break-Even Trigger ROE
    trailing_step?: number; // Price-based Trailing Deviation
    trailing_activation_roe?: number;
    trailing_callback_roe?: number;
    forbidden_hours?: number[];
    forbidden_days?: number[];
    use_exit_agent?: boolean;
}

export interface AegisTurboYamlConfig {
    enabled?: boolean;
    live_enabled?: boolean;
    allow_short?: boolean;
    position_fraction_cap?: number;
    position_fraction_overrides?: AegisPositionFractionOverrideRuleYamlConfig[];
    max_trades_per_day?: number;
    max_consecutive_losses?: number;
    daily_loss_stop_pct?: number;
    min_cooldown_ms?: number;
    max_liquidity_stress?: number;
    require_brackets?: boolean;
    close_if_bracket_fails?: boolean;
}

export interface AegisPositionFractionOverrideRuleYamlConfig {
    name?: string;
    symbol?: string;
    symbols?: string[];
    long?: number;
    short?: number;
}

export interface AegisPositionFractionOverride {
    symbol: string;
    side: 'LONG' | 'SHORT';
    positionFraction: number;
    ruleIndex: number;
    ruleName?: string;
}

export interface AegisPortfolioRiskYamlConfig {
    enabled?: boolean;
    max_open_positions?: number;
    max_same_direction_positions?: number;
    max_margin_used_pct?: number;
    max_notional_to_equity?: number;
}

export type AegisEntryQualityGateMode = 'OFF' | 'SHADOW' | 'ENFORCE';

export interface AegisEntryQualityGateYamlConfig {
    enabled?: boolean;
    mode?: AegisEntryQualityGateMode | string;
    min_score_long?: number;
    min_score_short?: number;
    require_momentum_confirm?: boolean;
    anti_falling_knife?: {
        enabled?: boolean;
        lookback_candles?: number;
        max_adverse_recent_return?: number;
    };
    overextension?: {
        enabled?: boolean;
        ema_distance_limit?: number;
    };
    volatility?: {
        enabled?: boolean;
        max_atr_percentile?: number;
    };
    require_3of3_when_symbol_flagged?: boolean;
    flagged_symbols?: string[];
}

export interface AegisEntryQualityGateRuntimeConfig {
    enabled: boolean;
    mode: AegisEntryQualityGateMode;
    config: {
        minScoreLong: number;
        minScoreShort: number;
        requireMomentumConfirm: boolean;
        antiFallingKnifeEnabled: boolean;
        antiFallingKnifeLookbackCandles: number;
        maxAdverseRecentReturn: number;
        overextensionEnabled: boolean;
        emaDistanceLimit: number;
        volatilityEnabled: boolean;
        maxAtrPercentile: number;
        require3of3WhenSymbolFlagged: boolean;
        flaggedSymbols: string[];
    };
}

export type AegisShortGateMode = 'PREMIUM_ONLY';

export interface AegisShortGateYamlConfig {
    enabled?: boolean;
    mode?: AegisShortGateMode | string;
    min_score?: number;
    require_votes?: number;
    position_fraction_multiplier?: number;
    max_leverage?: number;
    block_symbols?: string[];
    allow_if_regime_bearish?: boolean;
}

export interface AegisEventRiskYamlConfig {
    enabled?: boolean;
    mode?: EventRiskMode | string;
    enforce?: boolean;
    manual_override_enabled?: boolean;
    caution?: {
        min_quality_score?: number;
        max_tail_risk_score?: number;
        require_btc_eth_confirmation?: boolean;
    };
    risk_off?: {
        min_quality_score?: number;
        max_tail_risk_score?: number;
        allow_only_a_plus?: boolean;
    };
    manual_only?: {
        block_new_entries?: boolean;
    };
}

export interface AegisEventRiskRuntimeConfig {
    enabled: boolean;
    mode: EventRiskMode;
    enforce: boolean;
    manual_override_enabled: boolean;
    caution: {
        min_quality_score: number;
        max_tail_risk_score: number;
        require_btc_eth_confirmation: boolean;
    };
    risk_off: {
        min_quality_score: number;
        max_tail_risk_score: number;
        allow_only_a_plus: boolean;
    };
    manual_only: {
        block_new_entries: boolean;
    };
}

export interface AegisDecisionEnforcementYamlConfig {
    enabled?: boolean;
    mode?: AegisDecisionEnforcementMode | string;
    block_do_not_enter?: boolean;
    block_wait_confirmation?: boolean;
    block_manual_only?: boolean;
    block_entry_quality_shadow_block_when_event_risk?: {
        enabled?: boolean;
        event_modes?: Array<EventRiskMode | string>;
    };
    event_risk_enforcement?: {
        caution_blocks_weak_entries?: boolean;
        risk_off_blocks_non_a_plus?: boolean;
        manual_only_blocks_all_new_entries?: boolean;
    };
    block_caution_would_block_unless_a_plus?: boolean;
    block_all_entry_quality_shadow_block?: boolean;
    block_all_tail_risk_high?: boolean;
}

export interface AegisDecisionEnforcementRuntimeConfig {
    enabled: boolean;
    mode: AegisDecisionEnforcementMode;
    block_do_not_enter: boolean;
    block_wait_confirmation: boolean;
    block_manual_only: boolean;
    block_entry_quality_shadow_block_when_event_risk: {
        enabled: boolean;
        event_modes: EventRiskMode[];
    };
    event_risk_enforcement: {
        caution_blocks_weak_entries: boolean;
        risk_off_blocks_non_a_plus: boolean;
        manual_only_blocks_all_new_entries: boolean;
    };
    block_caution_would_block_unless_a_plus: boolean;
    block_all_entry_quality_shadow_block: boolean;
    block_all_tail_risk_high: boolean;
}

export interface AegisTelegramBlockDedupeYamlConfig {
    enabled?: boolean;
    cooldown_minutes?: number;
    summary_threshold?: number;
    max_cache_entries?: number;
    include_suppressed_count?: boolean;
}

export interface AegisTelegramBlockDedupeRuntimeConfig {
    enabled: boolean;
    cooldown_minutes: number;
    summary_threshold: number;
    max_cache_entries: number;
    include_suppressed_count: boolean;
}

export interface AegisTelegramNotificationsYamlConfig {
    block_dedupe?: AegisTelegramBlockDedupeYamlConfig;
}

export interface AegisTelegramNotificationsRuntimeConfig {
    block_dedupe: AegisTelegramBlockDedupeRuntimeConfig;
}

export type AegisExitEyeMode = 'OFF' | 'SHADOW' | 'PROTECT' | 'CLOSE';

export interface AegisExitEyeYamlConfig {
    enabled: boolean;
    mode: AegisExitEyeMode;
    min_roe_to_protect: number;
    min_peak_roe_to_protect: number;
    min_giveback_from_peak_roe: number;
    neutral_votes_to_protect: number;
    opposite_votes_to_close: number;
    min_roe_to_close_on_opposite: number;
    min_peak_roe_to_close_on_opposite: number;
    close_on_neutral_decay: boolean;
    neutral_close_votes: number;
    min_roe_to_close_on_neutral: number;
    min_peak_roe_to_close_on_neutral: number;
    min_giveback_to_close_on_neutral: number;
    require_consecutive_neutral_close: number;
    require_consecutive_neutral: number;
    require_consecutive_opposite: number;
    min_minutes_in_trade: number;
}

export type AegisSymbolMode = 'OFF' | 'SHADOW' | 'LIVE';

export interface AegisSymbolYamlConfig {
    enabled?: boolean;
    mode?: AegisSymbolMode | string;
}

export interface AegisSymbolConfig {
    symbol: string;
    enabled: boolean;
    mode: AegisSymbolMode;
}

export interface NinjaYamlConfig {
    SYMBOLS?: {
        [symbol: string]: number;  // Capital allocation (0-1)
    };
    symbols?: {
        [symbol: string]: AegisSymbolYamlConfig;
    };
    TRADING?: TradingConfig;
    SYSTEM: SystemConfig;
    REGIME_DETECTOR: RegimeDetectorConfig;
    IMMUNE_SYSTEM: ImmuneSystemConfig;
    REGIMES: {
        AEGIS_TURBO: RegimeYamlConfig;
    };
    aegis?: {
        turbo?: AegisTurboYamlConfig;
        exit_eye?: Partial<AegisExitEyeYamlConfig>;
        portfolio_risk?: AegisPortfolioRiskYamlConfig;
        short_gate?: AegisShortGateYamlConfig;
        event_risk?: AegisEventRiskYamlConfig;
        decision_enforcement?: AegisDecisionEnforcementYamlConfig;
        telegram_notifications?: AegisTelegramNotificationsYamlConfig;
        entry_quality_gate?: AegisEntryQualityGateYamlConfig;
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
        const legacySymbols = Object.keys(this.config.SYMBOLS || {});
        const aegisSymbols = Object.keys(this.config.symbols || {});
        return [...new Set([...legacySymbols, ...aegisSymbols].map((symbol) => this.normalizeSymbol(symbol)).filter(Boolean))];
    }

    getAegisSymbolConfigs(): Record<string, AegisSymbolConfig> {
        const legacySymbols = Object.keys(this.config.SYMBOLS || {});
        const configured = this.config.symbols || {};
        const allSymbols = [...new Set([...legacySymbols, ...Object.keys(configured)])];
        const result: Record<string, AegisSymbolConfig> = {};

        for (const rawSymbol of allSymbols) {
            const symbol = this.normalizeSymbol(rawSymbol);
            if (!symbol) continue;
            const rawConfig = configured[rawSymbol] ?? configured[symbol] ?? {};
            const enabled = rawConfig.enabled !== false;
            const mode = enabled ? this.normalizeSymbolMode(rawConfig.mode) : 'OFF';
            result[symbol] = { symbol, enabled, mode };
        }

        return result;
    }

    getActiveAegisSymbols(): string[] {
        return Object.values(this.getAegisSymbolConfigs())
            .filter((config) => config.enabled && config.mode !== 'OFF')
            .map((config) => config.symbol);
    }

    getLiveAegisSymbols(): string[] {
        return Object.values(this.getAegisSymbolConfigs())
            .filter((config) => config.enabled && config.mode === 'LIVE')
            .map((config) => config.symbol);
    }

    getShadowAegisSymbols(): string[] {
        return Object.values(this.getAegisSymbolConfigs())
            .filter((config) => config.enabled && config.mode === 'SHADOW')
            .map((config) => config.symbol);
    }

    getSymbolMode(symbol: string): AegisSymbolMode {
        const normalized = this.normalizeSymbol(symbol);
        if (!normalized) return 'OFF';
        return this.getAegisSymbolConfigs()[normalized]?.mode ?? 'SHADOW';
    }

    validateSingleLiveAegisSymbol(): void {
        // Multi-symbol LIVE is intentionally allowed by configuration. Runtime
        // position/state safety is managed by the trading service and exchange guards.
    }

    /**
     * Get list of ACTIVE symbols (have model + not vetoed)
     * Filters by checking metadata.json for each symbol
     */
    getActiveSymbols(): string[] {
        const allSymbols = this.getSymbols();
        const MODELS_DIR = '/home/jasan/Develop/trading_system/models/v2_ensemble';
        const QUALITY_THRESHOLD = 0.40; // Lowered from 0.55 to prevent filtering active champions

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
    getGuardianConfig(regime: RegimeType, symbol?: string): {
        beTriggerRoe: number;
        beOffsetPct: number;
        trailingDev: number;
        trailingActivationRoe?: number;
        trailingCallbackRoe?: number;
        useAtrTrailing?: boolean;
        atrMultiplier?: number;
    } {
        const regimeKey = regime.toUpperCase() as keyof typeof this.config.REGIMES;
        const baseRegime = this.config.REGIMES?.[regimeKey] || this.getDefaultRegimeConfig(regime);

        // Apply Symbol Overrides
        let mergedConfig = { ...baseRegime };
        if (symbol && this.config.SYMBOL_OVERRIDES?.[symbol]?.[regimeKey]) {
            const overrides = this.config.SYMBOL_OVERRIDES[symbol][regimeKey];
            mergedConfig = { ...mergedConfig, ...overrides };
        }

        return {
            beTriggerRoe: mergedConfig.be_roe ?? 0.10,
            beOffsetPct: 0.003, // Hardcoded 0.3% offset for now (standard fee cover)
            trailingDev: mergedConfig.trailing_step ?? 0.015,
            trailingActivationRoe: mergedConfig.trailing_activation_roe ?? 0.15,
            trailingCallbackRoe: mergedConfig.trailing_callback_roe ?? 0.30,
            useAtrTrailing: true, // Activate ATR logic for Trailing
            atrMultiplier: 1.5    // V31: Lower multiplier for stability on 8GB cards
        };
    }

    getAegisTurboConfig(): AegisTurboYamlConfig | undefined {
        return this.config.aegis?.turbo;
    }

    getAegisPositionFractionOverride(symbol: string, side: 'LONG' | 'SHORT'): AegisPositionFractionOverride | undefined {
        const normalizedSymbol = this.normalizeSymbol(symbol);
        const normalizedSide = side === 'SHORT' ? 'SHORT' : 'LONG';
        const sideKey = normalizedSide === 'LONG' ? 'long' : 'short';
        const rules = this.config.aegis?.turbo?.position_fraction_overrides;
        if (!normalizedSymbol || !Array.isArray(rules)) {
            return undefined;
        }

        for (let index = 0; index < rules.length; index++) {
            const rule = rules[index];
            const configuredSymbols = [
                ...(rule.symbol ? [rule.symbol] : []),
                ...(Array.isArray(rule.symbols) ? rule.symbols : [])
            ]
                .map((item) => this.normalizeSymbol(item))
                .filter(Boolean);

            if (!configuredSymbols.includes(normalizedSymbol)) {
                continue;
            }

            const rawPositionFraction = rule[sideKey];
            if (!this.isFiniteNumber(rawPositionFraction)) {
                continue;
            }

            return {
                symbol: normalizedSymbol,
                side: normalizedSide,
                positionFraction: Math.min(1, Math.max(0, rawPositionFraction)),
                ruleIndex: index,
                ruleName: typeof rule.name === 'string' && rule.name.trim() ? rule.name.trim() : undefined
            };
        }

        return undefined;
    }

    getAegisPortfolioRiskConfig(): Required<AegisPortfolioRiskYamlConfig> {
        const raw = this.config.aegis?.portfolio_risk || {};
        return {
            enabled: raw.enabled === true,
            max_open_positions: Math.max(0, Math.floor(this.finiteNumber(raw.max_open_positions, 0))),
            max_same_direction_positions: Math.max(0, Math.floor(this.finiteNumber(raw.max_same_direction_positions, 0))),
            max_margin_used_pct: Math.max(0, this.finiteNumber(raw.max_margin_used_pct, 0)),
            max_notional_to_equity: Math.max(0, this.finiteNumber(raw.max_notional_to_equity, 0)),
        };
    }

    getAegisShortGateConfig(): Required<AegisShortGateYamlConfig> {
        const raw = this.config.aegis?.short_gate || {};
        return {
            enabled: raw.enabled === true,
            mode: this.normalizeShortGateMode(raw.mode),
            min_score: Math.max(0, this.finiteNumber(raw.min_score, 0)),
            require_votes: Math.max(0, Math.floor(this.finiteNumber(raw.require_votes, 0))),
            position_fraction_multiplier: Math.max(0, this.finiteNumber(raw.position_fraction_multiplier, 1)),
            max_leverage: Math.max(0, this.finiteNumber(raw.max_leverage, 0)),
            block_symbols: Array.isArray(raw.block_symbols)
                ? raw.block_symbols.map((symbol) => this.normalizeSymbol(symbol)).filter(Boolean)
                : [],
            allow_if_regime_bearish: raw.allow_if_regime_bearish === true,
        };
    }

    getAegisEventRiskConfig(): AegisEventRiskRuntimeConfig {
        const raw = this.config.aegis?.event_risk || {};
        return {
            enabled: raw.enabled === true,
            mode: this.normalizeEventRiskMode(raw.mode),
            enforce: raw.enforce === true,
            manual_override_enabled: raw.manual_override_enabled === true,
            caution: {
                min_quality_score: Math.max(0, this.finiteNumber(raw.caution?.min_quality_score, 0.65)),
                max_tail_risk_score: Math.max(0, this.finiteNumber(raw.caution?.max_tail_risk_score, 0.45)),
                require_btc_eth_confirmation: raw.caution?.require_btc_eth_confirmation === true
            },
            risk_off: {
                min_quality_score: Math.max(0, this.finiteNumber(raw.risk_off?.min_quality_score, 0.75)),
                max_tail_risk_score: Math.max(0, this.finiteNumber(raw.risk_off?.max_tail_risk_score, 0.35)),
                allow_only_a_plus: raw.risk_off?.allow_only_a_plus === true
            },
            manual_only: {
                block_new_entries: raw.manual_only?.block_new_entries === true
            }
        };
    }

    getAegisDecisionEnforcementConfig(): AegisDecisionEnforcementRuntimeConfig {
        const raw = this.config.aegis?.decision_enforcement || {};
        return {
            enabled: raw.enabled === true,
            mode: this.normalizeDecisionEnforcementMode(raw.mode),
            block_do_not_enter: raw.block_do_not_enter === true,
            block_wait_confirmation: raw.block_wait_confirmation === true,
            block_manual_only: raw.block_manual_only === true,
            block_entry_quality_shadow_block_when_event_risk: {
                enabled: raw.block_entry_quality_shadow_block_when_event_risk?.enabled === true,
                event_modes: Array.isArray(raw.block_entry_quality_shadow_block_when_event_risk?.event_modes)
                    ? raw.block_entry_quality_shadow_block_when_event_risk.event_modes.map((mode) => this.normalizeEventRiskMode(mode))
                    : []
            },
            event_risk_enforcement: {
                caution_blocks_weak_entries: raw.event_risk_enforcement?.caution_blocks_weak_entries === true,
                risk_off_blocks_non_a_plus: raw.event_risk_enforcement?.risk_off_blocks_non_a_plus === true,
                manual_only_blocks_all_new_entries: raw.event_risk_enforcement?.manual_only_blocks_all_new_entries === true
            },
            block_caution_would_block_unless_a_plus: raw.block_caution_would_block_unless_a_plus === true,
            block_all_entry_quality_shadow_block: raw.block_all_entry_quality_shadow_block === true,
            block_all_tail_risk_high: raw.block_all_tail_risk_high === true
        };
    }

    getAegisTelegramNotificationsConfig(): AegisTelegramNotificationsRuntimeConfig {
        const raw = this.config.aegis?.telegram_notifications?.block_dedupe || {};
        return {
            block_dedupe: {
                enabled: raw.enabled !== false,
                cooldown_minutes: Math.max(1, this.finiteNumber(raw.cooldown_minutes, 15)),
                summary_threshold: Math.max(1, Math.floor(this.finiteNumber(raw.summary_threshold, 25))),
                max_cache_entries: Math.max(1, Math.floor(this.finiteNumber(raw.max_cache_entries, 1000))),
                include_suppressed_count: raw.include_suppressed_count !== false
            }
        };
    }

    setAegisEventRiskMode(mode: EventRiskMode | string): AegisEventRiskRuntimeConfig {
        const normalizedMode = this.normalizeEventRiskMode(mode);
        if (!this.config.aegis) {
            this.config.aegis = {};
        }
        this.config.aegis.event_risk = {
            ...(this.config.aegis.event_risk || {}),
            mode: normalizedMode
        };
        return this.getAegisEventRiskConfig();
    }

    getEntryQualityGateConfig(_symbol?: string): AegisEntryQualityGateRuntimeConfig {
        const raw = this.config.aegis?.entry_quality_gate || {};
        const flaggedSymbols = Array.isArray(raw.flagged_symbols)
            ? raw.flagged_symbols.map((item) => this.normalizeSymbol(item)).filter(Boolean)
            : [];

        return {
            enabled: raw.enabled === true,
            mode: this.normalizeEntryQualityGateMode(raw.mode),
            config: {
                minScoreLong: Math.max(0, this.finiteNumber(raw.min_score_long, 0.65)),
                minScoreShort: Math.max(0, this.finiteNumber(raw.min_score_short, 0.70)),
                requireMomentumConfirm: raw.require_momentum_confirm === true,
                antiFallingKnifeEnabled: raw.anti_falling_knife?.enabled === true,
                antiFallingKnifeLookbackCandles: Math.max(
                    1,
                    Math.floor(this.finiteNumber(raw.anti_falling_knife?.lookback_candles, 3))
                ),
                maxAdverseRecentReturn: Math.max(
                    0,
                    this.finiteNumber(raw.anti_falling_knife?.max_adverse_recent_return, 0.003)
                ),
                overextensionEnabled: raw.overextension?.enabled === true,
                emaDistanceLimit: Math.max(0, this.finiteNumber(raw.overextension?.ema_distance_limit, 0.006)),
                volatilityEnabled: raw.volatility?.enabled === true,
                maxAtrPercentile: Math.max(0, this.finiteNumber(raw.volatility?.max_atr_percentile, 0.75)),
                require3of3WhenSymbolFlagged: raw.require_3of3_when_symbol_flagged === true,
                flaggedSymbols
            }
        };
    }

    getAegisExitEyeConfig(): AegisExitEyeYamlConfig {
        const raw = this.config.aegis?.exit_eye || {};
        return {
            enabled: raw.enabled ?? false,
            mode: this.normalizeExitEyeMode(raw.mode),
            min_roe_to_protect: this.finiteNumber(raw.min_roe_to_protect, 0.08),
            min_peak_roe_to_protect: this.finiteNumber(raw.min_peak_roe_to_protect, 0.12),
            min_giveback_from_peak_roe: this.finiteNumber(raw.min_giveback_from_peak_roe, 0.04),
            neutral_votes_to_protect: Math.max(0, Math.floor(this.finiteNumber(raw.neutral_votes_to_protect, 2))),
            opposite_votes_to_close: Math.max(0, Math.floor(this.finiteNumber(raw.opposite_votes_to_close, 2))),
            min_roe_to_close_on_opposite: this.finiteNumber(raw.min_roe_to_close_on_opposite, 0.06),
            min_peak_roe_to_close_on_opposite: this.finiteNumber(raw.min_peak_roe_to_close_on_opposite, 0.10),
            close_on_neutral_decay: raw.close_on_neutral_decay === true,
            neutral_close_votes: Math.max(0, Math.floor(this.finiteNumber(raw.neutral_close_votes, 3))),
            min_roe_to_close_on_neutral: this.finiteNumber(raw.min_roe_to_close_on_neutral, 0.08),
            min_peak_roe_to_close_on_neutral: this.finiteNumber(raw.min_peak_roe_to_close_on_neutral, 0.12),
            min_giveback_to_close_on_neutral: this.finiteNumber(raw.min_giveback_to_close_on_neutral, 0.04),
            require_consecutive_neutral_close: Math.max(1, Math.floor(this.finiteNumber(raw.require_consecutive_neutral_close, 2))),
            require_consecutive_neutral: Math.max(1, Math.floor(this.finiteNumber(raw.require_consecutive_neutral, 2))),
            require_consecutive_opposite: Math.max(1, Math.floor(this.finiteNumber(raw.require_consecutive_opposite, 1))),
            min_minutes_in_trade: Math.max(0, this.finiteNumber(raw.min_minutes_in_trade, 3)),
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
            maxHoldMs: mergedConfig.max_trade_duration_ms || mergedConfig.max_hold_ms,
            beRoe: mergedConfig.be_roe,
            trailingActivationRoe: mergedConfig.trailing_activation_roe,
            trailingCallbackRoe: mergedConfig.trailing_callback_roe,
            forbiddenHours: mergedConfig.forbidden_hours,
            forbiddenDays: mergedConfig.forbidden_days,
            useExitAgent: mergedConfig.use_exit_agent
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
            AEGIS_TURBO: { leverage: 15, entryThreshold: 0.50, hardStopRoe: -0.15, tpRoe: 0.25, maxHoldMs: 28800000, beRoe: 0.10 }
        };
        return defaults[regime] || defaults.AEGIS_TURBO;
    }

    /**
     * Safe default configuration (used if YAML fails to load)
     */
    private getDefaultConfig(): NinjaYamlConfig {
        return {
            SYSTEM: {
                tick_interval_ms: 5000,
                max_trades_per_day: 100,
                global_leverage_default: 10,
                enable_sentinel: true
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
                AEGIS_TURBO: {
                    leverage: 15,
                    entry_threshold: 0.50,
                    hard_stop_roe: -0.15,
                    tp_roe: 0.25,
                    max_hold_ms: 28800000
                }
            },
            aegis: {
                turbo: {
                    enabled: false,
                    live_enabled: false,
                    allow_short: false,
                    position_fraction_cap: 0.10,
                    position_fraction_overrides: [],
                    max_trades_per_day: 1,
                    max_consecutive_losses: 1,
                    daily_loss_stop_pct: 0.10,
                    min_cooldown_ms: 900000,
                    max_liquidity_stress: 0.70,
                    require_brackets: true,
                    close_if_bracket_fails: true
                },
                exit_eye: {
                    enabled: false,
                    mode: 'OFF',
                    min_roe_to_protect: 0.08,
                    min_peak_roe_to_protect: 0.12,
                    min_giveback_from_peak_roe: 0.04,
                    neutral_votes_to_protect: 2,
                    opposite_votes_to_close: 2,
                    min_roe_to_close_on_opposite: 0.06,
                    min_peak_roe_to_close_on_opposite: 0.10,
                    close_on_neutral_decay: false,
                    neutral_close_votes: 3,
                    min_roe_to_close_on_neutral: 0.08,
                    min_peak_roe_to_close_on_neutral: 0.12,
                    min_giveback_to_close_on_neutral: 0.04,
                    require_consecutive_neutral_close: 2,
                    require_consecutive_neutral: 2,
                    require_consecutive_opposite: 1,
                    min_minutes_in_trade: 3
                },
                portfolio_risk: {
                    enabled: false
                },
                short_gate: {
                    enabled: false
                },
                event_risk: {
                    enabled: false,
                    mode: 'NORMAL',
                    enforce: false,
                    manual_override_enabled: false,
                    caution: {
                        min_quality_score: 0.65,
                        max_tail_risk_score: 0.45,
                        require_btc_eth_confirmation: true
                    },
                    risk_off: {
                        min_quality_score: 0.75,
                        max_tail_risk_score: 0.35,
                        allow_only_a_plus: true
                    },
                    manual_only: {
                        block_new_entries: false
                    }
                },
                decision_enforcement: {
                    enabled: false,
                    mode: 'OFF',
                    block_do_not_enter: false,
                    block_wait_confirmation: false,
                    block_manual_only: false,
                    block_entry_quality_shadow_block_when_event_risk: {
                        enabled: false,
                        event_modes: []
                    },
                    event_risk_enforcement: {
                        caution_blocks_weak_entries: false,
                        risk_off_blocks_non_a_plus: false,
                        manual_only_blocks_all_new_entries: false
                    },
                    block_caution_would_block_unless_a_plus: false,
                    block_all_entry_quality_shadow_block: false,
                    block_all_tail_risk_high: false
                },
                telegram_notifications: {
                    block_dedupe: {
                        enabled: true,
                        cooldown_minutes: 15,
                        summary_threshold: 25,
                        max_cache_entries: 1000,
                        include_suppressed_count: true
                    }
                },
                entry_quality_gate: {
                    enabled: false,
                    mode: 'OFF'
                }
            },
            symbols: {},
            SYMBOL_OVERRIDES: {}
        };
    }

    private normalizeSymbol(symbol?: string): string {
        return (symbol || '').trim().toUpperCase();
    }

    private normalizeSymbolMode(mode?: AegisSymbolMode | string): AegisSymbolMode {
        const normalized = (mode || 'SHADOW').trim().toUpperCase();
        if (normalized === 'OFF' || normalized === 'SHADOW' || normalized === 'LIVE') {
            return normalized;
        }
        return 'SHADOW';
    }

    private normalizeExitEyeMode(mode?: AegisExitEyeMode | string): AegisExitEyeMode {
        const normalized = (mode || 'OFF').trim().toUpperCase();
        if (normalized === 'OFF' || normalized === 'SHADOW' || normalized === 'PROTECT' || normalized === 'CLOSE') {
            return normalized;
        }
        return 'OFF';
    }

    private normalizeShortGateMode(mode?: AegisShortGateMode | string): AegisShortGateMode {
        const normalized = (mode || 'PREMIUM_ONLY').trim().toUpperCase();
        if (normalized === 'PREMIUM_ONLY') {
            return normalized;
        }
        return 'PREMIUM_ONLY';
    }

    private normalizeEntryQualityGateMode(mode?: AegisEntryQualityGateMode | string): AegisEntryQualityGateMode {
        const normalized = (mode || 'OFF').trim().toUpperCase();
        if (normalized === 'OFF' || normalized === 'SHADOW' || normalized === 'ENFORCE') {
            return normalized;
        }
        return 'OFF';
    }

    private normalizeDecisionEnforcementMode(mode?: AegisDecisionEnforcementMode | string): AegisDecisionEnforcementMode {
        const normalized = (mode || 'OFF').trim().toUpperCase();
        if (normalized === 'CONSERVATIVE') {
            return normalized;
        }
        return 'OFF';
    }

    private normalizeEventRiskMode(mode?: EventRiskMode | string): EventRiskMode {
        const normalized = (mode || 'NORMAL').trim().toUpperCase();
        if (
            normalized === 'NORMAL'
            || normalized === 'CAUTION'
            || normalized === 'RISK_OFF'
            || normalized === 'MANUAL_ONLY'
        ) {
            return normalized;
        }
        return 'NORMAL';
    }

    private finiteNumber(value: unknown, fallback: number): number {
        return this.isFiniteNumber(value) ? value : fallback;
    }

    private isFiniteNumber(value: unknown): value is number {
        return typeof value === 'number' && Number.isFinite(value);
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
