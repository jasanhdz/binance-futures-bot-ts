import { describe, expect, it } from 'vitest';
import { wilderAdxSeries } from './WilderAdx';

const candles = (values: number[]) =>
  values.map((close) => ({ high: close + 0.5, low: close - 0.5, close }));
describe('Wilder ADX reference arithmetic', () => {
  it('matches hand-calculated period-2 smoothing, not window DX', () => {
    const result = wilderAdxSeries(candles([10, 11, 10, 12, 11]), 2);
    expect(result).toHaveLength(2);
    expect(result[0]).toBeCloseTo(100 / 3, 10);
    expect(result[1]).toBeCloseTo(50 / 3, 10);
  });
  it('requires full warmup and handles flat and monotonic paths', () => {
    expect(wilderAdxSeries(candles(Array(27).fill(100)))).toEqual([]);
    expect(wilderAdxSeries(candles(Array(40).fill(100)))).toEqual(Array(13).fill(0));
    for (const sign of [-1, 1]) {
      const result = wilderAdxSeries(candles(Array.from({ length: 40 }, (_, i) => 100 + sign * i)));
      result.forEach((value) => expect(value).toBeCloseTo(100, 10));
    }
  });
  it('does not emit a value from invalid candles', () => {
    const rows = candles(Array(40).fill(100));
    rows[39].close = NaN;
    expect(wilderAdxSeries(rows)).toEqual([]);
  });
});
