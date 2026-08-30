import { createHash } from 'node:crypto';
import { Side } from '../../core/types';
import {
  AegisCleanEntryGuardRuntimeConfig,
  AegisDecisionEnforcementRuntimeConfig,
  AegisEntryQualityGateRuntimeConfig,
  AegisEventRiskRuntimeConfig,
  AegisExitEyeYamlConfig,
  AegisPhaseOShortLiveYamlConfig,
  AegisPortfolioRiskYamlConfig,
  AegisPositionFractionOverride,
  AegisProfitProtectionRuntimeConfig,
  AegisShortGateYamlConfig,
  AegisTelegramNotificationsRuntimeConfig,
  AegisTurboYamlConfig,
  NinjaConfigManager,
} from '../../infra/config/ConfigLoader';
import {
  AegisEntryGuardPolicy,
  AegisEntryPolicyRuntimeConfig,
  AegisMomentumRideRuntimeConfig,
  AegisRegimeContextRuntimeConfig,
} from '../../strategies/aegis/domain/entry/AegisEntryDecisionTypes';
import {
  DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG,
} from '../../strategies/aegis/domain/services/AegisCleanEntryGuard';
import {
  AegisProbeModeRuntimeConfig,
} from '../../strategies/aegis/domain/services/AegisProbeMode';
import {
  AegisRegimeGuardConfig,
  DEFAULT_AEGIS_REGIME_GUARD_CONFIG,
} from '../../strategies/aegis/domain/services/AegisRegimeGuard';
import { DEFAULT_AEGIS_BLOCK_NOTIFICATION_CONFIG } from '../services/AegisTelegramBlockNotifier';
import {
  mergeMicroBurstConfigs,
  parseMicroBurstConfig,
} from '../../strategies/micro-burst/application/MicroBurstConfigLoader';

export class TradingRuntimeConfigService {
  constructor(
    private readonly manager: NinjaConfigManager,
    private readonly entryQualityGateConfig: () => AegisEntryQualityGateRuntimeConfig,
  ) {}

  getMicroBurstConfig(): ReturnType<typeof parseMicroBurstConfig> {
    const manager = this.manager as NinjaConfigManager & {
      getMicroBurstConfig?: () => ReturnType<typeof parseMicroBurstConfig>;
    };
    const base = manager.getMicroBurstConfig ? manager.getMicroBurstConfig() : parseMicroBurstConfig({});
    return mergeMicroBurstConfigs(base, {
      prospectiveValidation:
        process.env.PHANTOM_MICRO_BURST_PROSPECTIVE_VALIDATION === undefined
          ? undefined
          : { enabled: process.env.PHANTOM_MICRO_BURST_PROSPECTIVE_VALIDATION === 'true' },
      marketArchive:
        process.env.PHANTOM_MICRO_BURST_MARKET_ARCHIVE === undefined
          ? undefined
          : { enabled: process.env.PHANTOM_MICRO_BURST_MARKET_ARCHIVE === 'true' },
    });
  }

