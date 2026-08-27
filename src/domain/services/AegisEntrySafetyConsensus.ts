import { Side } from '../types';
import {
  AegisEntryDecisionResult,
  AegisEntryGuardResult,
} from './aegis-entry/AegisEntryDecisionTypes';

type SafetyMode = 'OFF' | 'SHADOW' | 'ENFORCE';

export interface AegisEntrySafetyConsensusConfig {
  enabled?: boolean;
  mode?: SafetyMode;
  minimumRootRiskFamilies?: number;
  criticalLongVetoMode?: SafetyMode;
  requireValidRegimeForCriticalLong?: boolean;
}

export interface AegisEntrySafetyConsensusDecision {
  allowed: boolean;
  wouldBlock: boolean;
  enforced: boolean;
  reason: string;
  riskFamilies: string[];
  riskFamilyCount: number;
  derivedWarnings: string[];
  regimeDataValid: boolean;
  consensusWouldBlock: boolean;
  criticalLongVetoWouldBlock: boolean;
  longRiskLevel?: string;
}

function guardByName(
  result: AegisEntryDecisionResult,
  name: string,
): AegisEntryGuardResult | undefined {
  return result.guards.find((guard) => guard.name === name);
}

function guardWarns(result: AegisEntryDecisionResult, name: string): boolean {
  const guard = guardByName(result, name);
  return (
    guard?.wouldBlock === true || guard?.decision === 'DENY' || guard?.decision === 'SHADOW_DENY'
  );
}

function longRiskLevel(result: AegisEntryDecisionResult): string | undefined {
  const metadata = guardByName(result, 'long_risk_shadow')?.metadata.longRiskShadow;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>).riskLevel;
  return typeof value === 'string' ? value.toUpperCase() : undefined;
}

function hasValidRegimeData(result: AegisEntryDecisionResult): boolean {
  const context = result.decisions.regimeContext;
  if (!context || context.trendDirection === 'UNKNOWN' || context.volatilityState === 'UNKNOWN')
    return false;
  const finiteIndicators = Object.values(context.indicators ?? {}).filter(
    (value) => typeof value === 'number' && Number.isFinite(value),
  ).length;
  return finiteIndicators >= 4;
}

/**
 * Root-cause safety assessment. Entry quality, event risk, decision brain and
 * clean entry are one causal chain, so they must never count as four votes.
 */
export function evaluateAegisEntrySafetyConsensus(input: {
  side: Side;
  entryDecision: AegisEntryDecisionResult;
  config?: AegisEntrySafetyConsensusConfig;
}): AegisEntrySafetyConsensusDecision {
  const config = input.config ?? {};
  const enabled = config.enabled === true;
  const mode: SafetyMode =
    config.mode === 'ENFORCE' ? 'ENFORCE' : config.mode === 'OFF' ? 'OFF' : 'SHADOW';
  const criticalLongVetoMode: SafetyMode =
    config.criticalLongVetoMode === 'ENFORCE'
      ? 'ENFORCE'
      : config.criticalLongVetoMode === 'SHADOW'
        ? 'SHADOW'
        : 'OFF';
  const minimumRootRiskFamilies = Math.max(2, Math.floor(config.minimumRootRiskFamilies ?? 2));

  const regimeRisk = guardWarns(input.entryDecision, 'regime');
  const derivedWarnings = ['entry_quality', 'event_risk', 'decision_brain', 'clean_entry'].filter(
    (name) => guardWarns(input.entryDecision, name),
  );
  const qualityChainRisk = derivedWarnings.length > 0;
  const currentLongRiskLevel = longRiskLevel(input.entryDecision);
  const criticalLongRisk = input.side === 'LONG' && currentLongRiskLevel === 'CRITICAL';
  const regimeDataValid = hasValidRegimeData(input.entryDecision);

  const riskFamilies = [
    regimeRisk ? 'regime' : undefined,
    qualityChainRisk ? 'quality_chain' : undefined,
    criticalLongRisk ? 'critical_long' : undefined,
  ].filter((name): name is string => Boolean(name));

  const consensusWouldBlock = riskFamilies.length >= minimumRootRiskFamilies;
  const criticalLongVetoWouldBlock =
    criticalLongRisk &&
    regimeRisk &&
    (config.requireValidRegimeForCriticalLong === false || regimeDataValid);
  const consensusEnforced = enabled && mode === 'ENFORCE' && consensusWouldBlock;
  const criticalLongVetoEnforced =
    enabled && criticalLongVetoMode === 'ENFORCE' && criticalLongVetoWouldBlock;
  const enforced = consensusEnforced || criticalLongVetoEnforced;
  const wouldBlock =
    enabled &&
    ((mode !== 'OFF' && consensusWouldBlock) ||
      (criticalLongVetoMode !== 'OFF' && criticalLongVetoWouldBlock));

  return {
    allowed: !enforced,
    wouldBlock,
    enforced,
    reason: !enabled
      ? 'entry_safety_consensus_disabled'
      : criticalLongVetoEnforced
        ? 'entry_safety_critical_long_veto'
        : consensusEnforced
          ? 'entry_safety_root_consensus_hard_block'
          : wouldBlock
            ? 'entry_safety_root_consensus_shadow_block'
            : 'entry_safety_consensus_clear',
    riskFamilies,
    riskFamilyCount: riskFamilies.length,
    derivedWarnings,
    regimeDataValid,
    consensusWouldBlock,
    criticalLongVetoWouldBlock,
    longRiskLevel: currentLongRiskLevel,
  };
}
