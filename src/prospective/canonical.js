"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canonicalJson = canonicalJson;
exports.sha256 = sha256;
exports.canonicalUtc = canonicalUtc;
exports.requireSha256 = requireSha256;
const node_crypto_1 = require("node:crypto");
function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
            .join(',')}}`;
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
        throw new Error('PROSPECTIVE_CANONICALIZATION_FAILED');
    return encoded;
}
function sha256(value) {
    return (0, node_crypto_1.createHash)('sha256').update(value).digest('hex');
}
function canonicalUtc(value) {
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(value))
        throw new Error('PROSPECTIVE_TIMESTAMP_AMBIGUOUS');
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed))
        throw new Error('PROSPECTIVE_TIMESTAMP_INVALID');
    return new Date(parsed).toISOString();
}
function requireSha256(value, code) {
    if (!/^[0-9a-f]{64}$/.test(value))
        throw new Error(code);
    return value;
}
