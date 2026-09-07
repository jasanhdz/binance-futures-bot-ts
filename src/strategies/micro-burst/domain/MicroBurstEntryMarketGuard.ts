import type { StrategyExecutionIntent } from '../../../core/strategy/StrategyExecution';
import type { MicroBurstConfig, OrderBookSnapshot } from './MicroBurstTypes';
import { priceDistanceToBps } from './MicroBurstUnits';

/** No I/O: called before PREPARED and again at the durable send boundary. */
export function validateMicroBurstEntryMarket(
  intent: StrategyExecutionIntent,
  quantity: number,
  book: OrderBookSnapshot | undefined,
  now: number,
  config: MicroBurstConfig,
  entryPolicy: 'BASELINE' | 'REACTION' = 'BASELINE',
): string | undefined {
  const snapshotAt = Number(intent.metadata.signalSnapshotAtMs);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(snapshotAt) ||
    snapshotAt <= 0 ||
    snapshotAt > intent.requestedAt ||
    intent.requestedAt > now ||
    now - snapshotAt > config.candleFreshness1mMaxMs ||
    now - intent.requestedAt > config.bookFreshnessMaxMs
  )
    return 'MICRO_SIGNAL_EXPIRED';
  if (
    !book ||
    book.status !== 'HEALTHY' ||
    !Number.isFinite(book.observedAtMs) ||
    book.observedAtMs > now ||
    now - book.observedAtMs > config.bookFreshnessMaxMs
  )
    return 'MICRO_EXECUTABLE_BOOK_NOT_FRESH';
  const bid = book.bidDepth[0]?.price;
  const ask = book.askDepth[0]?.price;
  if (
    ![bid, ask].every(Number.isFinite) ||
    !(bid > 0 && ask >= bid) ||
    priceDistanceToBps(bid, ask) > config.bookAnomalySpreadBps
  )
    return 'MICRO_EXECUTABLE_SPREAD_INVALID';
  if (!Number.isFinite(quantity) || quantity <= 0) return 'MICRO_EXECUTABLE_DEPTH_INSUFFICIENT';
  const depth = intent.side === 'LONG' ? book.askDepth : book.bidDepth;
  let remaining = quantity;
  let notional = 0;
  let previous = intent.side === 'LONG' ? ask : bid;
  for (const level of depth) {
    if (
      !Number.isFinite(level.price) ||
      !Number.isFinite(level.qty) ||
      level.price <= 0 ||
      level.qty < 0 ||
      (intent.side === 'LONG' ? level.price < previous : level.price > previous)
    )
      return 'MICRO_EXECUTABLE_DEPTH_INVALID';
    const taken = Math.min(remaining, level.qty);
    notional += taken * level.price;
    remaining -= taken;
    previous = level.price;
    if (remaining <= 0) break;
  }
  if (remaining > 0) return 'MICRO_EXECUTABLE_DEPTH_INSUFFICIENT';
  const price = notional / quantity;
  const stop = intent.structuralStopPrice ?? NaN;
  const target = intent.destinationPrice ?? NaN;
  const sign = intent.side === 'LONG' ? 1 : -1;
  // Check the liquidation-side quote too: entry VWAP alone can conceal a broken stop.
  const exitQuote = intent.side === 'LONG' ? bid : ask;
  if (
    ![price, stop, target].every(Number.isFinite) ||
    stop <= 0 ||
    target <= 0 ||
    sign * (exitQuote - stop) <= 0 ||
    sign * (price - stop) <= 0 ||
    sign * (target - price) <= 0
  )
    return 'MICRO_EXECUTABLE_GEOMETRY_INVALID';
  const defended = stop / (1 - (sign * config.structuralInvalidationBufferBps) / 10_000);
  if (
    sign * (price - defended) < 0 ||
    priceDistanceToBps(price, defended) > config.nearLevelThresholdBps
  )
    return 'MICRO_REACTION_DISPLACED';
  const room = priceDistanceToBps(price, target);
  const risk = priceDistanceToBps(price, stop);
  if (room < config.minRoomBps || room / risk < config.minRewardRisk)
    return 'MICRO_EXECUTABLE_ROOM_LOST';
  if (entryPolicy === 'REACTION') {
    const costs = config.exitEstimatedRoundTripCostBps;
    const netRoom = room - costs;
    const netRR = netRoom / (risk + costs);
    if (!Number.isFinite(costs) || costs < 0 || !Number.isFinite(netRR) ||
        netRoom < config.minRoomBps || netRR < config.minRewardRisk)
      return 'MICRO_EXECUTABLE_NET_ROOM_LOST';
  }
  return undefined;
}
