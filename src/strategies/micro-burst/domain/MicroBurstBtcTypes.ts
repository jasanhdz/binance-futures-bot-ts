import { Side } from '../../types';

export interface BtcCandleObservation {
  close: number;
  closeTime: number;
  openTime: number;
}

export interface BtcReturnSet {
  ret1m: number;
  ret3m: number;
  ret5m: number;
  acceleration: number;
  direction: Side | 'NEUTRAL';
  observedAtMs: number;
}
