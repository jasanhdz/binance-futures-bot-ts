import type { MicroBurstConfig, MicroBurstExitContext, OrderBookSnapshot } from './MicroBurstTypes';
import { resolveMicroBurstExecutablePrice } from './MicroBurstEconomicContract';

/** Full visible exit VWAP. Residual fees/funding and volatility are explicit inputs, not guessed. */
export function microBurstExecutableExitEconomics(
  input: {
    book: OrderBookSnapshot | undefined;
    side: 'LONG' | 'SHORT';
    quantity: number;
    observedAtMs: number;
    costObservedAtMs?: number;
    costSource?: string;
    residualCostBps: number;
    volatilityBps: number;
  },
  config: MicroBurstConfig,
): MicroBurstExitContext['executableEconomics'] | null {
  const { book } = input;
  if (
    !book ||
    book.status !== 'HEALTHY' ||
    ![
      input.quantity,
      input.observedAtMs,
      input.residualCostBps,
      input.volatilityBps,
      book.observedAtMs,
    ].every(Number.isFinite) ||
    input.quantity <= 0 ||
    input.residualCostBps < config.exitEstimatedRoundTripCostBps ||
    input.volatilityBps < 0 ||
    book.observedAtMs > input.observedAtMs ||
    input.observedAtMs - book.observedAtMs > config.exitIntelligenceMaxObservationGapMs
  )
    return null;
  const bid = book.bidDepth[0]?.price;
  const ask = book.askDepth[0]?.price;
  if (
    ![bid, ask].every(Number.isFinite) ||
    bid <= 0 ||
    ask < bid ||
    ((ask - bid) / bid) * 10_000 > config.bookAnomalySpreadBps
  )
    return null;
  const depth = input.side === 'LONG' ? book.bidDepth : book.askDepth;
  const executable = resolveMicroBurstExecutablePrice({
    side: input.side,
    quantity: input.quantity,
    depth,
    observedAtMs: book.observedAtMs,
    asOfMs: input.observedAtMs,
    maxAgeMs: config.exitIntelligenceMaxObservationGapMs,
  });
  if (executable.status === 'UNAVAILABLE') return null;
  return {
    observedAtMs: book.observedAtMs,
    ...(Number.isFinite(input.costObservedAtMs)
      ? { costObservedAtMs: input.costObservedAtMs }
      : {}),
    ...(input.costSource ? { costSource: input.costSource } : {}),
    exitPrice: executable.value,
    quantityCovered: true,
    residualCostBps: input.residualCostBps,
    volatilityBps: input.volatilityBps,
  };
}
