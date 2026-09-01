"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROSPECTIVE_SHADOW_APPROVAL_SCOPE = exports.PROSPECTIVE_SHADOW_CANDIDATE_ID = void 0;
exports.validateProspectiveShadowCandidate = validateProspectiveShadowCandidate;
const manifest_1 = require("../brain/manifest");
exports.PROSPECTIVE_SHADOW_CANDIDATE_ID = 'aegis-prospective-shadow-candidate-v1';
exports.PROSPECTIVE_SHADOW_APPROVAL_SCOPE = 'PROSPECTIVE_SHADOW_ONLY';
function validateProspectiveShadowCandidate(descriptor, manifest) {
    if (descriptor.modelIdentity !== exports.PROSPECTIVE_SHADOW_CANDIDATE_ID ||
        descriptor.sourceModelBundleId === 'aegis-offline-reference-v1') {
        throw new Error('PROSPECTIVE_MODEL_IDENTITY_MISMATCH');
    }
    if (!/^[0-9a-f]{64}$/.test(descriptor.modelArtifactHash)) {
        throw new Error('PROSPECTIVE_MODEL_HASH_INVALID');
    }
    if (descriptor.trained !== true ||
        descriptor.approved !== true ||
        descriptor.approvalScope !== exports.PROSPECTIVE_SHADOW_APPROVAL_SCOPE ||
        descriptor.approvedForLive !== false) {
        throw new Error('PROSPECTIVE_MODEL_APPROVAL_INVALID');
    }
    const result = (0, manifest_1.validateBrainManifest)(manifest, {
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
