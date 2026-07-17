/** Strict compatibility handshake between operational bot and scientific brain. */

import { BrainContractVersion, BrainManifest } from './contract';
import { BrainClient } from './client';

export interface ExpectedBrainManifest {
  contractVersion: BrainContractVersion; universeId: string; symbols: readonly string[]; symbolSetHash: string;
  timeframe: string; modelBundleId: string; featureSchemaVersion?: string; featureHash?: string; configVersion?: string;
}
export type ManifestMismatchCode = 'CONTRACT_VERSION_MISMATCH' | 'UNIVERSE_MISMATCH' | 'SYMBOL_SET_HASH_MISMATCH' |
  'TIMEFRAME_MISMATCH' | 'MODEL_BUNDLE_MISMATCH' | 'FEATURE_SCHEMA_MISMATCH' | 'FEATURE_HASH_MISMATCH' |
  'CONFIG_VERSION_MISMATCH' | 'BRAIN_NOT_READY';
export interface ManifestValidationResult { compatible: boolean; mismatchCodes: readonly ManifestMismatchCode[]; }

export function validateBrainManifest(manifest: BrainManifest, expected: ExpectedBrainManifest): ManifestValidationResult {
  const codes: ManifestMismatchCode[] = [];
  if (manifest.contract_version !== expected.contractVersion) codes.push('CONTRACT_VERSION_MISMATCH');
  if (manifest.universe_id !== expected.universeId || manifest.symbols.join('\n') !== expected.symbols.join('\n')) codes.push('UNIVERSE_MISMATCH');
  if (manifest.symbol_set_hash !== expected.symbolSetHash) codes.push('SYMBOL_SET_HASH_MISMATCH');
  if (manifest.timeframe !== expected.timeframe) codes.push('TIMEFRAME_MISMATCH');
  if (manifest.model_bundle_id !== expected.modelBundleId) codes.push('MODEL_BUNDLE_MISMATCH');
  if (expected.featureSchemaVersion && manifest.feature_schema_version !== expected.featureSchemaVersion) codes.push('FEATURE_SCHEMA_MISMATCH');
  if (expected.featureHash && manifest.feature_hash !== expected.featureHash) codes.push('FEATURE_HASH_MISMATCH');
  if (expected.configVersion && manifest.config_version !== expected.configVersion) codes.push('CONFIG_VERSION_MISMATCH');
  if (!manifest.ready) codes.push('BRAIN_NOT_READY');
  return { compatible: codes.length === 0, mismatchCodes: codes };
}

export class BrainManifestHandshake {
  constructor(private readonly client: BrainClient, private readonly expected: ExpectedBrainManifest) {}
  async perform(): Promise<ManifestValidationResult> {
    try { return validateBrainManifest(await this.client.getManifest(), this.expected); }
    catch { return { compatible: false, mismatchCodes: ['BRAIN_NOT_READY'] }; }
  }
}
