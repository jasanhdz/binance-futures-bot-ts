import { Side } from '../../../core/types';
import { BookDataStatus, BtcDataStatus } from '../domain/MicroBurstTypes';

export interface MicroBurstShadowEvaluationResult {
  strategyId: string;
  strategyVersion: string;
  symbol: string;
  snapshotAtMs: number;
  decision: 'NO_TRADE' | 'ENTRY_INTENT';
  side?: Side;
  confidence: number;
  referencePrice: number;
  supportPrice: number | null;
  resistancePrice: number | null;
  structuralInvalidation: number | null;
  destinationPrice: number | null;
  roomToTargetBps: number | null;
  riskToInvalidationBps: number | null;
  rewardRisk: number | null;
  momentum: {
    direction: Side | 'NEUTRAL';
    strength: number;
    continuationScore: number;
  };
  book: {
    status: BookDataStatus;
    ageMs: number | null;
    imbalance: number;
    imbalanceSlope: number | null;
  };
  btc: {
    status: BtcDataStatus;
    ageMs: number | null;
    ret1m: number | null;
    ret3m: number | null;
    ret5m: number | null;
    conflict: boolean;
  };
  microRegime: string;
  dataQuality: {
    contextValid: boolean;
    invalidReasons: string[];
  };
  wouldEnter: boolean;
  liveExecution: false;
  shadowSignalId: string;
  duplicateSuppressed: boolean;
  firstObservedAt: number;
  lastObservedAt: number;
  diagnostics: Record<string, unknown>;
}

export interface MicroBurstShadowTelemetryLog {
  strategyId: string;
  strategyVersion: string;
  symbol: string;
  snapshotAtMs: number;
  decision: 'NO_TRADE' | 'ENTRY_INTENT';
  side?: Side;
  confidence: number;
  referencePrice: number;
  support: number | null;
  resistance: number | null;
  structuralInvalidation: number | null;
  target: number | null;
  roomToTargetBps: number | null;
  riskToInvalidationBps: number | null;
  rewardRisk: number | null;
  momentum: {
    direction: Side | 'NEUTRAL';
    strength: number;
    continuationScore: number;
  };
  bookStatus: BookDataStatus;
  bookAgeMs: number | null;
  bookImbalance: number;
  imbalanceSlope: number | null;
  btcStatus: BtcDataStatus;
  btcAgeMs: number | null;
  btcRet1m: number | null;
  btcRet3m: number | null;
  btcRet5m: number | null;
  btcConflict: boolean;
  microRegime: string;
  dataQualityContextValid: boolean;
  invalidReasons: string[];
  wouldEnter: boolean;
  liveExecution: false;
  shadowSignalId: string;
  duplicateSuppressed: boolean;
  firstObservedAt: number;
  lastObservedAt: number;
}
