"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROSPECTIVE_IDENTITY_SCHEME = exports.PROSPECTIVE_PROTOCOL_VERSION = void 0;
exports.deriveProspectiveSignalId = deriveProspectiveSignalId;
const canonical_1 = require("./canonical");
exports.PROSPECTIVE_PROTOCOL_VERSION = 'aegis-prospective-validation-v1';
exports.PROSPECTIVE_IDENTITY_SCHEME = 'aegis-prospective-signal-id-v1';
const forbidden = new Set([
    'outcome',
    'pnl',
    'realized_pnl',
    'future_price',
    'funding_result',
    'future_label',
    'filesystem_path',
    'generated_at',
]);
function deriveProspectiveSignalId(input) {
    for (const key of Object.keys(input)) {
        if (forbidden.has(key.toLowerCase()))
            throw new Error('PROSPECTIVE_IDENTITY_FORBIDDEN_INPUT');
    }
    if (input.protocolVersion !== exports.PROSPECTIVE_PROTOCOL_VERSION) {
        throw new Error('PROSPECTIVE_PROTOCOL_MISMATCH');
    }
    if (!input.cohortId || !input.decisionCycleId || !input.eventSequenceId) {
        throw new Error('PROSPECTIVE_IDENTITY_REQUIRED_INPUT_MISSING');
    }
    const symbol = input.symbol.trim().toUpperCase();
    if (symbol !== input.symbol || !/^[A-Z0-9]+$/.test(symbol)) {
        throw new Error('PROSPECTIVE_IDENTITY_SYMBOL_INVALID');
    }
    if (input.side !== 'SHORT' && input.side !== 'NO_TRADE') {
        throw new Error('PROSPECTIVE_IDENTITY_SIDE_INVALID');
    }
    const signal = (0, canonical_1.canonicalUtc)(input.signalTimestampUtc);
    const cutoff = (0, canonical_1.canonicalUtc)(input.informationCutoffUtc);
    if (Date.parse(cutoff) > Date.parse(signal))
        throw new Error('PROSPECTIVE_INFORMATION_CUTOFF_INVALID');
    const tuple = [
        input.protocolVersion,
        input.cohortId,
        (0, canonical_1.requireSha256)(input.modelArtifactHash, 'PROSPECTIVE_MODEL_HASH_INVALID'),
        (0, canonical_1.requireSha256)(input.configurationHash, 'PROSPECTIVE_CONFIG_HASH_INVALID'),
        symbol,
        input.decisionCycleId,
        input.side,
        signal,
        cutoff,
        input.eventSequenceId,
    ];
    return (0, canonical_1.sha256)(Buffer.concat([
        Buffer.from(exports.PROSPECTIVE_IDENTITY_SCHEME),
        Buffer.from([0]),
        Buffer.from((0, canonical_1.canonicalJson)(tuple)),
    ]));
}
