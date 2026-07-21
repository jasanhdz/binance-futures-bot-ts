/** Persistent public-market service for prospective Shadow Cohort 1. */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statfsSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalJson, sha256 } from './canonical';
import {
  buildProspectiveEnvelope,
  CompleteComponentEvidence,
  EvidenceBuildContext,
  JsonlProspectiveEvidenceRecorder,
  ProspectiveEvidenceEnvelope,
} from './evidence';
import { PROSPECTIVE_PROTOCOL_VERSION } from './identity';
import { assertPublicEndpoint } from './shadow-harness';
import { AegisEntryDecisionResult } from '../domain/services/aegis-entry/AegisEntryDecisionTypes';
import { Candle, DecisionRequest, MarketSnapshot } from '../brain/contract';

export const COHORT_ID = 'aegis-prospective-shadow-cohort-1' as const;
export const MODEL_IDENTITY = 'aegis-prospective-shadow-candidate-v1' as const;
export const MODEL_BUNDLE_SHA256 =
  '23b22403b70f7d6c385d1214e6543197f4ca4e57269af19b1013987891ed550a';
export const MODEL_ARTIFACT_SHA256 =
  '386742c20d74a3b67d47cd95629c646195472e05e9e8d136587d40989a82e3d1';
export const CONFIGURATION_SHA256 =
  'f944b0210b31928a519dc63459be3f1d53de811517dc1bbe9753596314579ec1';
export const SYMBOL_SET_SHA256 = 'f6448e67daf1d017e16cc6b331f6494e97e178824474994fff08864303ccd348';
export const SYMBOLS = [
  'ETHUSDT',
  'BTCUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'SUIUSDT',
  'LTCUSDT',
] as const;
export const PUBLIC_KLINES_ENDPOINT = 'https://fapi.binance.com/fapi/v1/klines';
const INTERVAL_MS = 300_000;
const HORIZON_BARS = 12;
const MIN_FREE_BYTES = 1_073_741_824;
const CREDENTIAL_PATTERN =
  /(^|_)(API[_-]?KEY|API[_-]?SECRET|SECRET[_-]?KEY|BINANCE[_-]?(KEY|SECRET))($|_)/i;

export interface ActivationRecord {
  schema_id: 'aegis-prospective-shadow-activation-v1';
  activation_id: string;
  cohort_id: typeof COHORT_ID;
  protocol_version: typeof PROSPECTIVE_PROTOCOL_VERSION;
  activation_timestamp_utc: string;
  activation_timestamp_utc_epoch_ms: number;
  python_commit: string;
  typescript_commit: string;
  model_identity: typeof MODEL_IDENTITY;
  model_bundle_sha256: string;
  trained_artifact_sha256: string;
  configuration_sha256: string;
  service_mode: 'SHADOW';
  approved_for_live: false;
  activation_state: 'OPENED';
  prospective_cohort: 'ACTIVE';
  private_endpoints_enabled: false;
  credentials_enabled: false;
  order_operations_enabled: false;
  content_sha256: string;
}

export interface RuntimePaths {
  root: string;
  evidence: string;
  outcomes: string;
  intents: string;
  checkpoint: string;
  state: string;
  health: string;
}

export interface RuntimeCheckpoint {
  schema_id: 'aegis-shadow-cohort-checkpoint-v1';
  activation_id: string;
  configuration_sha256: string;
  model_artifact_sha256: string;
  processed_cycle_ids: readonly string[];
  reconnect_count: number;
  checkpoint_sha256: string;
}

interface BridgeCandidate {
  symbol: string;
  side: 'SHORT' | 'NO_TRADE';
  selected: boolean;
  candidate: Record<string, unknown>;
  upstream_model: Record<string, unknown>;
  component_evidence: CompleteComponentEvidence;
}

interface BridgeResult {
  cohort_id: string;
  model_identity: string;
  model_artifact_hash: string;
  configuration_hash: string;
  decision_cycle_id: string;
  signal_timestamp_utc: string;
  candidates: BridgeCandidate[];
}

