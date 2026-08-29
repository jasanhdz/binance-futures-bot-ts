import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StrategyDecisionEvidenceV1 } from '../../core/blackbox/StrategyDecisionBlackBox';
import { JsonlDecisionEvidenceSink } from './JsonlDecisionEvidenceSink';

describe('JsonlDecisionEvidenceSink', () => {
  it('appends one immutable JSON record per line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'decision-blackbox-'));
    try {
      const path = join(dir, 'decisions.jsonl');
      const sink = new JsonlDecisionEvidenceSink(path);
      const record = {
        schemaVersion: 1,
        decisionId: 'd1',
        marketSnapshotId: 's1',
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
          schema: 'STRATEGY_DECISION_BLACKBOX_V1',
          schemaVersion: 1,
          marketSnapshotSchemaVersion: 1,
          causalClock: 'LOCAL_RECEIVE_TIME',
        },
      } satisfies StrategyDecisionEvidenceV1;

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
});
