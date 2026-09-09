import { isMicroBurstStrategy, isMicroBurstPolicy } from '../../../core/strategy/MicroBurstLegacy';
import { createHash } from 'node:crypto';
import type { StrategyIdentity } from '../../../core/strategy/StrategyIdentity';
import {
  defaultMicroBurstConfig,
  validMicroBurstContextualConfig,
  type MicroBurstConfig,
} from './MicroBurstTypes';
import {
  validMicroBurstContextualRiskPolicy,
  type MicroBurstContextualRiskPolicy,
} from './MicroBurstContextualRiskPolicy';

export interface MicroBurstTradePolicy {
  schemaVersion: 1;
  policyVersion: 'MICRO';
  sourceConfigHash: string;
  sourceCodeCommitSha: string;
  config: MicroBurstConfig;
  risk: MicroBurstContextualRiskPolicy;
  digest: string;
}

/** Resolved, serializable policy; approval remains the caller's separate responsibility. */
export function createMicroBurstTradePolicy(
  identity: StrategyIdentity,
  risk: MicroBurstContextualRiskPolicy,
  overrides: Partial<MicroBurstConfig> = {},
): MicroBurstTradePolicy {
  const base = { ...defaultMicroBurstConfig(), ...overrides };
  const payload = {
    schemaVersion: 1 as const,
    policyVersion: 'MICRO' as const,
    sourceConfigHash: identity.configHash!,
    sourceCodeCommitSha: identity.codeCommitSha,
    config: {
      ...base,
      contextualPolicyVersion: 'MICRO' as const,
      maxLeverageHardCap: Math.min(base.maxLeverageHardCap, 30),
      leverageTiers: {
        high: {
          ...base.leverageTiers.high,
          leverage: risk.highLeverage,
          positionFraction: risk.marginFraction,
        },
        medium: {
          ...base.leverageTiers.medium,
          leverage: risk.mediumLeverage,
          positionFraction: risk.marginFraction,
        },
      },
    },
    risk,
  };
  const digest = `sha256:${createHash('sha256').update(canonical(payload)).digest('hex')}`;
  const snapshot = JSON.parse(JSON.stringify({ ...payload, digest })) as MicroBurstTradePolicy;
  if (!isMicroBurstTradePolicy(snapshot, identity)) throw new Error('MICRO_TRADE_POLICY_INVALID');
  return snapshot;
}

export function isMicroBurstTradePolicy(
  value: unknown,
  identity: {
    strategyId: string;
    strategyVersion: string;
    configHash?: string;
    codeCommitSha: string;
  },
): value is MicroBurstTradePolicy {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const { digest, ...policy } = value as MicroBurstTradePolicy;
    return (
      Object.keys(value).length === 7 &&
      isMicroBurstStrategy(identity.strategyId) &&
      isMicroBurstPolicy(identity.strategyVersion) &&
      policy.schemaVersion === 1 &&
      isMicroBurstPolicy(policy.policyVersion) &&
      /^sha256:[a-f0-9]{64}$/.test(policy.sourceConfigHash) &&
      /^[a-f0-9]{40}$/.test(policy.sourceCodeCommitSha) &&
      policy.sourceConfigHash === identity.configHash &&
      policy.sourceCodeCommitSha === identity.codeCommitSha &&
      validMicroBurstContextualRiskPolicy(policy.risk) &&
      isMicroBurstPolicy(policy.config.contextualPolicyVersion) &&
      validMicroBurstContextualConfig(policy.config) &&
      policy.risk.feeReserveBps >= policy.config.exitEstimatedRoundTripCostBps &&
      Number.isFinite(policy.config.maxLeverageHardCap) &&
      policy.config.maxLeverageHardCap >= 20 &&
      policy.config.maxLeverageHardCap <= 30 &&
      policy.config.leverageTiers.medium.leverage === 20 &&
      policy.config.leverageTiers.high.leverage === 30 &&
      policy.config.leverageTiers.medium.positionFraction === policy.risk.marginFraction &&
      policy.config.leverageTiers.high.positionFraction === policy.risk.marginFraction &&
      digest === `sha256:${createHash('sha256').update(canonical(policy)).digest('hex')}`
    );
  } catch {
    return false;
  }
}

function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  throw new Error('MICRO_TRADE_POLICY_NOT_JSON');
}
