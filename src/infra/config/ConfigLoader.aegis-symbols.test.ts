import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { NinjaConfigManager } from './ConfigLoader';

const tempFiles: string[] = [];
const longRiskProbeBlockPolicy = {
    enabled: true,
    mode: 'ENFORCE_PROBE_LONG_CRITICAL',
    probeLongCriticalAction: 'BLOCK',
    probeLongHighAction: 'SHADOW',
    aegisLongCriticalAction: 'SHADOW',
    momentumLongCriticalAction: 'SHADOW',
    minRiskLevelToBlockProbe: 'CRITICAL',
    blockOnlyProbeMode: true,
    blockOnlyLong: true
};

function writeConfig(symbolsYaml: string, symbolOverridesYaml = '{}', extraYaml = ''): string {
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
${extraYaml}
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

    it('keeps analytical overlays SHADOW while E4 remains the explicit final veto', () => {
        const config = new NinjaConfigManager(path.resolve(process.cwd(), 'regime_config.live.yaml'));
        const guards = config.getAegisEntryPolicyConfig().guards;

        expect(Object.fromEntries(Object.entries(guards).map(([name, guard]) => [name, guard.mode])))
            .toEqual({
                regime: 'SHADOW',
                regime_context: 'SHADOW',
                momentum_ride: 'SHADOW',
                decision_brain: 'SHADOW',
                entry_quality: 'SHADOW',
                event_risk: 'SHADOW',
                clean_entry: 'SHADOW',
                probe_mode: 'SHADOW',
                long_risk_shadow: 'SHADOW',
                short_gate: 'SHADOW',
                e4_tail_risk: 'ENFORCE'
            });
        expect(Object.entries(guards).every(([name, guard]) =>
            guard.enabled && (name === 'e4_tail_risk' ? guard.mode === 'ENFORCE' : guard.mode === 'SHADOW')
        )).toBe(true);
    });

    it('uses 90 percent of available wallet for every live symbol and side', () => {
        const config = new NinjaConfigManager(path.resolve(process.cwd(), 'regime_config.live.yaml'));
        for (const symbol of ['ETHUSDT', ...massShadowSymbols]) {
            expect(config.getAegisPositionFractionOverride(symbol, 'LONG')?.positionFraction).toBe(0.90);
            expect(config.getAegisPositionFractionOverride(symbol, 'SHORT')?.positionFraction).toBe(0.90);
        }
        expect(config.getAegisTurboConfig()?.position_fraction_cap).toBe(0.90);
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

    it('resolves symbol defaults without activating omitted symbols', () => {
        const config = new NinjaConfigManager(writeConfig(`
symbols:
  defaults:
    enabled: true
    mode: LIVE
  entries:
    ETHUSDT: {}
    BTCUSDT:
      mode: SHADOW
`));

        expect(config.getSymbolMode('ETHUSDT')).toBe('LIVE');
        expect(config.getSymbolMode('BTCUSDT')).toBe('SHADOW');
        expect(config.getSymbolMode('SOLUSDT')).toBe('SHADOW');
        expect(config.getLiveAegisSymbols()).toEqual(['ETHUSDT']);
        expect(config.getShadowAegisSymbols()).toEqual(['BTCUSDT']);
    });

    it('keeps legacy symbol config working without defaults or profiles', () => {
        const config = new NinjaConfigManager(writeConfig(`
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
  BTCUSDT:
    enabled: false
    mode: LIVE
`));

        expect(config.getSymbolMode('ETHUSDT')).toBe('LIVE');
        expect(config.getSymbolMode('BTCUSDT')).toBe('OFF');
        expect(config.getActiveAegisSymbols()).toEqual(['ETHUSDT']);
    });

    it('resolves AEGIS_TURBO regime profiles before symbol overrides', () => {
        const config = new NinjaConfigManager(writeConfig(`
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
  BNBUSDT:
    enabled: true
    mode: LIVE
`, `
  ETHUSDT:
    AEGIS_TURBO:
      profile: major_default
  BNBUSDT:
    AEGIS_TURBO:
      profile: lower_leverage
      entry_threshold: 0.62
`, `
REGIME_PROFILES:
  AEGIS_TURBO:
    major_default:
      leverage: 20
    lower_leverage:
      leverage: 15
      entry_threshold: 0.61
`));

        expect(config.getRegimeConfig('AEGIS_TURBO', 'ETHUSDT')).toMatchObject({
            leverage: 20,
            entryThreshold: 0.60,
            hardStopRoe: -0.40,
            tpRoe: 0.50
        });
        expect(config.getRegimeConfig('AEGIS_TURBO', 'BNBUSDT')).toMatchObject({
            leverage: 15,
            entryThreshold: 0.62,
            hardStopRoe: -0.40,
            tpRoe: 0.50
        });
        expect(config.getRegimeConfig('AEGIS_TURBO', 'SOLUSDT')).toMatchObject({
            leverage: 20,
            entryThreshold: 0.60
        });
    });

    it('keeps effective AEGIS_TURBO config equivalent between repeated and profiled live-style YAML', () => {
        const symbolsYaml = `
symbols:
  defaults:
    enabled: true
    mode: LIVE
  entries:
    ETHUSDT: {}
    BTCUSDT: {}
    BNBUSDT: {}
    DOGEUSDT: {}
    SUIUSDT: {}
`;
        const legacyConfig = new NinjaConfigManager(writeConfig(symbolsYaml, `
  ETHUSDT:
    AEGIS_TURBO:
      leverage: 20
  BTCUSDT:
    AEGIS_TURBO:
      leverage: 20
  BNBUSDT:
    AEGIS_TURBO:
      leverage: 15
  DOGEUSDT:
    AEGIS_TURBO:
      leverage: 10
  SUIUSDT:
    AEGIS_TURBO:
      leverage: 8
`));
        const dryConfig = new NinjaConfigManager(writeConfig(symbolsYaml, `
  ETHUSDT:
    AEGIS_TURBO: {}
  BTCUSDT:
    AEGIS_TURBO: {}
  BNBUSDT:
    AEGIS_TURBO:
      profile: reduced_15x
  DOGEUSDT:
    AEGIS_TURBO:
      profile: reduced_10x
  SUIUSDT:
    AEGIS_TURBO:
      profile: reduced_8x
`, `
REGIME_PROFILES:
  AEGIS_TURBO:
    reduced_15x:
      leverage: 15
    reduced_10x:
      leverage: 10
    reduced_8x:
      leverage: 8
`));

        for (const symbol of ['ETHUSDT', 'BTCUSDT', 'BNBUSDT', 'DOGEUSDT', 'SUIUSDT']) {
            expect(dryConfig.getRegimeConfig('AEGIS_TURBO', symbol)).toEqual(
                legacyConfig.getRegimeConfig('AEGIS_TURBO', symbol)
            );
            expect(dryConfig.getSymbolMode(symbol)).toBe(legacyConfig.getSymbolMode(symbol));
        }
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

    it('parses regime guard config', () => {
        const config = new NinjaConfigManager(writeConfig(`
  regime_guard:
    enabled: true
    mode: ENFORCE
    source: ML_MODEL
    allow_when:
      - MOMENTUM_UP
      - TREND_DOWN
    block_when:
      - CHOP
      - UNKNOWN
    min_confidence: 0.72
    max_snapshot_age_seconds: 600
    high_tail_risk_threshold: 0.41
    require_btc_eth_alignment_for_alts: false
    allow_alt_long_when_btc_short: true
    allow_alt_short_when_btc_long: true
    telemetry:
      log_all_evaluations: true
      include_in_entry_metadata: false
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisRegimeGuardConfig()).toEqual({
            enabled: true,
            mode: 'ENFORCE',
            source: 'ML_MODEL',
            allowWhen: ['MOMENTUM_UP', 'TREND_DOWN'],
            blockWhen: ['CHOP', 'UNKNOWN'],
            minConfidence: 0.72,
            maxSnapshotAgeSeconds: 600,
            requireBtcEthAlignmentForAlts: false,
            allowAltLongWhenBtcShort: true,
            allowAltShortWhenBtcLong: true,
            highTailRiskThreshold: 0.41,
            telemetry: {
                logAllEvaluations: true,
                includeInEntryMetadata: false
            }
        });
    });

    it('uses safe regime guard defaults and normalizes invalid values', () => {
        const config = new NinjaConfigManager(writeConfig(`
  regime_guard:
    enabled: true
    mode: INVALID
    source: BROKEN
    allow_when:
      - NOPE
    block_when:
      - ALSO_NOPE
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisRegimeGuardConfig()).toMatchObject({
            enabled: true,
            mode: 'SHADOW',
            source: 'HYBRID_HEURISTIC',
            allowWhen: ['MOMENTUM_UP', 'MOMENTUM_DOWN', 'BREAKOUT_UP', 'BREAKOUT_DOWN', 'TREND_UP', 'TREND_DOWN'],
            blockWhen: ['RISK_OFF', 'HIGH_VOL_RISK'],
            minConfidence: 0.60,
            maxSnapshotAgeSeconds: 900,
            highTailRiskThreshold: 0.45,
            requireBtcEthAlignmentForAlts: true,
            allowAltLongWhenBtcShort: false,
            allowAltShortWhenBtcLong: false
        });
    });

    it('parses entry_policy regime guard OFF, SHADOW and ENFORCE', () => {
        const shadowConfig = new NinjaConfigManager(writeConfig(`
  entry_policy:
    enabled: true
    guards:
      regime:
        enabled: true
        mode: SHADOW
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));
        const enforceConfig = new NinjaConfigManager(writeConfig(`
  entry_policy:
    enabled: true
    guards:
      regime:
        enabled: true
        mode: ENFORCE
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));
        const offConfig = new NinjaConfigManager(writeConfig(`
  regime_guard:
    enabled: true
    mode: SHADOW
  entry_policy:
    enabled: true
    guards:
      regime:
        enabled: false
        mode: OFF
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(shadowConfig.getAegisEntryPolicyConfig().guards.regime).toEqual({ enabled: true, mode: 'SHADOW' });
        expect(enforceConfig.getAegisEntryPolicyConfig().guards.regime).toEqual({ enabled: true, mode: 'ENFORCE' });
        expect(offConfig.getAegisEntryPolicyConfig().guards.regime).toEqual({ enabled: false, mode: 'OFF' });
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

    it('parses probe mode config', () => {
        const config = new NinjaConfigManager(writeConfig(`
  probe_mode:
    enabled: true
    mode: ENFORCE
    apply_when_event_risk:
      - CAUTION
    min_turbo_score: 0.91
    max_tail_risk_score: 0.29
    require_decision_brain: ENTER_NOW
    require_entry_quality_allow: true
    require_feature_status_ok: true
    min_feature_parity_pct: 96
    allow_if_blocked_only_by:
      - clean_entry_event_risk_would_block
      - caution_btc_eth_not_confirmed
    max_probe_entries_per_hour: 1
    min_minutes_between_probe_entries: 60
    max_open_probe_positions: 1
    max_total_open_positions_when_probe: 2
    block_after_consecutive_losses: 2
    block_after_recent_stop_loss_minutes: 60
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisProbeModeConfig()).toEqual({
            enabled: true,
            mode: 'ENFORCE',
            apply_when_event_risk: ['CAUTION'],
            min_turbo_score: 0.91,
            max_tail_risk_score: 0.29,
            require_decision_brain: 'ENTER_NOW',
            require_entry_quality_allow: true,
            require_feature_status_ok: true,
            min_feature_parity_pct: 96,
            allow_if_blocked_only_by: ['clean_entry_event_risk_would_block', 'caution_btc_eth_not_confirmed'],
            max_probe_entries_per_hour: 1,
            min_minutes_between_probe_entries: 60,
            max_open_probe_positions: 1,
            max_total_open_positions_when_probe: 2,
            block_after_consecutive_losses: 2,
            block_after_recent_stop_loss_minutes: 60
        });
    });

    it('parses Aegis entry policy guard modes', () => {
        const config = new NinjaConfigManager(writeConfig(`
  entry_policy:
    enabled: true
    guards:
      regime:
        enabled: true
        mode: SHADOW
      decision_brain:
        enabled: true
        mode: ENFORCE
      entry_quality:
        enabled: true
        mode: SHADOW
      event_risk:
        enabled: false
        mode: OFF
      clean_entry:
        enabled: true
        mode: ENFORCE
      probe_mode:
        enabled: true
        mode: SHADOW
      short_gate:
        enabled: true
        mode: ENFORCE
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisEntryPolicyConfig()).toEqual({
            enabled: true,
            guards: {
                regime: { enabled: true, mode: 'SHADOW' },
                regime_context: { enabled: false, mode: 'SHADOW' },
                momentum_ride: { enabled: false, mode: 'SHADOW' },
                decision_brain: { enabled: true, mode: 'ENFORCE' },
                entry_quality: { enabled: true, mode: 'SHADOW' },
                event_risk: { enabled: false, mode: 'OFF' },
                clean_entry: { enabled: true, mode: 'ENFORCE' },
                probe_mode: { enabled: true, mode: 'SHADOW' },
                long_risk_shadow: longRiskProbeBlockPolicy,
                short_gate: { enabled: true, mode: 'ENFORCE' },
                e4_tail_risk: { enabled: false, mode: 'OFF' }
            }
        });
    });

    it('defaults entry policy from legacy guard configs when entry_policy is absent', () => {
        const config = new NinjaConfigManager(writeConfig(`
  decision_enforcement:
    enabled: true
    mode: CONSERVATIVE
  entry_quality_gate:
    enabled: true
    mode: SHADOW
  event_risk:
    enabled: true
    mode: CAUTION
  regime_guard:
    enabled: true
    mode: SHADOW
  clean_entry_guard:
    enabled: true
    mode: ENFORCE
  probe_mode:
    enabled: true
    mode: ENFORCE
  short_gate:
    enabled: true
    mode: PREMIUM_ONLY
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisEntryPolicyConfig()).toEqual({
            enabled: true,
            guards: {
                regime: { enabled: true, mode: 'SHADOW' },
                regime_context: { enabled: false, mode: 'SHADOW' },
                momentum_ride: { enabled: false, mode: 'SHADOW' },
                decision_brain: { enabled: true, mode: 'ENFORCE' },
                entry_quality: { enabled: true, mode: 'SHADOW' },
                event_risk: { enabled: true, mode: 'SHADOW' },
                clean_entry: { enabled: true, mode: 'ENFORCE' },
                probe_mode: { enabled: true, mode: 'ENFORCE' },
                long_risk_shadow: longRiskProbeBlockPolicy,
                short_gate: { enabled: true, mode: 'ENFORCE' },
                e4_tail_risk: { enabled: false, mode: 'OFF' }
            }
        });
    });

    it('uses safe entry policy defaults for invalid guard modes', () => {
        const config = new NinjaConfigManager(writeConfig(`
  entry_policy:
    enabled: true
    guards:
      clean_entry:
        enabled: true
        mode: invalid
      probe_mode:
        enabled: true
        mode: OFF
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisEntryPolicyConfig().guards.clean_entry).toEqual({
            enabled: true,
            mode: 'SHADOW'
        });
        expect(config.getAegisEntryPolicyConfig().guards.probe_mode).toEqual({
            enabled: false,
            mode: 'OFF'
        });
    });

    it('allows entry_policy to enforce only clean_entry without enabling unspecified guards', () => {
        const config = new NinjaConfigManager(writeConfig(`
  entry_policy:
    enabled: true
    guards:
      clean_entry:
        enabled: true
        mode: ENFORCE
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisEntryPolicyConfig()).toEqual({
            enabled: true,
            guards: {
                regime: { enabled: false, mode: 'SHADOW' },
                regime_context: { enabled: false, mode: 'SHADOW' },
                momentum_ride: { enabled: false, mode: 'SHADOW' },
                decision_brain: { enabled: false, mode: 'ENFORCE' },
                entry_quality: { enabled: false, mode: 'OFF' },
                event_risk: { enabled: false, mode: 'SHADOW' },
                clean_entry: { enabled: true, mode: 'ENFORCE' },
                probe_mode: { enabled: false, mode: 'OFF' },
                long_risk_shadow: longRiskProbeBlockPolicy,
                short_gate: { enabled: false, mode: 'ENFORCE' },
                e4_tail_risk: { enabled: false, mode: 'OFF' }
            }
        });
    });

    it('allows entry_policy to turn clean_entry OFF explicitly', () => {
        const config = new NinjaConfigManager(writeConfig(`
  clean_entry_guard:
    enabled: true
    mode: ENFORCE
  entry_policy:
    enabled: true
    guards:
      clean_entry:
        enabled: false
        mode: OFF
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisEntryPolicyConfig().guards.clean_entry).toEqual({
            enabled: false,
            mode: 'OFF'
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

    it('uses the global 90 percent allocation for AVAX on both sides', () => {
        const config = new NinjaConfigManager(path.resolve(process.cwd(), 'regime_config.live.yaml'));

        expect(config.getAegisPositionFractionOverride('AVAXUSDT', 'SHORT')).toMatchObject({
            symbol: 'AVAXUSDT',
            side: 'SHORT',
            positionFraction: 0.90,
            ruleName: 'all_symbols_available_wallet_90pct'
        });
        expect(config.getAegisPositionFractionOverride('AVAXUSDT', 'LONG')).toMatchObject({
            symbol: 'AVAXUSDT',
            side: 'LONG',
            positionFraction: 0.90,
            ruleName: 'all_symbols_available_wallet_90pct'
        });
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
                maxAtrPercentile: 0.75
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
                maxAtrPercentile: 0.75
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

    it('parses regime_context and entry_policy guard config', () => {
        const config = new NinjaConfigManager(writeConfig(`
  entry_policy:
    guards:
      regime_context:
        enabled: true
        mode: SHADOW
  regime_context:
    enabled: true
    mode: SHADOW
    timeframe: 5m
    thresholds:
      min_volume_ratio_for_momentum: 1.5
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisRegimeContextConfig()).toMatchObject({
            enabled: true,
            mode: 'SHADOW',
            timeframe: '5m',
            thresholds: expect.objectContaining({ minVolumeRatioForMomentum: 1.5 })
        });
        expect(config.getAegisEntryPolicyConfig().guards.regime_context).toEqual({ enabled: true, mode: 'SHADOW' });
    });

    it('parses momentum_ride global, symbol and side overrides with safe caps', () => {
        const config = new NinjaConfigManager(writeConfig(`
  entry_policy:
    guards:
      momentum_ride:
        enabled: true
        mode: SHADOW
  momentum_ride:
    enabled: true
    mode: SHADOW
    research_mode: true
    regime_filter:
      enabled: true
      use_as_gate: false
      record_metadata: true
      ignore_for_entry: true
    require_aegis_direction_confirmation: true
    allow_momentum_against_aegis: true
    require_btc_eth_not_contradicting: true
    require_btc_eth_confirmation: false
    symbols:
      xrpusdt:
        enabled: true
        mode: SHADOW
        long:
          enabled: true
          leverage: 100
          position_fraction: 0.10
          min_turbo_score: 0.85
        short:
          enabled: false
    safety_caps:
      max_leverage: 50
      max_position_fraction: 0.03
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        const momentum = config.getAegisMomentumRideConfig();
        expect(momentum.enabled).toBe(true);
        expect(momentum.researchMode).toBe(true);
        expect(momentum.regimeFilter).toEqual({
            enabled: true,
            useAsGate: false,
            recordMetadata: true,
            ignoreForEntry: true
        });
        expect(momentum.requireAegisDirectionConfirmation).toBe(true);
        expect(momentum.allowMomentumAgainstAegis).toBe(false);
        expect(momentum.requireBtcEthNotContradicting).toBe(true);
        expect(momentum.requireBtcEthConfirmation).toBe(false);
        expect(momentum.symbols.XRPUSDT.long.enabled).toBe(true);
        expect(momentum.symbols.XRPUSDT.long.leverage).toBe(50);
        expect(momentum.symbols.XRPUSDT.long.positionFraction).toBe(0.03);
        expect(momentum.symbols.XRPUSDT.long.minTurboScore).toBe(0.85);
        expect(momentum.symbols.XRPUSDT.short.enabled).toBe(false);
        expect(config.getAegisEntryPolicyConfig().guards.momentum_ride).toEqual({ enabled: true, mode: 'SHADOW' });
    });

    it('resolves momentum_ride defaults, profiles and symbol side overrides', () => {
        const config = new NinjaConfigManager(writeConfig(`
  momentum_ride:
    enabled: true
    mode: ENFORCE
    defaults:
      long:
        position_fraction: 0.02
        min_turbo_score: 0.90
        min_volume_ratio: 1.55
        momentum_candles: 3
        max_tail_risk_score: 0.25
        require_close_near_extreme: true
        min_close_location: 0.70
        max_wick_ratio: 0.35
        max_overextension_pct: 0.10
        allowed_regimes: [MOMENTUM_UP, TREND_UP, BREAKOUT_UP]
      short:
        position_fraction: 0.01
        min_turbo_score: 0.94
        min_volume_ratio: 1.75
        momentum_candles: 3
        max_tail_risk_score: 0.22
        require_close_near_extreme: true
        min_close_location: 0.70
        max_wick_ratio: 0.35
        max_overextension_pct: 0.08
        allowed_regimes: [MOMENTUM_DOWN, TREND_DOWN, BREAKOUT_DOWN]
    profiles:
      major_high_confidence_long:
        leverage: 50
        min_turbo_score: 0.88
        min_volume_ratio: 1.35
        max_tail_risk_score: 0.28
      major_short:
        leverage: 35
        position_fraction: 0.015
        min_turbo_score: 0.92
        min_volume_ratio: 1.45
        max_tail_risk_score: 0.25
    symbols:
      btcusdt:
        enabled: true
        mode: ENFORCE
        long:
          enabled: true
          profile: major_high_confidence_long
        short:
          enabled: true
          profile: major_short
      ethusdt:
        enabled: true
        mode: ENFORCE
        long:
          enabled: true
          profile: major_high_confidence_long
          max_tail_risk_score: 0.30
        short:
          enabled: true
          profile: major_short
          leverage: 30
    safety_caps:
      max_leverage: 50
      max_position_fraction: 0.02
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        const momentum = config.getAegisMomentumRideConfig();

        expect(momentum.symbols.BTCUSDT.long).toMatchObject({
            enabled: true,
            leverage: 50,
            positionFraction: 0.02,
            minTurboScore: 0.88,
            minVolumeRatio: 1.35,
            momentumCandles: 3,
            maxTailRiskScore: 0.28,
            maxOverextensionPct: 0.10,
            allowedRegimes: ['MOMENTUM_UP', 'TREND_UP', 'BREAKOUT_UP']
        });
        expect(momentum.symbols.BTCUSDT.short).toMatchObject({
            enabled: true,
            leverage: 35,
            positionFraction: 0.015,
            minTurboScore: 0.92,
            minVolumeRatio: 1.45,
            momentumCandles: 3,
            maxTailRiskScore: 0.25,
            maxOverextensionPct: 0.08,
            allowedRegimes: ['MOMENTUM_DOWN', 'TREND_DOWN', 'BREAKOUT_DOWN']
        });
        expect(momentum.symbols.ETHUSDT.long.maxTailRiskScore).toBe(0.30);
        expect(momentum.symbols.ETHUSDT.short.leverage).toBe(30);
    });

    it('keeps missing momentum profile safe and does not enable an omitted side', () => {
        const config = new NinjaConfigManager(writeConfig(`
  momentum_ride:
    enabled: true
    mode: ENFORCE
    defaults:
      long:
        leverage: 20
        position_fraction: 0.02
        min_turbo_score: 0.90
      short:
        leverage: 10
        position_fraction: 0.01
        min_turbo_score: 0.94
    profiles:
      known_long:
        leverage: 40
    symbols:
      xrpusdt:
        enabled: true
        mode: ENFORCE
        long:
          profile: missing_profile
        short:
          enabled: true
          profile: missing_profile
    safety_caps:
      max_leverage: 50
      max_position_fraction: 0.02
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        const momentum = config.getAegisMomentumRideConfig();

        expect(momentum.symbols.XRPUSDT.long.enabled).toBe(false);
        expect(momentum.symbols.XRPUSDT.long.leverage).toBe(20);
        expect(momentum.symbols.XRPUSDT.long.positionFraction).toBe(0.02);
        expect(momentum.symbols.XRPUSDT.short.enabled).toBe(true);
        expect(momentum.symbols.XRPUSDT.short.leverage).toBe(10);
        expect(momentum.symbols.XRPUSDT.short.positionFraction).toBe(0.01);
    });

    it('caps momentum profile leverage and position fraction without changing normal Aegis sizing', () => {
        const config = new NinjaConfigManager(writeConfig(`
  momentum_ride:
    enabled: true
    mode: ENFORCE
    defaults:
      long:
        leverage: 20
        position_fraction: 0.02
      short:
        leverage: 10
        position_fraction: 0.01
    profiles:
      aggressive_long:
        leverage: 100
        position_fraction: 0.50
    symbols:
      xrpusdt:
        enabled: true
        mode: ENFORCE
        long:
          enabled: true
          profile: aggressive_long
    safety_caps:
      max_leverage: 50
      max_position_fraction: 0.02
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`, `
  XRPUSDT:
    AEGIS_TURBO:
      leverage: 20
      entry_threshold: 0.60
      hard_stop_roe: -0.40
      tp_roe: 0.50
`));

        const momentum = config.getAegisMomentumRideConfig();

        expect(momentum.symbols.XRPUSDT.long.leverage).toBe(50);
        expect(momentum.symbols.XRPUSDT.long.positionFraction).toBe(0.02);
        expect(config.getRegimeConfig('AEGIS_TURBO', 'XRPUSDT')).toMatchObject({
            leverage: 20,
            entryThreshold: 0.60
        });
    });

    it('leaves omitted momentum LONG/SHORT sides disabled by default', () => {
        const config = new NinjaConfigManager(writeConfig(`
  momentum_ride:
    enabled: true
    mode: SHADOW
    symbols:
      xrpusdt:
        enabled: true
        mode: SHADOW
        long:
          leverage: 50
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        const momentum = config.getAegisMomentumRideConfig();
        expect(momentum.symbols.XRPUSDT.long.enabled).toBe(false);
        expect(momentum.symbols.XRPUSDT.short.enabled).toBe(false);
    });

    it('uses safe momentum defaults when config is absent or invalid', () => {
        const config = new NinjaConfigManager(writeConfig(`
  entry_policy:
    guards:
      momentum_ride:
        enabled: true
        mode: INVALID
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
`));

        expect(config.getAegisMomentumRideConfig()).toMatchObject({
            enabled: false,
            mode: 'SHADOW',
            researchMode: false,
            regimeFilter: {
                enabled: false,
                useAsGate: false,
                recordMetadata: true,
                ignoreForEntry: false
            },
            requireAegisDirectionConfirmation: true,
            allowMomentumAgainstAegis: false,
            symbols: {}
        });
        expect(config.getAegisEntryPolicyConfig().guards.momentum_ride).toEqual({ enabled: true, mode: 'SHADOW' });
    });
});
