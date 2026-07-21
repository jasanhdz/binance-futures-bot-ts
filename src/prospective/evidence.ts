import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AegisEntryDecisionResult } from '../domain/services/aegis-entry/AegisEntryDecisionTypes';
import { canonicalJson, canonicalUtc, requireSha256, sha256 } from './canonical';
import {
  deriveProspectiveSignalId,
  PROSPECTIVE_PROTOCOL_VERSION,
  ProspectiveIdentityInput,
} from './identity';

export const PROSPECTIVE_EVIDENCE_SCHEMA = 'aegis-prospective-signal-evidence-v1' as const;
export type ProspectiveAction =
  | 'ENTER_NOW'
  | 'WAIT_CONFIRMATION'
  | 'MANUAL_ONLY'
  | 'DO_NOT_ENTER'
  | 'NO_TRADE';
export type ComponentName = 'd3' | 'rv2' | 'trrm' | 'qmae' | 'eqm' | 'econ1';

export interface ComponentEvidence {
  status: 'PASS' | 'REJECT' | 'NOT_APPLICABLE' | 'ERROR';
  input_hash: string;
  output_hash: string;
  output: Record<string, unknown>;
}

export type CompleteComponentEvidence = Record<ComponentName, ComponentEvidence>;

export interface ProspectiveEvidenceEnvelope {
  schema_id: typeof PROSPECTIVE_EVIDENCE_SCHEMA;
  prospective_signal_id: string;
  evaluation_id: string;
  event_sequence_id: string;
  cohort_id: string;
  protocol_version: typeof PROSPECTIVE_PROTOCOL_VERSION;
  symbol: string;
  side: 'SHORT' | 'NO_TRADE';
  signal_timestamp_utc: string;
  information_cutoff_utc: string;
  source_typescript_commit: string;
  source_python_commit: string;
  model_identity: string;
  model_artifact_hash: string;
  configuration_hash: string;
  upstream_model: Record<string, unknown>;
  component_evidence: CompleteComponentEvidence;
  final_decision: {
    action: ProspectiveAction;
    reason_codes: readonly string[];
    component_results_hash: string;
    risk_intent: Record<string, unknown>;
  };
  operational_context: {
    intended_entry: 'SIGNAL_CLOSE';
    risk_policy_identity: string;
    sizing_policy_identity: string;
    cost_policy_identity: string;
    shadow_routing_result: 'HYPOTHETICAL_INTENT' | 'NO_INTENT' | 'BLOCKED';
  };
}

export interface EvidenceBuildContext extends ProspectiveIdentityInput {
  evaluationId: string;
  sourceTypescriptCommit: string;
  sourcePythonCommit: string;
  modelIdentity: string;
  upstreamModel: Record<string, unknown>;
  componentEvidence: CompleteComponentEvidence;
  riskPolicyIdentity: string;
  sizingPolicyIdentity: string;
  costPolicyIdentity: string;
  protocolActive: boolean;
}

export interface ProspectiveEvidenceRecorder {
  record(envelope: ProspectiveEvidenceEnvelope): void;
}

const sensitiveKey = /(api[_-]?key|secret|credential|private[_-]?balance|account[_-]?id)/i;

function assertNoSecrets(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(assertNoSecrets);
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (sensitiveKey.test(key)) throw new Error('PROSPECTIVE_SECRET_FIELD_PROHIBITED');
    assertNoSecrets(item);
  }
}

function validateComponents(components: CompleteComponentEvidence): void {
  for (const name of ['d3', 'rv2', 'trrm', 'qmae', 'eqm', 'econ1'] as const) {
    const component = components[name];
    if (!component) throw new Error('PROSPECTIVE_COMPONENT_EVIDENCE_INCOMPLETE');
    requireSha256(component.input_hash, 'PROSPECTIVE_COMPONENT_HASH_INVALID');
    requireSha256(component.output_hash, 'PROSPECTIVE_COMPONENT_HASH_INVALID');
    if (sha256(canonicalJson(component.output)) !== component.output_hash) {
      throw new Error('PROSPECTIVE_COMPONENT_HASH_MISMATCH');
    }
  }
}

export class InMemoryProspectiveEvidenceRecorder implements ProspectiveEvidenceRecorder {
  readonly events: ProspectiveEvidenceEnvelope[] = [];
  private readonly payloads = new Map<string, string>();

  record(envelope: ProspectiveEvidenceEnvelope): void {
    const payload = canonicalJson(envelope);
    const previous = this.payloads.get(envelope.prospective_signal_id);
    if (previous === payload) throw new Error('PROSPECTIVE_DUPLICATE_SIGNAL');
    if (previous !== undefined) throw new Error('PROSPECTIVE_SIGNAL_CONFLICT');
    this.payloads.set(envelope.prospective_signal_id, payload);
    this.events.push(envelope);
  }
}

export class JsonlProspectiveEvidenceRecorder implements ProspectiveEvidenceRecorder {
  private readonly payloads = new Map<string, string>();

  constructor(private readonly path: string) {
    if (!path) throw new Error('PROSPECTIVE_EVIDENCE_PATH_REQUIRED');
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
        const envelope = JSON.parse(line) as ProspectiveEvidenceEnvelope;
        this.payloads.set(envelope.prospective_signal_id, canonicalJson(envelope));
      }
    }
  }

  record(envelope: ProspectiveEvidenceEnvelope): void {
    const payload = canonicalJson(envelope);
    const previous = this.payloads.get(envelope.prospective_signal_id);
    if (previous === payload) throw new Error('PROSPECTIVE_DUPLICATE_SIGNAL');
    if (previous !== undefined) throw new Error('PROSPECTIVE_SIGNAL_CONFLICT');
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
    this.payloads.set(envelope.prospective_signal_id, payload);
  }
}

function mapAction(
  decision: AegisEntryDecisionResult,
  context: EvidenceBuildContext,
): ProspectiveAction {
  if (context.side === 'NO_TRADE') return 'NO_TRADE';
  if (decision.finalDecision === 'ALLOW') return 'ENTER_NOW';
  if (decision.finalDecision === 'WAIT_CONFIRMATION') return 'WAIT_CONFIRMATION';
  const brain = context.componentEvidence.d3.output.decision;
  return brain === 'MANUAL_ONLY' ? 'MANUAL_ONLY' : 'DO_NOT_ENTER';
}

export function buildProspectiveEnvelope(
  context: EvidenceBuildContext,
  decision: AegisEntryDecisionResult,
): ProspectiveEvidenceEnvelope {
  if (!context.protocolActive) throw new Error('PROSPECTIVE_PREACTIVATION_SIGNAL');
  validateComponents(context.componentEvidence);
  assertNoSecrets(context);
  const signalTimestamp = canonicalUtc(context.signalTimestampUtc);
  const cutoff = canonicalUtc(context.informationCutoffUtc);
  const id = deriveProspectiveSignalId(context);
  const action = mapAction(decision, context);
  const route =
    action === 'ENTER_NOW'
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
    schema_id: PROSPECTIVE_EVIDENCE_SCHEMA,
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
      component_results_hash: sha256(canonicalJson(context.componentEvidence)),
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

export function evaluateWithProspectiveEvidence(
  evaluate: () => AegisEntryDecisionResult,
  context: EvidenceBuildContext,
  recorder?: ProspectiveEvidenceRecorder,
): AegisEntryDecisionResult {
  const decision = evaluate();
  if (recorder) recorder.record(buildProspectiveEnvelope(context, decision));
  return decision;
}
