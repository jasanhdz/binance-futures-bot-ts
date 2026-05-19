import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { NinjaConfigManager } from './ConfigLoader';

const tempFiles: string[] = [];

function writeConfig(symbolsYaml: string, symbolOverridesYaml = '{}'): string {
    const filePath = path.join(os.tmpdir(), `aegis-symbols-${Date.now()}-${Math.random()}.yaml`);
    fs.writeFileSync(filePath, `
SYMBOLS:
  ETHUSDT: 1.0
SYSTEM:
  tick_interval_ms: 2000
  max_trades_per_day: 100
  global_leverage_default: 15
  enable_sentinel: false
REGIME_DETECTOR:
  volatility_spread_low: 0.0008
  volatility_spread_high: 0.0015
  bias_strength_threshold: 0.20
  obi_confirmation_threshold: 0.10
IMMUNE_SYSTEM:
  alpha_slow_rise: 0.15
  alpha_fast_fall: 0.70
  panic_exit_threshold: 0.55
REGIMES:
  AEGIS_TURBO:
    leverage: 20
    entry_threshold: 0.60
    hard_stop_roe: -0.40
    tp_roe: 0.50
aegis:
  turbo:
    enabled: true
    live_enabled: true
${symbolsYaml}
SYMBOL_OVERRIDES: ${symbolOverridesYaml}
`);
    tempFiles.push(filePath);
    return filePath;
}

