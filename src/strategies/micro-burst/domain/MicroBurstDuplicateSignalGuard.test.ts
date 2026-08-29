import { describe, expect, it, vi } from 'vitest';
import { MicroBurstDuplicateSignalGuard } from './MicroBurstDuplicateSignalGuard';

const NOW_MS = 1_700_000_000_000;

describe('MicroBurstDuplicateSignalGuard', () => {
  it('returns new signal on first observation', () => {
    const clock = { now: vi.fn(() => NOW_MS) };
    const guard = new MicroBurstDuplicateSignalGuard(clock);

    const result = guard.check('MICRO_BURST_V1', 'ETHUSDT', 'LONG', 99.7, NOW_MS);

    expect(result.duplicateSuppressed).toBe(false);
    expect(result.shadowSignalId).toContain('ETHUSDT');
    expect(result.shadowSignalId).toContain('LONG');
    expect(result.firstObservedAt).toBe(NOW_MS);
  });

  it('suppresses duplicate within same bucket', () => {
    const clock = { now: vi.fn(() => NOW_MS) };
    const guard = new MicroBurstDuplicateSignalGuard(clock);

    const first = guard.check('MICRO_BURST_V1', 'ETHUSDT', 'LONG', 99.7, NOW_MS);
    clock.now.mockReturnValue(NOW_MS + 5000);
    const second = guard.check('MICRO_BURST_V1', 'ETHUSDT', 'LONG', 99.7, NOW_MS + 5000);

    expect(second.duplicateSuppressed).toBe(true);
    expect(second.shadowSignalId).toBe(first.shadowSignalId);
    expect(second.firstObservedAt).toBe(first.firstObservedAt);
  });

  it('allows different sides as distinct signals', () => {
    const clock = { now: vi.fn(() => NOW_MS) };
    const guard = new MicroBurstDuplicateSignalGuard(clock);

    const long = guard.check('MICRO_BURST_V1', 'ETHUSDT', 'LONG', 99.7, NOW_MS);
    const short = guard.check('MICRO_BURST_V1', 'ETHUSDT', 'SHORT', 99.7, NOW_MS);

    expect(long.shadowSignalId).not.toBe(short.shadowSignalId);
    expect(long.duplicateSuppressed).toBe(false);
    expect(short.duplicateSuppressed).toBe(false);
  });

  it('allows different structural levels as distinct signals', () => {
    const clock = { now: vi.fn(() => NOW_MS) };
    const guard = new MicroBurstDuplicateSignalGuard(clock);

    const a = guard.check('MICRO_BURST_V1', 'ETHUSDT', 'LONG', 99.7, NOW_MS);
    const b = guard.check('MICRO_BURST_V1', 'ETHUSDT', 'LONG', 99.8, NOW_MS);

    expect(a.shadowSignalId).not.toBe(b.shadowSignalId);
  });

  it('allows signals in different time buckets', () => {
    const clock = { now: vi.fn(() => NOW_MS) };
    const guard = new MicroBurstDuplicateSignalGuard(clock);

    guard.check('MICRO_BURST_V1', 'ETHUSDT', 'LONG', 99.7, NOW_MS);
    clock.now.mockReturnValue(NOW_MS + 65_000);
    const next = guard.check('MICRO_BURST_V1', 'ETHUSDT', 'LONG', 99.7, NOW_MS + 65_000);

    expect(next.duplicateSuppressed).toBe(false);
  });

  it('clear resets state', () => {
    const clock = { now: vi.fn(() => NOW_MS) };
    const guard = new MicroBurstDuplicateSignalGuard(clock);

    guard.check('MICRO_BURST_V1', 'ETHUSDT', 'LONG', 99.7, NOW_MS);
    expect(guard.size()).toBe(1);

    guard.clear();
    expect(guard.size()).toBe(0);
  });
});
