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
  failClose = false;
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
  async marketClose(_s: string, _side: 'LONG' | 'SHORT', _qty: number) {
    this.calls.push('close');
    if (this.failClose) throw new Error('close rejected');
    return { orderId: 77, avgPrice: 0.69 };
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

  it('bracket failure emergency-closes the position (never left unprotected) then kills', async () => {
    exchange.failStop = true;
    const bridge = makeBridge();
    const ack = await bridge.execute(makeOrder());
    expect(ack.status).toBe('ACCEPTED');
    expect(ack.reason).toBe('FILLED_STOP_FAILED_EMERGENCY_CLOSED');
    expect(exchange.calls).toContain('close'); // position was closed immediately
    expect(bridge.killEngaged()).toBe(true);
    const events = bridge.drainEvents(0) as any[];
    expect(events.some((e) => e.type === 'EMERGENCY_CLOSE')).toBe(true);
    expect(events.some((e) => e.type === 'POSITION_CLOSED')).toBe(true);
    expect(events.some((e) => e.type === 'BRACKET_FAILED')).toBe(true);
  });

  it('if the emergency close ALSO fails, kill engages and an incident is raised', async () => {
    exchange.failStop = true;
    exchange.failClose = true;
    const bridge = makeBridge();
    const ack = await bridge.execute(makeOrder());
    expect(ack.reason).toBe('FILLED_STOP_FAILED_EMERGENCY_CLOSE_FAILED_KILL_ENGAGED');
    expect(bridge.killEngaged()).toBe(true);
    const events = bridge.drainEvents(0) as any[];
    expect(events.some((e) => e.type === 'INCIDENT' && (e.payload as any).type === 'EMERGENCY_CLOSE_FAILED')).toBe(true);
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

describe('ownership registration', () => {
  it('registers GEN2 ownership on a real fill so Phase O can never adopt it', async () => {
    const regPath = path.join(dir, 'ownership.json');
    const bridge = makeBridge({ ownershipRegistryPath: regPath });
    exchange.openPosition = false;
    await bridge.execute({ ...makeOrder(), strategy_context: { owner: 'GEN2', strategy: 'GEN2_EQM_TRRM', exit_policy: 'GEN2_H12', risk_policy: 'GEN2_EXPERIMENTAL', notification_policy: 'GEN2' } });
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
    const rec = reg['GEN2-abc123'];
    expect(rec.owner).toBe('GEN2');
    expect(rec.exitPolicy).toBe('GEN2_H12');
    expect(rec.symbol).toBe('ADAUSDT');
  });
});

describe('onEvent observability hook', () => {
  it('fires for every emitted event and a throwing sink never breaks execution', async () => {
    const seen: string[] = [];
    const bridge = makeBridge({
      onEvent: (e: any) => {
        seen.push(e.type);
        if (e.type === 'FILL') throw new Error('sink boom'); // must be swallowed
      },
    });
    const ack = await bridge.execute(makeOrder());
    expect(ack.status).toBe('ACCEPTED'); // execution unaffected by sink throw
    expect(seen).toEqual(['FILL', 'BRACKET_CONFIRMED']);
  });
});

describe('H12 time exits', () => {
  it('executes the due exit while position is open, even with kill switch engaged', async () => {
    let clock = Date.now();
    const bridge = makeBridge({ now: () => clock });
    await bridge.execute(makeOrder({ brackets: { stop_price: 0.7105, time_exit_at: new Date(clock + 1000).toISOString(), reduce_only: true } }));
    exchange.openPosition = true;
    expect(await bridge.processTimeExits()).toBe(0); // not due yet
    clock += 2000;
    bridge.engageKill('drill'); // risk-reducing exits must still run
    expect(await bridge.processTimeExits()).toBe(1);
    expect(exchange.calls).toContain('close');
    const events = bridge.drainEvents(0) as any[];
    expect(events.some((e) => e.type === 'TIME_EXIT_EXECUTED')).toBe(true);
    expect(await bridge.processTimeExits()).toBe(0); // retired, no double close
  });

  it('retires the exit without closing when the position is already gone', async () => {
    let clock = Date.now();
    const bridge = makeBridge({ now: () => clock });
    await bridge.execute(makeOrder({ brackets: { stop_price: 0.7105, time_exit_at: new Date(clock + 1000).toISOString(), reduce_only: true } }));
    exchange.openPosition = false; // stop already hit
    clock += 2000;
    expect(await bridge.processTimeExits()).toBe(0);
    const events = bridge.drainEvents(0) as any[];
    expect(events.some((e) => e.type === 'TIME_EXIT_SKIPPED_NO_POSITION')).toBe(true);
  });

  it('keeps the exit pending on exchange error and survives restart', async () => {
    let clock = Date.now();
    const bridge = makeBridge({ now: () => clock });
    await bridge.execute(makeOrder({ brackets: { stop_price: 0.7105, time_exit_at: new Date(clock + 1000).toISOString(), reduce_only: true } }));
    exchange.openPosition = true;
    exchange.failClose = true;
    clock += 2000;
    expect(await bridge.processTimeExits()).toBe(0); // failed, still pending
    const rebooted = makeBridge({ now: () => clock });
    exchange.failClose = false;
    expect(await rebooted.processTimeExits()).toBe(1); // pending exit persisted
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

  it('a torn trailing event line (power cut) does not block the drain', async () => {
    const bridge = makeBridge();
    await bridge.execute(makeOrder());
    fs.appendFileSync(path.join(dir, 'events_outbox.jsonl'), '{"type":"FILL","ts_seq');
    const all = bridge.drainEvents(0) as any[];
    expect(all.length).toBe(2); // intact events still drain
  });
});
