"use strict";
/** Persistent public-market service for prospective Shadow Cohort 1. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PersistentShadowService = exports.PublicKlineClient = exports.PUBLIC_KLINES_ENDPOINT = exports.SYMBOLS = exports.SYMBOL_SET_SHA256 = exports.CONFIGURATION_SHA256 = exports.MODEL_ARTIFACT_SHA256 = exports.MODEL_BUNDLE_SHA256 = exports.MODEL_IDENTITY = exports.COHORT_ID = void 0;
exports.assertCredentialFreeEnvironment = assertCredentialFreeEnvironment;
exports.loadActivationRecord = loadActivationRecord;
exports.checkpointPayload = checkpointPayload;
exports.validateCheckpoint = validateCheckpoint;
exports.runPublicConnectivityPreflight = runPublicConnectivityPreflight;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_child_process_1 = require("node:child_process");
const canonical_1 = require("./canonical");
const evidence_1 = require("./evidence");
const identity_1 = require("./identity");
const jsonl_1 = require("./jsonl");
const shadow_harness_1 = require("./shadow-harness");
const shared_binance_rate_limit_1 = require("../infra/adapters/shared-binance-rate-limit");
exports.COHORT_ID = 'aegis-prospective-shadow-cohort-1';
exports.MODEL_IDENTITY = 'aegis-prospective-shadow-candidate-v1';
exports.MODEL_BUNDLE_SHA256 = '23b22403b70f7d6c385d1214e6543197f4ca4e57269af19b1013987891ed550a';
exports.MODEL_ARTIFACT_SHA256 = '386742c20d74a3b67d47cd95629c646195472e05e9e8d136587d40989a82e3d1';
exports.CONFIGURATION_SHA256 = 'f944b0210b31928a519dc63459be3f1d53de811517dc1bbe9753596314579ec1';
exports.SYMBOL_SET_SHA256 = 'f6448e67daf1d017e16cc6b331f6494e97e178824474994fff08864303ccd348';
exports.SYMBOLS = [
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
];
exports.PUBLIC_KLINES_ENDPOINT = 'https://fapi.binance.com/fapi/v1/klines';
const INTERVAL_MS = 300000;
const HORIZON_BARS = 12;
const MIN_FREE_BYTES = 1073741824;
const MAX_CONSECUTIVE_FAILURES = 5;
const MIN_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 300000;
const CREDENTIAL_PATTERN = /(^|_)(API[_-]?KEY|API[_-]?SECRET|SECRET[_-]?KEY|BINANCE[_-]?(KEY|SECRET))($|_)/i;
function digestFile(path) {
    return (0, node_crypto_1.createHash)('sha256').update((0, node_fs_1.readFileSync)(path)).digest('hex');
}
function assertCredentialFreeEnvironment(environment) {
    const prohibited = Object.keys(environment).find((name) => CREDENTIAL_PATTERN.test(name));
    if (prohibited)
        throw new Error(`SHADOW_CREDENTIAL_ACCESS_PROHIBITED:${prohibited}`);
}
function loadActivationRecord(path) {
    const record = JSON.parse((0, node_fs_1.readFileSync)(path, 'utf8'));
    const { content_sha256: claimed, ...unsigned } = record;
    if (claimed !== (0, canonical_1.sha256)((0, canonical_1.canonicalJson)(unsigned)))
        throw new Error('PROSPECTIVE_ACTIVATION_RECORD_CORRUPT');
    if (record.schema_id !== 'aegis-prospective-shadow-activation-v1' ||
        record.cohort_id !== exports.COHORT_ID ||
        record.protocol_version !== identity_1.PROSPECTIVE_PROTOCOL_VERSION ||
        record.service_mode !== 'SHADOW' ||
        record.activation_state !== 'OPENED' ||
        record.prospective_cohort !== 'ACTIVE' ||
        record.model_identity !== exports.MODEL_IDENTITY ||
        record.model_bundle_sha256 !== exports.MODEL_BUNDLE_SHA256 ||
        record.trained_artifact_sha256 !== exports.MODEL_ARTIFACT_SHA256 ||
        record.configuration_sha256 !== exports.CONFIGURATION_SHA256 ||
        record.approved_for_live !== false ||
        record.private_endpoints_enabled !== false ||
        record.credentials_enabled !== false ||
        record.order_operations_enabled !== false) {
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
function durableWrite(path, value) {
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(path), { recursive: true });
    const temporary = `${path}.tmp`;
    (0, node_fs_1.writeFileSync)(temporary, `${(0, canonical_1.canonicalJson)(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    const descriptor = (0, node_fs_1.openSync)(temporary, 'r');
    try {
        (0, node_fs_1.fsyncSync)(descriptor);
    }
    finally {
        (0, node_fs_1.closeSync)(descriptor);
    }
    (0, node_fs_1.renameSync)(temporary, path);
    const directory = (0, node_fs_1.openSync)((0, node_path_1.dirname)(path), 'r');
    try {
        (0, node_fs_1.fsyncSync)(directory);
    }
    finally {
        (0, node_fs_1.closeSync)(directory);
    }
}
function durableAppend(path, value) {
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(path), { recursive: true });
    const descriptor = (0, node_fs_1.openSync)(path, 'a', 0o600);
    try {
        (0, node_fs_1.writeSync)(descriptor, `${(0, canonical_1.canonicalJson)(value)}\n`, undefined, 'utf8');
        (0, node_fs_1.fsyncSync)(descriptor);
    }
    finally {
        (0, node_fs_1.closeSync)(descriptor);
    }
}
function checkpointPayload(activationId, processed, reconnectCount) {
    const unsigned = {
        schema_id: 'aegis-shadow-cohort-checkpoint-v1',
        activation_id: activationId,
        configuration_sha256: exports.CONFIGURATION_SHA256,
        model_artifact_sha256: exports.MODEL_ARTIFACT_SHA256,
        processed_cycle_ids: [...processed].sort(),
        reconnect_count: reconnectCount,
    };
    return { ...unsigned, checkpoint_sha256: (0, canonical_1.sha256)((0, canonical_1.canonicalJson)(unsigned)) };
}
function validateCheckpoint(value, activationId) {
    const { checkpoint_sha256: claimed, ...unsigned } = value;
    if (claimed !== (0, canonical_1.sha256)((0, canonical_1.canonicalJson)(unsigned)) ||
        value.activation_id !== activationId ||
        value.configuration_sha256 !== exports.CONFIGURATION_SHA256 ||
        value.model_artifact_sha256 !== exports.MODEL_ARTIFACT_SHA256) {
        throw new Error('SHADOW_CHECKPOINT_CONFLICT');
    }
}
function parseKlines(rows, nowMs) {
    if (!Array.isArray(rows))
        throw new Error('SHADOW_PUBLIC_RESPONSE_INVALID');
    const candles = rows.map((row) => {
        if (!Array.isArray(row) || row.length < 7)
            throw new Error('SHADOW_PUBLIC_RESPONSE_INVALID');
        const openMs = Number(row[0]);
        const closeMs = openMs + INTERVAL_MS;
        const values = [row[1], row[2], row[3], row[4], row[5]].map(Number);
        if (!Number.isSafeInteger(openMs) ||
            values.some((value) => !Number.isFinite(value) || value < 0))
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
class PublicKlineClient {
    constructor(fetchImpl = fetch, timeoutMs = 10000, maxAttempts = 3, sharedRateLimiter) {
        this.fetchImpl = fetchImpl;
        this.timeoutMs = timeoutMs;
        this.maxAttempts = maxAttempts;
        this.sharedRateLimiter = sharedRateLimiter ?? new shared_binance_rate_limit_1.SharedBinanceRateLimiter('aegis-prospective-shadow-cohort-1');
        (0, shadow_harness_1.assertPublicEndpoint)('GET', exports.PUBLIC_KLINES_ENDPOINT);
    }
    getRateLimitMetrics() {
        return this.sharedRateLimiter.getMetrics();
    }
    async candles(symbol, limit, startTime) {
        if (!exports.SYMBOLS.includes(symbol))
            throw new Error('SHADOW_SYMBOL_UNAUTHORIZED');
        const url = new URL(exports.PUBLIC_KLINES_ENDPOINT);
        url.searchParams.set('symbol', symbol);
        url.searchParams.set('interval', '5m');
        url.searchParams.set('limit', String(limit));
        if (startTime !== undefined)
            url.searchParams.set('startTime', String(startTime));
        (0, shadow_harness_1.assertPublicEndpoint)('GET', url.toString());
        let last;
        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
            try {
                await this.sharedRateLimiter.acquire(5, 'klines');
                const response = await this.fetchImpl(url, { method: 'GET', signal: controller.signal });
                if (!response.ok) {
                    const body = await response.text();
                    if (response.status === 418 || response.status === 429) {
                        const retryAfter = Number(response.headers.get('retry-after') || 0);
                        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
                            ? retryAfter * 1000
                            : 60_000;
                        this.sharedRateLimiter.noteRateLimit(Date.now() + delayMs, response.status);
                    }
                    throw new Error(`SHADOW_PUBLIC_HTTP_${response.status}${body ? `: ${body}` : ''}`);
                }
                return parseKlines(await response.json(), Date.now());
            }
            catch (error) {
                last = error;
                if (attempt < this.maxAttempts)
                    await new Promise((done) => setTimeout(done, 250 * attempt));
            }
            finally {
                clearTimeout(timeout);
            }
        }
        throw new Error(last instanceof Error ? last.message : 'SHADOW_PUBLIC_CONNECTIVITY_FAILED');
    }
}
exports.PublicKlineClient = PublicKlineClient;
async function runPublicConnectivityPreflight(fetchImpl = fetch, now = () => new Date()) {
    assertCredentialFreeEnvironment(process.env);
    const started = performance.now();
    const candles = await new PublicKlineClient(fetchImpl).candles('BTCUSDT', 3);
    if (!candles.length)
        throw new Error('SHADOW_PUBLIC_CONNECTIVITY_FAILED');
    const latest = candles[candles.length - 1];
    const marketLagMs = now().getTime() - Date.parse(latest.close_time);
    if (marketLagMs < 0 || marketLagMs > 2 * INTERVAL_MS)
        throw new Error('SHADOW_STALE_MARKET_DATA');
    return {
        schema_id: 'aegis-shadow-public-connectivity-report-v1',
        status: 'PASS',
        endpoint: exports.PUBLIC_KLINES_ENDPOINT,
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
function pseudoDecision(selected) {
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
    };
}
class PersistentShadowService {
    constructor(options) {
        this.options = options;
        this.processed = new Set();
        this.matured = new Set();
        this.reconnects = 0;
        this.consecutiveFailures = 0;
        this.startedAt = new Date();
        this.stopping = false;
        this.counters = {
            evaluations: 0,
            evidence: 0,
            outcomes: 0,
            duplicates: 0,
            conflicts: 0,
            stale: 0,
        };
        assertCredentialFreeEnvironment(process.env);
        this.activation = loadActivationRecord(options.activationPath);
        if (digestFile(options.candidatePath) !== exports.MODEL_BUNDLE_SHA256)
            throw new Error('PROSPECTIVE_MODEL_HASH_MISMATCH');
        (0, node_fs_1.mkdirSync)(options.paths.root, { recursive: true });
        const storage = (0, node_fs_1.statfsSync)(options.paths.root);
        const free = storage.bavail * storage.bsize;
        if (free < MIN_FREE_BYTES)
            throw new Error('SHADOW_INSUFFICIENT_DISK_SPACE');
        for (const path of Object.values(options.paths))
            (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(path), { recursive: true });
        this.now = options.now ?? (() => new Date());
        this.sleep = options.sleep ?? ((delayMs) => new Promise((done) => setTimeout(done, delayMs)));
        this.market = new PublicKlineClient(options.fetchImpl);
        this.recorder = new evidence_1.JsonlProspectiveEvidenceRecorder(options.paths.evidence);
        if ((0, node_fs_1.existsSync)(options.paths.checkpoint)) {
            const checkpoint = JSON.parse((0, node_fs_1.readFileSync)(options.paths.checkpoint, 'utf8'));
            validateCheckpoint(checkpoint, this.activation.activation_id);
            checkpoint.processed_cycle_ids.forEach((value) => this.processed.add(value));
            this.reconnects = checkpoint.reconnect_count;
        }
        if ((0, node_fs_1.existsSync)(options.paths.outcomes)) {
            (0, jsonl_1.forEachJsonlLine)(options.paths.outcomes, (line) => {
                const outcome = JSON.parse(line);
                if (this.matured.has(outcome.prospective_signal_id))
                    throw new Error('PROSPECTIVE_OUTCOME_DUPLICATE');
                this.matured.add(outcome.prospective_signal_id);
            });
        }
    }
    bridge(request) {
        const result = (0, node_child_process_1.spawnSync)(this.options.pythonExecutable, [
            '-m',
            'aegis.prospective.shadow_bridge',
            'evaluate',
            '--config-dir',
            this.options.configDir,
            '--candidate',
            this.options.candidatePath,
            '--activation',
            this.options.activationPath,
        ], {
            cwd: this.options.repoRoot,
            env: { PATH: process.env.PATH, PYTHONPATH: (0, node_path_1.resolve)(this.options.repoRoot, 'src') },
            input: (0, canonical_1.canonicalJson)(request),
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
        });
        if (result.status !== 0)
            throw new Error(result.stderr.trim() || 'SHADOW_BRAIN_EVALUATION_FAILED_CLOSED');
        return JSON.parse(result.stdout);
    }
    async connectivityPreflight() {
        return runPublicConnectivityPreflight(this.options.fetchImpl, this.now);
    }
    async snapshot() {
        const all = await Promise.all(exports.SYMBOLS.map((symbol) => this.market.candles(symbol, 96)));
        const finalClose = all.map((candles) => candles[candles.length - 1]?.close_time);
        if (finalClose.some((value) => !value) || new Set(finalClose).size !== 1)
            throw new Error('SHADOW_UNALIGNED_SERIES');
        const closedAt = finalClose[0];
        const series = exports.SYMBOLS.map((symbol, index) => {
            const candles = all[index].filter((item) => item.close_time <= closedAt).slice(-96);
            if (candles.length < 60)
                throw new Error('SHADOW_INCOMPLETE_SERIES');
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
            symbol_set_hash: exports.SYMBOL_SET_SHA256,
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
    async runCycle() {
        const snapshot = await this.snapshot();
        if (Date.parse(snapshot.closed_at) < this.activation.activation_timestamp_utc_epoch_ms)
            throw new Error('PROSPECTIVE_EVENT_BEFORE_ACTIVATION');
        const cycleId = `shadow-cycle-${(0, canonical_1.sha256)((0, canonical_1.canonicalJson)({ cohort: exports.COHORT_ID, closed_at: snapshot.closed_at })).slice(0, 24)}`;
        if (this.processed.has(cycleId))
            return 0;
        const request = {
            request_id: `shadow-request-${(0, canonical_1.sha256)(cycleId).slice(0, 24)}`,
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
                component.output_hash = (0, canonical_1.sha256)((0, canonical_1.canonicalJson)(component.output));
            }
            const context = {
                protocolVersion: identity_1.PROSPECTIVE_PROTOCOL_VERSION,
                cohortId: exports.COHORT_ID,
                modelArtifactHash: exports.MODEL_ARTIFACT_SHA256,
                configurationHash: exports.CONFIGURATION_SHA256,
                symbol: item.symbol,
                decisionCycleId: cycleId,
                side: item.side,
                signalTimestampUtc: snapshot.closed_at,
                informationCutoffUtc: snapshot.closed_at,
                eventSequenceId: `binance-public-5m:${snapshot.closed_at}:${item.symbol}`,
                evaluationId: `${cycleId}:${String(index).padStart(2, '0')}`,
                sourceTypescriptCommit: this.activation.typescript_commit,
                sourcePythonCommit: this.activation.python_commit,
                modelIdentity: exports.MODEL_IDENTITY,
                upstreamModel: item.upstream_model,
                componentEvidence: item.component_evidence,
                riskPolicyIdentity: 'aegis-shadow-no-execution-risk-v1',
                sizingPolicyIdentity: 'aegis-shadow-qualified-risk-fraction-v1',
                costPolicyIdentity: 'aegis-prospective-roundtrip-10bps-v1',
                protocolActive: true,
            };
            const envelope = (0, evidence_1.buildProspectiveEnvelope)(context, pseudoDecision(item.selected));
            this.recorder.record(envelope);
            persisted += 1;
            if (envelope.final_decision.action === 'ENTER_NOW')
                this.persistIntent(envelope, snapshot);
        }
        this.processed.add(cycleId);
        this.counters.evaluations += result.candidates.length;
        this.counters.evidence += persisted;
        this.persistCheckpoint();
        await this.matureOutcomes();
        this.consecutiveFailures = 0;
        this.persistHealth('RUNNING', snapshot.closed_at);
        return persisted;
    }
    async matureOutcomes() {
        if (!(0, node_fs_1.existsSync)(this.options.paths.evidence))
            return 0;
        let count = 0;
        const envelopes = (0, node_fs_1.readFileSync)(this.options.paths.evidence, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        for (const envelope of envelopes) {
            if (envelope.side !== 'SHORT' || this.matured.has(envelope.prospective_signal_id))
                continue;
            const signalMs = Date.parse(envelope.signal_timestamp_utc);
            if (this.now().getTime() < signalMs + HORIZON_BARS * INTERVAL_MS)
                continue;
            const candles = await this.market.candles(envelope.symbol, HORIZON_BARS + 2, signalMs - INTERVAL_MS);
            const signal = candles.find((item) => Date.parse(item.close_time) === signalMs);
            const future = candles
                .filter((item) => Date.parse(item.open_time) >= signalMs)
                .slice(0, HORIZON_BARS);
            if (!signal || future.length !== HORIZON_BARS)
                throw new Error('PROSPECTIVE_MARKET_DATA_INCOMPLETE');
            const result = (0, node_child_process_1.spawnSync)(this.options.pythonExecutable, [
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
            ], {
                cwd: this.options.repoRoot,
                env: { PATH: process.env.PATH, PYTHONPATH: (0, node_path_1.resolve)(this.options.repoRoot, 'src') },
                input: (0, canonical_1.canonicalJson)({
                    envelope,
                    signal_candle: signal,
                    future_candles: future,
                    as_of_utc: this.now().toISOString(),
                }),
                encoding: 'utf8',
                maxBuffer: 4 * 1024 * 1024,
            });
            if (result.status !== 0)
                throw new Error(result.stderr.trim() || 'PROSPECTIVE_OUTCOME_PERSISTENCE_FAILED');
            this.matured.add(envelope.prospective_signal_id);
            this.counters.outcomes += 1;
            count += 1;
        }
        return count;
    }
    persistIntent(envelope, snapshot) {
        const series = snapshot.series.find((item) => item.symbol === envelope.symbol);
        const candle = series?.candles[series.candles.length - 1];
        if (!candle)
            throw new Error('SHADOW_SIMULATED_INTENT_INPUT_MISSING');
        const virtualNotional = 10000 * Number(envelope.final_decision.risk_intent.adjusted_position_fraction);
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
    persistCheckpoint() {
        durableWrite(this.options.paths.checkpoint, checkpointPayload(this.activation.activation_id, [...this.processed], this.reconnects));
    }
    persistHealth(state, lastMarketEvent) {
        const health = {
            schema_id: 'aegis-shadow-runtime-health-v1',
            service_state: state,
            activation_id: this.activation.activation_id,
            cohort_id: exports.COHORT_ID,
            uptime_seconds: Math.max(0, (this.now().getTime() - this.startedAt.getTime()) / 1000),
            last_public_market_event_timestamp: lastMarketEvent,
            public_connection_state: state === 'RUNNING' ? 'CONNECTED_PUBLIC_REST' : state,
            reconnect_count: this.reconnects,
            consecutive_failure_count: this.consecutiveFailures,
            consecutive_failure_limit: MAX_CONSECUTIVE_FAILURES,
            duplicate_event_count: this.counters.duplicates,
            conflicting_event_count: this.counters.conflicts,
            stale_event_count: this.counters.stale,
            evaluated_candidate_count: this.counters.evaluations,
            persisted_evidence_count: this.counters.evidence,
            matured_outcome_count: this.counters.outcomes,
            checkpoint_status: (0, node_fs_1.existsSync)(this.options.paths.checkpoint) ? 'VALID' : 'NOT_CREATED',
            journal_status: 'WRITABLE',
            disk_space_status: 'PASS',
            model_identity: exports.MODEL_IDENTITY,
            configuration_identity: exports.CONFIGURATION_SHA256,
            private_call_count: 0,
            order_call_count: 0,
            credential_read_count: 0,
            money_movement_count: 0,
            shared_rate_limit: this.market.getRateLimitMetrics(),
        };
        durableWrite(this.options.paths.health, health);
        durableWrite(this.options.paths.state, {
            ...health,
            schema_id: 'aegis-shadow-runtime-state-v1',
        });
    }
    async start() {
        this.startedAt = this.now();
        this.persistHealth('STARTING', null);
        while (!this.stopping) {
            const baseDelayMs = Math.max(MIN_RETRY_DELAY_MS, this.options.pollMs);
            let retryDelayMs = baseDelayMs;
            try {
                await this.runCycle();
                this.consecutiveFailures = 0;
            }
            catch (error) {
                if (!(error instanceof Error && /PROSPECTIVE_EVENT_BEFORE_ACTIVATION/.test(error.message))) {
                    this.reconnects += 1;
                    this.consecutiveFailures += 1;
                    this.persistCheckpoint();
                    if (this.consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
                        this.persistHealth('QUARANTINED', null);
                        return;
                    }
                    this.persistHealth('RETRYING', null);
                    retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, baseDelayMs * 2 ** (this.consecutiveFailures - 1));
                }
            }
            await this.sleep(retryDelayMs);
        }
        this.persistCheckpoint();
        this.persistHealth('STOPPED', null);
    }
    stop() {
        this.stopping = true;
    }
}
exports.PersistentShadowService = PersistentShadowService;
function defaultOptions() {
    const typescriptRoot = (0, node_path_1.resolve)(__dirname, '../..');
    const repoRoot = (0, node_path_1.resolve)(typescriptRoot, '..');
    const root = process.env.AEGIS_SHADOW_DATA_ROOT ?? (0, node_path_1.resolve)(repoRoot, 'data/prospective_shadow/cohort_1');
    return {
        repoRoot,
        typescriptRoot,
        activationPath: process.env.AEGIS_SHADOW_ACTIVATION_PATH ??
            (0, node_path_1.resolve)(repoRoot, 'reports/governance/aegis_prospective_validation/activation/shadow_cohort_1_activation.json'),
        candidatePath: process.env.AEGIS_SHADOW_MODEL_BUNDLE ??
            (0, node_path_1.resolve)(repoRoot, 'config/bundles/aegis-prospective-shadow-candidate-v1.json'),
        configDir: (0, node_path_1.resolve)(repoRoot, 'config'),
        pythonExecutable: process.env.AEGIS_SHADOW_PYTHON ?? '/home/jasan/.venv_rocm62/bin/python',
        paths: {
            root,
            evidence: (0, node_path_1.resolve)(root, 'journals/signal_evidence_v1.jsonl'),
            outcomes: (0, node_path_1.resolve)(root, 'journals/outcomes_v1.jsonl'),
            intents: (0, node_path_1.resolve)(root, 'journals/simulated_intents_v1.jsonl'),
            checkpoint: (0, node_path_1.resolve)(root, 'checkpoints/shadow_service_v1.json'),
            state: (0, node_path_1.resolve)(root, 'runtime/shadow_cohort_1_runtime_state.json'),
            health: (0, node_path_1.resolve)(root, 'runtime/shadow_cohort_1_health.json'),
        },
        pollMs: Number(process.env.AEGIS_SHADOW_POLL_MS ?? 15000),
    };
}
async function main() {
    if (process.argv.some((argument) => /--(live|real-orders|production-trading|use-private-api)/.test(argument)))
        throw new Error('SHADOW_LIVE_MODE_PROHIBITED');
    if (process.argv.includes('--connectivity-preflight')) {
        process.stdout.write(`${(0, canonical_1.canonicalJson)(await runPublicConnectivityPreflight())}\n`);
        return;
    }
    const options = defaultOptions();
    const service = new PersistentShadowService(options);
    if (process.argv.includes('--health')) {
        if (!(0, node_fs_1.existsSync)(options.paths.health))
            throw new Error('SHADOW_HEALTH_NOT_AVAILABLE');
        process.stdout.write((0, node_fs_1.readFileSync)(options.paths.health, 'utf8'));
        return;
    }
    if (process.argv.includes('--once')) {
        process.stdout.write(`${(0, canonical_1.canonicalJson)({ persisted: await service.runCycle() })}\n`);
        return;
    }
    process.on('SIGTERM', () => service.stop());
    process.on('SIGINT', () => service.stop());
    await service.start();
}
if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : 'SHADOW_SERVICE_FAILED'}\n`);
        process.exitCode = 2;
    });
}
