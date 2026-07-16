import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PositionOwnershipRegistry, classifyClientOrderId } from './PositionOwnership';
import { exitPolicyForOwner, tradingServiceManages } from './ExitPolicy';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-'));
  file = path.join(dir, 'sub', 'ownership.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('classifyClientOrderId', () => {
  it('recognises the GEN2 prefix, everything else is unknown', () => {
    expect(classifyClientOrderId('GEN2-f0d8a3d3852792e541d53d35a267')).toBe('GEN2');
    expect(classifyClientOrderId('Ixqsw3rK104LZrMrKYLn7f')).toBe('UNKNOWN'); // Phase O / Binance auto id
    expect(classifyClientOrderId(undefined)).toBe('UNKNOWN');
    expect(classifyClientOrderId('')).toBe('UNKNOWN');
  });
});

describe('PositionOwnershipRegistry', () => {
  it('persists records and is immutable per clientOrderId', () => {
    const reg = new PositionOwnershipRegistry(file);
    reg.register({ clientOrderId: 'GEN2-abc', owner: 'GEN2', strategy: 'GEN2_EQM_TRRM', exitPolicy: 'GEN2_H12', riskPolicy: 'GEN2_EXPERIMENTAL', notificationPolicy: 'GEN2', symbol: 'DOGEUSDT', side: 'SHORT', entryTimeMs: 1 });
    // second write does not overwrite (ownership immutable)
    reg.register({ clientOrderId: 'GEN2-abc', owner: 'PHASE_O', strategy: 'x', exitPolicy: 'y', riskPolicy: 'z', notificationPolicy: 'w', symbol: 'DOGEUSDT', side: 'SHORT', entryTimeMs: 2 });
    expect(reg.get('GEN2-abc')!.owner).toBe('GEN2');
    // survives reload (PM2 restart)
    const reloaded = new PositionOwnershipRegistry(file);
    expect(reloaded.get('GEN2-abc')!.exitPolicy).toBe('GEN2_H12');
  });

  it('resolves owner: registry record wins, then GEN2 prefix, else unknown', () => {
    const reg = new PositionOwnershipRegistry(file);
    reg.register({ clientOrderId: 'GEN2-abc', owner: 'GEN2', strategy: 's', exitPolicy: 'GEN2_H12', riskPolicy: 'r', notificationPolicy: 'GEN2', symbol: 'DOGEUSDT', side: 'SHORT', entryTimeMs: 1 });
    expect(reg.resolveOwner(['GEN2-abc']).owner).toBe('GEN2');
    expect(reg.resolveOwner(['GEN2-unregistered']).owner).toBe('GEN2'); // prefix fallback
    expect(reg.resolveOwner(['Ixqsw3rK104LZrMrKYLn7f']).owner).toBe('UNKNOWN'); // Phase O id, no record
    expect(reg.resolveOwner([]).owner).toBe('UNKNOWN');
    // if any id is GEN2, GEN2 wins (fail-safe: Phase O never adopts a GEN2-touched position)
    expect(reg.resolveOwner(['Ixqsw3rK104LZrMrKYLn7f', 'GEN2-abc']).owner).toBe('GEN2');
  });

  it('a corrupt registry file starts empty instead of throwing', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    const reg = new PositionOwnershipRegistry(file);
    expect(reg.get('anything')).toBeUndefined();
  });
});

describe('ExitPolicy', () => {
  it('GEN2 uses only stop/tp/h12/kill/telegram/reconciliation and is managed by the bridge', () => {
    const p = exitPolicyForOwner('GEN2');
    expect(p.managedBy).toBe('GEN2_BRIDGE');
    expect(p.modules).toContain('H12_TIME_EXIT');
    expect(p.modules).not.toContain('TRAILING');
    expect(p.modules).not.toContain('PROFIT_GUARDIAN');
    expect(p.modules).not.toContain('PYRAMID');
  });

  it('PHASE_O keeps its full policy and is the only owner TradingService manages', () => {
    expect(exitPolicyForOwner('PHASE_O').modules).toContain('TRAILING');
    expect(tradingServiceManages('PHASE_O')).toBe(true);
    expect(tradingServiceManages('GEN2')).toBe(false);
    expect(tradingServiceManages('MANUAL')).toBe(false);
    expect(tradingServiceManages('UNKNOWN')).toBe(false);
  });
});
