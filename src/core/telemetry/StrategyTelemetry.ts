import { createHash } from 'node:crypto';
import type { Side } from '../types';
import type { StrategyIdentity, StrategyId } from '../strategy/StrategyIdentity';

export const STRATEGY_TELEMETRY_V1 = 'STRATEGY_TELEMETRY_V1' as const;

export type StrategyTelemetryEventType =
  | 'DECISION'
  | 'GUARD_RESULT'
  | 'EXECUTION_INTENT'
  | 'EXECUTION_RESULT'
  | 'POSITION_EVENT'
  | 'EXIT'
  | 'OUTCOME';

export interface StrategyTelemetryEventInput {
  eventType: StrategyTelemetryEventType;
  strategyId: StrategyId;
  identity?: StrategyIdentity;
  symbol: string;
  occurredAtMs: number;
  decisionId?: string;
  marketSnapshotId?: string;
  signalId?: string;
  tradeId?: string;
  side?: Side;
  status?: string;
  reason?: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface StrategyTelemetryEventV1 extends StrategyTelemetryEventInput {
  schemaVersion: 1;
  eventId: string;
  recordedAtMs: number;
  details: Readonly<Record<string, unknown>>;
  provenance: {
    schema: typeof STRATEGY_TELEMETRY_V1;
    schemaVersion: 1;
  };
}

export function createStrategyTelemetryEvent(
  input: StrategyTelemetryEventInput,
  recordedAtMs = Date.now(),
): StrategyTelemetryEventV1 {
  const normalized = {
    ...input,
    symbol: input.symbol.toUpperCase(),
    details: { ...(input.details ?? {}) },
  };
  const eventId = createHash('sha256')
    .update(
      JSON.stringify({
        eventType: normalized.eventType,
        strategyId: normalized.strategyId,
        symbol: normalized.symbol,
        occurredAtMs: normalized.occurredAtMs,
        decisionId: normalized.decisionId ?? null,
        tradeId: normalized.tradeId ?? null,
        signalId: normalized.signalId ?? null,
        status: normalized.status ?? null,
        reason: normalized.reason ?? null,
        recordedAtMs,
      }),
    )
    .digest('hex');
  return Object.freeze({
    ...normalized,
    schemaVersion: 1 as const,
    eventId,
    recordedAtMs,
    provenance: Object.freeze({
      schema: STRATEGY_TELEMETRY_V1,
      schemaVersion: 1 as const,
    }),
  });
}
