import { Side } from '../../types';
import { BtcContext } from './MicroBurstTypes';
import { decimalReturnToBps } from './MicroBurstUnits';

export function hasBtcConflict(
  candidateSide: Side | 'NEUTRAL',
  btcContext: BtcContext,
  conflictThresholdBps: number,
): boolean {
  if (candidateSide === 'NEUTRAL' || btcContext.direction === 'NEUTRAL') return false;
  if (candidateSide === btcContext.direction) return false;
  const absoluteRet3mBps = Math.abs(decimalReturnToBps(btcContext.ret3m));
  return absoluteRet3mBps >= conflictThresholdBps;
}
