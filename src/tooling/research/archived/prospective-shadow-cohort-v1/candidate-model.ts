import { BrainManifest } from '../brain-contract-v1/contract';
import { validateBrainManifest } from '../brain-contract-v1/manifest';

export const PROSPECTIVE_SHADOW_CANDIDATE_ID = 'aegis-prospective-shadow-candidate-v1' as const;
export const PROSPECTIVE_SHADOW_APPROVAL_SCOPE = 'PROSPECTIVE_SHADOW_ONLY' as const;

export interface ProspectiveShadowCandidateDescriptor {
  modelIdentity: typeof PROSPECTIVE_SHADOW_CANDIDATE_ID;
  sourceModelBundleId: string;
  modelArtifactHash: string;
  featureSchemaVersion: 'aegis-features-v2';
  featureHash: string;
  trained: true;
  approved: true;
  approvalScope: typeof PROSPECTIVE_SHADOW_APPROVAL_SCOPE;
  approvedForLive: false;
}

export function validateProspectiveShadowCandidate(
  descriptor: ProspectiveShadowCandidateDescriptor,
  manifest: BrainManifest,
): void {
  if (
    descriptor.modelIdentity !== PROSPECTIVE_SHADOW_CANDIDATE_ID ||
    descriptor.sourceModelBundleId === 'aegis-offline-reference-v1'
  ) {
    throw new Error('PROSPECTIVE_MODEL_IDENTITY_MISMATCH');
  }
  if (!/^[0-9a-f]{64}$/.test(descriptor.modelArtifactHash)) {
    throw new Error('PROSPECTIVE_MODEL_HASH_INVALID');
  }
  if (
    descriptor.trained !== true ||
    descriptor.approved !== true ||
    descriptor.approvalScope !== PROSPECTIVE_SHADOW_APPROVAL_SCOPE ||
    descriptor.approvedForLive !== false
  ) {
    throw new Error('PROSPECTIVE_MODEL_APPROVAL_INVALID');
  }
  const result = validateBrainManifest(manifest, {
    contractVersion: manifest.contract_version,
    universeId: manifest.universe_id,
    symbols: manifest.symbols,
    symbolSetHash: manifest.symbol_set_hash,
    timeframe: manifest.timeframe,
    modelBundleId: descriptor.sourceModelBundleId,
    featureSchemaVersion: descriptor.featureSchemaVersion,
    featureHash: descriptor.featureHash,
    configVersion: manifest.config_version,
  });
  if (!result.compatible) {
    throw new Error(`PROSPECTIVE_MODEL_BRAIN_HANDSHAKE_FAILED:${result.mismatchCodes.join(',')}`);
  }
}
