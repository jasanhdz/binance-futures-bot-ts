import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256 } from './canonical';
import { JsonlProspectiveEvidenceRecorder } from './evidence';
import {
  assertCredentialFreeEnvironment,
  checkpointPayload,
  COHORT_ID,
  CONFIGURATION_SHA256,
  loadActivationRecord,
  MODEL_ARTIFACT_SHA256,
  MODEL_BUNDLE_SHA256,
  MODEL_IDENTITY,
  PersistentShadowService,
  PublicKlineClient,
  RuntimePaths,
  ShadowServiceOptions,
  validateCheckpoint,
} from './shadow-service';
import { validateShadowStartup } from './shadow-harness';

const activation = () => {
  const unsigned = {
    schema_id: 'aegis-prospective-shadow-activation-v1',
    activation_id: 'shadow-cohort-1-1784635200000',
    cohort_id: COHORT_ID,
    protocol_version: 'aegis-prospective-validation-v1',
    activation_timestamp_utc: '2026-07-21T12:00:00.000Z',
    activation_timestamp_utc_epoch_ms: 1784635200000,
    python_commit: 'a'.repeat(40),
    typescript_commit: 'b'.repeat(40),
    model_identity: MODEL_IDENTITY,
    model_bundle_sha256: MODEL_BUNDLE_SHA256,
    trained_artifact_sha256: MODEL_ARTIFACT_SHA256,
    configuration_sha256: CONFIGURATION_SHA256,
    service_mode: 'SHADOW',
    approved_for_live: false,
    activation_state: 'OPENED',
    prospective_cohort: 'ACTIVE',
    private_endpoints_enabled: false,
    credentials_enabled: false,
    order_operations_enabled: false,
  } as const;
  return { ...unsigned, content_sha256: sha256(canonicalJson(unsigned)) };
};

function serviceFixture(reconnectCount = 0): {
  service: PersistentShadowService;
  paths: RuntimePaths;
  fetchImpl: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
} {
  const root = mkdtempSync(join(tmpdir(), 'aegis-shadow-service-'));
  const typescriptRoot = resolve(__dirname, '../..');
  const repoRoot = resolve(typescriptRoot, '..');
  const activationPath = join(root, 'activation.json');
  const paths: RuntimePaths = {
    root,
    evidence: join(root, 'evidence.jsonl'),
    outcomes: join(root, 'outcomes.jsonl'),
    intents: join(root, 'intents.jsonl'),
    checkpoint: join(root, 'checkpoint.json'),
    state: join(root, 'state.json'),
    health: join(root, 'health.json'),
  };
  writeFileSync(activationPath, `${canonicalJson(activation())}\n`);
  writeFileSync(
    paths.checkpoint,
    `${canonicalJson(checkpointPayload(activation().activation_id, [], reconnectCount))}\n`,
  );
  const fetchImpl = vi.fn();
  const sleep = vi.fn(async () => undefined);
  const options: ShadowServiceOptions = {
    repoRoot,
    typescriptRoot,
    activationPath,
    candidatePath: resolve(repoRoot, 'config/bundles/aegis-prospective-shadow-candidate-v1.json'),
    configDir: resolve(repoRoot, 'config'),
    pythonExecutable: 'unused-in-lifecycle-tests',
    paths,
    pollMs: 0,
    fetchImpl: fetchImpl as typeof fetch,
    sleep,
  };
  return { service: new PersistentShadowService(options), paths, fetchImpl, sleep };
}

