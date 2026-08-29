import { describe, expect, it } from 'vitest';
import { hasBtcConflict } from './MicroBurstBtcContext';
import { makeBtcContext } from './MicroBurst.test-support';
import { bpsToDecimalReturn, decimalReturnToBps } from './MicroBurstUnits';

describe('Micro Burst BTC unit contract', () => {
  it('converts decimal returns and basis points exactly', () => {
    expect(decimalReturnToBps(0.001)).toBe(10);
    expect(decimalReturnToBps(0.003)).toBe(30);
    expect(decimalReturnToBps(-0.005)).toBe(-50);
    expect(bpsToDecimalReturn(30)).toBe(0.003);
  });

  it.each([
    [-0.0029, false],
    [-0.003, true],
    [-0.0031, true],
  ] as const)(
    'LONG versus BTC SHORT ret3m=%s uses inclusive 30 bps boundary',
    (ret3m, expected) => {
      expect(hasBtcConflict('LONG', makeBtcContext({ direction: 'SHORT', ret3m }), 30)).toBe(
        expected,
      );
    },
  );

  it.each([
    [0.0029, false],
    [0.003, true],
    [0.0031, true],
  ] as const)(
    'SHORT versus BTC LONG ret3m=%s uses inclusive 30 bps boundary',
    (ret3m, expected) => {
      expect(hasBtcConflict('SHORT', makeBtcContext({ direction: 'LONG', ret3m }), 30)).toBe(
        expected,
      );
    },
  );

  it('never reports conflict for neutral BTC', () => {
    expect(
      hasBtcConflict('LONG', makeBtcContext({ direction: 'NEUTRAL', ret3m: -0.005 }), 30),
    ).toBe(false);
    expect(
      hasBtcConflict('SHORT', makeBtcContext({ direction: 'NEUTRAL', ret3m: 0.005 }), 30),
    ).toBe(false);
  });
});
