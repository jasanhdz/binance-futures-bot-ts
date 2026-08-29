import { describe, expect, it } from 'vitest';
import type { MarketSnapshotV1 } from '../market-data/MarketSnapshotProvider';
import type { StrategyDecisionEnvelope } from '../strategy/StrategyDecision';
import {
  createDecisionEvidenceV1,
  type DecisionEvidenceSink,
  type MarketSnapshotEvidenceSink,
  StrategyDecisionBlackBox,
} from './StrategyDecisionBlackBox';

function snapshot(overrides: Partial<MarketSnapshotV1> = {}): MarketSnapshotV1 {
  return {
    schemaVersion: 1,
    snapshotId: 'snapshot-1',
    symbol: 'BTCUSDT',
    captureStartedAtMs: 900,
    capturedAtMs: 950,
    primary: {} as MarketSnapshotV1['primary'],
    health: 'COMPLETE',
    provenance: {} as MarketSnapshotV1['provenance'],
    ...overrides,
  };
}

function decision(overrides: Partial<StrategyDecisionEnvelope> = {}): StrategyDecisionEnvelope {
  return {
    identity: {
      strategyId: 'MICRO_BURST_V1',
      strategyVersion: '1.0.0',
      freezeState: 'DRAFT',
      codeCommitSha: 'abc123',
    },
    mode: 'SHADOW',
    symbol: 'BTCUSDT',
    timestamp: 1_000,
    decision: 'ENTRY_INTENT',
    side: 'LONG',
    reason: 'test',
    diagnostics: { score: 0.8 },
    ...overrides,
  };
}

describe('StrategyDecisionBlackBox', () => {
  it('links a strategy decision to the causal shared market snapshot without mixing clock domains', () => {
    const record = createDecisionEvidenceV1(snapshot(), decision({ timestamp: 100 }), 1_010, 950);
    expect(record.marketSnapshotId).toBe('snapshot-1');
    expect(record.strategy.strategyId).toBe('MICRO_BURST_V1');
    expect(record.decision).toBe('ENTRY_INTENT');
    expect(record.evaluatedAtReceivedMs).toBe(950);
    expect(record.strategyTimestampMs).toBe(100);
    expect(record.provenance.causalClock).toBe('LOCAL_RECEIVE_TIME');
  });

  it('rejects a snapshot captured after the local receive-time evaluation boundary', () => {
    expect(() => createDecisionEvidenceV1(snapshot({ capturedAtMs: 1_001 }), decision(), 1_010, 1_000)).toThrow(
      /causal violation/,
    );
  });

  it('rejects cross-symbol links', () => {
    expect(() => createDecisionEvidenceV1(snapshot({ symbol: 'ETHUSDT' }), decision())).toThrow(
      /symbol mismatch/,
    );
  });

  it('persists the market snapshot before the linked decision', async () => {
    const writes: string[] = [];
    const snapshotSink: MarketSnapshotEvidenceSink = {
      append: async (value) => {
        writes.push(`snapshot:${value.snapshotId}`);
      },
    };
    const decisionSink: DecisionEvidenceSink = {
      append: async (value) => {
        writes.push(`decision:${value.marketSnapshotId}`);
      },
    };
    const blackBox = new StrategyDecisionBlackBox(decisionSink, () => 1_010, snapshotSink);

    await blackBox.observe(snapshot(), decision());

    expect(writes).toEqual(['snapshot:snapshot-1', 'decision:snapshot-1']);
    expect(blackBox.health()).toEqual({
      attempted: 1,
      written: 1,
      failed: 0,
      snapshotsAttempted: 1,
      snapshotsWritten: 1,
      snapshotsFailed: 0,
    });
  });

  it('does not emit an orphan decision when snapshot persistence fails', async () => {
    let decisionWrites = 0;
    const snapshotSink: MarketSnapshotEvidenceSink = {
      append: async () => {
        throw new Error('snapshot disk unavailable');
      },
    };
    const decisionSink: DecisionEvidenceSink = {
      append: async () => {
        decisionWrites += 1;
      },
    };
    const blackBox = new StrategyDecisionBlackBox(decisionSink, () => 1_010, snapshotSink);

    await expect(blackBox.observe(snapshot(), decision())).resolves.toBeUndefined();
    expect(decisionWrites).toBe(0);
    expect(blackBox.health()).toMatchObject({ failed: 1, snapshotsFailed: 1 });
  });

  it('keeps collection failure observational and exposes health', async () => {
    const sink: DecisionEvidenceSink = {
      append: async () => {
        throw new Error('disk unavailable');
      },
    };
    const blackBox = new StrategyDecisionBlackBox(sink, () => 1_010);

    await expect(blackBox.observe(snapshot(), decision())).resolves.toBeUndefined();
    expect(blackBox.health()).toEqual({
      attempted: 1,
      written: 0,
      failed: 1,
      snapshotsAttempted: 0,
      snapshotsWritten: 0,
      snapshotsFailed: 0,
    });
  });

  it('produces a stable decision id for the same causal identity', () => {
    const a = createDecisionEvidenceV1(snapshot(), decision(), 1_010, 950);
    const b = createDecisionEvidenceV1(snapshot(), decision(), 9_999, 950);
    expect(a.decisionId).toBe(b.decisionId);
  });
});