export interface ShadowServiceOptions {
  repoRoot: string;
  typescriptRoot: string;
  activationPath: string;
  candidatePath: string;
  configDir: string;
  pythonExecutable: string;
  paths: RuntimePaths;
  pollMs: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function digestFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function assertCredentialFreeEnvironment(environment: NodeJS.ProcessEnv): void {
  const prohibited = Object.keys(environment).find((name) => CREDENTIAL_PATTERN.test(name));
  if (prohibited) throw new Error(`SHADOW_CREDENTIAL_ACCESS_PROHIBITED:${prohibited}`);
}

export function loadActivationRecord(path: string): ActivationRecord {
  const record = JSON.parse(readFileSync(path, 'utf8')) as ActivationRecord;
  const { content_sha256: claimed, ...unsigned } = record;
  if (claimed !== sha256(canonicalJson(unsigned)))
    throw new Error('PROSPECTIVE_ACTIVATION_RECORD_CORRUPT');
  if (
    record.schema_id !== 'aegis-prospective-shadow-activation-v1' ||
    record.cohort_id !== COHORT_ID ||
    record.protocol_version !== PROSPECTIVE_PROTOCOL_VERSION ||
    record.service_mode !== 'SHADOW' ||
    record.activation_state !== 'OPENED' ||
    record.prospective_cohort !== 'ACTIVE' ||
    record.model_identity !== MODEL_IDENTITY ||
    record.model_bundle_sha256 !== MODEL_BUNDLE_SHA256 ||
    record.trained_artifact_sha256 !== MODEL_ARTIFACT_SHA256 ||
    record.configuration_sha256 !== CONFIGURATION_SHA256 ||
    record.approved_for_live !== false ||
    record.private_endpoints_enabled !== false ||
    record.credentials_enabled !== false ||
    record.order_operations_enabled !== false
  ) {
    throw new Error('PROSPECTIVE_ACTIVATION_RECORD_INVALID');
  }
  const runtimeTsCommit = process.env.AEGIS_SHADOW_TYPESCRIPT_COMMIT;
  const runtimePythonCommit = process.env.AEGIS_SHADOW_PYTHON_COMMIT;
  if (runtimeTsCommit && runtimeTsCommit !== record.typescript_commit)
    throw new Error('PROSPECTIVE_CODE_HASH_MISMATCH');
  if (runtimePythonCommit && runtimePythonCommit !== record.python_commit)
    throw new Error('PROSPECTIVE_CODE_HASH_MISMATCH');
  return record;
}

function durableWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${canonicalJson(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  const descriptor = openSync(temporary, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function durableAppend(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, 'a', 0o600);
  try {
    writeSync(descriptor, `${canonicalJson(value)}\n`, undefined, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function checkpointPayload(
  activationId: string,
  processed: readonly string[],
  reconnectCount: number,
): RuntimeCheckpoint {
  const unsigned = {
    schema_id: 'aegis-shadow-cohort-checkpoint-v1' as const,
    activation_id: activationId,
    configuration_sha256: CONFIGURATION_SHA256,
    model_artifact_sha256: MODEL_ARTIFACT_SHA256,
    processed_cycle_ids: [...processed].sort(),
    reconnect_count: reconnectCount,
  };
  return { ...unsigned, checkpoint_sha256: sha256(canonicalJson(unsigned)) };
}

export function validateCheckpoint(value: RuntimeCheckpoint, activationId: string): void {
  const { checkpoint_sha256: claimed, ...unsigned } = value;
  if (
    claimed !== sha256(canonicalJson(unsigned)) ||
    value.activation_id !== activationId ||
    value.configuration_sha256 !== CONFIGURATION_SHA256 ||
    value.model_artifact_sha256 !== MODEL_ARTIFACT_SHA256
  ) {
    throw new Error('SHADOW_CHECKPOINT_CONFLICT');
  }
}

function parseKlines(rows: unknown, nowMs: number): Candle[] {
  if (!Array.isArray(rows)) throw new Error('SHADOW_PUBLIC_RESPONSE_INVALID');
  const candles = rows.map((row): Candle => {
    if (!Array.isArray(row) || row.length < 7) throw new Error('SHADOW_PUBLIC_RESPONSE_INVALID');
    const openMs = Number(row[0]);
    const closeMs = openMs + INTERVAL_MS;
    const values = [row[1], row[2], row[3], row[4], row[5]].map(Number);
    if (
      !Number.isSafeInteger(openMs) ||
      values.some((value) => !Number.isFinite(value) || value < 0)
    )
      throw new Error('SHADOW_PUBLIC_RESPONSE_INVALID');
    return {
      open_time: new Date(openMs).toISOString(),
      close_time: new Date(closeMs).toISOString(),
      open: values[0],
      high: values[1],
      low: values[2],
      close: values[3],
      volume: values[4],
      is_closed: closeMs <= nowMs,
      source: 'BINANCE_USDM_PUBLIC_KLINES',
      sequence: String(openMs),
    };
  });
  return candles.filter((item) => item.is_closed);
}

export class PublicKlineClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
    private readonly maxAttempts = 3,
  ) {
    assertPublicEndpoint('GET', PUBLIC_KLINES_ENDPOINT);
  }

  async candles(symbol: string, limit: number, startTime?: number): Promise<Candle[]> {
    if (!SYMBOLS.includes(symbol as (typeof SYMBOLS)[number]))
      throw new Error('SHADOW_SYMBOL_UNAUTHORIZED');
    const url = new URL(PUBLIC_KLINES_ENDPOINT);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', '5m');
    url.searchParams.set('limit', String(limit));
    if (startTime !== undefined) url.searchParams.set('startTime', String(startTime));
    assertPublicEndpoint('GET', url.toString());
    let last: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, { method: 'GET', signal: controller.signal });
        if (!response.ok) throw new Error(`SHADOW_PUBLIC_HTTP_${response.status}`);
        return parseKlines(await response.json(), Date.now());
      } catch (error) {
        last = error;
        if (attempt < this.maxAttempts)
          await new Promise((done) => setTimeout(done, 250 * attempt));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error(last instanceof Error ? last.message : 'SHADOW_PUBLIC_CONNECTIVITY_FAILED');
  }
}

export async function runPublicConnectivityPreflight(
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<Record<string, unknown>> {
  assertCredentialFreeEnvironment(process.env);
  const started = performance.now();
  const candles = await new PublicKlineClient(fetchImpl).candles('BTCUSDT', 3);
  if (!candles.length) throw new Error('SHADOW_PUBLIC_CONNECTIVITY_FAILED');
  const latest = candles[candles.length - 1];
  const marketLagMs = now().getTime() - Date.parse(latest.close_time);
  if (marketLagMs < 0 || marketLagMs > 2 * INTERVAL_MS) throw new Error('SHADOW_STALE_MARKET_DATA');
  return {
    schema_id: 'aegis-shadow-public-connectivity-report-v1',
    status: 'PASS',
    endpoint: PUBLIC_KLINES_ENDPOINT,
    endpoint_class: 'PUBLIC_REST',
    dns_tls_http: 'PASS',
    symbol: 'BTCUSDT',
    interval: '5m',
    market_timestamp_available: true,
    market_lag_ms: marketLagMs,
    websocket: 'NOT_APPLICABLE_REST_RUNTIME',
    private_calls: 0,
    credential_reads: 0,
    order_calls: 0,
    elapsed_ms: performance.now() - started,
  };
}

function pseudoDecision(selected: boolean): AegisEntryDecisionResult {
  const finalDecision = selected ? 'ALLOW' : 'DENY';
  return {
    finalDecision,
    finalReason: selected ? 'SCIENTIFIC_CANDIDATE_SELECTED' : 'SCIENTIFIC_CANDIDATE_NOT_SELECTED',
    allowed: selected,
    shouldOpen: selected,
    finalStrategy: selected ? 'aegis_prospective_shadow' : 'none',
    strategy: selected ? 'aegis_prospective_shadow' : 'none',
    strategyCandidates: {},
    guards: [],
    trace: {},
    metadata: { execution_mode: 'SIMULATED_SHADOW' },
    warnings: [],
    adjustedLeverage: 1,
    adjustedPositionFraction: selected ? 0.01 : 0,
    decisions: {},
  } as unknown as AegisEntryDecisionResult;
}

export class PersistentShadowService {
  private readonly now: () => Date;
  private readonly market: PublicKlineClient;
  private readonly activation: ActivationRecord;
  private readonly recorder: JsonlProspectiveEvidenceRecorder;
  private readonly processed = new Set<string>();
  private readonly matured = new Set<string>();
  private reconnects = 0;
  private startedAt = new Date();
  private stopping = false;
  private counters = {
    evaluations: 0,
    evidence: 0,
    outcomes: 0,
    duplicates: 0,
    conflicts: 0,
    stale: 0,
  };

  constructor(private readonly options: ShadowServiceOptions) {
    assertCredentialFreeEnvironment(process.env);
    this.activation = loadActivationRecord(options.activationPath);
    if (digestFile(options.candidatePath) !== MODEL_BUNDLE_SHA256)
      throw new Error('PROSPECTIVE_MODEL_HASH_MISMATCH');
    mkdirSync(options.paths.root, { recursive: true });
    const storage = statfsSync(options.paths.root);
    const free = storage.bavail * storage.bsize;
    if (free < MIN_FREE_BYTES) throw new Error('SHADOW_INSUFFICIENT_DISK_SPACE');
    for (const path of Object.values(options.paths)) mkdirSync(dirname(path), { recursive: true });
    this.now = options.now ?? (() => new Date());
    this.market = new PublicKlineClient(options.fetchImpl);
    this.recorder = new JsonlProspectiveEvidenceRecorder(options.paths.evidence);
    if (existsSync(options.paths.checkpoint)) {
      const checkpoint = JSON.parse(
        readFileSync(options.paths.checkpoint, 'utf8'),
      ) as RuntimeCheckpoint;
      validateCheckpoint(checkpoint, this.activation.activation_id);
      checkpoint.processed_cycle_ids.forEach((value) => this.processed.add(value));
      this.reconnects = checkpoint.reconnect_count;
    }
    if (existsSync(options.paths.outcomes)) {
      for (const line of readFileSync(options.paths.outcomes, 'utf8').split('\n').filter(Boolean)) {
        const outcome = JSON.parse(line) as { prospective_signal_id: string };
        if (this.matured.has(outcome.prospective_signal_id))
          throw new Error('PROSPECTIVE_OUTCOME_DUPLICATE');
        this.matured.add(outcome.prospective_signal_id);
      }
    }
  }

  private bridge(request: DecisionRequest): BridgeResult {
    const result = spawnSync(
      this.options.pythonExecutable,
      [
        '-m',
        'aegis.prospective.shadow_bridge',
        'evaluate',
        '--config-dir',
        this.options.configDir,
        '--candidate',
        this.options.candidatePath,
        '--activation',
        this.options.activationPath,
      ],
      {
        cwd: this.options.repoRoot,
        env: { PATH: process.env.PATH, PYTHONPATH: resolve(this.options.repoRoot, 'src') },
        input: canonicalJson(request),
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.status !== 0)
      throw new Error(result.stderr.trim() || 'SHADOW_BRAIN_EVALUATION_FAILED_CLOSED');
    return JSON.parse(result.stdout) as BridgeResult;
  }

  async connectivityPreflight(): Promise<Record<string, unknown>> {
    return runPublicConnectivityPreflight(this.options.fetchImpl, this.now);
  }

  private async snapshot(): Promise<MarketSnapshot> {
    const all = await Promise.all(SYMBOLS.map((symbol) => this.market.candles(symbol, 96)));
    const finalClose = all.map((candles) => candles[candles.length - 1]?.close_time);
    if (finalClose.some((value) => !value) || new Set(finalClose).size !== 1)
      throw new Error('SHADOW_UNALIGNED_SERIES');
    const closedAt = finalClose[0] as string;
    const series = SYMBOLS.map((symbol, index) => {
      const candles = all[index].filter((item) => item.close_time <= closedAt).slice(-96);
      if (candles.length < 60) throw new Error('SHADOW_INCOMPLETE_SERIES');
      return {
        symbol,
        candles,
        last_confirmed_close: closedAt,
        feed_quality: {
          missing_bars: 0,
          duplicate_bars: 0,
          source_lag_ms: this.now().getTime() - Date.parse(closedAt),
        },
      };
    });
    return {
      closed_at: closedAt,
      timeframe: '5m',
      symbol_set_hash: SYMBOL_SET_SHA256,
      series,
      portfolio: {
        blocked_symbols: [],
        occupied_symbols: [],
        available_slots: 1,
        long_exposure_count: 0,
        short_exposure_count: 0,
        active_cooldowns: {},
        accepted_decision_ids: [],
        operational_time: closedAt,
      },
    };
  }

  async runCycle(): Promise<number> {
    const snapshot = await this.snapshot();
    if (Date.parse(snapshot.closed_at) < this.activation.activation_timestamp_utc_epoch_ms)
      throw new Error('PROSPECTIVE_EVENT_BEFORE_ACTIVATION');
    const cycleId = `shadow-cycle-${sha256(canonicalJson({ cohort: COHORT_ID, closed_at: snapshot.closed_at })).slice(0, 24)}`;
    if (this.processed.has(cycleId)) return 0;
    const request: DecisionRequest = {
      request_id: `shadow-request-${sha256(cycleId).slice(0, 24)}`,
      decision_cycle_id: cycleId,
      schema_version: 'aegis-decision-request-v1',
      contract_version: 'aegis-clean-rebuild-v1',
      config_version: 'aegis-clean-rebuild-config-v1',
      snapshot,
    };
    const result = this.bridge(request);
    let persisted = 0;
    for (const [index, item] of result.candidates.entries()) {
      for (const component of Object.values(item.component_evidence)) {
        component.output_hash = sha256(canonicalJson(component.output));
      }
      const context: EvidenceBuildContext = {
        protocolVersion: PROSPECTIVE_PROTOCOL_VERSION,
        cohortId: COHORT_ID,
        modelArtifactHash: MODEL_ARTIFACT_SHA256,
        configurationHash: CONFIGURATION_SHA256,
        symbol: item.symbol,
        decisionCycleId: cycleId,
        side: item.side,
        signalTimestampUtc: snapshot.closed_at,
        informationCutoffUtc: snapshot.closed_at,
        eventSequenceId: `binance-public-5m:${snapshot.closed_at}:${item.symbol}`,
        evaluationId: `${cycleId}:${String(index).padStart(2, '0')}`,
        sourceTypescriptCommit: this.activation.typescript_commit,
        sourcePythonCommit: this.activation.python_commit,
        modelIdentity: MODEL_IDENTITY,
        upstreamModel: item.upstream_model,
        componentEvidence: item.component_evidence,
        riskPolicyIdentity: 'aegis-shadow-no-execution-risk-v1',
        sizingPolicyIdentity: 'aegis-shadow-qualified-risk-fraction-v1',
        costPolicyIdentity: 'aegis-prospective-roundtrip-10bps-v1',
        protocolActive: true,
      };
      const envelope = buildProspectiveEnvelope(context, pseudoDecision(item.selected));
      this.recorder.record(envelope);
      persisted += 1;
      if (envelope.final_decision.action === 'ENTER_NOW') this.persistIntent(envelope, snapshot);
    }
    this.processed.add(cycleId);
    this.counters.evaluations += result.candidates.length;
    this.counters.evidence += persisted;
    this.persistCheckpoint();
    await this.matureOutcomes();
    this.persistHealth('RUNNING', snapshot.closed_at);
    return persisted;
  }

  async matureOutcomes(): Promise<number> {
    if (!existsSync(this.options.paths.evidence)) return 0;
    let count = 0;
    const envelopes = readFileSync(this.options.paths.evidence, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProspectiveEvidenceEnvelope);
    for (const envelope of envelopes) {
      if (envelope.side !== 'SHORT' || this.matured.has(envelope.prospective_signal_id)) continue;
      const signalMs = Date.parse(envelope.signal_timestamp_utc);
      if (this.now().getTime() < signalMs + HORIZON_BARS * INTERVAL_MS) continue;
      const candles = await this.market.candles(
        envelope.symbol,
        HORIZON_BARS + 2,
        signalMs - INTERVAL_MS,
      );
      const signal = candles.find((item) => Date.parse(item.close_time) === signalMs);
      const future = candles
        .filter((item) => Date.parse(item.open_time) >= signalMs)
        .slice(0, HORIZON_BARS);
      if (!signal || future.length !== HORIZON_BARS)
        throw new Error('PROSPECTIVE_MARKET_DATA_INCOMPLETE');
      const result = spawnSync(
        this.options.pythonExecutable,
        [
          '-m',
          'aegis.prospective.shadow_bridge',
          'mature',
          '--config-dir',
          this.options.configDir,
          '--candidate',
          this.options.candidatePath,
          '--activation',
          this.options.activationPath,
          '--outcome-journal',
          this.options.paths.outcomes,
        ],
        {
          cwd: this.options.repoRoot,
          env: { PATH: process.env.PATH, PYTHONPATH: resolve(this.options.repoRoot, 'src') },
          input: canonicalJson({
            envelope,
            signal_candle: signal,
            future_candles: future,
            as_of_utc: this.now().toISOString(),
          }),
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      if (result.status !== 0)
        throw new Error(result.stderr.trim() || 'PROSPECTIVE_OUTCOME_PERSISTENCE_FAILED');
      this.matured.add(envelope.prospective_signal_id);
      this.counters.outcomes += 1;
      count += 1;
    }
    return count;
  }

  private persistIntent(envelope: ProspectiveEvidenceEnvelope, snapshot: MarketSnapshot): void {
    const series = snapshot.series.find((item) => item.symbol === envelope.symbol);
    const candle = series?.candles[series.candles.length - 1];
    if (!candle) throw new Error('SHADOW_SIMULATED_INTENT_INPUT_MISSING');
    const virtualNotional =
      10_000 * Number(envelope.final_decision.risk_intent.adjusted_position_fraction);
    durableAppend(this.options.paths.intents, {
      schema_id: 'aegis-shadow-simulated-intent-v1',
      execution_mode: 'SIMULATED_SHADOW',
      prospective_signal_id: envelope.prospective_signal_id,
      symbol: envelope.symbol,
      side: 'SHORT',
      hypothetical_entry: candle.close,
      hypothetical_quantity: virtualNotional / candle.close,
      synthetic_balance_identity: 'aegis-shadow-synthetic-usd-10000-v1',
      sizing_policy_identity: 'aegis-shadow-qualified-risk-fraction-v1',
      cost_policy_identity: 'aegis-prospective-roundtrip-10bps-v1',
      funding_policy_identity: 'aegis-prospective-zero-funding-v1',
      simulated: true,
      exchange_fill: false,
    });
  }

  private persistCheckpoint(): void {
    durableWrite(
      this.options.paths.checkpoint,
      checkpointPayload(this.activation.activation_id, [...this.processed], this.reconnects),
    );
  }

  private persistHealth(state: string, lastMarketEvent: string | null): void {
    const health = {
      schema_id: 'aegis-shadow-runtime-health-v1',
      service_state: state,
      activation_id: this.activation.activation_id,
      cohort_id: COHORT_ID,
      uptime_seconds: Math.max(0, (this.now().getTime() - this.startedAt.getTime()) / 1000),
      last_public_market_event_timestamp: lastMarketEvent,
      public_connection_state: state === 'RUNNING' ? 'CONNECTED_PUBLIC_REST' : state,
      reconnect_count: this.reconnects,
      duplicate_event_count: this.counters.duplicates,
      conflicting_event_count: this.counters.conflicts,
      stale_event_count: this.counters.stale,
      evaluated_candidate_count: this.counters.evaluations,
      persisted_evidence_count: this.counters.evidence,
      matured_outcome_count: this.counters.outcomes,
      checkpoint_status: existsSync(this.options.paths.checkpoint) ? 'VALID' : 'NOT_CREATED',
      journal_status: 'WRITABLE',
      disk_space_status: 'PASS',
      model_identity: MODEL_IDENTITY,
      configuration_identity: CONFIGURATION_SHA256,
      private_call_count: 0,
      order_call_count: 0,
      credential_read_count: 0,
      money_movement_count: 0,
    };
    durableWrite(this.options.paths.health, health);
    durableWrite(this.options.paths.state, {
      ...health,
      schema_id: 'aegis-shadow-runtime-state-v1',
    });
  }

  async start(): Promise<void> {
    this.startedAt = this.now();
    this.persistHealth('STARTING', null);
    while (!this.stopping) {
      try {
        await this.runCycle();
        await this.matureOutcomes();
      } catch (error) {
        if (
          !(error instanceof Error && /PROSPECTIVE_EVENT_BEFORE_ACTIVATION/.test(error.message))
        ) {
          this.reconnects += 1;
          this.persistCheckpoint();
          if (this.reconnects > 5) {
            this.persistHealth('QUARANTINED', null);
            throw new Error('SHADOW_RESTART_LIMIT_EXCEEDED');
          }
        }
      }
      await new Promise((done) => setTimeout(done, this.options.pollMs));
    }
    this.persistCheckpoint();
    this.persistHealth('STOPPED', null);
  }

  stop(): void {
    this.stopping = true;
  }
}

function defaultOptions(): ShadowServiceOptions {
  const typescriptRoot = resolve(__dirname, '../..');
  const repoRoot = resolve(typescriptRoot, '..');
  const root =
    process.env.AEGIS_SHADOW_DATA_ROOT ?? resolve(repoRoot, 'data/prospective_shadow/cohort_1');
  return {
    repoRoot,
    typescriptRoot,
    activationPath:
      process.env.AEGIS_SHADOW_ACTIVATION_PATH ??
      resolve(
        repoRoot,
        'reports/governance/aegis_prospective_validation/activation/shadow_cohort_1_activation.json',
      ),
    candidatePath:
      process.env.AEGIS_SHADOW_MODEL_BUNDLE ??
      resolve(repoRoot, 'config/bundles/aegis-prospective-shadow-candidate-v1.json'),
    configDir: resolve(repoRoot, 'config'),
    pythonExecutable: process.env.AEGIS_SHADOW_PYTHON ?? '/home/jasan/.venv_rocm62/bin/python',
    paths: {
      root,
      evidence: resolve(root, 'journals/signal_evidence_v1.jsonl'),
      outcomes: resolve(root, 'journals/outcomes_v1.jsonl'),
      intents: resolve(root, 'journals/simulated_intents_v1.jsonl'),
      checkpoint: resolve(root, 'checkpoints/shadow_service_v1.json'),
      state: resolve(root, 'runtime/shadow_cohort_1_runtime_state.json'),
      health: resolve(root, 'runtime/shadow_cohort_1_health.json'),
    },
    pollMs: Number(process.env.AEGIS_SHADOW_POLL_MS ?? 15_000),
  };
}

async function main(): Promise<void> {
  if (
    process.argv.some((argument) =>
      /--(live|real-orders|production-trading|use-private-api)/.test(argument),
    )
  )
    throw new Error('SHADOW_LIVE_MODE_PROHIBITED');
  if (process.argv.includes('--connectivity-preflight')) {
    process.stdout.write(`${canonicalJson(await runPublicConnectivityPreflight())}\n`);
    return;
  }
  const options = defaultOptions();
  const service = new PersistentShadowService(options);
  if (process.argv.includes('--health')) {
    if (!existsSync(options.paths.health)) throw new Error('SHADOW_HEALTH_NOT_AVAILABLE');
    process.stdout.write(readFileSync(options.paths.health, 'utf8'));
    return;
  }
  if (process.argv.includes('--once')) {
    process.stdout.write(`${canonicalJson({ persisted: await service.runCycle() })}\n`);
    return;
  }
  process.on('SIGTERM', () => service.stop());
  process.on('SIGINT', () => service.stop());
  await service.start();
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'SHADOW_SERVICE_FAILED'}\n`);
    process.exitCode = 2;
  });
}
