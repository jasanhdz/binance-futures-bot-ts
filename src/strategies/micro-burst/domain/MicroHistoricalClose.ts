import type { StrategyIdentity } from '../../../core/strategy/StrategyIdentity';
import {
  reconcileMicroBurstEconomics,
  validMicroBurstEconomicIdentity,
  type MicroBurstEconomicIdentity,
  type MicroBurstSettlementEvidence,
} from './MicroBurstSettlement';

/** Original journal provenance, not an approval to execute this historical policy. */
export interface MicroHistoricalIdentity extends MicroBurstEconomicIdentity {
  provenance: {
    source: 'DURABLE_ENTRY_JOURNAL';
    operationId: string;
    clientOrderId: string;
    identity: Omit<StrategyIdentity, 'strategyId'> & { strategyId: string };
    entryPrice: number;
  };
}

export interface MicroFlatObservation {
  source: 'BINANCE_FRESH_FLAT_AND_ALL_OPEN_ORDERS';
  symbol: string;
  startedAtMs: number;
  observedAtMs: number;
  regularOpenOrders: 0;
  algoOpenOrders: 0;
}

export interface MicroHistoricalCloseProof {
  protocol: 'MICRO_EXTERNALLY_CONFIRMED_CLOSE';
  identity: MicroHistoricalIdentity;
  evidence: MicroBurstSettlementEvidence;
  flat: [MicroFlatObservation, MicroFlatObservation];
}

export function validMicroHistoricalIdentity(identity: MicroHistoricalIdentity): boolean {
  const p = identity?.provenance;
  return (
    validMicroBurstEconomicIdentity(identity) &&
    !!p &&
    p.source === 'DURABLE_ENTRY_JOURNAL' &&
    /^entry_[a-f0-9]{64}$/.test(p.operationId) &&
    /^se_[a-f0-9]{33}$/.test(p.clientOrderId) &&
    p.identity?.strategyId === 'MICRO_BURST_V1' &&
    p.identity.strategyVersion === '0.8.0-expected-continuation-live' &&
    p.identity.freezeState === 'FROZEN_LIVE' &&
    /^sha256:[a-f0-9]{64}$/.test(p.identity.strategyHash ?? '') &&
    /^sha256:[a-f0-9]{64}$/.test(p.identity.configHash ?? '') &&
    /^[a-f0-9]{40}$/.test(p.identity.codeCommitSha) &&
    Number.isFinite(p.entryPrice) &&
    p.entryPrice > 0
  );
}

export function validMicroHistoricalClose(proof: MicroHistoricalCloseProof): boolean {
  if (
    !proof ||
    proof.protocol !== 'MICRO_EXTERNALLY_CONFIRMED_CLOSE' ||
    !validMicroHistoricalIdentity(proof.identity) ||
    reconcileMicroBurstEconomics(proof.identity, proof.evidence).status !== 'VERIFIED' ||
    !Array.isArray(proof.flat) ||
    proof.flat.length !== 2
  )
    return false;
  const entryFills = proof.evidence.fills.filter((f) => f.orderId === proof.identity.entryOrderId);
  const average =
    entryFills.reduce((sum, f) => sum + f.price * f.quantity, 0) / proof.identity.quantity;
  if (
    Math.abs(average - proof.identity.provenance.entryPrice) >
    Number.EPSILON * Math.max(average, proof.identity.provenance.entryPrice) * entryFills.length * 8
  )
    return false;
  return proof.flat.every(
    (o, i) =>
      o?.source === 'BINANCE_FRESH_FLAT_AND_ALL_OPEN_ORDERS' &&
      o.symbol === proof.identity.symbol &&
      o.regularOpenOrders === 0 &&
      o.algoOpenOrders === 0 &&
      Number.isSafeInteger(o.startedAtMs) &&
      Number.isSafeInteger(o.observedAtMs) &&
      o.startedAtMs >= proof.evidence.observedAtMs &&
      o.observedAtMs >= o.startedAtMs &&
      o.observedAtMs - o.startedAtMs <= 10_000 &&
      (i === 0 || o.startedAtMs >= proof.flat[i - 1].observedAtMs + 300),
  );
}
