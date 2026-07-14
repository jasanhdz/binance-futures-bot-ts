import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Gen2Bridge } from './Gen2Bridge';
import { createGen2BridgeServer } from './Gen2BridgeServer';

const SECRET = 'server-secret';
const CID = 'gen2-20260711T202935Z';

let dir: string;
let server: http.Server;
let port: number;
let bridge: Gen2Bridge;

function sign(body: string, timestamp: string): string {
  return crypto.createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
}

function request(method: string, pathName: string, body: string, headers: Record<string, string> = {}): Promise<{ code: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathName, method, headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ code: res.statusCode || 0, json: JSON.parse(data) }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function signedRequest(method: string, pathName: string, body = ''): Promise<{ code: number; json: any }> {
  const ts = String(Date.now());
  return request(method, pathName, body, { 'X-GEN2-TIMESTAMP': ts, 'X-GEN2-SIGNATURE': sign(body, ts) });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen2-server-'));
  bridge = new Gen2Bridge({
    secret: SECRET,
    candidateId: CID,
    allowedSymbols: ['ADAUSDT'],
    stateDir: dir,
    executionEnabled: false,
    phaseOAllowOrders: false,
  });
  server = createGen2BridgeServer({ bridge, allowedSymbols: ['ADAUSDT'] });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function order(clientOrderId = 'GEN2-server-test') {
  return JSON.stringify({
    schema: 'gen2_decision_order_v1',
    candidate_id: CID,
    client_order_id: clientOrderId,
    signal_id: 'ADAUSDT-x',
    symbol: 'ADAUSDT',
    side: 'SHORT',
    quantity: 35,
    leverage: 3,
    margin_type: 'ISOLATED',
    brackets: { stop_price: 0.7105, time_exit_at: 'x', reduce_only: true },
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
}

describe('gen2 bridge http server', () => {
  it('refuses unsigned and badly signed requests', async () => {
    const unsigned = await request('GET', '/gen2/status', '');
    expect(unsigned.code).toBe(401);
    const ts = String(Date.now());
    const bad = await request('GET', '/gen2/status', '', { 'X-GEN2-TIMESTAMP': ts, 'X-GEN2-SIGNATURE': 'ffff' });
    expect(bad.code).toBe(401);
    expect(bad.json.reason).toBe('SIGNATURE_INVALID');
  });

  it('rejects a replayed request (same timestamp+signature)', async () => {
    const ts = String(Date.now());
    const sig = sign('', ts);
    const first = await request('GET', '/gen2/status', '', { 'X-GEN2-TIMESTAMP': ts, 'X-GEN2-SIGNATURE': sig });
    expect(first.code).toBe(200);
    const replay = await request('GET', '/gen2/status', '', { 'X-GEN2-TIMESTAMP': ts, 'X-GEN2-SIGNATURE': sig });
    expect(replay.code).toBe(401);
    expect(replay.json.reason).toBe('SIGNATURE_REPLAYED');
  });

  it('GET /gen2/status returns the full contract the brain expects', async () => {
    const res = await signedRequest('GET', '/gen2/status');
    expect(res.code).toBe(200);
    expect(res.json.schema).toBe('gen2_status_v1');
    expect(res.json.gen2_enabled).toBe(true);
    expect(res.json.phase_o_allow_orders).toBe(false);
    expect(res.json.execution_enabled).toBe(false);
    expect(res.json).toHaveProperty('available_balance');
    expect(res.json).toHaveProperty('open_positions');
  });

  it('POST /gen2/execute validates and acks (dry-run without exchange), duplicate detected', async () => {
    const body = order();
    const first = await signedRequest('POST', '/gen2/execute', body);
    expect(first.code).toBe(200);
    expect(first.json.status).toBe('ACCEPTED_DRYRUN');
    const dup = await signedRequest('POST', '/gen2/execute', body);
    expect(dup.json.status).toBe('DUPLICATE');
  });

  it('POST and GET /gen2/events drain by sequence', async () => {
    bridge.emitEvent('FILL', 'GEN2-e1', { fill_price: 1 });
    bridge.emitEvent('BRACKET_CONFIRMED', 'GEN2-e1', {});
    const viaGet = await signedRequest('GET', '/gen2/events?after=0');
    expect(viaGet.json.events.length).toBe(2);
    const viaPost = await signedRequest('POST', '/gen2/events', JSON.stringify({ after_sequence: 1 }));
    expect(viaPost.json.events.length).toBe(1);
    expect(viaPost.json.events[0].ts_sequence).toBe(2);
  });

  it('POST /gen2/kill engages the kill switch and blocks subsequent orders', async () => {
    const res = await signedRequest('POST', '/gen2/kill', JSON.stringify({ reason: 'remote-test' }));
    expect(res.json.status).toBe('KILL_ENGAGED');
    const blocked = await signedRequest('POST', '/gen2/execute', order('GEN2-after-kill'));
    expect(blocked.json.status).toBe('REJECTED');
    expect(blocked.json.reason).toBe('KILL_SWITCH_ENGAGED');
  });

  it('unknown route is refused', async () => {
    const res = await signedRequest('GET', '/gen2/nope');
    expect(res.code).toBe(404);
  });
});
