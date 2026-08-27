import { describe, expect, it, vi } from 'vitest';
import { AegisEntryDecisionResult } from '../../../../domain/services/aegis-entry/AegisEntryDecisionTypes';
import { AegisEntryGuardOrchestrator } from '../../../../domain/services/aegis-entry/AegisEntryGuardOrchestrator';
import { canonicalJson, sha256 } from './canonical';
import {
  buildProspectiveEnvelope,
  CompleteComponentEvidence,
  EvidenceBuildContext,
  evaluateWithProspectiveEvidence,
  InMemoryProspectiveEvidenceRecorder,
} from './evidence';
import {
  deriveProspectiveSignalId,
  PROSPECTIVE_PROTOCOL_VERSION,
  ProspectiveIdentityInput,
} from './identity';
import {
  assertPublicEndpoint,
  ShadowOnlyHarness,
  ShadowStartupConfig,
  validateShadowStartup,
} from './shadow-harness';
import {
  PROSPECTIVE_SHADOW_CANDIDATE_ID,
  ProspectiveShadowCandidateDescriptor,
  validateProspectiveShadowCandidate,
} from './candidate-model';

const hash = (value: unknown): string => sha256(canonicalJson(value));

const components = (brainDecision = 'ENTER_NOW'): CompleteComponentEvidence =>
  Object.fromEntries(
    ['d3', 'rv2', 'trrm', 'qmae', 'eqm', 'econ1'].map((name) => {
      const output = name === 'd3' ? { decision: brainDecision, value: name } : { value: name };
      return [
        name,
        { status: 'PASS', input_hash: hash({ input: name }), output_hash: hash(output), output },
      ];
    }),
  ) as unknown as CompleteComponentEvidence;

const decision = (
  finalDecision: AegisEntryDecisionResult['finalDecision'] = 'ALLOW',
): AegisEntryDecisionResult =>
  ({
    finalDecision,
    finalReason: finalDecision === 'ALLOW' ? 'allowed' : 'blocked',
    allowed: finalDecision === 'ALLOW',
    shouldOpen: finalDecision === 'ALLOW',
    finalStrategy: finalDecision === 'ALLOW' ? 'aegis_turbo' : 'none',
    strategy: finalDecision === 'ALLOW' ? 'aegis_turbo' : 'none',
    strategyCandidates: {
      momentum_ride: { decision: 'NOT_APPLICABLE', reason: 'not_applicable' },
      aegis_turbo: { decision: finalDecision, reason: 'fixture' },
    },
    guards: [
      {
        name: 'decision_brain',
        enabled: true,
        mode: 'ENFORCE',
        decision: finalDecision === 'ALLOW' ? 'ALLOW' : 'DENY',
        reason: finalDecision === 'ALLOW' ? 'brain_allowed' : 'brain_blocked',
        wouldBlock: finalDecision !== 'ALLOW',
        enforced: true,
        metadata: {},
      },
    ],
    trace: {},
    metadata: {},
    warnings: [],
    adjustedLeverage: 2,
    adjustedPositionFraction: 0.1,
    decisions: {},
  }) as unknown as AegisEntryDecisionResult;

const identity = (overrides: Partial<ProspectiveIdentityInput> = {}): ProspectiveIdentityInput => ({
  protocolVersion: PROSPECTIVE_PROTOCOL_VERSION,
  cohortId: 'cohort-v1',
  modelArtifactHash: 'a'.repeat(64),
  configurationHash: 'b'.repeat(64),
  symbol: 'ADAUSDT',
  decisionCycleId: 'cycle-1',
  side: 'SHORT',
  signalTimestampUtc: '2026-07-21T12:00:00.000Z',
  informationCutoffUtc: '2026-07-21T12:00:00.000Z',
  eventSequenceId: 'event-1',
  ...overrides,
});

