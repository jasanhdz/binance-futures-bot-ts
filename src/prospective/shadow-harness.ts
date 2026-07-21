import { canonicalJson, canonicalUtc, requireSha256, sha256 } from './canonical';
import {
  EvidenceBuildContext,
  evaluateWithProspectiveEvidence,
  ProspectiveEvidenceRecorder,
} from './evidence';
import { AegisEntryDecisionResult } from '../domain/services/aegis-entry/AegisEntryDecisionTypes';
import { deriveProspectiveSignalId } from './identity';
import {
  PROSPECTIVE_SHADOW_APPROVAL_SCOPE,
  PROSPECTIVE_SHADOW_CANDIDATE_ID,
} from './candidate-model';

export type ShadowMethod = 'GET' | 'WEBSOCKET';

export interface ShadowStartupConfig {
  mode: 'SHADOW' | string;
  protocolActive: boolean;
  activationBoundary: 'NOT_OPENED' | string;
  eventClassification: 'PREACTIVATION_NON_COHORT' | string;
  cohortId?: string;
  modelMode: 'PROSPECTIVE_SHADOW_CANDIDATE' | string;
  modelIdentity: string;
  expectedModelIdentity: string;
  modelApproved: boolean;
  modelTrained: boolean;
  approvalScope: 'PROSPECTIVE_SHADOW_ONLY' | string;
  approvedForLive: boolean;
  modelArtifactHash: string;
  expectedModelArtifactHash: string;
  configurationHash: string;
  expectedConfigurationHash: string;
  balanceSource: 'SYNTHETIC' | string;
  adapter: 'PUBLIC_ONLY' | string;
  orderRoutingEnabled: boolean;
  credentials?: Record<string, string>;
}

export interface ShadowMarketEvent {
  eventId: string;
  symbol: string;
  eventTimestampUtc: string;
  receivedTimestampUtc: string;
  referencePrice: number;
}

export interface HypotheticalOrderIntent {
  simulated: true;
  execution_mode: 'SIMULATED_SHADOW';
  prospectiveSignalId: string;
  symbol: string;
  side: 'SHORT';
  hypotheticalEntry: number;
  hypotheticalQuantity: number;
  hypotheticalFeeFraction: number;
  hypotheticalSlippageFraction: number;
  source: 'SYNTHETIC_BALANCE';
}

export interface ShadowCheckpoint {
  schema_id: 'aegis-shadow-checkpoint-v1';
  configuration_hash: string;
  model_artifact_hash: string;
  processed_event_ids: readonly string[];
  checkpoint_hash: string;
}

export function validateShadowStartup(config: ShadowStartupConfig): void {
  if (config.mode !== 'SHADOW') throw new Error('SHADOW_LIVE_MODE_PROHIBITED');
  if (!config.protocolActive) throw new Error('SHADOW_PROTOCOL_NOT_ACTIVE');
  const preactivation =
    config.activationBoundary === 'NOT_OPENED' &&
    config.eventClassification === 'PREACTIVATION_NON_COHORT';
  const active =
    config.activationBoundary === 'OPENED' &&
    config.eventClassification === config.cohortId &&
    config.cohortId === 'aegis-prospective-shadow-cohort-1';
  if (!preactivation && !active) throw new Error('PROSPECTIVE_ACTIVATION_NOT_AUTHORIZED');
  if (config.modelMode !== 'PROSPECTIVE_SHADOW_CANDIDATE')
    throw new Error('PROSPECTIVE_MODEL_MODE_INVALID');
  if (
    config.modelIdentity !== PROSPECTIVE_SHADOW_CANDIDATE_ID ||
    config.modelIdentity !== config.expectedModelIdentity
  )
    throw new Error('PROSPECTIVE_MODEL_IDENTITY_MISMATCH');
  if (!config.modelTrained) throw new Error('SHADOW_MODEL_NOT_TRAINED');
  if (!config.modelApproved) throw new Error('SHADOW_MODEL_NOT_APPROVED');
  if (config.approvalScope !== PROSPECTIVE_SHADOW_APPROVAL_SCOPE)
    throw new Error('PROSPECTIVE_MODEL_APPROVAL_SCOPE_INVALID');
  if (config.approvedForLive) throw new Error('SHADOW_LIVE_APPROVAL_PROHIBITED');
  if (config.adapter !== 'PUBLIC_ONLY') throw new Error('SHADOW_PRIVATE_ENDPOINT_PROHIBITED');
  if (config.balanceSource !== 'SYNTHETIC') throw new Error('SHADOW_PRIVATE_BALANCE_PROHIBITED');
  if (config.orderRoutingEnabled) throw new Error('SHADOW_ORDER_OPERATION_PROHIBITED');
  if (config.credentials && Object.keys(config.credentials).length) {
    throw new Error('SHADOW_CREDENTIAL_ACCESS_PROHIBITED');
  }
  if (
    requireSha256(config.modelArtifactHash, 'SHADOW_MODEL_HASH_INVALID') !==
    config.expectedModelArtifactHash
  ) {
    throw new Error('PROSPECTIVE_MODEL_HASH_MISMATCH');
  }
  if (
    requireSha256(config.configurationHash, 'SHADOW_CONFIG_HASH_INVALID') !==
    config.expectedConfigurationHash
  ) {
    throw new Error('PROSPECTIVE_CONFIG_HASH_MISMATCH');
  }
}

