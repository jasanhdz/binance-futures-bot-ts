import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { StrategyDecisionEvidenceV2 } from '../../core/blackbox/StrategyDecisionBlackBox';
import { auditCaptureReadiness, classifyReadiness } from './MicroBurstCaptureReadinessAudit';
import { MicroBurstEpisodeCapture } from './MicroBurstEpisodeCapture';

function record(at = 400_000): StrategyDecisionEvidenceV2 {
  return {
    strategy: { strategyId: 'MICRO_BURST' },
    symbol: 'SOLUSDT',
    evaluatedAtReceivedMs: at,
    decisionId: `d-${at}`,
    decision: 'NO_TRADE',
    reason: 'REACTION_NO_QUALIFIED_SIDE',
    diagnostics: {
      sides: { LONG: { reason: 'REACTION_TRIGGER_MISSING' } },
      strategyInputReplay: {
        context: {
          dataQuality: { contextValid: true, invalidReasons: [] },
          aggTradeFlow: { windowComplete: true, gapFree: true, capacityTruncated: false },
        },
      },
    },
  } as unknown as StrategyDecisionEvidenceV2;
}

it('separates elapsed warmup from missing data and healthy-context strategy rejection', () => {
  expect(classifyReadiness(record(200_000), 100_000).phase).toBe('INITIAL_CAPTURE_WARMUP');
  expect(classifyReadiness(record(), 100_000).phase).toBe('POST_WARMUP_CONTEXT_EVALUABLE');
  expect(classifyReadiness({ ...record(), reason: 'BTC_UNAVAILABLE' }, 100_000).phase).toBe(
    'POST_WARMUP_AT_USE_DATA_REJECTED',
  );
  expect(classifyReadiness({ ...record(), diagnostics: {} }, 100_000).phase).toBe(
    'POST_WARMUP_INPUT_MISSING',
  );
});

it('locates malformed bytes without borrowing neighboring timestamps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-readiness-'));
  try {
    const path = join(dir, 'source.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify(record())}\n{"truncated":\n${JSON.stringify(record(401_000))}\n`,
    );
    const result = await auditCaptureReadiness([path], 100_000, 500_000);
    expect(result).toMatchObject({
      totals: { POST_WARMUP_CONTEXT_EVALUABLE: 2 },
      malformed: [
        { line: 2, inferredTimestamp: null, previousValid: { line: 1 }, nextValid: { line: 3 } },
      ],
      sources: [{ eligibility: 'QUARANTINED' }],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('captures original accepted inputs once per episode and marks interrupted lifecycle incomplete', async () => {
  const root = mkdtempSync(join(tmpdir(), 'episode-capture-'));
  try {
    const directory = join(root, 'run');
    const capture = await MicroBurstEpisodeCapture.create(
      directory,
      {
        config: { threshold: 1 },
        producer: {
          reportedCommit: 'a'.repeat(40),
          executionIdentity: 'UNVERIFIED_PRODUCER',
        },
      },
      100_000,
    );
    const accepted = record();
    const decision = {
      ...accepted,
      decision: 'ENTRY_INTENT' as const,
      diagnostics: { ...accepted.diagnostics, episodeId: 'episode-1' },
    };
    await capture.append({ kind: 'DECISION', receivedAtMs: 400_000, decision });
    await capture.append({ kind: 'DECISION', receivedAtMs: 400_001, decision });
    await capture.append({
      kind: 'VARIANT_TERMINAL',
      receivedAtMs: 400_002,
      episodeId: 'episode-1',
      variant: 'PULLBACK',
      outcome: 'REJECTED',
      evidence: { reason: 'PRICE_NOT_RESPONDING' },
    });
    expect(() => capture.append({ kind: 'DECISION', receivedAtMs: 399_000, decision })).toThrow(
      'CLOCK_REGRESSED',
    );
    await capture.close();
    const completion = JSON.parse(readFileSync(join(directory, 'completion.json'), 'utf8'));
    expect(completion).toMatchObject({
      sequence: 3,
      marketCoverage: 'NOT_CERTIFIED',
      episodes: [
        {
          episodeId: 'episode-1',
          decisionIds: ['d-400000'],
          lifecycle: 'INCOMPLETE',
          terminal: { PULLBACK: 'REJECTED' },
        },
      ],
    });
    const manifest = JSON.parse(readFileSync(join(directory, 'producer.json'), 'utf8'));
    expect(manifest.producer.executionIdentity).toBe('UNVERIFIED_PRODUCER');
    expect(manifest.producer.codeSha256).toBeNull();
    expect(() => capture.append({ kind: 'DECISION', receivedAtMs: 400_010, decision })).toThrow(
      'NOT_WRITABLE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
