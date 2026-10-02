import { readFileSync } from 'node:fs';
import type { ProspectiveOutcomeRecord } from '../../strategies/micro-burst/research/MicroBurstOutcomeTypes';

export interface ActualFillWindow {
  shadowSignalId: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  entryAtMs: number;
  exitAtMs: number;
}

/** Describes recorded extrema only. Never reconstructs a path from horizon summaries. */
export function auditObservedExcursions(
  outcome: ProspectiveOutcomeRecord,
  actual: ActualFillWindow,
) {
  if (outcome.shadowSignalId !== actual.shadowSignalId || outcome.side !== actual.side)
    throw new Error('SIGNAL_IDENTITY_MISMATCH');
  if (
    ![actual.entryPrice, actual.entryAtMs, actual.exitAtMs].every(
      (value) => Number.isFinite(value) && value > 0,
    ) ||
    actual.exitAtMs < actual.entryAtMs
  )
    throw new Error('INVALID_FILL_WINDOW');
  const model = outcome.entryOutcomes?.SIGNAL_PRICE;
  const referencePrice = model?.assumption.entryPrice;
  if (
    !model ||
    !model.horizons ||
    !model.assumption.available ||
    !referencePrice ||
    !Number.isFinite(referencePrice) ||
    referencePrice <= 0
  )
    throw new Error('SIGNAL_PRICE_MODEL_UNAVAILABLE');
  const sign = actual.side === 'LONG' ? 1 : -1;
  return {
    shadowSignalId: outcome.shadowSignalId,
    coverage: 'RAW_TRAJECTORY_NOT_VERIFIED',
    executableProfitOpportunity: 'UNKNOWN',
    counterfactualEligibility: 'INELIGIBLE_WITHOUT_CAUSAL_RAW_INPUTS_AND_EXECUTION_EVIDENCE',
    horizons: Object.values(model.horizons).map((horizon) => {
      const describe = (bps: number | null, delayMs: number | null, favorable: boolean) => {
        if (
          bps === null ||
          delayMs === null ||
          !Number.isFinite(bps) ||
          !Number.isFinite(delayMs) ||
          delayMs < 0 ||
          delayMs > horizon.horizonMs ||
          horizon.tradeCount <= 0
        )
          return {
            status: 'UNKNOWN',
            price: null,
            observedAtMs: null,
            returnFromActualEntryBps: null,
          };
        // Zero excursions can be initialized from the signal quote, not an actual trade.
        if (delayMs === 0 && bps === 0)
          return {
            status: 'SIGNAL_BASELINE_NOT_A_TRADE',
            price: null,
            observedAtMs: null,
            returnFromActualEntryBps: null,
          };
        const observedAtMs = outcome.signalAtMs + delayMs;
        const price = referencePrice * (1 + (sign * (favorable ? bps : -bps)) / 10_000);
        const status =
          observedAtMs < actual.entryAtMs
            ? 'BEFORE_ACTUAL_ENTRY'
            : observedAtMs > actual.exitAtMs
              ? 'AFTER_ACTUAL_EXIT'
              : 'OBSERVED_DURING_POSITION';
        return {
          status,
          price,
          observedAtMs,
          returnFromActualEntryBps:
            status === 'OBSERVED_DURING_POSITION'
              ? ((sign * (price - actual.entryPrice)) / actual.entryPrice) * 10_000
              : null,
        };
      };
      return {
        horizonMs: horizon.horizonMs,
        favorableObservation: describe(horizon.mfeBps, horizon.timeToMfeMs, true),
        adverseObservation: describe(horizon.maeBps, horizon.timeToMaeMs, false),
        actualPositionMfeBps: null,
        actualPositionMaeBps: null,
      };
    }),
  };
}

if (require.main === module) {
  const [journal, shadowSignalId, side, entryPrice, entryAtMs, exitAtMs] = process.argv.slice(2);
  if (!journal || !shadowSignalId || !['LONG', 'SHORT'].includes(side))
    throw new Error(
      'USAGE: <outcomes.jsonl> <shadowSignalId> <LONG|SHORT> <entryPrice> <entryAtMs> <exitAtMs>',
    );
  const rows = readFileSync(journal, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ProspectiveOutcomeRecord);
  const matches = rows.filter((row) => row.shadowSignalId === shadowSignalId);
  if (matches.length !== 1) throw new Error('EXPECTED_ONE_MATCHING_OUTCOME');
  console.log(
    JSON.stringify(
      auditObservedExcursions(matches[0], {
        shadowSignalId,
        side: side as 'LONG' | 'SHORT',
        entryPrice: Number(entryPrice),
        entryAtMs: Number(entryAtMs),
        exitAtMs: Number(exitAtMs),
      }),
      null,
      2,
    ),
  );
}
