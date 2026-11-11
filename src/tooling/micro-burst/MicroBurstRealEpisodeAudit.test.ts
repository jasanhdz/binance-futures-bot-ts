import { expect, it } from 'vitest';
import { compareOriginalDecision } from './MicroBurstRealEpisodeAudit';
import { makeMicroBurstContext } from '../../strategies/micro-burst/domain/MicroBurst.test-support';
import { defaultMicroBurstConfig } from '../../strategies/micro-burst/domain/MicroBurstTypes';
import { captureMicroBurstReplay } from '../../strategies/micro-burst/domain/MicroBurstExactReplay';
import type { StrategyDecisionEvidenceV2 } from '../../core/blackbox/StrategyDecisionBlackBox';

it('compares original inputs without treating the historical commit tag as code proof', () => {
  const context = makeMicroBurstContext();
  context.dataQuality.contextValid = false;
  const replay = captureMicroBurstReplay(
    { ...context, observedAtMs: context.timestamp, exchangeObservedAtMs: context.timestamp },
    defaultMicroBurstConfig(),
    'a'.repeat(40),
  );
  const record = {
    decisionId: 'original',
    symbol: context.symbol,
    evaluatedAtReceivedMs: context.timestamp,
    decision: 'NO_TRADE',
    reason: 'REACTION_CONTEXT_INVALID',
    confidence: context.momentum.strength,
    strategy: { configHash: 'historical-runtime-config' },
    diagnostics: { strategyInputReplay: replay },
  } as unknown as StrategyDecisionEvidenceV2;
  expect(compareOriginalDecision(record)).toMatchObject({
    status: 'MATCH_WITH_CURRENT_EVALUATOR',
    differences: [],
    historicalCodeIdentity: 'NOT_CERTIFIED_BY_COMMIT_TAG_ALONE',
    rawWarmupCoverage: 'NOT_CERTIFIED',
  });
  expect(
    compareOriginalDecision({ ...record, reason: 'WRONG', structuralInvalidation: 10 }),
  ).toMatchObject({ status: 'MISMATCH', differences: ['reason', 'stop'] });
  expect(compareOriginalDecision({ ...record, diagnostics: {} }).status).toBe(
    'MISSING_ORIGINAL_INPUT',
  );
});
