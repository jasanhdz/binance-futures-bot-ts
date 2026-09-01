import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StrategyDecisionEvidenceV2 } from '../../core/blackbox/StrategyDecisionBlackBox';
import { JsonlDecisionEvidenceSink } from './JsonlDecisionEvidenceSink';

describe('JsonlDecisionEvidenceSink', () => {
  it('appends one immutable JSON record per line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'decision-blackbox-'));
    try {
      const path = join(dir, 'decisions.jsonl');
      const sink = new JsonlDecisionEvidenceSink(path);
      const record = {
        schemaVersion: 2,
        decisionId: 'd1',
        marketSnapshotId: 's1',
        marketSnapshotStored: true,
        marketSnapshotContentHash: 'snapshot-content-hash-1',
        evidenceLevel: 'COMPACT',
        symbol: 'BTCUSDT',
        evaluatedAtReceivedMs: 1,
        strategyTimestampMs: 1,
        recordedAtMs: 2,
        strategy: {
          strategyId: 'AEGIS_TURBO',
          strategyVersion: '1',
          freezeState: 'DRAFT',
          codeCommitSha: 'sha',
        },
        mode: 'SHADOW',
        decision: 'NO_TRADE',
        reason: 'test',
        diagnostics: {},
        marketHealth: 'COMPLETE',
        provenance: {
          schema: 'STRATEGY_DECISION_BLACKBOX_V2',
          schemaVersion: 2,
          marketSnapshotSchemaVersion: 1,
          causalClock: 'LOCAL_RECEIVE_TIME',
          storagePolicy: 'TIERED_DEDUPLICATED_ROTATING_JSONL_V2',
        },
      } satisfies StrategyDecisionEvidenceV2;

      await sink.append(record);
      await sink.append({ ...record, decisionId: 'd2' });

      const lines = (await readFile(path, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).decisionId).toBe('d1');
      expect(JSON.parse(lines[1]).decisionId).toBe('d2');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects legacy V1 records instead of appending them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'decision-blackbox-v1-rejected-'));
    try {
      const sink = new JsonlDecisionEvidenceSink(join(dir, 'decisions-v2.jsonl'));
      const legacy = {
        schemaVersion: 1,
        evidenceLevel: 'COMPACT',
        provenance: {
          schema: 'UNSUPPORTED_LEGACY_BLACKBOX_SCHEMA',
          schemaVersion: 1,
        },
      } as unknown as StrategyDecisionEvidenceV2;

      await expect(sink.append(legacy)).rejects.toThrow(
        'UNSUPPORTED_STRATEGY_DECISION_BLACKBOX_SCHEMA',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
