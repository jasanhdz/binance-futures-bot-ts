import { describe, expect, it } from 'vitest';
import type { MarketSnapshotV1 } from '../market-data/MarketSnapshotProvider';
import type { StrategyDecisionEnvelope } from '../strategy/StrategyDecision';
import {
  createDecisionEvidenceV1,
  type DecisionEvidenceSink,
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
  it('links a strategy decision to the causal shared market snapshot', () => {
    const record = createDecisionEvidenceV1(snapshot(), decision(), 1_010);
    expect(record.marketSnapshotId).toBe('snapshot-1');
    expect(record.strategy.strategyId).toBe('MICRO_BURST_V1');
    expect(record.decision).toBe('ENTRY_INTENT');
    expect(record.provenance.schema).toBe('STRATEGY_DECISION_BLACKBOX_V1');
  });

  it('rejects a snapshot captured after the decision boundary', () => {
    expect(() => createDecisionEvidenceV1(snapshot({ capturedAtMs: 1_001 }), decision())).toThrow(
      /causal violation/,
    );
  });

  it('rejects cross-symbol links', () => {
    expect(() => createDecisionEvidenceV1(snapshot({ symbol: 'ETHUSDT' }), decision())).toThrow(
      /symbol mismatch/,
    );
  });

  it('keeps collection failure observational and exposes health', async () => {
    const sink: DecisionEvidenceSink = {
      append: async () => {
        throw new Error('disk unavailable');
      },
    };
    const blackBox = new StrategyDecisionBlackBox(sink, () => 1_010);

    await expect(blackBox.observe(snapshot(), decision())).resolves.toBeUndefined();
    expect(blackBox.health()).toEqual({ attempted: 1, written: 0, failed: 1 });
  });

  it('produces a stable decision id for the same causal identity', () => {
    const a = createDecisionEvidenceV1(snapshot(), decision(), 1_010);
    const b = createDecisionEvidenceV1(snapshot(), decision(), 9_999);
    expect(a.decisionId).toBe(b.decisionId);
  });
});