  getMicroBurstProvenance(config: ReturnType<typeof parseMicroBurstConfig>) {
    const stable = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
      if (value && typeof value === 'object') {
        return `{${Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
          .join(',')}}`;
      }
      return JSON.stringify(value);
    };
    const configHash = createHash('sha256').update(stable(config)).digest('hex');
    const codeCommitSha = process.env.GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? process.env.COMMIT_SHA ?? 'UNKNOWN';
    const requestedCohort = config.prospectiveValidation?.cohortId;
    const cohortId = requestedCohort ?? `MBV1-M3_2-${codeCommitSha.slice(0, 12)}-${configHash.slice(0, 12)}`;
    return {
      codeCommitSha,
      configHash,
      cohortId,
      officialCohortReady: codeCommitSha !== 'UNKNOWN' && cohortId.startsWith('MBV1-M3_2-'),
    };
  }

  getAegisTurboYamlConfig(): AegisTurboYamlConfig | undefined {
    const manager = this.manager as any;
    return typeof manager.getAegisTurboConfig === 'function' ? manager.getAegisTurboConfig() : undefined;
  }

  getAegisPhaseOShortLiveConfig(): AegisPhaseOShortLiveYamlConfig | undefined {
    const manager = this.manager as any;
    return typeof manager.getAegisPhaseOShortLiveConfig === 'function' ? manager.getAegisPhaseOShortLiveConfig() : undefined;
  }

  getAegisExitEyeConfig(): AegisExitEyeYamlConfig {
    const manager = this.manager as any;
    if (typeof manager.getAegisExitEyeConfig === 'function') return manager.getAegisExitEyeConfig();
    return {
      enabled: false, mode: 'OFF', min_roe_to_protect: 0.08, min_peak_roe_to_protect: 0.12,
      min_giveback_from_peak_roe: 0.04, neutral_votes_to_protect: 2, opposite_votes_to_close: 2,
      min_roe_to_close_on_opposite: 0.06, min_peak_roe_to_close_on_opposite: 0.1,
      close_on_neutral_decay: false, neutral_close_votes: 3, min_roe_to_close_on_neutral: 0.08,
      min_peak_roe_to_close_on_neutral: 0.12, min_giveback_to_close_on_neutral: 0.04,
      require_consecutive_neutral_close: 2, require_consecutive_neutral: 2,
      require_consecutive_opposite: 1, min_minutes_in_trade: 3,
    };
  }

  getAegisProfitProtectionConfig(): AegisProfitProtectionRuntimeConfig {
    const manager = this.manager as any;
    if (typeof manager.getAegisProfitProtectionConfig === 'function') return manager.getAegisProfitProtectionConfig();
    return { enabled: true, protect_profit_enabled: true, min_peak_roe_to_protect: 0.08, protect_giveback_roe: 0.05, min_locked_roe: 0.01, be_offset_pct: 0.003, immediate_trigger_buffer_pct: 0.001 };
  }

  getAegisPortfolioRiskConfig(): Required<AegisPortfolioRiskYamlConfig> {
    const manager = this.manager as any;
    if (typeof manager.getAegisPortfolioRiskConfig === 'function') return manager.getAegisPortfolioRiskConfig();
    return { enabled: false, max_open_positions: 0, max_same_direction_positions: 0, max_margin_used_pct: 0, max_notional_to_equity: 0 };
  }

  getAegisShortGateConfig(): Required<AegisShortGateYamlConfig> {
    const manager = this.manager as any;
    if (typeof manager.getAegisShortGateConfig === 'function') return manager.getAegisShortGateConfig();
    return { enabled: false, mode: 'PREMIUM_ONLY', position_fraction_multiplier: 1, max_leverage: 0, block_symbols: [], allow_if_regime_bearish: false };
  }

  getAegisEventRiskConfig(): AegisEventRiskRuntimeConfig {
    const manager = this.manager as any;
    if (typeof manager.getAegisEventRiskConfig === 'function') return manager.getAegisEventRiskConfig();
    return {
      enabled: false, mode: 'NORMAL', enforce: false, manual_override_enabled: false,
      caution: { min_quality_score: 0.65, max_tail_risk_score: 0.45, require_btc_eth_confirmation: true },
      risk_off: { min_quality_score: 0.75, max_tail_risk_score: 0.35, allow_only_a_plus: true },
      manual_only: { block_new_entries: false },
    };
  }

  getAegisDecisionEnforcementConfig(): AegisDecisionEnforcementRuntimeConfig {
    const manager = this.manager as any;
    if (typeof manager.getAegisDecisionEnforcementConfig === 'function') return manager.getAegisDecisionEnforcementConfig();
    return {
      enabled: false, mode: 'OFF', block_do_not_enter: false, block_wait_confirmation: false,
      block_manual_only: false,
      block_entry_quality_shadow_block_when_event_risk: { enabled: false, event_modes: [] },
      event_risk_enforcement: { caution_blocks_weak_entries: false, risk_off_blocks_non_a_plus: false, manual_only_blocks_all_new_entries: false },
      block_caution_would_block_unless_a_plus: false, block_all_entry_quality_shadow_block: false,
      block_all_tail_risk_high: false,
    };
  }

  getAegisTelegramNotificationsConfig(): AegisTelegramNotificationsRuntimeConfig {
    const manager = this.manager as any;
    if (typeof manager.getAegisTelegramNotificationsConfig === 'function') return manager.getAegisTelegramNotificationsConfig();
    return { automatic_block_alerts_enabled: false, block_dedupe: DEFAULT_AEGIS_BLOCK_NOTIFICATION_CONFIG };
  }

  getAegisPositionFractionOverride(symbol: string, side: Side): AegisPositionFractionOverride | undefined {
    const manager = this.manager as any;
    return typeof manager.getAegisPositionFractionOverride === 'function' ? manager.getAegisPositionFractionOverride(symbol, side) : undefined;
  }

  getAegisCleanEntryGuardConfig(): AegisCleanEntryGuardRuntimeConfig {
    const manager = this.manager as any;
    return typeof manager.getAegisCleanEntryGuardConfig === 'function' ? manager.getAegisCleanEntryGuardConfig() : DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG;
  }

  getAegisProbeModeConfig(): AegisProbeModeRuntimeConfig {
    const manager = this.manager as any;
    if (typeof manager.getAegisProbeModeConfig === 'function') return manager.getAegisProbeModeConfig();
    return {
      enabled: false, mode: 'OFF', apply_when_event_risk: ['CAUTION'], min_turbo_score: 0.9,
      max_tail_risk_score: 0.3, require_decision_brain: 'ENTER_NOW', require_entry_quality_allow: true,
      require_feature_status_ok: true, min_feature_parity_pct: 95,
      allow_if_blocked_only_by: ['clean_entry_event_risk_would_block', 'caution_btc_eth_not_confirmed'],
      max_probe_entries_per_hour: 1, min_minutes_between_probe_entries: 60, max_open_probe_positions: 1,
      max_total_open_positions_when_probe: 2, block_after_consecutive_losses: 2,
      block_after_recent_stop_loss_minutes: 60,
    };
  }

  getAegisRegimeGuardConfig(): AegisRegimeGuardConfig {
    const manager = this.manager as any;
    return typeof manager.getAegisRegimeGuardConfig === 'function' ? manager.getAegisRegimeGuardConfig() : DEFAULT_AEGIS_REGIME_GUARD_CONFIG;
  }

  getAegisRegimeContextConfig(): AegisRegimeContextRuntimeConfig {
    const manager = this.manager as any;
    if (typeof manager.getAegisRegimeContextConfig === 'function') return manager.getAegisRegimeContextConfig();
    return {
      enabled: false, mode: 'SHADOW', timeframe: '5m',
      indicators: { emaFast: 7, emaMid: 25, emaSlow: 99, atrWindow: 14, volumeWindow: 20, bollingerWindow: 20, adxWindow: 14, choppinessWindow: 14 },
      thresholds: { maxChoppinessForMomentum: 55, minAdxForMomentum: 18, minVolumeRatioForMomentum: 1.3, maxAtrPercentileForAggressive: 0.8, maxExhaustionScore: 0.6 },
    };
  }

  getAegisMomentumRideConfig(): AegisMomentumRideRuntimeConfig {
    const manager = this.manager as any;
    if (typeof manager.getAegisMomentumRideConfig === 'function') return manager.getAegisMomentumRideConfig();
    return {
      enabled: false, mode: 'SHADOW', researchMode: false,
      regimeFilter: { enabled: false, useAsGate: false, recordMetadata: true, ignoreForEntry: true },
      allowWhenAegisDenied: false, requireAegisDirectionConfirmation: true, allowMomentumAgainstAegis: false,
      requireBtcEthNotContradicting: true, requireBtcEthConfirmation: false, symbols: {},
      safetyCaps: { maxLeverage: 50, maxPositionFraction: 0.03, maxOpenMomentumPositions: 1, maxTotalOpenPositionsWhenMomentum: 2, maxMomentumTradesPerDay: 3, maxConsecutiveMomentumLosses: 2, cooldownAfterLossMinutes: 60, disableSymbolAfterStopLossMinutes: 120, requireBrackets: true, requireProfitProtection: true },
    };
  }

  getE4TailRiskConfig(): AegisEntryGuardPolicy {
    const manager = this.manager as any;
    if (typeof manager.getAegisEntryPolicyConfig === 'function') {
      const policy = manager.getAegisEntryPolicyConfig();
      if (policy?.guards?.e4_tail_risk) return policy.guards.e4_tail_risk;
    }
    return { enabled: false, mode: 'OFF' };
  }

  getAegisEntryPolicyConfig(): AegisEntryPolicyRuntimeConfig {
    const manager = this.manager as any;
    if (typeof manager.getAegisEntryPolicyConfig === 'function') return manager.getAegisEntryPolicyConfig();
    const entryQualityGate = this.entryQualityGateConfig();
    const eventRisk = this.getAegisEventRiskConfig();
    const regimeGuard = this.getAegisRegimeGuardConfig();
    const regimeContext = this.getAegisRegimeContextConfig();
    const cleanEntry = this.getAegisCleanEntryGuardConfig();
    const probeMode = this.getAegisProbeModeConfig();
    const decisionEnforcement = this.getAegisDecisionEnforcementConfig();
    const shortGate = this.getAegisShortGateConfig();
    return {
      enabled: true,
      guards: {
        regime: { enabled: regimeGuard.enabled, mode: regimeGuard.enabled ? regimeGuard.mode : 'OFF' },
        regime_context: { enabled: regimeContext.enabled, mode: regimeContext.enabled ? regimeContext.mode : 'OFF' },
        decision_brain: { enabled: decisionEnforcement.enabled, mode: decisionEnforcement.enabled ? 'ENFORCE' : 'OFF' },
        entry_quality: { enabled: entryQualityGate.enabled, mode: entryQualityGate.enabled ? entryQualityGate.mode : 'OFF' },
        event_risk: { enabled: eventRisk.enabled, mode: eventRisk.enabled ? (eventRisk.enforce ? 'ENFORCE' : 'SHADOW') : 'OFF' },
        clean_entry: { enabled: cleanEntry.enabled, mode: cleanEntry.enabled ? cleanEntry.mode : 'OFF' },
        probe_mode: { enabled: probeMode.enabled, mode: probeMode.enabled ? probeMode.mode : 'OFF' },
        long_risk_shadow: { enabled: true, mode: 'ENFORCE_PROBE_LONG_CRITICAL', probeLongCriticalAction: 'BLOCK', probeLongHighAction: 'SHADOW', aegisLongCriticalAction: 'SHADOW', minRiskLevelToBlockProbe: 'CRITICAL', blockOnlyProbeMode: true, blockOnlyLong: true },
        short_gate: { enabled: shortGate.enabled === true, mode: shortGate.enabled === true ? 'ENFORCE' : 'OFF' },
        e4_tail_risk: this.getE4TailRiskConfig(),
      },
    };
  }
}
