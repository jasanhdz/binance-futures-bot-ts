"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JsonlProspectiveEvidenceRecorder = exports.InMemoryProspectiveEvidenceRecorder = exports.PROSPECTIVE_EVIDENCE_SCHEMA = void 0;
exports.buildProspectiveEnvelope = buildProspectiveEnvelope;
exports.evaluateWithProspectiveEvidence = evaluateWithProspectiveEvidence;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const canonical_1 = require("./canonical");
const identity_1 = require("./identity");
const jsonl_1 = require("./jsonl");
exports.PROSPECTIVE_EVIDENCE_SCHEMA = 'aegis-prospective-signal-evidence-v1';
const sensitiveKey = /(api[_-]?key|secret|credential|private[_-]?balance|account[_-]?id)/i;
function assertNoSecrets(value) {
    if (Array.isArray(value))
        return value.forEach(assertNoSecrets);
    if (!value || typeof value !== 'object')
        return;
    for (const [key, item] of Object.entries(value)) {
        if (sensitiveKey.test(key))
            throw new Error('PROSPECTIVE_SECRET_FIELD_PROHIBITED');
        assertNoSecrets(item);
    }
}
function validateComponents(components) {
    for (const name of ['d3', 'rv2', 'trrm', 'qmae', 'eqm', 'econ1']) {
        const component = components[name];
        if (!component)
            throw new Error('PROSPECTIVE_COMPONENT_EVIDENCE_INCOMPLETE');
        (0, canonical_1.requireSha256)(component.input_hash, 'PROSPECTIVE_COMPONENT_HASH_INVALID');
        (0, canonical_1.requireSha256)(component.output_hash, 'PROSPECTIVE_COMPONENT_HASH_INVALID');
        if ((0, canonical_1.sha256)((0, canonical_1.canonicalJson)(component.output)) !== component.output_hash) {
            throw new Error('PROSPECTIVE_COMPONENT_HASH_MISMATCH');
        }
    }
}
class InMemoryProspectiveEvidenceRecorder {
    constructor() {
        this.events = [];
        this.payloads = new Map();
    }
    record(envelope) {
        const payload = (0, canonical_1.canonicalJson)(envelope);
        const previous = this.payloads.get(envelope.prospective_signal_id);
        if (previous === payload)
            throw new Error('PROSPECTIVE_DUPLICATE_SIGNAL');
        if (previous !== undefined)
            throw new Error('PROSPECTIVE_SIGNAL_CONFLICT');
        this.payloads.set(envelope.prospective_signal_id, payload);
        this.events.push(envelope);
    }
}
exports.InMemoryProspectiveEvidenceRecorder = InMemoryProspectiveEvidenceRecorder;
class JsonlProspectiveEvidenceRecorder {
    constructor(path) {
        this.path = path;
        this.payloadHashes = new Map();
        if (!path)
            throw new Error('PROSPECTIVE_EVIDENCE_PATH_REQUIRED');
        if ((0, node_fs_1.existsSync)(path)) {
            (0, jsonl_1.forEachJsonlLine)(path, (line) => {
                const envelope = JSON.parse(line);
                const payload = (0, canonical_1.canonicalJson)(envelope);
                const payloadHash = (0, canonical_1.sha256)(payload);
                const previous = this.payloadHashes.get(envelope.prospective_signal_id);
                if (previous === payloadHash)
                    throw new Error('PROSPECTIVE_DUPLICATE_SIGNAL');
                if (previous !== undefined)
                    throw new Error('PROSPECTIVE_SIGNAL_CONFLICT');
                this.payloadHashes.set(envelope.prospective_signal_id, payloadHash);
            });
        }
    }
    record(envelope) {
        const payload = (0, canonical_1.canonicalJson)(envelope);
        const payloadHash = (0, canonical_1.sha256)(payload);
        const previous = this.payloadHashes.get(envelope.prospective_signal_id);
        if (previous === payloadHash)
            throw new Error('PROSPECTIVE_DUPLICATE_SIGNAL');
        if (previous !== undefined)
            throw new Error('PROSPECTIVE_SIGNAL_CONFLICT');
        (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(this.path), { recursive: true });
        const descriptor = (0, node_fs_1.openSync)(this.path, 'a', 0o600);
        try {
            (0, node_fs_1.writeSync)(descriptor, `${payload}\n`, undefined, 'utf8');
            (0, node_fs_1.fsyncSync)(descriptor);
        }
        finally {
            (0, node_fs_1.closeSync)(descriptor);
        }
        this.payloadHashes.set(envelope.prospective_signal_id, payloadHash);
    }
}
exports.JsonlProspectiveEvidenceRecorder = JsonlProspectiveEvidenceRecorder;
function mapAction(decision, context) {
    if (context.side === 'NO_TRADE')
        return 'NO_TRADE';
    if (decision.finalDecision === 'ALLOW')
        return 'ENTER_NOW';
    if (decision.finalDecision === 'WAIT_CONFIRMATION')
        return 'WAIT_CONFIRMATION';
    const brain = context.componentEvidence.d3.output.decision;
    return brain === 'MANUAL_ONLY' ? 'MANUAL_ONLY' : 'DO_NOT_ENTER';
}
function buildProspectiveEnvelope(context, decision) {
    if (!context.protocolActive)
        throw new Error('PROSPECTIVE_PREACTIVATION_SIGNAL');
    validateComponents(context.componentEvidence);
    assertNoSecrets(context);
    const signalTimestamp = (0, canonical_1.canonicalUtc)(context.signalTimestampUtc);
    const cutoff = (0, canonical_1.canonicalUtc)(context.informationCutoffUtc);
    const id = (0, identity_1.deriveProspectiveSignalId)(context);
    const action = mapAction(decision, context);
    const route = action === 'ENTER_NOW'
        ? 'HYPOTHETICAL_INTENT'
        : action === 'NO_TRADE'
            ? 'NO_INTENT'
            : 'BLOCKED';
    const reasonCodes = [decision.finalReason, ...decision.guards.map((guard) => guard.reason)];
    const riskIntent = {
        adjusted_leverage: decision.adjustedLeverage,
        adjusted_position_fraction: decision.adjustedPositionFraction,
        final_strategy: decision.finalStrategy,
    };
    return {
        schema_id: exports.PROSPECTIVE_EVIDENCE_SCHEMA,
        prospective_signal_id: id,
        evaluation_id: context.evaluationId,
        event_sequence_id: context.eventSequenceId,
        cohort_id: context.cohortId,
        protocol_version: context.protocolVersion,
        symbol: context.symbol,
        side: context.side,
        signal_timestamp_utc: signalTimestamp,
        information_cutoff_utc: cutoff,
        source_typescript_commit: context.sourceTypescriptCommit,
        source_python_commit: context.sourcePythonCommit,
        model_identity: context.modelIdentity,
        model_artifact_hash: context.modelArtifactHash,
        configuration_hash: context.configurationHash,
        upstream_model: context.upstreamModel,
        component_evidence: context.componentEvidence,
        final_decision: {
            action,
            reason_codes: reasonCodes,
            component_results_hash: (0, canonical_1.sha256)((0, canonical_1.canonicalJson)(context.componentEvidence)),
            risk_intent: riskIntent,
        },
        operational_context: {
            intended_entry: 'SIGNAL_CLOSE',
            risk_policy_identity: context.riskPolicyIdentity,
            sizing_policy_identity: context.sizingPolicyIdentity,
            cost_policy_identity: context.costPolicyIdentity,
            shadow_routing_result: route,
        },
    };
}
async function evaluateWithProspectiveEvidence(evaluate, context, recorder) {
    const decision = await evaluate();
    if (recorder)
        recorder.record(buildProspectiveEnvelope(context, decision));
    return decision;
}
