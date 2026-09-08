import { hasLiveAuthority, StrategyIdentity } from '../../../core/strategy/StrategyIdentity';
import * as crypto from 'crypto';

export const MICRO_BURST_V1_VERSION = '0.9.0-reaction-entry-live';
export const MICRO_BURST_V1_STRATEGY_SHA256 =
  '5d3995995c49b3a4397038a7169b44759da8b1f6afc0798d90906e6898548810';
export const MICRO_BURST_V1_CONFIG_SHA256 =
  '093ab31d5531272246e7d408c0351d3a41e7d3716deaa02bf25ba39a43db2f1b';

export const MICRO_BURST_V1_SHADOW_AUTHORITY_ENABLED: boolean = true;
export const MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED: boolean = true;

export function createMicroBurstV1Identity(
  // Approval is supplied separately after committing; never infer it from GIT_COMMIT_SHA.
  codeCommitSha = process.env.MICRO_BURST_APPROVED_COMMIT ?? 'UNKNOWN',
): StrategyIdentity {
  return {
    strategyId: 'MICRO_BURST_V1',
    strategyVersion: MICRO_BURST_V1_VERSION,
    freezeState: 'FROZEN_LIVE',
    codeCommitSha,
    strategyHash: `sha256:${MICRO_BURST_V1_STRATEGY_SHA256}`,
    configHash: `sha256:${MICRO_BURST_V1_CONFIG_SHA256}`,
  };
}

export function hasMicroBurstV1LiveAuthority(
  identity: StrategyIdentity,
  effectiveConfigSha256: string,
  deployedCodeCommitSha: string,
): boolean {
  const configMatches = identity.configHash === `sha256:${effectiveConfigSha256}`;

  return Boolean(
    hasLiveAuthority(identity, 'LIVE') &&
      /^[a-f0-9]{40}$/i.test(identity.codeCommitSha) &&
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
  if (!hasMicroBurstV1LiveAuthority(identity, input.effectiveConfigSha256, input.declaredCommitSha))
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
    .update(`${symbol}\u0000${side}\u0000${cohortId}\u0000${startedAtMs}`)
    .digest('hex')
    .slice(0, 24);
  return `MBV1-EP-${digest}`;
}
