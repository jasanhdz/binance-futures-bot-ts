import type { MarketDataPort } from '../../../app/ports/MarketData';
import { prepareClosedCandles } from '../../../core/market-data/CandleIntegrity';
import type { Side } from '../../../core/types';
import { detectSupportResistance } from '../domain/MicroBurstSupportResistance';
import type { MicroBurstConfig, MicroBurstExitContext } from '../domain/MicroBurstTypes';

/** Same confirmed 5m structure as entry, resolved with the trade's frozen policy. */
export async function readMicroBurstNextObstacle(
  exchange: Pick<MarketDataPort, 'getCandles'>,
  symbol: string,
  side: Side,
  destination: number,
  config: MicroBurstConfig,
  snapshotAtMs: number,
): Promise<MicroBurstExitContext['nextConfirmedObstacle']> {
  try {
    if (!Number.isFinite(destination) || destination <= 0) return undefined;
    const raw = await exchange.getCandles(symbol, '5m', config.srLookbackBars);
    const prepared = prepareClosedCandles(
      raw,
      300_000,
      snapshotAtMs,
      config.candleFreshness5mMaxMs,
    );
    if (prepared.reasons.length) return undefined;
    const { levels } = detectSupportResistance(prepared.candles, {
      lookbackBars: config.srLookbackBars,
      pivotLeftBars: config.srPivotLeftBars,
      pivotRightBars: config.srPivotRightBars,
      clusterToleranceBps: config.srClusterToleranceBps,
      minStrength: config.srMinStrength,
      nearLevelThresholdBps: config.nearLevelThresholdBps,
      snapshotAtMs,
    });
    const next = levels
      .filter(
        (level) =>
          level.availableAtMs < snapshotAtMs &&
          (side === 'LONG'
            ? level.type === 'resistance' && level.price > destination
            : level.type === 'support' && level.price < destination),
      )
      .sort((a, b) => (side === 'LONG' ? a.price - b.price : b.price - a.price))[0];
    return next ? { price: next.price, availableAtMs: next.availableAtMs } : undefined;
  } catch {
    return undefined;
  }
}
