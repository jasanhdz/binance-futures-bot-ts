import type { MicroBurstConfig, MicroBurstExitContext, OrderBookSnapshot } from './MicroBurstTypes';

/** Full visible exit VWAP. Residual fees/funding and volatility are explicit inputs, not guessed. */
export function microBurstExecutableExitEconomics(
  input: {
    book: OrderBookSnapshot | undefined;
    side: 'LONG' | 'SHORT';
    quantity: number;
    observedAtMs: number;
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
  let remaining = input.quantity;
  let notional = 0;
  let previous = depth[0].price;
  for (const level of depth) {
    if (
      ![level.price, level.qty].every(Number.isFinite) ||
      level.price <= 0 ||
      level.qty < 0 ||
      (input.side === 'LONG' ? level.price > previous : level.price < previous)
    )
      return null;
    const taken = Math.min(remaining, level.qty);
    notional += taken * level.price;
    remaining -= taken;
    previous = level.price;
    if (remaining <= 0) break;
  }
  if (remaining > 0 || !Number.isFinite(notional) || notional <= 0) return null;
  return {
    observedAtMs: book.observedAtMs,
    exitPrice: notional / input.quantity,
    quantityCovered: true,
    residualCostBps: input.residualCostBps,
    volatilityBps: input.volatilityBps,
  };
}
