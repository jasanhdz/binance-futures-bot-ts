import type { Logger } from '../../../app/ports/Logger';
import type { StateStore } from '../../../app/ports/StateStore';
import type { BotState, Side } from '../../../core/types';
import type { AegisTradingSignal } from '../domain/AegisStrategy';
import type {
  AegisEntryContext,
  AegisRegimeContextRuntimeConfig,
} from '../domain/entry/AegisEntryDecisionTypes';
import type { AegisMicroLiveGateDecision } from '../domain/services/AegisMicroLiveGate';
import type { AegisCleanEntryGuardOutput } from '../domain/services/AegisCleanEntryGuard';
import type { AegisRegimeGuardConfig } from '../domain/services/AegisRegimeGuard';
import type {
  AegisCleanEntryGuardRuntimeConfig,
  AegisDecisionEnforcementRuntimeConfig,
  AegisEntryQualityGateRuntimeConfig,
  AegisEventRiskRuntimeConfig,
  AegisShortGateYamlConfig,
} from '../../../infra/config/ConfigLoader';
import type { AegisProbeModeRuntimeConfig } from '../domain/services/AegisProbeMode';

export interface AegisEntryContextBuilderInput {
  symbol: string;
  side: Side;
  signal: AegisTradingSignal;
  gate: AegisMicroLiveGateDecision;
  baseGate: AegisMicroLiveGateDecision;
}

export interface AegisEntryContextBuilderDeps {
  logger: Logger;
  now(): number;
  getEntryQualityConfig(symbol: string): AegisEntryQualityGateRuntimeConfig;
  getEventRiskConfig(): AegisEventRiskRuntimeConfig;
  getGlobalState(): BotState;
  countStateOpenPositions(): {
    totalOpenPositions: number;
    openMomentumPositions: number;
    openProbePositions: number;
  };
  mostRecentStopLossAt(): number | undefined;
  readAegisRisk(now: number): { consecutiveLosses: number; tradesToday: number };
  stateForSymbol(symbol: string): StateStore;
  hasOpenPosition(symbol: string): Promise<boolean>;
  buildEntryQualityMarketContext(symbol: string): Record<string, unknown>;
  getRegimeGuardConfig(): AegisRegimeGuardConfig;
  getRegimeContextConfig(): AegisRegimeContextRuntimeConfig;
  getCleanEntryConfig(): AegisCleanEntryGuardRuntimeConfig;
  getProbeModeConfig(): AegisProbeModeRuntimeConfig;
  getShortGateConfig(): AegisShortGateYamlConfig;
  getDecisionEnforcementConfig(): AegisDecisionEnforcementRuntimeConfig;
}

/** Builds the complete causal and operational context consumed by Aegis guards. */
export class AegisEntryContextBuilder {
  constructor(private readonly deps: AegisEntryContextBuilderDeps) {}

