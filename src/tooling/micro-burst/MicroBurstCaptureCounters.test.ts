import { expect, it } from 'vitest';
import { reconcileMicroBurstCaptureCounters } from './MicroBurstCaptureCounters';

function sampleHealth(): Record<string, any> {
  return {
    runtime: {
      totalEvaluationAttempts: 10,
      totalEvaluations: 10,
      totalEvaluationFailures: 0,
      evaluationInFlight: 0,
      observationQueue: {
        captureAttempts: 10,
        captureSucceeded: 10,
        captureFailures: 0,
        exactDecisionEmissions: 10,
        accepted: 10,
        written: 10,
        dropped: 0,
        failed: 0,
        pendingRecords: 0,
        drainTimedOut: false,
      },
    },
    decisionWriter: { recordsWritten: 10, pendingWrites: 0, writeFailures: 0, overloadRejected: 0 },
  };
}

it('reconciles completed evaluations through queue admission to persisted decision rows', () => {
  const counters = reconcileMicroBurstCaptureCounters(sampleHealth());
  expect(counters.blockers).toEqual([]);
  expect(counters.equalities).toEqual({
    evaluations: true,
    exactInputCopies: true,
    emittedQueueAdmissions: true,
    queuePersistence: true,
    writerMatchesQueue: true,
  });
  expect(counters.decisionWriter.recordsWritten).toBe(10);
});

it('accounts evaluator failures and flags them as an incomplete observation session', () => {
  const health = sampleHealth();
  health.runtime.totalEvaluationAttempts = 10;
  health.runtime.totalEvaluations = 8;
  health.runtime.totalEvaluationFailures = 2;
  health.runtime.observationQueue.captureAttempts = 8;
  health.runtime.observationQueue.captureSucceeded = 8;
  health.runtime.observationQueue.exactDecisionEmissions = 8;
  health.runtime.observationQueue.accepted = 8;
  health.runtime.observationQueue.written = 8;
  health.decisionWriter.recordsWritten = 8;
  const counters = reconcileMicroBurstCaptureCounters(health);
  expect(counters.equalities.evaluations).toBe(true);
  expect(counters.blockers).toContain('EVALUATION_FAILURES_NONZERO');
});

it('distinguishes a queue drop from persisted and pending records', () => {
  const health = sampleHealth();
  health.runtime.observationQueue.exactDecisionEmissions = 10;
  health.runtime.observationQueue.accepted = 9;
  health.runtime.observationQueue.dropped = 1;
  health.runtime.observationQueue.written = 9;
  health.runtime.observationQueue.dropped = 1;
  health.decisionWriter.recordsWritten = 9;
  const counters = reconcileMicroBurstCaptureCounters(health);
  expect(counters.equalities.emittedQueueAdmissions).toBe(true);
  expect(counters.equalities.queuePersistence).toBe(true);
  expect(counters.blockers).toContain('DECISION_QUEUE_DROPPED');
});
