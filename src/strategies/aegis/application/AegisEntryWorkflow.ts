import type { Exchange, USDTAccountSnapshot } from '../../../app/ports/Exchange';
import type { Logger } from '../../../app/ports/Logger';
import type { Notifier } from '../../../app/ports/Notifier';
import type { StateStore } from '../../../app/ports/StateStore';
import type {
  HistoryAccountSnapshotInput,
  HistoryTradeEventInput,
} from '../../../app/logging/StrategyHistoryService';
import type { Side } from '../../../core/types';
import type { StrategyId, StrategyIdentity } from '../../../core/strategy/StrategyIdentity';
import { CONFIG } from '../../../infra/config/environment';
import type { NinjaConfigManager } from '../../../infra/config/ConfigLoader';
import {
  type AegisResearchStrategy,
  type AegisTurboHistoryLogger,
  getPortfolioSessionId,
} from '../../../infra/logging/AegisTurboHistoryLogger';
import { VERIFIED_AEGIS_TRADE_OWNERSHIP } from '../../../infra/logging/AegisTradeOwnership';
import type { AegisTradingSignal } from '../domain/AegisStrategy';
import type {
  AegisEntryContext,
  AegisEntryPolicyRuntimeConfig,
} from '../domain/entry/AegisEntryDecisionTypes';
import type { AegisMicroLiveGateDecision } from '../domain/services/AegisMicroLiveGate';
import type { AegisProbeModeDecision } from '../domain/services/AegisProbeMode';
import { AegisPortfolioRiskGuard } from '../domain/services/AegisPortfolioRiskGuard';
import type { AegisEntryCoordinator } from './AegisEntryCoordinator';
import type { AegisExecutionCoordinator } from './AegisExecutionCoordinator';
import type { AegisPhaseOMetadata } from './AegisPhaseOMetadataParser';

const DEFAULT_AEGIS_MAX_HOLD_MS = 8 * 60 * 60 * 1000;

export interface AegisEntryWorkflowDeps {
  exchange: Exchange;
  logger: Logger;
  notifier: Notifier;
  configManager: NinjaConfigManager;
  canExecuteLive(symbol: string): boolean;
  getSymbolMode(symbol: string): string;
  getTradingMode(): string;
  getAegisTurboYamlConfig(): any;
  stateForSymbol(symbol: string): StateStore;
  getAegisPositionFractionOverride(symbol: string, side: Side): any;
  logAegisTradeEvent(symbol: string, event: string, input?: HistoryTradeEventInput): Promise<void>;
  buildAegisEntryContext(input: {
    symbol: string;
    side: Side;
    signal: AegisTradingSignal;
    gate: AegisMicroLiveGateDecision;
    baseGate: AegisMicroLiveGateDecision;
  }): Promise<AegisEntryContext>;
  getAegisEntryPolicyConfig(): AegisEntryPolicyRuntimeConfig;
  extractPhaseOTurboMetadata(
    signal: AegisTradingSignal,
    side: Side,
  ): AegisPhaseOMetadata | null | undefined;
  isPhaseOShortLiveSignal(signal: AegisTradingSignal, side: Side): boolean;
  withPhaseOShortGuardModes(policy: AegisEntryPolicyRuntimeConfig): AegisEntryPolicyRuntimeConfig;
  getAegisPhaseOShortLiveConfig(): any;
  getPhaseOShortTradesToday(): number;
  logAegisTurboSignal(symbol: string, signal: AegisTradingSignal, extras?: any): Promise<void>;
  shouldLogError(symbol: string, key: string, intervalMs: number): boolean;
  aegisEntryCoordinator: AegisEntryCoordinator;
  strategyRuntimeCoordinator: {
    captureAegisDecision(symbol: string): Promise<any>;
    observeAegisDecision(snapshot: any, observation: any): Promise<void>;
  };
  finiteNumber(value: unknown): value is number;
  logEntryIntelligenceDispositionShadow(...args: any[]): Promise<void>;
  logEntryQualityGateDecision(...args: any[]): Promise<void>;
  logAegisEventRiskDecision(...args: any[]): Promise<void>;
  logAegisDecisionEnforcementDenied(...args: any[]): Promise<void>;
  notifyDecisionEnforcementDenied(...args: any[]): Promise<void>;
  logAegisProbeModeDecision(...args: any[]): Promise<void>;
  logAegisCleanEntryGuardDecision(...args: any[]): Promise<void>;
  notifyProbeModeAllowed(...args: any[]): Promise<void>;
  getEntryQualityGateConfig(symbol: string): any;
  readEntryAccountSnapshot(walletFallback?: number): Promise<USDTAccountSnapshot>;
  roundQuantity(quantity: number, filters: any): number;
  getAegisPortfolioRiskConfig(): any;
  readAegisPortfolioExposure(): Promise<{
    openPositions: number;
    longPositions: number;
    shortPositions: number;
    marginUsed: number;
    notional: number;
  }>;
  notifyError(symbol: string, title: string, error: unknown): Promise<void>;
  strategyIdentity(strategy: AegisResearchStrategy): StrategyIdentity;
  aegisExecutionCoordinator: AegisExecutionCoordinator;
  getAegisTurboRegimeConfig(symbol: string): any;
  getAegisGuardianConfig(symbol: string, regimeConfig: any): any;
  recordProbeModeEntry(openedAtMs: number, tradeId: string): void;
  historyLogger: AegisTurboHistoryLogger;
  logAegisAccountSnapshot(input: HistoryAccountSnapshotInput): Promise<void>;
  recordConfirmedOpen(strategyId: StrategyId, openedAt: number, phaseOShortLive: boolean): void;
  buildAegisEntryMessage(input: any): string;
  formatScore(value?: number): string;
  lastEntryBalance: number;
  peakBalance: number;
}

/** Owns the complete Aegis entry workflow after strategy ordering selects Aegis. */
export class AegisEntryWorkflow {
  constructor(private readonly deps: AegisEntryWorkflowDeps) {}