  async build(input: AegisEntryContextBuilderInput): Promise<AegisEntryContext> {
    const aegis = input.signal.metadata?.aegis ?? input.signal.aegis;
    const entryQualityRuntimeConfig = this.deps.getEntryQualityConfig(input.symbol);
    const eventRiskConfig = this.deps.getEventRiskConfig();
    const eventRiskAuto = aegis?.event_risk_auto;
    const eventRiskAutoRecord = eventRiskAuto as Record<string, unknown> | undefined;
    const btcContext = eventRiskAuto?.btc_context as Record<string, unknown> | undefined;
    const ethContext = eventRiskAuto?.eth_context as Record<string, unknown> | undefined;
    const globalState = this.deps.getGlobalState();
    const stateExposure = this.deps.countStateOpenPositions();
    const lastStopLossAt = this.deps.mostRecentStopLossAt();
    const now = this.deps.now();
    const aegisRisk = this.deps.readAegisRisk(now);
    const sameSymbolPositionExists =
      this.deps.stateForSymbol(input.symbol).get().mode !== 'IDLE' ||
      (await this.deps.hasOpenPosition(input.symbol).catch((error) => {
        this.deps.logger.error('aegis_position_ownership_read_failed_entry_blocked', {
          symbol: input.symbol,
          error: String(error),
          entryPolicy: 'FAIL_CLOSED',
        });
        return true;
      }));

    return {
      symbol: input.symbol,
      side: input.side,
      rawAction: aegis?.turbo?.raw?.action ?? input.signal.action,
      finalAction: aegis?.turbo?.gated?.action ?? aegis?.turbo?.action ?? input.signal.action,
      turboScore: input.gate.turboScore ?? 0,
      votes: input.gate.votes,
      setupGrade:
        (aegis?.clean_entry_guard as any)?.setupGrade ??
        (aegis as any)?.decision_enforcement?.setupGrade ??
        (aegis?.turbo as any)?.setupGrade ??
        (aegis?.turbo as any)?.setup_grade,
      leverage: input.gate.leverage,
      requestedPositionFraction: input.gate.positionFraction,
      basePositionFraction: input.baseGate.positionFraction,
      signal: input.signal,
      gate: input.gate,
      decisionBrain: {
        decision: aegis?.decision_brain?.decision,
        confidence: aegis?.decision_brain?.enter_now_prob ?? undefined,
        reason: aegis?.decision_brain?.reason,
        block: aegis?.decision_brain,
      },
      entryQuality: {
        model: aegis?.entry_quality_model,
        recommendation: aegis?.entry_quality_model?.recommendation,
        entryQualityScore: aegis?.entry_quality_model?.entry_quality_score,
        tailRiskScore: aegis?.entry_quality_model?.tail_risk_score,
        featureStatus: aegis?.entry_quality_model?.feature_status,
        featureParityPct: aegis?.entry_quality_model?.feature_parity_pct,
        missingFeaturesCount: aegis?.entry_quality_model?.missing_features_count,
        modelScope: aegis?.entry_quality_model?.model_scope,
        modelVersion: aegis?.entry_quality_model?.model_version,
        ruleGate: {
          enabled: entryQualityRuntimeConfig.enabled,
          mode: entryQualityRuntimeConfig.mode,
          config: entryQualityRuntimeConfig.config,
          ...this.deps.buildEntryQualityMarketContext(input.symbol),
        },
      },
      eventRisk: {
        enabled: eventRiskConfig.enabled,
        mode: eventRiskConfig.mode,
        enforce: eventRiskConfig.enforce,
        reason: undefined,
        wouldBlock: undefined,
        confidence: eventRiskAuto?.confidence ?? undefined,
        auto: eventRiskAuto,
        btcAction: this.contextAction(btcContext),
        btcScore: this.contextScore(btcContext),
        ethAction: this.contextAction(ethContext),
        ethScore: this.contextScore(ethContext),
        isAltSymbol: input.symbol !== 'BTCUSDT' && input.symbol !== 'ETHUSDT',
        config: {
          caution: {
            minQualityScore: eventRiskConfig.caution.min_quality_score,
            maxTailRiskScore: eventRiskConfig.caution.max_tail_risk_score,
            requireBtcEthConfirmation: eventRiskConfig.caution.require_btc_eth_confirmation,
          },
          riskOff: {
            minQualityScore: eventRiskConfig.risk_off.min_quality_score,
            maxTailRiskScore: eventRiskConfig.risk_off.max_tail_risk_score,
            allowOnlyAPlus: eventRiskConfig.risk_off.allow_only_a_plus,
          },
          manualOnly: {
            blockNewEntries: eventRiskConfig.manual_only.block_new_entries,
          },
        },
      },
      regime: {
        config: this.deps.getRegimeGuardConfig(),
        contextConfig: this.deps.getRegimeContextConfig(),
        btcAction: this.contextAction(btcContext),
        btcScore: this.contextScore(btcContext),
        btcVotes: this.contextVotes(btcContext),
        ethAction: this.contextAction(ethContext),
        ethScore: this.contextScore(ethContext),
        ethVotes: this.contextVotes(ethContext),
        marketDistribution: undefined,
        snapshotAgeSeconds: this.contextSnapshotAgeSeconds(eventRiskAutoRecord, now),
      },
      cleanEntry: {
        metadata: aegis?.clean_entry_guard as AegisCleanEntryGuardOutput['metadata'] | undefined,
        config: this.deps.getCleanEntryConfig(),
      },
      probe: { config: this.deps.getProbeModeConfig() },
      shortGate: { config: this.deps.getShortGateConfig() },
      decisionEnforcement: {
        config: this.deps.getDecisionEnforcementConfig(),
        riskOffTailMax: eventRiskConfig.risk_off.max_tail_risk_score,
      },
      operational: {
        consecutiveLosses: aegisRisk.consecutiveLosses,
        tradesToday: aegisRisk.tradesToday,
        openPositionsCount: stateExposure.totalOpenPositions,
        openMomentumPositions: stateExposure.openMomentumPositions,
        openProbePositions: stateExposure.openProbePositions,
        sameSymbolPositionExists,
        recentStopLossMinutes:
          lastStopLossAt !== undefined ? (now - lastStopLossAt) / 60000 : undefined,
        lastStopLossAt,
        lastProbeAt: globalState.lastProbeAt,
        probeEntryTimestamps: globalState.probeEntryTimestamps,
        timestamp: now,
      },
    };
  }

  private contextAction(context: Record<string, unknown> | undefined): string | undefined {
    const value = context?.action ?? context?.turbo_action ?? context?.suggested_action;
    return value === undefined ? undefined : String(value).trim().toUpperCase();
  }

  private contextScore(context: Record<string, unknown> | undefined): number | undefined {
    const value = context?.score ?? context?.turbo_score ?? context?.confidence;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private contextVotes(
    context: Record<string, unknown> | undefined,
  ): { long?: number; short?: number; neutral?: number } | undefined {
    const value = context?.votes;
    if (!value || typeof value !== 'object') return undefined;
    const votes = value as Record<string, unknown>;
    return {
      long: this.finite(votes.long),
      short: this.finite(votes.short),
      neutral: this.finite(votes.neutral),
    };
  }

  private contextSnapshotAgeSeconds(
    eventRiskAuto: Record<string, unknown> | undefined,
    now: number,
  ): number | undefined {
    const direct = eventRiskAuto?.snapshot_age_seconds ?? eventRiskAuto?.snapshotAgeSeconds;
    if (this.finite(direct) !== undefined) return Number(direct);
    const snapshotTs =
      eventRiskAuto?.snapshot_timestamp_ms ??
      eventRiskAuto?.snapshotTimestampMs ??
      eventRiskAuto?.generated_at_ms;
    return this.finite(snapshotTs) === undefined
      ? undefined
      : Math.max(0, (now - Number(snapshotTs)) / 1000);
  }

  private finite(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
}
