/** Read-only bridge from coordinated final candles to scientific shadow evidence. */

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BrainClient } from './client';
import { BRAIN_CONTRACT_VERSION, DecisionRequest, DecisionResponse, MarketSnapshot } from './contract';
import { DecisionGate, GateResult, OperationalContext } from './decision-gate';
import { ExpectedBrainManifest, validateBrainManifest } from './manifest';

export type ShadowCycleStatus = 'RECORDED' | 'FAILED_CLOSED';
export type ShadowAction = 'WOULD_LONG' | 'WOULD_SHORT' | 'WOULD_NOT_TRADE' | 'BLOCKED';

export interface ShadowDecisionEvidence {
  schema_version: 'aegis-shadow-decision-v1';
  status: ShadowCycleStatus;
  decision_cycle_id: string;
  request_id: string;
  cycle_closed_at: string;
  input_hash: string;
  model_bundle_id?: string;
  decision_id?: string;
  decision_status?: string;
  ranking?: DecisionResponse['ranking'];
  selected_candidate_hash?: string;
  gate_result?: GateResult;
  shadow_action: ShadowAction;
  reason_codes: readonly string[];
  latency_ms: Readonly<Record<string, number>>;
  recorded_at: string;
  execution_enabled: false;
}

export interface ShadowEvidenceRecorder { record(event: ShadowDecisionEvidence): void; }

export class InMemoryShadowEvidenceRecorder implements ShadowEvidenceRecorder {
  readonly events: ShadowDecisionEvidence[] = [];
  record(event: ShadowDecisionEvidence): void { this.events.push(event); }
}

export class JsonlShadowEvidenceRecorder implements ShadowEvidenceRecorder {
  constructor(private readonly path: string) {
    if (!path) throw new Error('SHADOW_EVIDENCE_PATH_REQUIRED');
  }
  record(event: ShadowDecisionEvidence): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

export class ShadowCycleError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'ShadowCycleError'; }
}

export interface ShadowCoordinatorOptions {
  client: BrainClient;
  gate: DecisionGate;
  recorder: ShadowEvidenceRecorder;
  expectedManifest: ExpectedBrainManifest;
  operationalContext: (now: string) => OperationalContext;
  now?: () => Date;
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

export function validateCoordinatedShadowSnapshot(snapshot: MarketSnapshot, expected: ExpectedBrainManifest): void {
  if (snapshot.timeframe !== expected.timeframe) throw new ShadowCycleError('SHADOW_TIMEFRAME_MISMATCH');
  if (snapshot.symbol_set_hash !== expected.symbolSetHash) throw new ShadowCycleError('SHADOW_UNIVERSE_HASH_MISMATCH');
  const symbols = snapshot.series.map((item) => item.symbol);
  if (symbols.length !== expected.symbols.length || new Set(symbols).size !== symbols.length ||
      [...symbols].sort().join('\n') !== [...expected.symbols].sort().join('\n')) {
    throw new ShadowCycleError('SHADOW_UNIVERSE_MISMATCH');
  }
  const close = Date.parse(snapshot.closed_at);
  if (!Number.isFinite(close)) throw new ShadowCycleError('SHADOW_INVALID_CYCLE_TIME');
  for (const series of snapshot.series) {
    if (!series.candles.length || series.feed_quality.missing_bars > 0 || series.feed_quality.duplicate_bars > 0) {
      throw new ShadowCycleError('SHADOW_INCOMPLETE_SERIES');
    }
    if (series.last_confirmed_close !== snapshot.closed_at) throw new ShadowCycleError('SHADOW_UNALIGNED_SERIES');
    const last = series.candles[series.candles.length - 1];
    if (!last.is_closed || last.close_time !== snapshot.closed_at) throw new ShadowCycleError('SHADOW_PARTIAL_CANDLE');
    if (series.candles.some((candle, index) => !candle.is_closed || !Number.isFinite(Date.parse(candle.close_time)) ||
        (index > 0 && Date.parse(candle.open_time) !== Date.parse(series.candles[index - 1].close_time)))) {
      throw new ShadowCycleError('SHADOW_NON_CAUSAL_OR_GAPPED_SERIES');
    }
  }
}

export class ShadowBrainCoordinator {
  private readonly processedCycles = new Set<string>();
  private readonly now: () => Date;