const context = (overrides: Partial<EvidenceBuildContext> = {}): EvidenceBuildContext => ({
  ...identity({ cohortId: 'PREACTIVATION_NON_COHORT' }),
  evaluationId: 'evaluation-1',
  sourceTypescriptCommit: 'c'.repeat(40),
  sourcePythonCommit: 'd'.repeat(40),
  modelIdentity: PROSPECTIVE_SHADOW_CANDIDATE_ID,
  upstreamModel: { direction: 'SHORT', confidence: 0.8 },
  componentEvidence: components(),
  riskPolicyIdentity: 'risk-v1',
  sizingPolicyIdentity: 'synthetic-sizing-v1',
  costPolicyIdentity: 'prospective-cost-v1',
  protocolActive: true,
  ...overrides,
});

const startup = (overrides: Partial<ShadowStartupConfig> = {}): ShadowStartupConfig => ({
  mode: 'SHADOW',
  protocolActive: true,
  activationBoundary: 'NOT_OPENED',
  eventClassification: 'PREACTIVATION_NON_COHORT',
  modelMode: 'PROSPECTIVE_SHADOW_CANDIDATE',
  modelIdentity: PROSPECTIVE_SHADOW_CANDIDATE_ID,
  expectedModelIdentity: PROSPECTIVE_SHADOW_CANDIDATE_ID,
  modelApproved: true,
  modelTrained: true,
  approvalScope: 'PROSPECTIVE_SHADOW_ONLY',
  approvedForLive: false,
  modelArtifactHash: 'a'.repeat(64),
  expectedModelArtifactHash: 'a'.repeat(64),
  configurationHash: 'b'.repeat(64),
  expectedConfigurationHash: 'b'.repeat(64),
  balanceSource: 'SYNTHETIC',
  adapter: 'PUBLIC_ONLY',
  orderRoutingEnabled: false,
  ...overrides,
});

describe('prospective identity', () => {
  it('is deterministic, canonicalizes equivalent UTC values, and ignores object key order', () => {
    const left = deriveProspectiveSignalId(identity());
    const reordered = Object.fromEntries(
      Object.entries(identity()).reverse(),
    ) as unknown as ProspectiveIdentityInput;
    expect(deriveProspectiveSignalId(reordered)).toBe(left);
    expect(
      deriveProspectiveSignalId(identity({ signalTimestampUtc: '2026-07-21T14:00:00+02:00' })),
    ).toBe(left);
    expect(left).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes for every governed identity dimension', () => {
    const base = deriveProspectiveSignalId(identity());
    for (const changed of [
      identity({ symbol: 'ETHUSDT' }),
      identity({ decisionCycleId: 'cycle-2' }),
      identity({ eventSequenceId: 'event-2' }),
      identity({ signalTimestampUtc: '2026-07-21T12:00:01Z' }),
      identity({ modelArtifactHash: 'e'.repeat(64) }),
      identity({ configurationHash: 'f'.repeat(64) }),
    ]) {
      expect(deriveProspectiveSignalId(changed)).not.toBe(base);
    }
  });

  it('rejects ambiguity, future cutoff, bad versions, sides, symbols, and forbidden fields', () => {
    expect(() =>
      deriveProspectiveSignalId(identity({ signalTimestampUtc: '2026-07-21T12:00:00' })),
    ).toThrow('PROSPECTIVE_TIMESTAMP_AMBIGUOUS');
    expect(() =>
      deriveProspectiveSignalId(identity({ informationCutoffUtc: '2026-07-21T12:00:01Z' })),
    ).toThrow('PROSPECTIVE_INFORMATION_CUTOFF_INVALID');
    expect(() => deriveProspectiveSignalId(identity({ protocolVersion: 'bad' as never }))).toThrow(
      'PROSPECTIVE_PROTOCOL_MISMATCH',
    );
    expect(() => deriveProspectiveSignalId(identity({ side: 'LONG' as never }))).toThrow(
      'PROSPECTIVE_IDENTITY_SIDE_INVALID',
    );
    expect(() => deriveProspectiveSignalId(identity({ symbol: 'adausdt' }))).toThrow(
      'PROSPECTIVE_IDENTITY_SYMBOL_INVALID',
    );
    expect(() => deriveProspectiveSignalId({ ...identity(), outcome: 1 } as never)).toThrow(
      'PROSPECTIVE_IDENTITY_FORBIDDEN_INPUT',
    );
  });
});

