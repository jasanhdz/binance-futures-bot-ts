import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionOrder, Gen2Bridge, Gen2BridgeConfig, Gen2ExchangePort } from './Gen2Bridge';

const SECRET = 'test-secret';
const CID = 'gen2-20260711T202935Z';

function sign(body: string, timestamp: string): string {
  return crypto.createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
}

function makeOrder(overrides: Partial<DecisionOrder> = {}): DecisionOrder {
  return {
    schema: 'gen2_decision_order_v1',
    candidate_id: CID,
    client_order_id: 'GEN2-abc123',
    signal_id: 'ADAUSDT-2026-07-12T00:00:00',
    symbol: 'ADAUSDT',
    side: 'SHORT',
    quantity: 35,
    leverage: 3,
    margin_type: 'ISOLATED',
    brackets: { stop_price: 0.7105, time_exit_at: '2026-07-12 01:05:00', reduce_only: true },
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

class MockExchange implements Gen2ExchangePort {
  calls: string[] = [];
  failStop = false;
  failMarket = false;
  openPosition = false;
  lastClientOrderId?: string;
  async ensureMarginType(): Promise<void> {
    this.calls.push('margin');
  }
  async setLeverage(): Promise<void> {
    this.calls.push('leverage');
  }
  async marketOpen(_s: string, _side: 'LONG' | 'SHORT', qty: number, clientOrderId?: string) {
    this.calls.push('market');
    this.lastClientOrderId = clientOrderId;
    if (this.failMarket) throw new Error('exchange down');
    return { orderId: 42, avgPrice: 0.7, executedQty: qty };
  }
  async placeStopClose(): Promise<boolean> {
    this.calls.push('stop');
    return !this.failStop;
  }
  async getUSDTBalance(): Promise<number> {
    return 116.24;
  }
  async hasOpenPosition(): Promise<boolean> {
    return this.openPosition;
  }
}

let dir: string;
let exchange: MockExchange;

function makeBridge(overrides: Partial<Gen2BridgeConfig> = {}): Gen2Bridge {
  return new Gen2Bridge({
    secret: SECRET,
    candidateId: CID,
    allowedSymbols: ['ADAUSDT', 'DOGEUSDT'],
    stateDir: dir,
    executionEnabled: true,
    phaseOAllowOrders: false,
    exchange,
    ...overrides,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen2-bridge-'));
  exchange = new MockExchange();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('signature verification', () => {
  it('accepts a valid signature once and rejects its replay', () => {
    const bridge = makeBridge();
    const ts = String(Date.now());
    const sig = sign('body', ts);
    expect(bridge.verifySignature('body', ts, sig).ok).toBe(true);
    expect(bridge.verifySignature('body', ts, sig)).toEqual({ ok: false, reason: 'SIGNATURE_REPLAYED' });
  });

  it('rejects bad signature and stale timestamp', () => {
    const bridge = makeBridge();
    const ts = String(Date.now());
    expect(bridge.verifySignature('body', ts, 'deadbeef').reason).toBe('SIGNATURE_INVALID');
    const old = String(Date.now() - 60_000);
    expect(bridge.verifySignature('body', old, sign('body', old)).reason).toBe('TIMESTAMP_INVALID_OR_REPLAY');
  });
});

describe('order validation fail-closed', () => {
  it('refuses wrong candidate, symbol, side, leverage, expiry, unpaused Phase O and kill switch', async () => {
    const bridge = makeBridge();
    expect(bridge.validateOrder(makeOrder({ candidate_id: 'other' })).reason).toBe('WRONG_CANDIDATE');
    expect(bridge.validateOrder(makeOrder({ symbol: 'BTCUSDT' })).reason).toBe('SYMBOL_NOT_ALLOWED');
    expect(bridge.validateOrder(makeOrder({ side: 'LONG' })).reason).toBe('ONLY_SHORT_ALLOWED');
    expect(bridge.validateOrder(makeOrder({ leverage: 25 })).reason).toBe('LEVERAGE_INVALID');
    expect(bridge.validateOrder(makeOrder({ expires_at: new Date(Date.now() - 1000).toISOString() })).reason).toBe('ORDER_EXPIRED');
    const unpaused = makeBridge({ phaseOAllowOrders: true });
    expect(unpaused.validateOrder(makeOrder()).reason).toBe('PHASE_O_NOT_PAUSED');
    bridge.engageKill('test');
    expect(bridge.validateOrder(makeOrder()).reason).toBe('KILL_SWITCH_ENGAGED');
  });
});

describe('execution and idempotency', () => {
  it('executes, forwards deterministic clientOrderId, emits FILL + BRACKET_CONFIRMED', async () => {
    const bridge = makeBridge();
    const ack = await bridge.execute(makeOrder());
    expect(ack.status).toBe('ACCEPTED');
    expect(ack.reason).toBe('FILLED_AND_BRACKETED');
    expect(exchange.lastClientOrderId).toBe('GEN2-abc123');
    const events = bridge.drainEvents(0) as any[];
    expect(events.map((e) => e.type)).toEqual(['FILL', 'BRACKET_CONFIRMED']);
  });

  it('repeated client_order_id returns DUPLICATE and never re-executes', async () => {
    const bridge = makeBridge();
    await bridge.execute(makeOrder());
    const marketCalls = exchange.calls.filter((c) => c === 'market').length;
    const dup = await bridge.execute(makeOrder());
    expect(dup.status).toBe('DUPLICATE');
    expect(exchange.calls.filter((c) => c === 'market').length).toBe(marketCalls);
  });

  it('idempotency survives restart (state persisted)', async () => {
    const bridge = makeBridge();
    await bridge.execute(makeOrder());
    const rebooted = makeBridge();
    const dup = await rebooted.execute(makeOrder());
    expect(dup.status).toBe('DUPLICATE');
  });

  it('bracket failure engages kill switch and reports it', async () => {
    exchange.failStop = true;
    const bridge = makeBridge();
    const ack = await bridge.execute(makeOrder());
    expect(ack.status).toBe('ACCEPTED');
    expect(ack.reason).toBe('FILLED_BUT_BRACKET_FAILED_KILL_ENGAGED');
    expect(bridge.killEngaged()).toBe(true);
    const events = bridge.drainEvents(0) as any[];
    expect(events.some((e) => e.type === 'BRACKET_FAILED')).toBe(true);
  });

  it('exchange error yields REJECTED with event, no kill', async () => {
    exchange.failMarket = true;
    const bridge = makeBridge();
    const ack = await bridge.execute(makeOrder());
    expect(ack.status).toBe('REJECTED');
    expect(bridge.killEngaged()).toBe(false);
  });

  it('open position refuses new order', async () => {
    exchange.openPosition = true;
    const bridge = makeBridge();
    const ack = await bridge.execute(makeOrder());
    expect(ack.status).toBe('REJECTED');
    expect(ack.reason).toBe('POSITION_ALREADY_OPEN');
  });

  it('without exchange returns ACCEPTED_DRYRUN and never throws', async () => {
    const bridge = makeBridge({ exchange: undefined, executionEnabled: false });
    const ack = await bridge.execute(makeOrder({ client_order_id: 'GEN2-dry' }));
    expect(ack.status).toBe('ACCEPTED_DRYRUN');
  });
});

describe('events', () => {
  it('drainEvents pages by sequence', async () => {
    const bridge = makeBridge();
    await bridge.execute(makeOrder());
    const all = bridge.drainEvents(0) as any[];
    expect(all.length).toBe(2);
    const afterFirst = bridge.drainEvents(all[0].ts_sequence) as any[];
    expect(afterFirst.length).toBe(1);
    expect(afterFirst[0].ts_sequence).toBeGreaterThan(all[0].ts_sequence);
  });
});