function readRuntime(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('Shadow Cohort 1 activation safety', () => {
  it('accepts a hash-bound active Shadow record and rejects mutation', () => {
    const root = mkdtempSync(join(tmpdir(), 'aegis-shadow-'));
    const path = join(root, 'activation.json');
    writeFileSync(path, `${canonicalJson(activation())}\n`);
    expect(loadActivationRecord(path).cohort_id).toBe(COHORT_ID);
    writeFileSync(path, `${canonicalJson({ ...activation(), approved_for_live: true })}\n`);
    expect(() => loadActivationRecord(path)).toThrow('PROSPECTIVE_ACTIVATION_RECORD_CORRUPT');
  });

  it('rejects credential aliases without exposing their values', () => {
    const value = 'distinctive-secret-canary';
    expect(() => assertCredentialFreeEnvironment({ BINANCE_API_KEY: value })).toThrow(
      'SHADOW_CREDENTIAL_ACCESS_PROHIBITED:BINANCE_API_KEY',
    );
    try {
      assertCredentialFreeEnvironment({ BINANCE_API_KEY: value });
    } catch (error) {
      expect(String(error)).not.toContain(value);
    }
  });

  it('accepts active cohort startup but cannot weaken Live isolation', () => {
    const base = {
      mode: 'SHADOW',
      protocolActive: true,
      activationBoundary: 'OPENED',
      eventClassification: COHORT_ID,
      cohortId: COHORT_ID,
      modelMode: 'PROSPECTIVE_SHADOW_CANDIDATE',
      modelIdentity: MODEL_IDENTITY,
      expectedModelIdentity: MODEL_IDENTITY,
      modelApproved: true,
      modelTrained: true,
      approvalScope: 'PROSPECTIVE_SHADOW_ONLY',
      approvedForLive: false,
      modelArtifactHash: MODEL_ARTIFACT_SHA256,
      expectedModelArtifactHash: MODEL_ARTIFACT_SHA256,
      configurationHash: CONFIGURATION_SHA256,
      expectedConfigurationHash: CONFIGURATION_SHA256,
      balanceSource: 'SYNTHETIC',
      adapter: 'PUBLIC_ONLY',
      orderRoutingEnabled: false,
    };
    expect(() => validateShadowStartup(base)).not.toThrow();
    expect(() => validateShadowStartup({ ...base, mode: 'LIVE' })).toThrow(
      'SHADOW_LIVE_MODE_PROHIBITED',
    );
    expect(() => validateShadowStartup({ ...base, orderRoutingEnabled: true })).toThrow(
      'SHADOW_ORDER_OPERATION_PROHIBITED',
    );
  });

  it('hash-binds checkpoints and rejects conflicting recovery', () => {
    const checkpoint = checkpointPayload('activation-1', ['cycle-b', 'cycle-a'], 1);
    expect(checkpoint.processed_cycle_ids).toEqual(['cycle-a', 'cycle-b']);
    expect(() => validateCheckpoint(checkpoint, 'activation-1')).not.toThrow();
    expect(() => validateCheckpoint({ ...checkpoint, reconnect_count: 2 }, 'activation-1')).toThrow(
      'SHADOW_CHECKPOINT_CONFLICT',
    );
  });

  it('fsync recorder recovers immutable identity and rejects duplicate/conflict', () => {
    const root = mkdtempSync(join(tmpdir(), 'aegis-evidence-'));
    const path = join(root, 'evidence.jsonl');
    const envelope: Record<string, unknown> = {
      schema_id: 'aegis-prospective-signal-evidence-v1',
      prospective_signal_id: 'a'.repeat(64),
    };
    const first = new JsonlProspectiveEvidenceRecorder(path);
    first.record(envelope as never);
    expect(readFileSync(path, 'utf8')).toBe(`${canonicalJson(envelope)}\n`);
    const recovered = new JsonlProspectiveEvidenceRecorder(path);
    expect(() => recovered.record(envelope as never)).toThrow('PROSPECTIVE_DUPLICATE_SIGNAL');
    expect(() => recovered.record({ ...envelope, evaluation_id: 'changed' } as never)).toThrow(
      'PROSPECTIVE_SIGNAL_CONFLICT',
    );
  });

  it('public client uses only allowlisted unsigned klines requests', async () => {
    let observed = '';
    const fetchImpl = async (input: string | URL | Request) => {
      observed = String(input);
      return new Response(
        JSON.stringify([[1784634900000, '1', '2', '0.5', '1.5', '10', 1784635199999]]),
        { status: 200 },
      );
    };
    const client = new PublicKlineClient(fetchImpl as typeof fetch, 100, 1);
    const candles = await client.candles('BTCUSDT', 1);
    expect(observed).toContain('/fapi/v1/klines?');
    expect(observed).not.toMatch(/signature|apiKey|listenKey/);
    expect(candles).toHaveLength(1);
    await expect(client.candles('NOTAUTHORIZED', 1)).rejects.toThrow('SHADOW_SYMBOL_UNAUTHORIZED');
  });
});

describe('Persistent shadow recovery lifecycle', () => {
  it('recovers after a transient failure with a high historical reconnect count', async () => {
    const { service, paths, fetchImpl } = serviceFixture(99);
    let retryHealth: Record<string, unknown> | undefined;
    vi.spyOn(service, 'runCycle')
      .mockRejectedValueOnce(new Error('TRANSIENT_PUBLIC_FAILURE'))
      .mockImplementationOnce(async () => {
        retryHealth = readRuntime(paths.health);
        service.stop();
        return 0;
      });
    vi.spyOn(service, 'matureOutcomes').mockResolvedValue(0);

    await expect(service.start()).resolves.toBeUndefined();

    expect(retryHealth).toMatchObject({
      service_state: 'RETRYING',
      public_connection_state: 'RETRYING',
      reconnect_count: 100,
      consecutive_failure_count: 1,
    });
    expect(readRuntime(paths.checkpoint).reconnect_count).toBe(100);
    expect(readRuntime(paths.health)).toMatchObject({
      service_state: 'STOPPED',
      reconnect_count: 100,
      consecutive_failure_count: 0,
      private_call_count: 0,
      order_call_count: 0,
      credential_read_count: 0,
      money_movement_count: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('quarantines only after the consecutive failure budget is exceeded', async () => {
    const { service, paths, sleep } = serviceFixture();
    const cycle = vi.spyOn(service, 'runCycle').mockRejectedValue(new Error('PERSISTENT_FAILURE'));

    await expect(service.start()).resolves.toBeUndefined();

    expect(cycle).toHaveBeenCalledTimes(6);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(readRuntime(paths.health)).toMatchObject({
      service_state: 'QUARANTINED',
      public_connection_state: 'QUARANTINED',
      reconnect_count: 6,
      consecutive_failure_count: 6,
      consecutive_failure_limit: 5,
    });
  });

  it('resets consecutive failures after successful cycles', async () => {
    const { service, paths } = serviceFixture();
    const failingAttempts = new Set([1, 2, 3, 4, 6, 7, 8, 9]);
    let attempt = 0;
    vi.spyOn(service, 'runCycle').mockImplementation(async () => {
      attempt += 1;
      if (failingAttempts.has(attempt)) throw new Error('INTERMITTENT_FAILURE');
      if (attempt === 10) service.stop();
      return 0;
    });
    vi.spyOn(service, 'matureOutcomes').mockResolvedValue(0);

    await service.start();

    expect(attempt).toBe(10);
    expect(readRuntime(paths.health)).toMatchObject({
      service_state: 'STOPPED',
      reconnect_count: 8,
      consecutive_failure_count: 0,
    });
  });
});