describe('prospective evidence recorder', () => {
  it('records every action class, including rejected and no-trade candidates', () => {
    const cases: Array<[AegisEntryDecisionResult, EvidenceBuildContext, string]> = [
      [decision('ALLOW'), context(), 'ENTER_NOW'],
      [decision('WAIT_CONFIRMATION'), context({ eventSequenceId: 'event-2' }), 'WAIT_CONFIRMATION'],
      [
        decision('DENY'),
        context({ eventSequenceId: 'event-3', componentEvidence: components('MANUAL_ONLY') }),
        'MANUAL_ONLY',
      ],
      [
        decision('DENY'),
        context({ eventSequenceId: 'event-4', componentEvidence: components('DO_NOT_ENTER') }),
        'DO_NOT_ENTER',
      ],
      [decision('DENY'), context({ eventSequenceId: 'event-5', side: 'NO_TRADE' }), 'NO_TRADE'],
    ];
    const recorder = new InMemoryProspectiveEvidenceRecorder();
    for (const [result, evidence, action] of cases) {
      recorder.record(buildProspectiveEnvelope(evidence, result));
      expect(recorder.events[recorder.events.length - 1]?.final_decision.action).toBe(action);
    }
    expect(recorder.events).toHaveLength(5);
    expect(Object.keys(recorder.events[0].component_evidence).sort()).toEqual([
      'd3',
      'econ1',
      'eqm',
      'qmae',
      'rv2',
      'trrm',
    ]);
  });

  it('is observationally equivalent and introduces no additional decision or order intent', async () => {
    const original = decision('ALLOW');
    const evaluator = vi.fn(async () => original);
    const recorder = new InMemoryProspectiveEvidenceRecorder();
    const observed = await evaluateWithProspectiveEvidence(evaluator, context(), recorder);
    expect(observed).toBe(original);
    expect(observed).toEqual(original);
    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(recorder.events).toHaveLength(1);
  });

  it('preserves the canonical Aegis entry orchestrator result exactly', async () => {
    const entryContext = {
      symbol: 'ADAUSDT',
      side: 'SHORT',
      turboScore: 0.8,
      leverage: 2,
      requestedPositionFraction: 0.1,
      basePositionFraction: 0.1,
      signal: {},
      gate: {},
      entryQuality: { ruleGate: {} },
      eventRisk: { enabled: false, mode: 'NORMAL', enforce: false, isAltSymbol: true },
      shortGate: { config: {} },
      decisionEnforcement: { config: {} },
      operational: {
        consecutiveLosses: 0,
        tradesToday: 0,
        openPositionsCount: 0,
        openProbePositions: 0,
        sameSymbolPositionExists: false,
        timestamp: Date.parse('2026-07-21T12:00:00Z'),
      },
    } as never;
    const policy = { enabled: false, guards: {} } as never;
    const baseline = await AegisEntryGuardOrchestrator.evaluate(entryContext, policy);
    const recorder = new InMemoryProspectiveEvidenceRecorder();
    const observed = await evaluateWithProspectiveEvidence(
      async () => AegisEntryGuardOrchestrator.evaluate(entryContext, policy),
      context(),
      recorder,
    );
    expect(observed).toEqual(baseline);
    expect(observed.finalDecision).toBe(baseline.finalDecision);
    expect(observed.finalReason).toBe(baseline.finalReason);
    expect(observed.guards).toEqual(baseline.guards);
    expect(observed.adjustedLeverage).toBe(baseline.adjustedLeverage);
    expect(observed.adjustedPositionFraction).toBe(baseline.adjustedPositionFraction);
  });

  it('fails on preactivation, missing components, hashes, secrets, duplicates, and conflicts', () => {
    expect(() => buildProspectiveEnvelope(context({ protocolActive: false }), decision())).toThrow(
      'PROSPECTIVE_PREACTIVATION_SIGNAL',
    );
    expect(() =>
      buildProspectiveEnvelope(
        context({ componentEvidence: { ...components(), qmae: undefined } as never }),
        decision(),
      ),
    ).toThrow('PROSPECTIVE_COMPONENT_EVIDENCE_INCOMPLETE');
    const bad = components();
    bad.rv2 = { ...bad.rv2, output: { changed: true } };
    expect(() => buildProspectiveEnvelope(context({ componentEvidence: bad }), decision())).toThrow(
      'PROSPECTIVE_COMPONENT_HASH_MISMATCH',
    );
    expect(() =>
      buildProspectiveEnvelope(context({ upstreamModel: { api_key: 'forbidden' } }), decision()),
    ).toThrow('PROSPECTIVE_SECRET_FIELD_PROHIBITED');
    const recorder = new InMemoryProspectiveEvidenceRecorder();
    const envelope = buildProspectiveEnvelope(context(), decision());
    recorder.record(envelope);
    expect(() => recorder.record(envelope)).toThrow('PROSPECTIVE_DUPLICATE_SIGNAL');
    expect(() => recorder.record({ ...envelope, evaluation_id: 'conflict' })).toThrow(
      'PROSPECTIVE_SIGNAL_CONFLICT',
    );
  });
});