describe('NinjaConfigManager Aegis symbol modes', () => {
    const massShadowSymbols = [
        'BTCUSDT',
        'SOLUSDT',
        'BNBUSDT',
        'XRPUSDT',
        'DOGEUSDT',
        'ADAUSDT',
        'AVAXUSDT',
        'LINKUSDT',
        'SUIUSDT',
        'LTCUSDT'
    ];

    afterEach(() => {
        for (const filePath of tempFiles.splice(0)) {
            try {
                fs.unlinkSync(filePath);
            } catch {
                // best-effort cleanup
            }
        }
    });

    it('parses OFF, SHADOW and LIVE modes', () => {
        const config = new NinjaConfigManager(writeConfig(`
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
  BTCUSDT:
    enabled: true
    mode: SHADOW
  SOLUSDT:
    enabled: false
    mode: OFF
`));

        expect(config.getSymbolMode('ETHUSDT')).toBe('LIVE');
        expect(config.getSymbolMode('BTCUSDT')).toBe('SHADOW');
        expect(config.getSymbolMode('SOLUSDT')).toBe('OFF');
        expect(config.getActiveAegisSymbols()).toEqual(['ETHUSDT', 'BTCUSDT']);
        expect(config.getLiveAegisSymbols()).toEqual(['ETHUSDT']);
        expect(config.getShadowAegisSymbols()).toEqual(['BTCUSDT']);
    });

    it('defaults missing mode to SHADOW and disabled symbols to OFF', () => {
        const config = new NinjaConfigManager(writeConfig(`
symbols:
  BTCUSDT:
    enabled: true
  SOLUSDT:
    enabled: false
    mode: LIVE
`));

        expect(config.getSymbolMode('BTCUSDT')).toBe('SHADOW');
        expect(config.getSymbolMode('SOLUSDT')).toBe('OFF');
    });

    it('permits validation when more than one symbol is LIVE', () => {
        const config = new NinjaConfigManager(writeConfig(`
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
  BTCUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getLiveAegisSymbols()).toEqual(['ETHUSDT', 'BTCUSDT']);
        expect(() => config.validateSingleLiveAegisSymbol()).not.toThrow();
    });

    it('accepts one LIVE symbol with ten SHADOW onboarding symbols', () => {
        const shadowYaml = massShadowSymbols
            .map((symbol) => `  ${symbol}:\n    enabled: true\n    mode: SHADOW`)
            .join('\n');
        const config = new NinjaConfigManager(writeConfig(`
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
${shadowYaml}
`));

        expect(config.getLiveAegisSymbols()).toEqual(['ETHUSDT']);
        expect(config.getShadowAegisSymbols()).toEqual(massShadowSymbols);
        expect(config.getActiveAegisSymbols()).toEqual(['ETHUSDT', ...massShadowSymbols]);
        expect(() => config.validateSingleLiveAegisSymbol()).not.toThrow();
    });

    it('applies conservative AEGIS_TURBO leverage overrides per onboarding symbol', () => {
        const shadowYaml = massShadowSymbols
            .map((symbol) => `  ${symbol}:\n    enabled: true\n    mode: SHADOW`)
            .join('\n');
        const leverageBySymbol = {
            ETHUSDT: 20,
            BTCUSDT: 20,
            SOLUSDT: 20,
            BNBUSDT: 15,
            XRPUSDT: 20,
            DOGEUSDT: 10,
            ADAUSDT: 20,
            AVAXUSDT: 20,
            LINKUSDT: 20,
            SUIUSDT: 8,
            LTCUSDT: 15
        };
        const overrideYaml = `
  ETHUSDT:
    AEGIS_TURBO:
      leverage: 20
  BTCUSDT:
    AEGIS_TURBO:
      leverage: 20
  SOLUSDT:
    AEGIS_TURBO:
      leverage: 20
  BNBUSDT:
    AEGIS_TURBO:
      leverage: 15
  XRPUSDT:
    AEGIS_TURBO:
      leverage: 20
  DOGEUSDT:
    AEGIS_TURBO:
      leverage: 10
  ADAUSDT:
    AEGIS_TURBO:
      leverage: 20
  AVAXUSDT:
    AEGIS_TURBO:
      leverage: 20
  LINKUSDT:
    AEGIS_TURBO:
      leverage: 20
  SUIUSDT:
    AEGIS_TURBO:
      leverage: 8
  LTCUSDT:
    AEGIS_TURBO:
      leverage: 15`;
        const config = new NinjaConfigManager(writeConfig(`
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
${shadowYaml}
`, overrideYaml));

        for (const [symbol, leverage] of Object.entries(leverageBySymbol)) {
            expect(config.getRegimeConfig('AEGIS_TURBO', symbol).leverage).toBe(leverage);
        }
        expect(config.getRegimeConfig('AEGIS_TURBO', 'UNKNOWNUSDT').leverage).toBe(20);
        expect(config.getRegimeConfig('AEGIS_TURBO', 'SUIUSDT').hardStopRoe).toBe(-0.40);
        expect(config.getRegimeConfig('AEGIS_TURBO', 'SUIUSDT').entryThreshold).toBe(0.60);
    });

    it('defaults portfolio risk and short gate to disabled', () => {
        const config = new NinjaConfigManager(writeConfig(`
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisPortfolioRiskConfig()).toMatchObject({ enabled: false });
        expect(config.getAegisShortGateConfig()).toMatchObject({ enabled: false });
        expect(config.getAegisEventRiskConfig()).toMatchObject({
            enabled: false,
            mode: 'NORMAL',
            enforce: false
        });
        expect(config.getAegisTelegramNotificationsConfig()).toEqual({
            automatic_block_alerts_enabled: false,
            block_dedupe: {
                enabled: true,
                cooldown_minutes: 15,
                summary_threshold: 25,
                max_cache_entries: 1000,
                include_suppressed_count: true
            }
        });
    });

    it('parses portfolio risk and short gate config', () => {
        const config = new NinjaConfigManager(writeConfig(`
  portfolio_risk:
    enabled: true
    max_open_positions: 4
    max_same_direction_positions: 3
    max_margin_used_pct: 0.45
    max_notional_to_equity: 10
  short_gate:
    enabled: true
    mode: PREMIUM_ONLY
    min_score: 0.80
    require_votes: 3
    position_fraction_multiplier: 0.50
    max_leverage: 10
    block_symbols:
      - solusdt
      - AVAXUSDT
    allow_if_regime_bearish: false
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisPortfolioRiskConfig()).toEqual({
            enabled: true,
            max_open_positions: 4,
            max_same_direction_positions: 3,
            max_margin_used_pct: 0.45,
            max_notional_to_equity: 10
        });
        expect(config.getAegisShortGateConfig()).toEqual({
            enabled: true,
            mode: 'PREMIUM_ONLY',
            min_score: 0.80,
            require_votes: 3,
            position_fraction_multiplier: 0.50,
            max_leverage: 10,
            block_symbols: ['SOLUSDT', 'AVAXUSDT'],
            allow_if_regime_bearish: false
        });
    });

    it('parses event risk config and supports runtime mode override', () => {
        const config = new NinjaConfigManager(writeConfig(`
  event_risk:
    enabled: true
    mode: RISK_OFF
    enforce: false
    manual_override_enabled: true
    caution:
      min_quality_score: 0.66
      max_tail_risk_score: 0.44
      require_btc_eth_confirmation: true
    risk_off:
      min_quality_score: 0.77
      max_tail_risk_score: 0.33
      allow_only_a_plus: true
    manual_only:
      block_new_entries: false
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisEventRiskConfig()).toEqual({
            enabled: true,
            mode: 'RISK_OFF',
            enforce: false,
            manual_override_enabled: true,
            caution: {
                min_quality_score: 0.66,
                max_tail_risk_score: 0.44,
                require_btc_eth_confirmation: true
            },
            risk_off: {
                min_quality_score: 0.77,
                max_tail_risk_score: 0.33,
                allow_only_a_plus: true
            },
            manual_only: {
                block_new_entries: false
            }
        });

        expect(config.setAegisEventRiskMode('MANUAL_ONLY').mode).toBe('MANUAL_ONLY');
        expect(config.getAegisEventRiskConfig().mode).toBe('MANUAL_ONLY');
    });

    it('loads CAUTION as YAML default while runtime riskmode override remains temporary', () => {
        const filePath = writeConfig(`
  event_risk:
    enabled: true
    mode: CAUTION
    enforce: false
    manual_override_enabled: true
    caution:
      min_quality_score: 0.65
      max_tail_risk_score: 0.45
      require_btc_eth_confirmation: true
    risk_off:
      min_quality_score: 0.75
      max_tail_risk_score: 0.35
      allow_only_a_plus: true
    manual_only:
      block_new_entries: false
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`);
        const config = new NinjaConfigManager(filePath);

        expect(config.getAegisEventRiskConfig().mode).toBe('CAUTION');
        expect(config.setAegisEventRiskMode('NORMAL').mode).toBe('NORMAL');
        expect(config.setAegisEventRiskMode('RISK_OFF').mode).toBe('RISK_OFF');

        const restartedConfig = new NinjaConfigManager(filePath);
        expect(restartedConfig.getAegisEventRiskConfig().mode).toBe('CAUTION');
    });

    it('parses decision enforcement conservative config', () => {
        const config = new NinjaConfigManager(writeConfig(`
  decision_enforcement:
    enabled: true
    mode: CONSERVATIVE
    block_do_not_enter: true
    block_wait_confirmation: true
    block_manual_only: true
    block_entry_quality_shadow_block_when_event_risk:
      enabled: true
      event_modes:
        - CAUTION
        - RISK_OFF
        - MANUAL_ONLY
    event_risk_enforcement:
      caution_blocks_weak_entries: true
      risk_off_blocks_non_a_plus: true
      manual_only_blocks_all_new_entries: true
    block_caution_would_block_unless_a_plus: true
    block_all_entry_quality_shadow_block: false
    block_all_tail_risk_high: false
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisDecisionEnforcementConfig()).toEqual({
            enabled: true,
            mode: 'CONSERVATIVE',
            block_do_not_enter: true,
            block_wait_confirmation: true,
            block_manual_only: true,
            block_entry_quality_shadow_block_when_event_risk: {
                enabled: true,
                event_modes: ['CAUTION', 'RISK_OFF', 'MANUAL_ONLY']
            },
            event_risk_enforcement: {
                caution_blocks_weak_entries: true,
                risk_off_blocks_non_a_plus: true,
                manual_only_blocks_all_new_entries: true
            },
            block_caution_would_block_unless_a_plus: true,
            block_all_entry_quality_shadow_block: false,
            block_all_tail_risk_high: false
        });
    });

    it('uses safe clean entry guard defaults when config is absent', () => {
        const config = new NinjaConfigManager(writeConfig(`
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisCleanEntryGuardConfig()).toMatchObject({
            enabled: false,
            mode: 'SHADOW',
            useEntryQualityModelAsSourceOfTruth: true,
            ignoreRuleGateInsufficientDataWhenModelOk: true,
            minFeatureParityPct: 95,
            dirtyConditions: {
                blockWhenTailRiskGte: 0.45
            },
            cleanConditions: {
                maxTailRiskScore: 0.40
            }
        });
    });

    it('parses clean entry guard config', () => {
        const config = new NinjaConfigManager(writeConfig(`
  clean_entry_guard:
    enabled: true
    mode: ENFORCE
    use_entry_quality_model_as_source_of_truth: true
    ignore_rule_gate_insufficient_data_when_model_ok: true
    min_feature_parity_pct: 96
    apply_to:
      long: true
      short: false
    dirty_conditions:
      block_when_entry_quality_insufficient: true
      block_when_event_risk_would_block: true
      block_when_tail_risk_gte: 0.46
      block_when_entry_quality_not_allow: true
    require_clean_for_premium_symbols: true
    clean_conditions:
      require_decision_brain_enter_now: true
      require_entry_quality_allow: true
      require_no_insufficient_data: true
      require_event_risk_would_block_false: true
      max_tail_risk_score: 0.39
    exception:
      allow_extreme_momentum_in_shadow_only: true
      min_turbo_score: 0.98
      require_votes_3_of_3: true
      max_tail_risk_score: 0.34
    telemetry:
      log_all_evaluations: true
      include_in_entry_metadata: true
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisCleanEntryGuardConfig()).toEqual({
            enabled: true,
            mode: 'ENFORCE',
            useEntryQualityModelAsSourceOfTruth: true,
            ignoreRuleGateInsufficientDataWhenModelOk: true,
            minFeatureParityPct: 96,
            applyTo: { long: true, short: false },
            dirtyConditions: {
                blockWhenEntryQualityInsufficient: true,
                blockWhenEventRiskWouldBlock: true,
                blockWhenTailRiskGte: 0.46,
                blockWhenEntryQualityNotAllow: true
            },
            requireCleanForPremiumSymbols: true,
            cleanConditions: {
                requireDecisionBrainEnterNow: true,
                requireEntryQualityAllow: true,
                requireNoInsufficientData: true,
                requireEventRiskWouldBlockFalse: true,
                maxTailRiskScore: 0.39
            },
            exception: {
                allowExtremeMomentumInShadowOnly: true,
                minTurboScore: 0.98,
                requireVotes3Of3: true,
                maxTailRiskScore: 0.34
            },
            telemetry: {
                logAllEvaluations: true,
                includeInEntryMetadata: true
            }
        });
    });

    it('parses Aegis Telegram block dedupe notification config', () => {
        const config = new NinjaConfigManager(writeConfig(`
  telegram_notifications:
    automatic_block_alerts_enabled: true
    block_dedupe:
      enabled: false
      cooldown_minutes: 10
      summary_threshold: 12
      max_cache_entries: 50
      include_suppressed_count: false
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisTelegramNotificationsConfig()).toEqual({
            automatic_block_alerts_enabled: true,
            block_dedupe: {
                enabled: false,
                cooldown_minutes: 10,
                summary_threshold: 12,
                max_cache_entries: 50,
                include_suppressed_count: false
            }
        });
    });

    it('parses Aegis profit protection config', () => {
        const config = new NinjaConfigManager(writeConfig(`
  profit_protection:
    enabled: true
    protect_profit_enabled: false
    min_peak_roe_to_protect: 0.09
    protect_giveback_roe: 0.045
    min_locked_roe: 0.015
    be_offset_pct: 0.004
    immediate_trigger_buffer_pct: 0.002
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisProfitProtectionConfig()).toEqual({
            enabled: true,
            protect_profit_enabled: false,
            min_peak_roe_to_protect: 0.09,
            protect_giveback_roe: 0.045,
            min_locked_roe: 0.015,
            be_offset_pct: 0.004,
            immediate_trigger_buffer_pct: 0.002
        });
    });

    it('resolves Aegis Turbo position fraction overrides by symbol group and side', () => {
        const config = new NinjaConfigManager(writeConfig(`
    position_fraction_overrides:
      - name: majors
        symbols:
          - btcusdt
          - ETHUSDT
        long: 0.16
        short: 0.08
      - name: link-only
        symbol: LINKUSDT
        long: 0.12
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
  BTCUSDT:
    enabled: true
    mode: LIVE
  LINKUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisPositionFractionOverride('BTCUSDT', 'LONG')).toEqual({
            symbol: 'BTCUSDT',
            side: 'LONG',
            positionFraction: 0.16,
            ruleIndex: 0,
            ruleName: 'majors'
        });
        expect(config.getAegisPositionFractionOverride('ethusdt', 'SHORT')).toEqual({
            symbol: 'ETHUSDT',
            side: 'SHORT',
            positionFraction: 0.08,
            ruleIndex: 0,
            ruleName: 'majors'
        });
        expect(config.getAegisPositionFractionOverride('LINKUSDT', 'LONG')).toMatchObject({
            symbol: 'LINKUSDT',
            side: 'LONG',
            positionFraction: 0.12,
            ruleName: 'link-only'
        });
        expect(config.getAegisPositionFractionOverride('LINKUSDT', 'SHORT')).toBeUndefined();
        expect(config.getAegisPositionFractionOverride('ADAUSDT', 'LONG')).toBeUndefined();
    });

    it('clamps configured position fraction overrides to wallet fraction bounds', () => {
        const config = new NinjaConfigManager(writeConfig(`
    position_fraction_overrides:
      - symbol: ADAUSDT
        long: 1.5
        short: -0.1
symbols:
  ADAUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisPositionFractionOverride('ADAUSDT', 'LONG')?.positionFraction).toBe(1);
        expect(config.getAegisPositionFractionOverride('ADAUSDT', 'SHORT')?.positionFraction).toBe(0);
    });

    it('parses operational policy with portfolio off and no blocked shorts', () => {
        const config = new NinjaConfigManager(writeConfig(`
  portfolio_risk:
    enabled: false
  short_gate:
    enabled: true
    mode: PREMIUM_ONLY
    min_score: 0.80
    require_votes: 3
    position_fraction_multiplier: 1.0
    max_leverage: 10
    block_symbols: []
    allow_if_regime_bearish: false
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisPortfolioRiskConfig().enabled).toBe(false);
        expect(config.getAegisShortGateConfig()).toMatchObject({
            enabled: true,
            mode: 'PREMIUM_ONLY',
            min_score: 0.80,
            require_votes: 3,
            position_fraction_multiplier: 1.0,
            max_leverage: 10,
            block_symbols: [],
            allow_if_regime_bearish: false
        });
    });

    it('parses full entry quality gate config', () => {
        const config = new NinjaConfigManager(writeConfig(`
  entry_quality_gate:
    enabled: true
    mode: SHADOW
    min_score_long: 0.65
    min_score_short: 0.70
    require_momentum_confirm: true
    anti_falling_knife:
      enabled: true
      lookback_candles: 3
      max_adverse_recent_return: 0.003
    overextension:
      enabled: true
      ema_distance_limit: 0.006
    volatility:
      enabled: true
      max_atr_percentile: 0.75
    require_3of3_when_symbol_flagged: true
    flagged_symbols:
      - dogeusdt
      - ETHUSDT
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getEntryQualityGateConfig()).toEqual({
            enabled: true,
            mode: 'SHADOW',
            config: {
                minScoreLong: 0.65,
                minScoreShort: 0.70,
                requireMomentumConfirm: true,
                antiFallingKnifeEnabled: true,
                antiFallingKnifeLookbackCandles: 3,
                maxAdverseRecentReturn: 0.003,
                overextensionEnabled: true,
                emaDistanceLimit: 0.006,
                volatilityEnabled: true,
                maxAtrPercentile: 0.75,
                require3of3WhenSymbolFlagged: true,
                flaggedSymbols: ['DOGEUSDT', 'ETHUSDT']
            }
        });
    });

    it('uses safe entry quality defaults when config is absent', () => {
        const config = new NinjaConfigManager(writeConfig(`
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getEntryQualityGateConfig()).toEqual({
            enabled: false,
            mode: 'OFF',
            config: {
                minScoreLong: 0.65,
                minScoreShort: 0.70,
                requireMomentumConfirm: false,
                antiFallingKnifeEnabled: false,
                antiFallingKnifeLookbackCandles: 3,
                maxAdverseRecentReturn: 0.003,
                overextensionEnabled: false,
                emaDistanceLimit: 0.006,
                volatilityEnabled: false,
                maxAtrPercentile: 0.75,
                require3of3WhenSymbolFlagged: false,
                flaggedSymbols: []
            }
        });
    });

    it('parses entry quality mode SHADOW correctly', () => {
        const config = new NinjaConfigManager(writeConfig(`
  entry_quality_gate:
    enabled: true
    mode: shadow
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getEntryQualityGateConfig().mode).toBe('SHADOW');
    });

    it('parses entry quality flagged_symbols correctly', () => {
        const config = new NinjaConfigManager(writeConfig(`
  entry_quality_gate:
    enabled: true
    mode: SHADOW
    flagged_symbols:
      - solusdt
      - LTCUSDT
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getEntryQualityGateConfig().config.flaggedSymbols).toEqual(['SOLUSDT', 'LTCUSDT']);
    });
});