  async execute(
    symbol: string,
    signal: AegisTradingSignal,
    gate: AegisMicroLiveGateDecision,
    tradeId: string,
    signalId?: string,
  ): Promise<void> {
    const { exchange, logger, notifier, configManager } = this.deps;
    const symbolState = this.deps.stateForSymbol(symbol);
    const yaml = this.deps.getAegisTurboYamlConfig();
    let probeModeDecision: AegisProbeModeDecision | undefined;

    try {
      if (!this.deps.canExecuteLive(symbol)) {
        logger.warn('aegis_live_execution_blocked_by_symbol_mode', {
          symbol,
          symbolMode: this.deps.getSymbolMode(symbol),
          tradingMode: this.deps.getTradingMode(),
          liveEnabled: CONFIG.AEGIS_LIVE_ENABLED,
          yamlEnabled: yaml?.enabled === true,
          yamlLiveEnabled: yaml?.live_enabled === true,
        });
        return;
      }
      if (!gate.allowed || (gate.side !== 'LONG' && gate.side !== 'SHORT')) return;
      const side = gate.side;
      let exchangePositionExists: boolean;
      try {
        exchangePositionExists = await exchange.hasOpenPosition(symbol, 'ANY');
      } catch (error) {
        logger.error('aegis_position_ownership_read_failed_entry_blocked', {
          symbol,
          error: String(error),
          entryPolicy: 'FAIL_CLOSED',
        });
        return;
      }
      if (symbolState.get().mode !== 'IDLE' || exchangePositionExists) {
        logger.warn('aegis_entry_blocked_by_existing_or_external_position', { symbol, side });
        return;
      }
      const positionFractionOverride = this.deps.getAegisPositionFractionOverride(symbol, side);
      const gateAfterPositionOverride: AegisMicroLiveGateDecision = positionFractionOverride
        ? { ...gate, positionFraction: positionFractionOverride.positionFraction }
        : gate;
      if (positionFractionOverride) {
        await this.deps.logAegisTradeEvent(symbol, 'POSITION_FRACTION_OVERRIDE_APPLIED', {
          tradeId,
          reason: 'configured_position_fraction_override',
          metadata: {
            symbol,
            side,
            mlPositionFraction: gate.positionFraction,
            overriddenPositionFraction: positionFractionOverride.positionFraction,
            ruleIndex: positionFractionOverride.ruleIndex,
            ruleName: positionFractionOverride.ruleName,
          },
        });
        logger.warn('aegis_position_fraction_override_applied', {
          symbol,
          side,
          mlPositionFraction: gate.positionFraction,
          overriddenPositionFraction: positionFractionOverride.positionFraction,
          ruleIndex: positionFractionOverride.ruleIndex,
          ruleName: positionFractionOverride.ruleName,
        });
      }
      const entryContext = await this.deps.buildAegisEntryContext({
        symbol,
        side,
        signal,
        gate: gateAfterPositionOverride,
        baseGate: gate,
      });
      const baseEntryPolicy = this.deps.getAegisEntryPolicyConfig();
      const phaseOMetadata = this.deps.extractPhaseOTurboMetadata(signal, side);
      const phaseOShortLive = this.deps.isPhaseOShortLiveSignal(signal, side);
      const entryPolicy = phaseOShortLive
        ? this.deps.withPhaseOShortGuardModes(baseEntryPolicy)
        : baseEntryPolicy;
      if (phaseOShortLive) {
        const phaseOConfig = this.deps.getAegisPhaseOShortLiveConfig();
        const phaseOLimit = phaseOConfig?.max_phase_o_trades_per_day;
        if (
          typeof phaseOLimit === 'number' &&
          this.deps.getPhaseOShortTradesToday() >= phaseOLimit
        ) {
          await this.deps.logAegisTurboSignal(symbol, signal, {
            signalId,
            tradeId,
            gate: {
              ...gateAfterPositionOverride,
              allowed: false,
              reason: 'risk_guard_max_phase_o_trades_per_day',
            },
            executed: false,
          });
          await this.deps.logAegisTradeEvent(symbol, 'GATE_DENIED', {
            tradeId,
            reason: 'risk_guard_max_phase_o_trades_per_day',
            metadata: {
              countSource: 'trade_opened',
              currentCount: this.deps.getPhaseOShortTradesToday(),
              limit: phaseOLimit,
              phaseOOnly: true,
              side,
              symbol,
              phase_o_short_detected: true,
              phase_o_metadata_source_path: phaseOMetadata?.sourcePath,
              blocked_by_hard_safety: true,
              blocked_by_secondary_guard: false,
            },
          });
          logger.warn('risk_guard_max_phase_o_trades_per_day', {
            symbol,
            side,
            countSource: 'trade_opened',
            currentCount: this.deps.getPhaseOShortTradesToday(),
            limit: phaseOLimit,
            phaseOOnly: true,
          });
          return;
        }
        const phaseOGuardMetadata = {
          symbol,
          side,
          phase_o_short_detected: true,
          phase_o_short_recognized: true,
          phase_o_metadata_source_path: phaseOMetadata?.sourcePath,
          phase_o_short_guard_modes_applied: true,
          guardMode: 'SHADOW',
          guard_modes: {
            clean_entry: 'SHADOW',
            event_risk: 'SHADOW',
            entry_quality: 'SHADOW',
            decision_brain: 'SHADOW',
            regime_engine: 'SHADOW',
            probe_mode: 'SHADOW',
            short_gate: 'SHADOW',
            long_risk_shadow: 'SHADOW',
          },
          hard_safety_enforced: {
            brackets: true,
            max_open: true,
            max_trades: true,
            daily_loss: true,
            min_notional: true,
            link_no_entry: true,
          },
          shadowGuards: [
            'clean_entry',
            'event_risk',
            'entry_quality',
            'decision_brain',
            'regime',
            'probe_mode',
            'short_gate',
            'long_risk_shadow',
          ],
          enforcedGuards: [
            'phase_o_ml',
            'brackets',
            'max_trades_per_day',
            'daily_loss_stop',
            'exchange_min_notional',
            'link_no_entry',
          ],
          technicalEntryProtectionEnforced: false,
          technicalEntryProtectionStatus: 'OBSERVATION_ONLY_NOT_VALIDATED',
          ignoredForPhaseO: true,
        };
        if (
          this.deps.shouldLogError(
            symbol,
            'PHASE_O_TECHNICAL_ENTRY_PROTECTION_NOT_ENFORCED',
            300000,
          )
        ) {
          logger.error('aegis_phase_o_technical_entry_protection_not_enforced', {
            symbol,
            side,
            phase_o_metadata_source_path: phaseOMetadata?.sourcePath,
            regime_guard_mode: 'SHADOW',
            regime_context_mode: entryPolicy.guards.regime_context.mode,
            evidence: 'multitimeframe_filter_not_validated',
            action: 'OBSERVATION_ONLY',
          });
        }
        logger.info('phase_o_short_guard_modes_applied', phaseOGuardMetadata);
        await this.deps.logAegisTradeEvent(symbol, 'PHASE_O_SHORT_GUARD_MODES_APPLIED', {
          tradeId,
          reason: 'phase_o_short_guard_modes_applied',
          metadata: phaseOGuardMetadata,
        });
      }
      const consensusConfig = this.deps.getAegisTurboYamlConfig()?.entry_safety_consensus;
      const {
        entryDecision,
        safetyConsensus: entrySafetyConsensus,
        blackBoxSnapshot,
      } = await this.deps.aegisEntryCoordinator.evaluate({
        context: entryContext,
        side,
        policy: entryPolicy,
        captureDecision: () => this.deps.strategyRuntimeCoordinator.captureAegisDecision(symbol),
        consensusConfig: consensusConfig
          ? {
              enabled: consensusConfig.enabled,
              mode: consensusConfig.mode,
              minimumRootRiskFamilies: consensusConfig.minimum_root_risk_families,
              criticalLongVetoMode: consensusConfig.critical_long_veto_mode,
              requireValidRegimeForCriticalLong:
                consensusConfig.require_valid_regime_for_critical_long,
            }
          : undefined,
      });
      await this.deps.strategyRuntimeCoordinator.observeAegisDecision(blackBoxSnapshot ?? null, {
        symbol,
        timestamp: entryContext.operational.timestamp,
        side,
        allowed: entryDecision.shouldOpen && entrySafetyConsensus.allowed,
        reason: entrySafetyConsensus.allowed
          ? entryDecision.finalReason
          : entrySafetyConsensus.reason,
        confidence: this.deps.finiteNumber(signal.confidence)
          ? Number(signal.confidence)
          : undefined,
        requestedRisk: entryDecision.adjustedPositionFraction,
        diagnostics: {
          signalId,
          tradeId,
          entryPolicy: entryDecision.metadata,
          entryPolicyTrace: entryDecision.trace,
          entrySafetyConsensus,
          observationalOnly: true,
        },
      });
      const shortGateDecision = entryDecision.decisions.shortGate;
      const entryQualityDecision = entryDecision.decisions.entryQuality;
      const eventRiskDecision = entryDecision.decisions.eventRisk;
      const decisionEnforcement = entryDecision.decisions.decisionEnforcement;
      const cleanEntryGuard = entryDecision.decisions.cleanEntry;
      probeModeDecision = entryDecision.decisions.probeMode;
      await this.deps.logAegisTradeEvent(symbol, 'ENTRY_POLICY_DECISION', {
        tradeId,
        reason: entryDecision.finalReason,
        metadata: {
          ...entryDecision.metadata,
          trace: entryDecision.trace,
        },
      });
      await this.deps.logEntryIntelligenceDispositionShadow(
        symbol,
        signal,
        'ENTRY_POLICY',
        entryDecision.shouldOpen,
        entryDecision.finalReason,
        entryDecision.deniedBy,
        signalId,
        tradeId,
      );

      await this.deps.logAegisTradeEvent(symbol, 'ENTRY_SAFETY_CONSENSUS_DECISION', {
        tradeId,
        reason: entrySafetyConsensus.reason,
        metadata: {
          ...entrySafetyConsensus,
          side,
          finalEntryPolicyDecision: entryDecision.finalDecision,
          finalEntryPolicyReason: entryDecision.finalReason,
        },
      });
      if (!entrySafetyConsensus.allowed) {
        const deniedGate = {
          ...gateAfterPositionOverride,
          allowed: false,
          reason: entrySafetyConsensus.reason,
        };
        await this.deps.logAegisTurboSignal(symbol, signal, {
          signalId,
          tradeId,
          gate: deniedGate,
          executed: false,
          metadata: { entrySafetyConsensus, entryPolicy: entryDecision.metadata },
        });
        logger.warn('aegis_entry_safety_consensus_blocked', {
          symbol,
          side,
          ...entrySafetyConsensus,
        });
        return;
      }

      if (
        shortGateDecision &&
        !shortGateDecision.allowed &&
        entryDecision.deniedBy === 'short_gate'
      ) {
        const deniedGate = {
          ...gateAfterPositionOverride,
          allowed: false,
          reason: shortGateDecision.reason,
        };
        await this.deps.logAegisTurboSignal(symbol, signal, {
          signalId,
          tradeId,
          gate: deniedGate,
          executed: false,
        });
        await this.deps.logAegisTradeEvent(symbol, 'SHORT_GATE_DENIED', {
          tradeId,
          reason: shortGateDecision.reason,
          metadata: {
            symbol,
            score: gate.turboScore,
            votes: gate.votes,
            reason: shortGateDecision.reason,
            canonicalDecisionAuthorized: shortGateDecision.metadata.canonicalDecisionAuthorized,
            entryPolicy: entryDecision.metadata,
          },
        });
        logger.warn('aegis_short_gate_denied', {
          symbol,
          side,
          reason: shortGateDecision.reason,
          turboScore: gate.turboScore,
          votes: gate.votes,
          metadata: shortGateDecision.metadata,
        });
        return;
      }

      if (!entryDecision.shouldOpen && entryDecision.deniedBy === 'regime') {
        const deniedGate = {
          ...gateAfterPositionOverride,
          allowed: false,
          reason: entryDecision.finalReason,
        };
        await this.deps.logAegisTurboSignal(symbol, signal, {
          signalId,
          tradeId,
          gate: deniedGate,
          executed: false,
          metadata: { entryPolicy: entryDecision.metadata },
        });
        return;
      }

      if (!entryDecision.shouldOpen && entryDecision.deniedBy === 'long_risk_shadow') {
        const deniedGate = {
          ...gateAfterPositionOverride,
          allowed: false,
          reason: entryDecision.finalReason,
        };
        await this.deps.logAegisTurboSignal(symbol, signal, {
          signalId,
          tradeId,
          gate: deniedGate,
          executed: false,
          metadata: { entryPolicy: entryDecision.metadata },
        });
        logger.warn('aegis_long_risk_shadow_blocked_probe_long', {
          symbol,
          side,
          reason: entryDecision.finalReason,
          metadata: entryDecision.metadata.longRiskShadow,
        });
        return;
      }

      const leverage = entryDecision.adjustedLeverage;
      const positionFraction = entryDecision.adjustedPositionFraction;
      const effectiveGate: AegisMicroLiveGateDecision = {
        ...gateAfterPositionOverride,
        leverage,
        positionFraction,
      };
      if (leverage <= 0 || positionFraction <= 0) return;

      if (entryQualityDecision) {
        await this.deps.logEntryQualityGateDecision(
          symbol,
          side,
          entryQualityDecision,
          this.deps.getEntryQualityGateConfig(symbol).mode,
          tradeId,
        );
      }
      if (
        entryQualityDecision &&
        !entryQualityDecision.allowed &&
        entryDecision.deniedBy === 'entry_quality'
      ) {
        const deniedGate = {
          ...effectiveGate,
          allowed: false,
          reason: entryQualityDecision.reason,
        };
        await this.deps.logAegisTurboSignal(symbol, signal, {
          signalId,
          tradeId,
          gate: deniedGate,
          executed: false,
          metadata: { entryPolicy: entryDecision.metadata },
        });
        return;
      }

      if (eventRiskDecision) {
        await this.deps.logAegisEventRiskDecision(symbol, eventRiskDecision, tradeId);
      }
      if (
        eventRiskDecision &&
        !eventRiskDecision.allowed &&
        entryDecision.deniedBy === 'event_risk'
      ) {
        const deniedGate = { ...effectiveGate, allowed: false, reason: eventRiskDecision.reason };
        await this.deps.logAegisTurboSignal(symbol, signal, {
          signalId,
          tradeId,
          gate: deniedGate,
          executed: false,
          metadata: {
            event_risk_mode: eventRiskDecision.mode,
            event_risk_action: eventRiskDecision.action,
            entryPolicy: entryDecision.metadata,
          },
        });
        return;
      }

      if (
        decisionEnforcement &&
        !decisionEnforcement.allowed &&
        entryDecision.deniedBy === 'decision_brain'
      ) {
        const deniedGate = { ...effectiveGate, allowed: false, reason: decisionEnforcement.reason };
        await this.deps.logAegisTurboSignal(symbol, signal, {
          signalId,
          tradeId,
          gate: deniedGate,
          executed: false,
          metadata: {
            decision_enforcement_reason: decisionEnforcement.reason,
            decision_brain_decision: decisionEnforcement.metadata.decisionBrainDecision,
            entry_quality_recommendation: decisionEnforcement.metadata.entryQualityRecommendation,
            event_risk_mode: decisionEnforcement.metadata.eventRiskMode,
            event_risk_reason: decisionEnforcement.metadata.eventRiskReason,
            event_risk_would_block: decisionEnforcement.metadata.eventRiskWouldBlock,
            is_a_plus: decisionEnforcement.metadata.aPlus,
            setup_grade: decisionEnforcement.metadata.setupGrade,
            entryPolicy: entryDecision.metadata,
          },
        });
        await this.deps.logAegisDecisionEnforcementDenied(symbol, decisionEnforcement, tradeId);
        await this.deps.notifyDecisionEnforcementDenied(symbol, decisionEnforcement);
        if (probeModeDecision) {
          await this.deps.logAegisProbeModeDecision(symbol, probeModeDecision, tradeId);
        }
        return;
      }

      if (
        shortGateDecision &&
        side === 'SHORT' &&
        shortGateDecision.reason === 'short_allowed_current_brain_canonical'
      ) {
        await this.deps.logAegisTradeEvent(symbol, 'SHORT_GATE_ADJUSTED', {
          tradeId,
          reason: shortGateDecision.reason,
          metadata: {
            originalLeverage: gateAfterPositionOverride.leverage,
            adjustedLeverage: leverage,
            originalPositionFraction: gateAfterPositionOverride.positionFraction,
            adjustedPositionFraction: positionFraction,
          },
        });
        logger.warn('aegis_short_gate_adjusted', {
          symbol,
          originalLeverage: gateAfterPositionOverride.leverage,
          adjustedLeverage: leverage,
          originalPositionFraction: gateAfterPositionOverride.positionFraction,
          adjustedPositionFraction: positionFraction,
        });
      }

      if (cleanEntryGuard) {
        await this.deps.logAegisCleanEntryGuardDecision(symbol, cleanEntryGuard, tradeId);
      }
      if (cleanEntryGuard && !cleanEntryGuard.allowed) {
        if (probeModeDecision) {
          await this.deps.logAegisProbeModeDecision(symbol, probeModeDecision, tradeId);
        }
        logger.info('aegis_clean_entry_guard_wait_confirmation', {
          symbol,
          side,
          reasons: cleanEntryGuard.reasons,
          metadata: {
            ...cleanEntryGuard.metadata,
            probeMode: probeModeDecision?.metadata,
            entryPolicy: entryDecision.metadata,
          },
        });
        if (!probeModeDecision?.allowed) {
          const deniedGate = {
            ...effectiveGate,
            allowed: false,
            reason: entryDecision.finalReason,
          };
          await this.deps.logAegisTurboSignal(symbol, signal, {
            signalId,
            tradeId,
            gate: deniedGate,
            executed: false,
            metadata: {
              cleanEntryGuard: cleanEntryGuard.metadata,
              clean_entry_guard_decision: cleanEntryGuard.decision,
              clean_entry_guard_reasons: cleanEntryGuard.reasons,
              probeMode: probeModeDecision?.metadata,
              entryPolicy: entryDecision.metadata,
            },
          });
          return;
        }
        await this.deps.notifyProbeModeAllowed(symbol, side, probeModeDecision);
      }

      const decisionMetadata = decisionEnforcement?.metadata;
      const cleanEntryMetadata = cleanEntryGuard?.metadata;
      const wallet = await exchange.getUSDTBalance();
      const entryAccount = await this.deps.readEntryAccountSnapshot(wallet);
      const feeBufferPct = configManager.trading?.fee_buffer_pct ?? CONFIG.FEE_BUFFER_PCT ?? 0.05;
      const availableWallet = this.deps.finiteNumber(entryAccount.availableBalance)
        ? Math.max(0, Math.min(wallet, Number(entryAccount.availableBalance)))
        : wallet;
      const effectiveWallet = availableWallet * (1 - feeBufferPct);
      const markPrice = await exchange.getMarkPrice(symbol);
      const filters = await exchange.getSymbolFilters(symbol, leverage);
      const requestedNotional = effectiveWallet * positionFraction * leverage;
      let notional =
        this.deps.finiteNumber(filters.notionalCap) && Number(filters.notionalCap) > 0
          ? Math.min(requestedNotional, Number(filters.notionalCap))
          : requestedNotional;
      let margin = notional / leverage;
      let quantity = this.deps.roundQuantity(notional / markPrice, filters);
      let executedPositionFraction =
        effectiveWallet > 0 ? Math.min(positionFraction, margin / effectiveWallet) : 0;

      const portfolioRiskConfig = this.deps.getAegisPortfolioRiskConfig();
      if (portfolioRiskConfig.enabled === true) {
        const exposure = await this.deps.readAegisPortfolioExposure();
        const portfolioDecision = AegisPortfolioRiskGuard.evaluate({
          symbol,
          side,
          currentOpenPositions: exposure.openPositions,
          currentLongPositions: exposure.longPositions,
          currentShortPositions: exposure.shortPositions,
          walletBalance: entryAccount.walletBalance ?? wallet,
          equityTotal: entryAccount.equityTotal ?? entryAccount.walletBalance ?? wallet,
          currentMarginUsed: exposure.marginUsed,
          currentNotional: exposure.notional,
          newTradeEstimatedMargin: margin,
          newTradeEstimatedNotional: notional,
          config: portfolioRiskConfig,
        });
        if (!portfolioDecision.allowed) {
          const deniedGate = { ...effectiveGate, allowed: false, reason: portfolioDecision.reason };
          await this.deps.logAegisTurboSignal(symbol, signal, {
            signalId,
            tradeId,
            gate: deniedGate,
            executed: false,
          });
          await this.deps.logAegisTradeEvent(symbol, 'PORTFOLIO_RISK_DENIED', {
            tradeId,
            reason: portfolioDecision.reason,
            metadata: {
              symbol,
              side,
              reason: portfolioDecision.reason,
              openPositions: portfolioDecision.metadata.openPositions,
              sameDirectionPositions: portfolioDecision.metadata.sameDirectionPositions,
              marginUsedPct: portfolioDecision.metadata.marginUsedPct,
              notionalToEquity: portfolioDecision.metadata.notionalToEquity,
              limits: portfolioDecision.metadata.limits,
            },
          });
          logger.warn('aegis_portfolio_risk_denied', {
            symbol,
            side,
            reason: portfolioDecision.reason,
            metadata: portfolioDecision.metadata,
          });
          return;
        }
      }

      if (quantity <= 0 || quantity * markPrice < filters.minNotional) {
        logger.warn('aegis_position_too_small', {
          symbol,
          quantity,
          markPrice,
          notional: quantity * markPrice,
          minNotional: filters.minNotional,
        });
        await this.deps.notifyError(
          symbol,
          'AEGIS ENTRY SIZE UNAVAILABLE',
          `Available wallet cannot satisfy minNotional=${filters.minNotional}`,
        );
        return;
      }

      await this.deps.logAegisTurboSignal(symbol, signal, {
        signalId,
        tradeId,
        gate: effectiveGate,
        executed: true,
        metadata: {
          decision_enforcement_reason: decisionEnforcement?.reason,
          cleanEntryGuard: cleanEntryMetadata,
          setup_grade: decisionMetadata?.setupGrade,
          is_a_plus: decisionMetadata?.aPlus,
          decision_brain_decision: decisionMetadata?.decisionBrainDecision,
          entry_quality_recommendation: decisionMetadata?.entryQualityRecommendation,
          event_risk_mode: decisionMetadata?.eventRiskMode,
          event_risk_reason: decisionMetadata?.eventRiskReason,
          event_risk_would_block: decisionMetadata?.eventRiskWouldBlock,
          probeMode: probeModeDecision?.metadata,
          entryPolicy: entryDecision.metadata,
        },
      });
      await this.deps.logAegisTradeEvent(symbol, 'GATE_ALLOWED', {
        tradeId,
        reason: probeModeDecision?.allowed ? 'probe_mode_allowed' : effectiveGate.reason,
        metadata: {
          side: effectiveGate.side,
          leverage: effectiveGate.leverage,
          positionFraction: effectiveGate.positionFraction,
          stopRoe: effectiveGate.stopRoe,
          takeProfitRoe: effectiveGate.takeProfitRoe,
          trailingActivationRoe: effectiveGate.trailingActivationRoe,
          trailingCallbackRoe: effectiveGate.trailingCallbackRoe,
          decisionEnforcementReason: decisionEnforcement?.reason,
          cleanEntryGuard: cleanEntryMetadata,
          setupGrade: decisionMetadata?.setupGrade,
          aPlus: decisionMetadata?.aPlus,
          decisionBrainDecision: decisionMetadata?.decisionBrainDecision,
          entryQualityRecommendation: decisionMetadata?.entryQualityRecommendation,
          tailRiskScore: decisionMetadata?.tailRiskScore,
          eventRiskMode: decisionMetadata?.eventRiskMode,
          eventRiskReason: decisionMetadata?.eventRiskReason,
          eventRiskWouldBlock: decisionMetadata?.eventRiskWouldBlock,
          probeMode: probeModeDecision?.metadata,
          entryPolicy: entryDecision.metadata,
        },
      });

      // ═══════════════════════════════════════════════════════════════
      // E4 TAIL RISK CHECK: Final veto gate before execution
      // NOTE: No manual approval gate is implemented. E4 is the last
      // automated check. If E4 allows, trade proceeds immediately.
      // ═══════════════════════════════════════════════════════════════
      const e4GuardResult = entryDecision.guards.find((g) => g.name === 'e4_tail_risk');
      const e4Enabled = e4GuardResult?.enabled === true;
      const e4Available = e4GuardResult?.metadata?.available === true;
      const e4Decision = e4GuardResult?.metadata?.riskDecision;

      if (e4Enabled && e4GuardResult?.enforced && e4GuardResult.wouldBlock) {
        await this.deps.logAegisTradeEvent(symbol, 'E4_TAIL_RISK_BLOCKED', {
          tradeId,
          reason: e4GuardResult.reason,
          metadata: {
            symbol,
            side,
            e4Score: e4GuardResult.metadata?.score,
            e4Threshold: e4GuardResult.metadata?.threshold,
            e4Decision,
            e4Available,
            enforced: e4GuardResult.enforced,
            entryDecision: entryDecision.finalDecision,
            finalReason: entryDecision.finalReason,
          },
        });
        logger.warn('e4_tail_risk_blocked_entry', {
          symbol,
          side,
          e4Score: e4GuardResult.metadata?.score,
          e4Decision,
          reason: e4GuardResult.reason,
        });
        return;
      }

      if (e4Enabled && e4GuardResult?.enforced && !e4Available) {
        await this.deps.logAegisTradeEvent(symbol, 'E4_TAIL_RISK_UNAVAILABLE', {
          tradeId,
          reason: 'e4_service_unavailable',
          metadata: {
            symbol,
            side,
            e4GuardResult: e4GuardResult?.metadata,
            entryDecision: entryDecision.finalDecision,
            finalReason: entryDecision.finalReason,
          },
        });
        logger.warn('e4_tail_risk_unavailable', {
          symbol,
          side,
          reason: e4GuardResult?.reason,
        });
        return;
      }

      if (e4Enabled && e4Available) {
        await this.deps.logAegisTradeEvent(symbol, 'E4_TAIL_RISK_PASSED', {
          tradeId,
          reason: 'e4_allow_all_guards_passed',
          metadata: {
            symbol,
            side,
            e4Score: e4GuardResult?.metadata?.score,
            e4Decision,
            e4Available,
            entryDecision: entryDecision.finalDecision,
            finalReason: entryDecision.finalReason,
          },
        });
      }
      // ═══════════════════════════════════════════════════════════════

      await this.deps.logAegisTradeEvent(symbol, 'ORDER_SUBMITTED', {
        tradeId,
        price: markPrice,
        metadata: {
          side,
          quantity,
          leverage,
          positionFraction,
          cleanEntryGuard: cleanEntryMetadata,
          probeMode: probeModeDecision?.metadata,
          entryPolicy: entryDecision.metadata,
          marginEstimated: margin,
          notionalEstimated: notional,
        },
      });
      const requireBrackets = yaml?.require_brackets !== false;
      const configuredCloseIfBracketFails = yaml?.close_if_bracket_fails !== false;
      const finalStrategyLabel: AegisResearchStrategy = 'AEGIS_TURBO';
      const finalStrategyIdentity = this.deps.strategyIdentity(finalStrategyLabel);
      const execution = await this.deps.aegisExecutionCoordinator.execute({
        identity: finalStrategyIdentity,
        signalId,
        tradeId,
        symbol,
        side,
        requestedAt: Date.now(),
        risk: { leverage, positionFraction },
        protection: {
          stopRoe: effectiveGate.stopRoe,
          takeProfitRoe: effectiveGate.takeProfitRoe,
          requireStop: requireBrackets,
          requireTakeProfit: requireBrackets,
          closeIfProtectionFails: configuredCloseIfBracketFails,
        },
        failureCloseReasons: {
          positionConfirmation: 'AEGIS_POSITION_VERIFY_FAILED',
          protection: 'AEGIS_BRACKET_FAILED',
          unexpected: 'AEGIS_ENTRY_ERROR_CLOSED',
        },
        provenance: {
          source: 'aegis_approved_entry',
          requestedStrategy: 'AEGIS_TURBO',
          finalStrategy: entryDecision.finalStrategy,
          decisionReason: entryDecision.finalReason,
          configuredCloseIfBracketFails,
          effectiveCloseIfProtectionFails: true,
          cleanEntryGuard: cleanEntryMetadata,
          probeMode: probeModeDecision?.metadata,
          entryPolicy: entryDecision.metadata,
        },
      });
      const executionMetadata = execution.metadata as Record<string, any>;
      for (const adjustment of executionMetadata.quantityAdjustments ?? []) {
        logger.warn('aegis_entry_quantity_rejected', { symbol, side, ...adjustment });
        await this.deps.logAegisTradeEvent(symbol, 'ORDER_QUANTITY_ADJUSTED', {
          tradeId,
          reason: 'AEGIS_ENTRY_QUANTITY_RETRY',
          metadata: { side, ...adjustment },
        });
      }
      if (execution.status !== 'OPENED') {
        if (executionMetadata.positionStillOpen === true) {
          symbolState.set({
            mode: side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE',
            positionOwner: 'BOT',
            tradeOrigin: 'BOT',
            ownershipStatus: 'UNKNOWN',
            eligibleForBotMetrics: false,
            metricsExclusionReason: 'entry_emergency_close_failed',
            lastSide: side,
            lastEntryPrice: this.deps.finiteNumber(executionMetadata.entryPrice)
              ? executionMetadata.entryPrice
              : markPrice,
            lastLeverage: leverage,
            lastEntryAt: Date.now(),
            lastTradeId: tradeId,
            lastStrategy: finalStrategyLabel,
            lastStrategyVersion: finalStrategyIdentity.strategyVersion,
            lastStrategyHash: finalStrategyIdentity.strategyHash,
            lastConfigHash: finalStrategyIdentity.configHash,
            lastCodeCommitSha: finalStrategyIdentity.codeCommitSha,
            lastStrategyFreezeState: finalStrategyIdentity.freezeState,
            lastEntryQty: this.deps.finiteNumber(executionMetadata.quantity)
              ? executionMetadata.quantity
              : quantity,
            lastPositionFraction: positionFraction,
            lastStopRoe: effectiveGate.stopRoe,
            lastTakeProfitRoe: effectiveGate.takeProfitRoe,
            lastBracketStatus: 'PENDING',
          });
        }
        if (
          execution.reason === 'POSITION_CONFIRMATION_FAILED' ||
          executionMetadata.failureStage === 'POSITION_CONFIRMATION'
        ) {
          await exchange.readActivePosition(symbol, side).catch(() => null);
          logger.error('aegis_position_verify_failed_after_market_open', { symbol, side, tradeId });
          await this.deps.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_ATTEMPT', {
            tradeId,
            reason: 'AEGIS_POSITION_VERIFY_FAILED',
            metadata: { side },
          });
          if (executionMetadata.emergencyCloseError) {
            logger.error('aegis_emergency_close_failed', {
              symbol,
              side,
              error: executionMetadata.emergencyCloseError,
            });
            await this.deps.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_FAILED', {
              tradeId,
              reason: 'AEGIS_POSITION_VERIFY_FAILED',
              metadata: { side, error: executionMetadata.emergencyCloseError },
            });
            await notifier.sendMessage(
              `⚠️ **AEGIS EMERGENCY CLOSE FAILED**\n` +
                `Symbol: ${symbol}\n` +
                `Reason: AEGIS_POSITION_VERIFY_FAILED\n` +
                `Error: ${String(executionMetadata.emergencyCloseError).slice(0, 180)}`,
            );
          } else {
            await this.deps.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_SUCCESS', {
              tradeId,
              reason: 'AEGIS_POSITION_VERIFY_FAILED',
              metadata: { side },
            });
            await notifier.sendMessage(
              `⚠️ **AEGIS EMERGENCY CLOSE**\n` +
                `Symbol: ${symbol}\n` +
                `Side: ${side}\n` +
                `Reason: AEGIS_POSITION_VERIFY_FAILED`,
            );
          }
        } else if (
          execution.reason === 'BRACKETS_FAILED' ||
          executionMetadata.failureStage === 'PROTECTION'
        ) {
          logger.error(
            executionMetadata.error
              ? 'aegis_bracket_creation_failed'
              : 'aegis_bracket_validation_failed',
            { symbol, side, ...executionMetadata },
          );
          await this.deps.logAegisTradeEvent(
            symbol,
            executionMetadata.error ? 'EMERGENCY_CLOSE_ATTEMPT' : 'BRACKET_MISSING',
            {
              tradeId,
              reason: executionMetadata.error
                ? String(executionMetadata.error).includes('TP')
                  ? 'TAKE_PROFIT_BRACKET_FAILED'
                  : 'STOP_BRACKET_FAILED'
                : 'AEGIS_REQUIRED_BRACKETS_MISSING',
              metadata: executionMetadata,
            },
          );
          if (executionMetadata.closeIfProtectionFails !== false) {
            if (executionMetadata.emergencyCloseError) {
              await this.deps.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_FAILED', {
                tradeId,
                reason: 'AEGIS_BRACKET_FAILED',
                metadata: executionMetadata,
              });
            } else {
              await this.deps.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_SUCCESS', {
                tradeId,
                reason: 'AEGIS_BRACKET_FAILED',
                metadata: executionMetadata,
              });
              symbolState.set({
                mode: 'IDLE',
                lastExitAt: Date.now(),
                lastExitReason: 'AEGIS_BRACKET_FAILED',
                lastBracketStatus: 'FAILED_CLOSED',
              });
            }
            await notifier.sendMessage(
              `⚠️ **BRACKET FAILED**\n` +
                `Symbol: ${symbol}\n` +
                `Error: ${String(executionMetadata.error ?? 'AEGIS_REQUIRED_BRACKETS_MISSING')}\n` +
                `ACTION REQUIRED: Check Open Orders!`,
            );
          }
        } else if (executionMetadata.recoverableEntrySizeError === true) {
          logger.warn('aegis_entry_quantity_rejected', { symbol, side, ...executionMetadata });
          await this.deps.logAegisTradeEvent(symbol, 'ORDER_SIZE_REJECTED', {
            tradeId,
            reason: 'AEGIS_ENTRY_QUANTITY_ADJUSTMENT_EXHAUSTED',
            metadata: { side, ...executionMetadata },
          });
          await this.deps.notifyError(symbol, 'AEGIS ENTRY SIZE REJECTED', executionMetadata.error);
        } else {
          await this.deps.notifyError(
            symbol,
            'AEGIS ENTRY FAILED',
            executionMetadata.error ?? execution.reason,
          );
        }
        return;
      }

      const entryPrice = execution.entryPrice;
      const marginUsed = this.deps.finiteNumber(executionMetadata.marginUsed)
        ? executionMetadata.marginUsed
        : margin;
      const stopPrice = Number(executionMetadata.stopPrice);
      const tpPrice = Number(executionMetadata.takeProfitPrice);
      const bracketStatus = {
        hasSL: executionMetadata.hasStop ?? requireBrackets,
        hasTP: executionMetadata.hasTakeProfit ?? requireBrackets,
      };
      await this.deps.logAegisTradeEvent(symbol, 'POSITION_CONFIRMED', {
        tradeId,
        price: entryPrice,
        metadata: {
          side,
          quantity: execution.quantity,
          sideMode: executionMetadata.sideMode,
          orderId: execution.orderId,
        },
      });
      await this.deps.logAegisTradeEvent(symbol, 'BRACKETS_CONFIRMED', {
        tradeId,
        metadata: { stopPrice, tpPrice, bracketStatus },
      });
      const openedAtMs = execution.openedAt;
      const regimeConfig = this.deps.getAegisTurboRegimeConfig(symbol);
      const guardianConfig = this.deps.getAegisGuardianConfig(symbol, regimeConfig);
      symbolState.set({
        mode: side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE',
        positionOwner: 'BOT',
        tradeOrigin: 'BOT',
        ownershipStatus: 'VERIFIED',
        eligibleForBotMetrics: true,
        metricsExclusionReason: null,
        lastSide: side,
        lastEntryPrice: entryPrice,
        lastLeverage: leverage,
        lastEntryAt: openedAtMs,
        lastOrderId: execution.orderId,
        peakRoe: 0,
        lowestRoe: 0,
        currentRegime: 'AEGIS_TURBO',
        lastStrategy: finalStrategyLabel,
        lastStrategyVersion: finalStrategyIdentity.strategyVersion,
        lastStrategyHash: finalStrategyIdentity.strategyHash,
        lastConfigHash: finalStrategyIdentity.configHash,
        lastCodeCommitSha: finalStrategyIdentity.codeCommitSha,
        lastStrategyFreezeState: finalStrategyIdentity.freezeState,
        lastTradeId: tradeId,
        lastPeakPrice: entryPrice,
        lastEntryWallet: wallet,
        lastEntryMargin: marginUsed,
        lastEntryQty: execution.quantity,
        lastMlProb: effectiveGate.turboScore,
        lastAegisTurboScore: effectiveGate.turboScore,
        lastAegisRawReason: effectiveGate.rawReason,
        lastAegisGatedReason: effectiveGate.gatedReason,
        lastAegisGatedBlockedBy: effectiveGate.gatedBlockedBy,
        lastStopRoe: effectiveGate.stopRoe,
        lastStopPrice: stopPrice,
        lastBreakEvenRoe: guardianConfig.beTriggerRoe,
        breakEvenArmed: false,
        breakEvenExecuted: false,
        lastBreakEvenStop: undefined,
        lastBreakEvenAt: undefined,
        lastTakeProfitRoe: effectiveGate.takeProfitRoe,
        lastTrailingActivationRoe: effectiveGate.trailingActivationRoe,
        lastTrailingCallbackRoe: effectiveGate.trailingCallbackRoe,
        lastMaxHoldMs: regimeConfig?.maxHoldMs ?? DEFAULT_AEGIS_MAX_HOLD_MS,
        lastPositionFraction: execution.positionFraction,
        lastRequestedLeverage: effectiveGate.leverage,
        lastActualLeverage: leverage,
        lastBracketStatus: 'OK',
        probeModeActive: probeModeDecision?.allowed === true,
        lastProbeAt:
          probeModeDecision?.allowed === true ? openedAtMs : symbolState.get().lastProbeAt,
        lastProbeTradeId:
          probeModeDecision?.allowed === true ? tradeId : symbolState.get().lastProbeTradeId,
        exitEyeNeutralCount: 0,
        exitEyeOppositeCount: 0,
      });
      if (probeModeDecision?.allowed) {
        this.deps.recordProbeModeEntry(openedAtMs, tradeId);
      }
      await this.deps.historyLogger.logTradeOpen({
        ...VERIFIED_AEGIS_TRADE_OWNERSHIP,
        trade_id: tradeId,
        portfolio_session_id: getPortfolioSessionId(),
        symbol,
        strategy: finalStrategyLabel,
        strategy_version: finalStrategyIdentity.strategyVersion,
        strategy_hash: finalStrategyIdentity.strategyHash,
        config_hash: finalStrategyIdentity.configHash,
        code_commit_sha: finalStrategyIdentity.codeCommitSha,
        mode: this.deps.getTradingMode(),
        side,
        opened_at: new Date(openedAtMs).toISOString(),
        entry_price: entryPrice,
        quantity: execution.quantity,
        leverage,
        position_fraction: execution.positionFraction,
        margin_estimated: marginUsed,
        notional_estimated: execution.quantity * entryPrice,
        turbo_score: effectiveGate.turboScore,
        votes: effectiveGate.votes,
        stop_roe: effectiveGate.stopRoe,
        take_profit_roe: effectiveGate.takeProfitRoe,
        trailing_activation_roe: effectiveGate.trailingActivationRoe,
        trailing_callback_roe: effectiveGate.trailingCallbackRoe,
        sl_price: stopPrice,
        tp_price: tpPrice,
        brackets_confirmed: true,
        status: 'OPEN',
        metadata: {
          rawReason: effectiveGate.rawReason,
          gatedReason: effectiveGate.gatedReason,
          gatedBlockedBy: effectiveGate.gatedBlockedBy,
          originalLeverage: gate.leverage,
          originalPositionFraction: gate.positionFraction,
          positionFractionOverride: positionFractionOverride
            ? {
                ruleIndex: positionFractionOverride.ruleIndex,
                ruleName: positionFractionOverride.ruleName,
                overriddenPositionFraction: positionFractionOverride.positionFraction,
              }
            : undefined,
          cleanEntryGuard: cleanEntryMetadata,
          probeMode: probeModeDecision?.metadata,
          entryPolicy: entryDecision.metadata,
          orderId: execution.orderId,
          estimated: true,
        },
      });
      await this.deps.logAegisAccountSnapshot({
        symbol,
        walletBalance: entryAccount.walletBalance ?? wallet,
        availableBalance: entryAccount.availableBalance,
        unrealizedPnl: entryAccount.unrealizedPnlTotal,
        positionOpen: true,
        side,
        entryPrice,
        markPrice,
        marginUsed,
        quantity: execution.quantity,
        leverage,
        metadata: { event: 'trade_open', tradeId },
      });

      this.deps.recordConfirmedOpen(finalStrategyLabel, openedAtMs, phaseOShortLive);
      this.deps.lastEntryBalance = wallet;
      if (wallet > this.deps.peakBalance) this.deps.peakBalance = wallet;

      logger.warn('aegis_turbo_micro_live_entry', {
        symbol,
        side,
        entryPrice,
        quantity: execution.quantity,
        margin: marginUsed,
        leverage,
        positionFraction: execution.positionFraction,
        finalStrategy: entryDecision.finalStrategy,
        turboScore: effectiveGate.turboScore,
        votes: effectiveGate.votes,
        rawReason: effectiveGate.rawReason,
      });
      logger.info('aegis_turbo_brackets_created', { symbol, side, stopPrice, tpPrice });

      await notifier.sendMessage(
        this.deps.buildAegisEntryMessage({
          symbol,
          side,
          entryPrice,
          quantity: execution.quantity,
          marginUsed,
          wallet,
          account: entryAccount,
          leverage,
          stopPrice,
          tpPrice,
          gate: effectiveGate,
          filters,
        }),
      );
      logger.info('📱 [TELEGRAM_REPORT] AEGIS ENTRY SENT', {
        message: `🔥 AEGIS TURBO ENTRY\n${symbol} | ${side}\n...score: ${this.deps.formatScore(effectiveGate.turboScore)}`,
      });
    } catch (error) {
      logger.error('aegis_entry_error_closed', { symbol, error: String(error) });
      await this.deps.notifyError(symbol, 'AEGIS ENTRY FAILED', error);
    }
  }
}
