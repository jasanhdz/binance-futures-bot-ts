import { describe, expect, it, vi } from 'vitest';
import { StrategyTelemetryBus } from './StrategyTelemetryBus';
import { DecisionEvidenceTelemetrySink } from './DecisionEvidenceTelemetrySink';
import { TelemetryStrategyExecutionPort } from './TelemetryStrategyExecutionPort';

const identity = {
  strategyId: 'MOMENTUM_RIDE' as const,
  strategyVersion: 'test',
  strategyHash: 'hash',
  configHash: 'config',
  codeCommitSha: 'sha',
};

describe('StrategyTelemetryBus', () => {
  it('mirrors black-box decisions without replacing the primary evidence sink', async () => {
    const events: any[] = [];
    const telemetry = new StrategyTelemetryBus([{ append: async (event) => void events.push(event) }], () => 2000);
    const primary = { append: vi.fn(async () => undefined) };
    const sink = new DecisionEvidenceTelemetrySink(primary, telemetry);
    const evidence: any = {
      schemaVersion: 1,
      decisionId: 'decision-1',
      marketSnapshotId: 'snapshot-1',
      symbol: 'BTCUSDT',
      evaluatedAtReceivedMs: 1500,
      strategyTimestampMs: 1400,
      recordedAtMs: 1600,
      strategy: identity,
      mode: 'LIVE',
      decision: 'ENTRY_INTENT',
      side: 'LONG',
      reason: 'momentum',
      confidence: 0.8,
      diagnostics: { score: 4 },
      marketHealth: { status: 'FRESH' },
      provenance: {},
    };

    await sink.append(evidence);
    expect(primary.append).toHaveBeenCalledWith(evidence);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'DECISION',
      strategyId: 'MOMENTUM_RIDE',
      decisionId: 'decision-1',
      marketSnapshotId: 'snapshot-1',
      status: 'ENTRY_INTENT',
    });
  });

  it('traces execution intent and result with the same trade id', async () => {
    const events: any[] = [];
    const telemetry = new StrategyTelemetryBus([{ append: async (event) => void events.push(event) }], () => 3000);
    const inner = {
      execute: vi.fn(async (intent: any) => ({
        status: 'OPENED' as const,
        identity: intent.identity,
        tradeId: intent.tradeId,
        symbol: intent.symbol,
        side: intent.side,
        orderId: 'order-1',
        entryPrice: 100,
        quantity: 1,
        leverage: 2,
        positionFraction: 0.1,
        openedAt: 2500,
        metadata: {},
      })),
    };
    const port = new TelemetryStrategyExecutionPort(inner, telemetry, () => 3000);
    await port.execute({
      identity,
      signalId: 'signal-1',
      tradeId: 'trade-1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      requestedAt: 2200,
      leverage: 2,
      positionFraction: 0.1,
      stopRoe: -0.4,
      takeProfitRoe: 1,
      protection: { requireStop: true, requireTakeProfit: true, closeIfProtectionFails: true },
      metadata: {},
    });

    expect(events.map((event) => event.eventType)).toEqual(['EXECUTION_INTENT', 'EXECUTION_RESULT']);
    expect(events.every((event) => event.tradeId === 'trade-1')).toBe(true);
  });

  it('fails open when telemetry persistence fails', async () => {
    const telemetry = new StrategyTelemetryBus([{ append: async () => { throw new Error('disk'); } }]);
    await expect(telemetry.publish({
      eventType: 'OUTCOME',
      strategyId: 'AEGIS_TURBO',
      symbol: 'ETHUSDT',
      occurredAtMs: 1,
      status: 'LOSS',
    })).resolves.toBeUndefined();
    expect(telemetry.health()).toEqual({ attempted: 1, written: 0, failed: 1 });
  });
});
