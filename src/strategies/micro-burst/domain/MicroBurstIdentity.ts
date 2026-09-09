import { hasLiveAuthority, StrategyIdentity } from '../../../core/strategy/StrategyIdentity';
import * as crypto from 'crypto';

export const MICRO_BURST_VERSION = 'MICRO';
export const MICRO_BURST_STRATEGY_SHA256 = crypto
  .createHash('sha256')
  .update('MICRO_MARGIN_FRACTION_20_30_NET_LOSS_3')
  .digest('hex');
export const MICRO_BURST_CONFIG_SHA256 =
  '132879584379e97474309df05d99552a6b835fecdcbe38d3b586b7bfb76633e1';

export const MICRO_BURST_SHADOW_AUTHORITY_ENABLED: boolean = true;
export const MICRO_BURST_LIVE_AUTHORITY_ENABLED: boolean = true;

export function createMicroBurstIdentity(
  approvedCommit = process.env.MICRO_BURST_APPROVED_COMMIT ?? 'UNKNOWN',
  approvedConfigSha = process.env.MICRO_BURST_APPROVED_CONFIG_SHA256 ?? 'UNKNOWN',
): StrategyIdentity {
  return {
    strategyId: 'MICRO_BURST',
    strategyVersion: 'MICRO',
    freezeState: 'FROZEN_LIVE',
    codeCommitSha: approvedCommit,
    configHash: `sha256:${approvedConfigSha}`,
    strategyHash: `sha256:${MICRO_BURST_STRATEGY_SHA256}`,
  };
}

export function hasMicroBurstLiveAuthority(
  identity: StrategyIdentity,
  effectiveConfigSha256: string,
  deployedCodeCommitSha: string,
): boolean {
  const configMatches = identity.configHash === `sha256:${effectiveConfigSha256}`;

  return Boolean(
    identity.strategyId === 'MICRO_BURST' &&
      identity.strategyVersion === 'MICRO' &&
      hasLiveAuthority(identity, 'LIVE') &&
      /^[a-f0-9]{40}$/i.test(identity.codeCommitSha) &&
      /^[a-f0-9]{64}$/.test(effectiveConfigSha256) &&
      deployedCodeCommitSha.toLowerCase() === identity.codeCommitSha.toLowerCase() &&
      configMatches,
  );
}

/** Read-only attestation of supplied evidence. Environment labels alone attest no artifact. */
export function diagnoseMicroBurstAuthority(input: {
  identity: StrategyIdentity;
  effectiveConfigSha256: string;
  declaredCommitSha: string;
  artifactCommitSha?: string;
  artifactVerified: boolean;
  sourceDirty: boolean;
}): {
  status: 'MATCHED_EVIDENCE' | 'UNVERIFIED' | 'MISMATCH';
  reasons: string[];
  grantsAuthority: false;
} {
  const reasons: string[] = [];
  const { identity } = input;
  if (!hasMicroBurstLiveAuthority(identity, input.effectiveConfigSha256, input.declaredCommitSha))
    reasons.push('DECLARED_IDENTITY_CONFIG_OR_COMMIT_MISMATCH');
  if (input.sourceDirty) reasons.push('SOURCE_DIRTY');
  const verified = input.artifactVerified && /^[a-f0-9]{40}$/i.test(input.artifactCommitSha ?? '');
  if (!verified) reasons.push('ARTIFACT_NOT_VERIFIED');
  else if (input.artifactCommitSha!.toLowerCase() !== identity.codeCommitSha.toLowerCase())
    reasons.push('ARTIFACT_APPROVAL_COMMIT_MISMATCH');
  return {
    status: reasons.some((reason) => reason.endsWith('MISMATCH'))
      ? 'MISMATCH'
      : reasons.length
        ? 'UNVERIFIED'
        : 'MATCHED_EVIDENCE',
    reasons,
    grantsAuthority: false,
  };
}

/** Stable across processes and independent of insertion order for a chronological episode. */
export function createMicroBurstEpisodeId(
  symbol: string,
  side: string,
  startedAtMs: number,
  cohortId = '',
): string {
  const digest = crypto
    .createHash('sha256')
    // Keep the historical causal hash stable while exposing only the canonical prefix.
    .update(
      `${symbol}\u0000${side}\u0000${cohortId.replace(/^MICRO:/, 'reaction-entry-2-contextual-shadow:')}\u0000${startedAtMs}`,
    )
    .digest('hex')
    .slice(0, 24);
  return `MB-EP-${digest}`;
}
