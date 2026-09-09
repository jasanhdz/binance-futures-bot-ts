import { describe, expect, it, vi } from 'vitest';
import { EntryGateDiagnostics } from './EntryGateDiagnostics';

describe('EntryGateDiagnostics', () => {
  it('aggregates counts once per minute and emits idle heartbeats', () => {
    let now = 0;
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const diagnostics = new EntryGateDiagnostics(logger, 'MICRO_BURST', () => now);
    for (let i = 0; i < 1_000; i++)
      diagnostics.record('admission', 'CONFIG_MISMATCH', { symbol: 'ETHUSDT' });
    expect(logger.info).not.toHaveBeenCalled();
    now = 60_000;
    diagnostics.heartbeat();
    expect(logger.info).toHaveBeenLastCalledWith(
      'strategy_entry_gate_summary',
      expect.objectContaining({ total: 1_000, counts: { 'admission:CONFIG_MISMATCH': 1_000 } }),
    );
    diagnostics.heartbeat();
    expect(logger.info).toHaveBeenCalledTimes(1);
    now += 60_000;
    diagnostics.heartbeat();
    expect(logger.info).toHaveBeenLastCalledWith(
      'strategy_entry_gate_summary',
      expect.objectContaining({ total: 0, counts: {}, lastSample: undefined }),
    );
  });

  it('bounds reason cardinality without losing counts', () => {
    let now = 0;
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const diagnostics = new EntryGateDiagnostics(logger, 'MOMENTUM_RIDE', () => now);
    for (let i = 0; i < 1_000; i++) diagnostics.record('preflight', String(i));
    now = 60_000;
    diagnostics.heartbeat();
    const report = logger.info.mock.calls[0][1];
    expect(Object.keys(report.counts)).toHaveLength(64);
    expect(Object.values(report.counts).reduce((a: number, b) => a + Number(b), 0)).toBe(1_000);
  });
});
