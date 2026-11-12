export interface CaptureCounterReconciliation {
  schema: 'MICRO_CAPTURE_COUNTER_RECONCILIATION_V1';
  evaluation: { attempted: number; completed: number; failed: number; inFlight: number };
  exactInput: {
    attempts: number;
    copied: number;
    copyFailures: number;
    envelopesEmitted: number;
    copiedWithoutEnvelope: number;
  };
  observationQueue: {
    accepted: number;
    dropped: number;
    written: number;
    failed: number;
    pending: number;
    drainTimedOut: boolean;
  };
  decisionWriter: {
    recordsWritten: number;
    pending: number;
    writeFailures: number;
    overloadRejected: number;
  };
  equalities: {
    evaluations: boolean;
    exactInputCopies: boolean;
    emittedQueueAdmissions: boolean;
    queuePersistence: boolean;
    writerMatchesQueue: boolean;
  };
  blockers: string[];
}

const count = (value: unknown): number =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : -1;

/** Reconciles only persisted, monotonic counters; missing values fail closed. */
export function reconcileMicroBurstCaptureCounters(
  health: Record<string, any>,
): CaptureCounterReconciliation {
  const runtime = health.runtime ?? {};
  const input = runtime.observationQueue ?? {};
  const queue = runtime.observationQueue ?? {};
  const writer = health.decisionWriter ?? {};
  const result: CaptureCounterReconciliation = {
    schema: 'MICRO_CAPTURE_COUNTER_RECONCILIATION_V1',
    evaluation: {
      attempted: count(runtime.totalEvaluationAttempts),
      completed: count(runtime.totalEvaluations),
      failed: count(runtime.totalEvaluationFailures),
      inFlight: count(runtime.evaluationInFlight),
    },
    exactInput: {
      attempts: count(input.captureAttempts),
      copied: count(input.captureSucceeded),
      copyFailures: count(input.captureFailures),
      envelopesEmitted: count(input.exactDecisionEmissions),
      copiedWithoutEnvelope: -1,
    },
    observationQueue: {
      accepted: count(queue.accepted),
      dropped: count(queue.dropped),
      written: count(queue.written),
      failed: count(queue.failed),
      pending: count(queue.pendingRecords),
      drainTimedOut: queue.drainTimedOut === true,
    },
    decisionWriter: {
      recordsWritten: count(writer.recordsWritten),
      pending: count(writer.pendingWrites),
      writeFailures: count(writer.writeFailures),
      overloadRejected: count(writer.overloadRejected),
    },
    equalities: {
      evaluations: false,
      exactInputCopies: false,
      emittedQueueAdmissions: false,
      queuePersistence: false,
      writerMatchesQueue: false,
    },
    blockers: [],
  };
  result.exactInput.copiedWithoutEnvelope =
    result.exactInput.copied < 0 || result.exactInput.envelopesEmitted < 0
      ? -1
      : result.exactInput.copied - result.exactInput.envelopesEmitted;
  result.equalities.evaluations =
    result.evaluation.attempted >= 0 &&
    result.evaluation.completed >= 0 &&
    result.evaluation.failed >= 0 &&
    result.evaluation.inFlight >= 0 &&
    result.evaluation.attempted ===
      result.evaluation.completed + result.evaluation.failed + result.evaluation.inFlight;
  result.equalities.exactInputCopies =
    result.exactInput.attempts >= 0 &&
    result.exactInput.copied >= 0 &&
    result.exactInput.copyFailures >= 0 &&
    result.exactInput.attempts === result.exactInput.copied + result.exactInput.copyFailures;
  result.equalities.emittedQueueAdmissions =
    result.exactInput.envelopesEmitted >= 0 &&
    result.observationQueue.accepted >= 0 &&
    result.observationQueue.dropped >= 0 &&
    !result.observationQueue.drainTimedOut &&
    result.exactInput.envelopesEmitted ===
      result.observationQueue.accepted + result.observationQueue.dropped;
  result.equalities.queuePersistence =
    result.observationQueue.accepted >= 0 &&
    result.observationQueue.written >= 0 &&
    result.observationQueue.failed >= 0 &&
    result.observationQueue.pending >= 0 &&
    result.observationQueue.accepted ===
      result.observationQueue.written +
        result.observationQueue.failed +
        result.observationQueue.pending;
  result.equalities.writerMatchesQueue =
    result.decisionWriter.recordsWritten >= 0 &&
    result.observationQueue.written >= 0 &&
    result.decisionWriter.recordsWritten === result.observationQueue.written;

  if (!result.equalities.evaluations) result.blockers.push('EVALUATION_COUNTERS_UNRECONCILED');
  if (result.evaluation.inFlight !== 0) result.blockers.push('EVALUATION_STILL_IN_FLIGHT');
  if (result.evaluation.failed !== 0) result.blockers.push('EVALUATION_FAILURES_NONZERO');
  if (!result.equalities.exactInputCopies)
    result.blockers.push('EXACT_INPUT_CAPTURE_COUNTERS_UNRECONCILED');
  if (result.exactInput.attempts !== result.evaluation.completed)
    result.blockers.push('COMPLETED_EVALUATION_WITHOUT_EXACT_INPUT_CAPTURE');
  if (result.exactInput.copyFailures !== 0) result.blockers.push('EXACT_INPUT_CAPTURE_FAILURES');
  if (result.exactInput.copiedWithoutEnvelope !== 0)
    result.blockers.push('CAPTURED_INPUT_WITHOUT_EMITTED_DECISION');
  if (!result.equalities.emittedQueueAdmissions)
    result.blockers.push('DECISION_QUEUE_ADMISSIONS_UNRECONCILED');
  if (!result.equalities.queuePersistence)
    result.blockers.push('DECISION_QUEUE_PERSISTENCE_UNRECONCILED');
  if (!result.equalities.writerMatchesQueue) result.blockers.push('DECISION_WRITER_QUEUE_MISMATCH');
  if (result.observationQueue.drainTimedOut) result.blockers.push('DECISION_QUEUE_DRAIN_TIMED_OUT');
  if (result.observationQueue.pending !== 0) result.blockers.push('DECISION_QUEUE_PENDING');
  if (result.observationQueue.dropped !== 0) result.blockers.push('DECISION_QUEUE_DROPPED');
  if (result.observationQueue.failed !== 0) result.blockers.push('DECISION_QUEUE_FAILED');
  if (result.decisionWriter.pending !== 0) result.blockers.push('DECISION_WRITER_PENDING');
  if (result.decisionWriter.writeFailures !== 0) result.blockers.push('DECISION_WRITER_FAILED');
  if (result.decisionWriter.overloadRejected !== 0)
    result.blockers.push('DECISION_WRITER_OVERLOADED');
  result.blockers.sort();
  return result;
}