describe('shadow-only safety', () => {
  it('accepts only the trained Shadow-only candidate and matching brain contract', () => {
    const descriptor: ProspectiveShadowCandidateDescriptor = {
      modelIdentity: PROSPECTIVE_SHADOW_CANDIDATE_ID,
      sourceModelBundleId: 'aegis-short-candidate-e3-experimental',
      modelArtifactHash: 'a'.repeat(64),
      featureSchemaVersion: 'aegis-features-v2',
      featureHash: 'f'.repeat(64),
      trained: true,
      approved: true,
      approvalScope: 'PROSPECTIVE_SHADOW_ONLY',
      approvedForLive: false,
    };
    const manifest = {
      schema_version: 'aegis-brain-manifest-v1',
      contract_version: 'aegis-brain-contract-v1',
      universe_id: 'universe-v1',
      symbols: ['ADAUSDT'],
      symbol_set_hash: 's'.repeat(64),
      timeframe: '5m',
      config_version: 'config-v1',
      model_bundle_id: descriptor.sourceModelBundleId,
      feature_schema_version: descriptor.featureSchemaVersion,
      feature_hash: descriptor.featureHash,
      ready: true,
    } as never;
    expect(() => validateProspectiveShadowCandidate(descriptor, manifest)).not.toThrow();
    expect(() =>
      validateProspectiveShadowCandidate(
        { ...descriptor, sourceModelBundleId: 'aegis-offline-reference-v1' },
        manifest,
      ),
    ).toThrow('PROSPECTIVE_MODEL_IDENTITY_MISMATCH');
    expect(() =>
      validateProspectiveShadowCandidate(
        { ...descriptor, approvedForLive: true } as never,
        manifest,
      ),
    ).toThrow('PROSPECTIVE_MODEL_APPROVAL_INVALID');
  });

  it('accepts only allowlisted public market endpoints', () => {
    expect(() =>
      assertPublicEndpoint('GET', 'https://fapi.binance.com/fapi/v1/klines?symbol=ADAUSDT'),
    ).not.toThrow();
    expect(() =>
      assertPublicEndpoint('WEBSOCKET', 'wss://fstream.binance.com/ws/adausdt@kline_5m'),
    ).not.toThrow();
    expect(() => assertPublicEndpoint('GET', 'https://fapi.binance.com/fapi/v2/account')).toThrow(
      'SHADOW_PRIVATE_ENDPOINT_PROHIBITED',
    );
    expect(() => assertPublicEndpoint('GET', 'https://example.com/public')).toThrow(
      'SHADOW_UNAUTHORIZED_ENDPOINT',
    );
    expect(() =>
      assertPublicEndpoint('GET', 'https://user:secret@fapi.binance.com/fapi/v1/klines'),
    ).toThrow('SHADOW_CREDENTIAL_ACCESS_PROHIBITED');
  });

  it('hard-denies live mode, credentials, private adapters, real balances, routing, and drift', () => {
    expect(() => validateShadowStartup(startup())).not.toThrow();
    expect(() => validateShadowStartup(startup({ mode: 'LIVE' }))).toThrow(
      'SHADOW_LIVE_MODE_PROHIBITED',
    );
    expect(() => validateShadowStartup(startup({ credentials: { key: 'x' } }))).toThrow(
      'SHADOW_CREDENTIAL_ACCESS_PROHIBITED',
    );
    expect(() => validateShadowStartup(startup({ adapter: 'LIVE' }))).toThrow(
      'SHADOW_PRIVATE_ENDPOINT_PROHIBITED',
    );
    expect(() => validateShadowStartup(startup({ balanceSource: 'ACCOUNT' }))).toThrow(
      'SHADOW_PRIVATE_BALANCE_PROHIBITED',
    );
    expect(() => validateShadowStartup(startup({ orderRoutingEnabled: true }))).toThrow(
      'SHADOW_ORDER_OPERATION_PROHIBITED',
    );
    expect(() => validateShadowStartup(startup({ modelArtifactHash: 'c'.repeat(64) }))).toThrow(
      'PROSPECTIVE_MODEL_HASH_MISMATCH',
    );
    expect(() => validateShadowStartup(startup({ protocolActive: false }))).toThrow(
      'SHADOW_PROTOCOL_NOT_ACTIVE',
    );
    expect(() => validateShadowStartup(startup({ modelTrained: false }))).toThrow(
      'SHADOW_MODEL_NOT_TRAINED',
    );
    expect(() => validateShadowStartup(startup({ modelMode: 'OFFLINE_REFERENCE' }))).toThrow(
      'PROSPECTIVE_MODEL_MODE_INVALID',
    );
    expect(() => validateShadowStartup(startup({ approvedForLive: true }))).toThrow(
      'SHADOW_LIVE_APPROVAL_PROHIBITED',
    );
    expect(() => validateShadowStartup(startup({ activationBoundary: 'OPENED' }))).toThrow(
      'PROSPECTIVE_ACTIVATION_NOT_AUTHORIZED',
    );
  });

  it('creates only simulated intents and handles stale, duplicate, checkpoint, and restart cases', async () => {
    const recorder = new InMemoryProspectiveEvidenceRecorder();
    const harness = new ShadowOnlyHarness(startup(), recorder);
    const event = {
      eventId: 'market-1',
      symbol: 'ADAUSDT',
      eventTimestampUtc: '2026-07-21T12:00:00Z',
      receivedTimestampUtc: '2026-07-21T12:00:01Z',
      referencePrice: 1,
    };
    const result = await harness.evaluate(event, async () => decision('ALLOW'), context(), 1000);
    expect(result.intent).toMatchObject({
      simulated: true,
      source: 'SYNTHETIC_BALANCE',
      side: 'SHORT',
    });
    expect(result.intent).not.toHaveProperty('exchangeOrderId');
    await expect(async () => await harness.evaluate(event, async () => decision(), context(), 1000)).rejects.toThrow(
      'SHADOW_DUPLICATE_EVENT',
    );
    const checkpoint = harness.checkpoint();
    const resumed = new ShadowOnlyHarness(
      startup(),
      new InMemoryProspectiveEvidenceRecorder(),
      checkpoint,
    );
    expect(resumed.checkpoint()).toEqual(checkpoint);
    expect(
      () =>
        new ShadowOnlyHarness(
          startup({ configurationHash: 'c'.repeat(64), expectedConfigurationHash: 'c'.repeat(64) }),
          recorder,
          checkpoint,
        ),
    ).toThrow('SHADOW_CHECKPOINT_CONFLICT');
    const fresh = new ShadowOnlyHarness(startup(), new InMemoryProspectiveEvidenceRecorder());
    await expect(async () =>
      await fresh.evaluate(
        { ...event, eventId: 'stale', receivedTimestampUtc: '2026-07-21T12:01:00Z' },
        async () => decision(),
        context(),
        1000,
      ),
    ).rejects.toThrow('SHADOW_STALE_MARKET_DATA');
  });
});
