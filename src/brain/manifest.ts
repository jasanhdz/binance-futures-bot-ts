/** Compatibility handshake between the operational bot and scientific brain. */

import { BrainContractVersion, BrainManifest } from './contract';

export interface ExpectedBrainManifest {
  contractVersion: BrainContractVersion;
  universeId: string;
  symbols: readonly string[];
  symbolSetHash: string;
  timeframe: string;
  modelBundleId: string;
  featureSchemaVersion?: string;
}

export type ManifestMismatchCode =
  | 'CONTRACT_VERSION_MISMATCH'
  | 'UNIVERSE_MISMATCH'
  | 'SYMBOL_SET_HASH_MISMATCH'
  | 'TIMEFRAME_MISMATCH'
  | 'MODEL_BUNDLE_MISMATCH'
  | 'FEATURE_SCHEMA_MISMATCH'
  | 'BRAIN_NOT_READY';

export interface ManifestValidationResult {
  compatible: boolean;
  mismatchCodes: readonly ManifestMismatchCode[];
}

/** TODO: compare every frozen expectation and preserve position management on failure. */
export type ValidateBrainManifest = (
  manifest: BrainManifest,
  expected: ExpectedBrainManifest,
) => ManifestValidationResult;

export interface BrainManifestHandshake {
  perform(): Promise<ManifestValidationResult>;
}
