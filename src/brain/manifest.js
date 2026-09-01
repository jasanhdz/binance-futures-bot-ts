"use strict";
/** Strict compatibility handshake between operational bot and scientific brain. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrainManifestHandshake = void 0;
exports.validateBrainManifest = validateBrainManifest;
function validateBrainManifest(manifest, expected) {
    const codes = [];
    if (manifest.contract_version !== expected.contractVersion)
        codes.push('CONTRACT_VERSION_MISMATCH');
    if (manifest.universe_id !== expected.universeId || manifest.symbols.join('\n') !== expected.symbols.join('\n'))
        codes.push('UNIVERSE_MISMATCH');
    if (manifest.symbol_set_hash !== expected.symbolSetHash)
        codes.push('SYMBOL_SET_HASH_MISMATCH');
    if (manifest.timeframe !== expected.timeframe)
        codes.push('TIMEFRAME_MISMATCH');
    if (manifest.model_bundle_id !== expected.modelBundleId)
        codes.push('MODEL_BUNDLE_MISMATCH');
    if (expected.featureSchemaVersion && manifest.feature_schema_version !== expected.featureSchemaVersion)
        codes.push('FEATURE_SCHEMA_MISMATCH');
    if (expected.featureHash && manifest.feature_hash !== expected.featureHash)
        codes.push('FEATURE_HASH_MISMATCH');
    if (expected.configVersion && manifest.config_version !== expected.configVersion)
        codes.push('CONFIG_VERSION_MISMATCH');
    if (!manifest.ready)
        codes.push('BRAIN_NOT_READY');
    return { compatible: codes.length === 0, mismatchCodes: codes };
}
class BrainManifestHandshake {
    constructor(client, expected) {
        this.client = client;
        this.expected = expected;
    }
    async perform() {
        try {
            return validateBrainManifest(await this.client.getManifest(), this.expected);
        }
        catch {
            return { compatible: false, mismatchCodes: ['BRAIN_NOT_READY'] };
        }
    }
}
exports.BrainManifestHandshake = BrainManifestHandshake;
