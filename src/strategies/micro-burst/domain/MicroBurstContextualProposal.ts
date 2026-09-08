import type {
  MicroBurstConfig,
  MicroBurstContext,
  MicroBurstEntryDecision,
  OrderBookSnapshot,
} from './MicroBurstTypes';
import { evaluateMicroBurstReactionEntry } from './MicroBurstReactionEntryPolicy';
import { createMicroBurstExecutionIntent } from './MicroBurstExecutionIntentFactory';
import {
  sizeMicroBurstLossBudget,
  type MicroBurstLossBudgetInput,
  type MicroBurstMarginFractionInput,
} from './MicroBurstLossBudgetSizing';
import type { MarginBudgetSizingResult } from '../../../core/risk/SizingEngine';

/** Research composition requires account/risk evidence as input; it cannot obtain or mutate it. */
export function evaluateMicroBurstContextualProposal(input: {
  context: MicroBurstContext;
  book: OrderBookSnapshot | undefined;
  observedAtMs: number;
  config: MicroBurstConfig;
  risk:
    | Omit<MicroBurstLossBudgetInput, 'intent' | 'book' | 'now'>
    | Omit<MicroBurstMarginFractionInput, 'intent' | 'book' | 'now'>;
}): {
  authority: 'OBSERVATION_ONLY';
  entry: MicroBurstEntryDecision;
  sizing: MarginBudgetSizingResult | null;
  eligibleForResearchFill: boolean;
} {
  const config = { ...input.config, contextualPolicyVersion: 'CONTEXTUAL_V3' as const };
  const entry = evaluateMicroBurstReactionEntry(
    input.context,
    config,
    input.book,
    input.observedAtMs,
  );
  if (entry.action !== 'ENTRY_INTENT')
    return { authority: 'OBSERVATION_ONLY', entry, sizing: null, eligibleForResearchFill: false };
  const intent = createMicroBurstExecutionIntent({
    identity: {
      strategyId: 'MICRO_BURST_V1',
      strategyVersion: 'CONTEXTUAL_V3',
      freezeState: 'SHADOW_CANDIDATE',
      codeCommitSha: 'UNKNOWN',
    },
    symbol: input.context.symbol,
    side: entry.side!,
    // A high confirmation tier is not permission for 40x, nor to exceed a 20x approval.
    leverage: Math.min(entry.leverage!, 30, input.risk.approvedLeverageCap),
    positionFraction: entry.positionFraction!,
    stopInvalidationPrice: entry.stopInvalidationPrice!,
    targetPrice: entry.targetPrice!,
    requestedAt: input.observedAtMs,
    signalSnapshotAtMs: input.context.timestamp,
    tradeId: String(entry.diagnostics.episodeId),
  });
  const sizing = sizeMicroBurstLossBudget(
    { ...input.risk, intent, book: input.book, now: input.observedAtMs },
    config,
  );
  return {
    authority: 'OBSERVATION_ONLY',
    entry: {
      ...entry,
      leverage: intent.leverage,
      diagnostics: { ...entry.diagnostics, sizing, leverageIsNotRiskBudget: true },
    },
    sizing,
    eligibleForResearchFill: sizing.valid,
  };
}