export function assertPublicEndpoint(method: ShadowMethod, endpoint: string): void {
  const url = new URL(endpoint);
  if (url.username || url.password || url.searchParams.has('signature')) {
    throw new Error('SHADOW_CREDENTIAL_ACCESS_PROHIBITED');
  }
  const publicRest =
    method === 'GET' &&
    url.protocol === 'https:' &&
    url.hostname === 'fapi.binance.com' &&
    url.pathname === '/fapi/v1/klines';
  const publicStream =
    method === 'WEBSOCKET' &&
    url.protocol === 'wss:' &&
    url.hostname === 'fstream.binance.com' &&
    url.pathname.startsWith('/ws/');
  if (!publicRest && !publicStream) {
    if (/(account|balance|listenKey|order|position|leverage|marginType)/i.test(url.pathname)) {
      throw new Error('SHADOW_PRIVATE_ENDPOINT_PROHIBITED');
    }
    throw new Error('SHADOW_UNAUTHORIZED_ENDPOINT');
  }
}

export class ShadowOnlyHarness {
  private readonly processed = new Set<string>();

  constructor(
    private readonly config: ShadowStartupConfig,
    private readonly recorder: ProspectiveEvidenceRecorder,
    checkpoint?: ShadowCheckpoint,
  ) {
    validateShadowStartup(config);
    if (checkpoint) {
      const { checkpoint_hash: checkpointHash, ...payload } = checkpoint;
      if (
        checkpointHash !== sha256(canonicalJson(payload)) ||
        checkpoint.configuration_hash !== config.configurationHash ||
        checkpoint.model_artifact_hash !== config.modelArtifactHash
      ) {
        throw new Error('SHADOW_CHECKPOINT_CONFLICT');
      }
      checkpoint.processed_event_ids.forEach((value) => this.processed.add(value));
    }
  }

  evaluate(
    event: ShadowMarketEvent,
    evaluate: () => AegisEntryDecisionResult,
    evidence: EvidenceBuildContext,
    syntheticBalanceUsd: number,
  ): { decision: AegisEntryDecisionResult; intent?: HypotheticalOrderIntent } {
    if (this.processed.has(event.eventId)) throw new Error('SHADOW_DUPLICATE_EVENT');
    const eventTime = Date.parse(canonicalUtc(event.eventTimestampUtc));
    const received = Date.parse(canonicalUtc(event.receivedTimestampUtc));
    if (received < eventTime || received - eventTime > 30_000)
      throw new Error('SHADOW_STALE_MARKET_DATA');
    if (!(event.referencePrice > 0) || !(syntheticBalanceUsd > 0))
      throw new Error('SHADOW_MARKET_EVENT_INVALID');
    if (
      evidence.modelIdentity !== this.config.modelIdentity ||
      evidence.modelArtifactHash !== this.config.modelArtifactHash
    )
      throw new Error('PROSPECTIVE_MODEL_EVIDENCE_MISMATCH');
    if (evidence.cohortId !== this.config.eventClassification)
      throw new Error('PROSPECTIVE_COHORT_MISMATCH');
    const decision = evaluateWithProspectiveEvidence(evaluate, evidence, this.recorder);
    this.processed.add(event.eventId);
    if (decision.finalDecision !== 'ALLOW') return { decision };
    return {
      decision,
      intent: {
        simulated: true,
        execution_mode: 'SIMULATED_SHADOW',
        prospectiveSignalId: requireSha256(
          deriveProspectiveSignalId(evidence),
          'PROSPECTIVE_SIGNAL_ID_INVALID',
        ),
        symbol: event.symbol,
        side: 'SHORT',
        hypotheticalEntry: event.referencePrice * 0.9999,
        hypotheticalQuantity:
          (syntheticBalanceUsd * decision.adjustedPositionFraction) / event.referencePrice,
        hypotheticalFeeFraction: 0.0004,
        hypotheticalSlippageFraction: 0.0001,
        source: 'SYNTHETIC_BALANCE',
      },
    };
  }

  checkpoint(): ShadowCheckpoint {
    const payload: Omit<ShadowCheckpoint, 'checkpoint_hash'> = {
      schema_id: 'aegis-shadow-checkpoint-v1' as const,
      configuration_hash: this.config.configurationHash,
      model_artifact_hash: this.config.modelArtifactHash,
      processed_event_ids: [...this.processed].sort(),
    };
    return { ...payload, checkpoint_hash: sha256(canonicalJson(payload)) };
  }
}