  constructor(private readonly options: ShadowCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async process(snapshot: MarketSnapshot): Promise<ShadowDecisionEvidence> {
    const started = performance.now();
    const inputHash = digest(snapshot);
    const cycleId = `shadow-cycle-${digest({ closed_at: snapshot.closed_at, input_hash: inputHash }).slice(0, 24)}`;
    const requestId = `shadow-request-${digest({ cycle_id: cycleId }).slice(0, 24)}`;
    if (this.processedCycles.has(cycleId)) throw new ShadowCycleError('SHADOW_CYCLE_ALREADY_PROCESSED');
    try {
      validateCoordinatedShadowSnapshot(snapshot, this.options.expectedManifest);
      const manifestStarted = performance.now();
      const manifest = await this.options.client.getManifest();
      const manifestLatency = performance.now() - manifestStarted;
      const compatibility = validateBrainManifest(manifest, this.options.expectedManifest);
      if (!compatibility.compatible) throw new ShadowCycleError(compatibility.mismatchCodes.join(','));
      const request: DecisionRequest = {
        request_id: requestId, decision_cycle_id: cycleId, schema_version: 'aegis-decision-request-v1',
        contract_version: BRAIN_CONTRACT_VERSION, config_version: manifest.config_version, snapshot,
      };
      const evaluationStarted = performance.now();
      const decision = await this.options.client.evaluate(request);
      const evaluationLatency = performance.now() - evaluationStarted;
      if (decision.decision_cycle_id !== cycleId) throw new ShadowCycleError('SHADOW_DECISION_CYCLE_MISMATCH');
      const now = this.now().toISOString();
      const context = this.options.operationalContext(now);
      if (context.mode !== 'SHADOW') throw new ShadowCycleError('SHADOW_CONTEXT_MODE_REQUIRED');
      const gate = this.options.gate.validate(decision, context);
      if (gate.decision !== 'DENY' || !gate.reasonCodes.includes('SHADOW_MODE_NON_EXECUTING')) {
        throw new ShadowCycleError('SHADOW_GATE_MUST_DENY_EXECUTION');
      }
      const selected = decision.selected[0];
      const hypothetical = decision.status === 'NO_TRADE' ? 'WOULD_NOT_TRADE' :
        selected?.side === 'LONG' ? 'WOULD_LONG' : selected?.side === 'SHORT' ? 'WOULD_SHORT' : 'BLOCKED';
      const event: ShadowDecisionEvidence = {
        schema_version: 'aegis-shadow-decision-v1', status: 'RECORDED', decision_cycle_id: cycleId,
        request_id: requestId, cycle_closed_at: snapshot.closed_at, input_hash: inputHash,
        model_bundle_id: decision.model_bundle_id, decision_id: decision.decision_id,
        decision_status: decision.status, ranking: decision.ranking,
        selected_candidate_hash: selected?.candidate_hash, gate_result: gate,
        shadow_action: hypothetical, reason_codes: gate.reasonCodes,
        latency_ms: { manifest: manifestLatency, evaluation: evaluationLatency, total: performance.now() - started },
        recorded_at: now, execution_enabled: false,
      };
      this.options.recorder.record(event);
      this.processedCycles.add(cycleId);
      return event;
    } catch (error) {
      const code = error instanceof ShadowCycleError ? error.code : 'SHADOW_BRAIN_UNAVAILABLE';
      const event: ShadowDecisionEvidence = {
        schema_version: 'aegis-shadow-decision-v1', status: 'FAILED_CLOSED', decision_cycle_id: cycleId,
        request_id: requestId, cycle_closed_at: snapshot.closed_at, input_hash: inputHash,
        shadow_action: 'BLOCKED', reason_codes: [code], latency_ms: { total: performance.now() - started },
        recorded_at: this.now().toISOString(), execution_enabled: false,
      };
      this.options.recorder.record(event);
      this.processedCycles.add(cycleId);
      return event;
    }
  }
}
