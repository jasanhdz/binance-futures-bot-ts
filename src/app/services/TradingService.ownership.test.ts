import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TradingService } from './TradingService';
import { PositionOwnershipRegistry } from '../../execution/PositionOwnership';

let dir: string;

function makeService(openingIds: string[]) {
  const exchange = {
    readActivePosition: vi.fn().mockResolvedValue({ sideMode: 'BOTH', qtyAbs: 546, entryPrice: 0.07442, leverage: 10 }),
    getOpeningClientOrderIds: vi.fn().mockResolvedValue(openingIds),
    getMarkPrice: vi.fn().mockResolvedValue(0.0744),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const notifier = { sendMessage: vi.fn(), sendAlert: vi.fn() };
  const state = { get: vi.fn(() => ({ mode: 'IDLE' })), set: vi.fn(), reset: vi.fn(), forSymbol: vi.fn() };
  const svc = new TradingService(
    { exchange: exchange as any, mlService: { getSignal: vi.fn(), getExitSignal: vi.fn(), checkHealth: vi.fn() } as any, logger, state: state as any, notifier, configManager: {} as any },
    { symbols: ['DOGEUSDT'], tickIntervalMs: 0, maxTradesPerDay: 100, tradingMode: 'AEGIS_TURBO_MICRO_LIVE' },
  );
  (svc as any).ownershipRegistry = new PositionOwnershipRegistry(path.join(dir, 'ownership.json'));
  return { svc, exchange, logger, notifier };
}

beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-own-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('TradingService ownership resolution', () => {
  it('classifies a GEN2- opened position as GEN2 (Phase O must not manage it)', async () => {
    const { svc } = makeService(['GEN2-f0d8a3d3852792e541d53d35a267']);
    const owner = await (svc as any).resolvePositionOwner('DOGEUSDT', 'SHORT');
    expect(owner).toBe('GEN2');
  });

  it('classifies a Phase O opened position (Binance-auto id) as PHASE_O so Phase O keeps managing its own', async () => {
    const { svc } = makeService(['Ixqsw3rK104LZrMrKYLn7f']);
    expect(await (svc as any).resolvePositionOwner('DOGEUSDT', 'SHORT')).toBe('PHASE_O');
  });

  it('defaults to PHASE_O when ownership cannot be resolved (never orphans a Phase O position)', async () => {
    const { svc } = makeService([]);
    expect(await (svc as any).resolvePositionOwner('DOGEUSDT', 'SHORT')).toBe('PHASE_O');
  });

  it('honours an explicit registry record over the id prefix', async () => {
    const { svc } = makeService(['someid']);
    (svc as any).getOwnershipRegistry().register({ clientOrderId: 'someid', owner: 'GEN2', strategy: 's', exitPolicy: 'GEN2_H12', riskPolicy: 'r', notificationPolicy: 'GEN2', symbol: 'DOGEUSDT', side: 'SHORT', entryTimeMs: 1 });
    expect(await (svc as any).resolvePositionOwner('DOGEUSDT', 'SHORT')).toBe('GEN2');
  });
});
