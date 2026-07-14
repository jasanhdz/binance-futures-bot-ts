/**
 * GEN2 bridge HTTP transport.
 *
 * Aegis (Python) -> HTTP -> this server -> Gen2Bridge (pure logic) -> Binance.
 * Every route requires a valid HMAC signature over `<timestamp>.<rawBody>`
 * (X-GEN2-TIMESTAMP / X-GEN2-SIGNATURE) with clock-skew and single-use
 * signature anti-replay enforced by the bridge. Fail-closed: anything
 * unsigned, malformed or unknown is refused with a recorded reason.
 *
 * Endpoints:
 *   GET  /gen2/status                 -> bridge status + available balance
 *   POST /gen2/execute                -> DecisionOrder -> ExecutionAck
 *   GET  /gen2/events?after=N         -> execution events with ts_sequence > N
 *   POST /gen2/events {after_sequence}-> same drain, POST form
 *   POST /gen2/kill {reason, action}  -> engage kill switch (block new orders)
 */
import http from 'http';
import { DecisionOrder, Gen2Bridge, Gen2ExchangePort } from './Gen2Bridge';

export interface Gen2BridgeServerDeps {
  bridge: Gen2Bridge;
  allowedSymbols: string[];
  exchange?: Gen2ExchangePort;
}

function sendJson(res: http.ServerResponse, code: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function collectStatus(deps: Gen2BridgeServerDeps): Promise<Record<string, unknown>> {
  let openPositions: unknown[] = [];
  let availableBalance: number | null = null;
  if (deps.exchange) {
    // Fail-closed: if the exchange cannot answer, report null balance and a
    // sentinel open position so the brain refuses to size orders.
    try {
      availableBalance = await deps.exchange.getUSDTBalance();
      const flags = await Promise.all(
        deps.allowedSymbols.map(async (s) => ((await deps.exchange!.hasOpenPosition(s, 'ANY')) ? s : null)),
      );
      openPositions = flags.filter(Boolean);
    } catch (err: any) {
      availableBalance = null;
      openPositions = [{ error: `EXCHANGE_STATUS_UNAVAILABLE:${String(err?.message || err).slice(0, 80)}` }];
    }
  }
  return deps.bridge.status(openPositions, availableBalance);
}

export function createGen2BridgeServer(deps: Gen2BridgeServerDeps): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const raw = await readBody(req);
      const timestamp = String(req.headers['x-gen2-timestamp'] || '');
      const signature = String(req.headers['x-gen2-signature'] || '');
      const auth = deps.bridge.verifySignature(raw, timestamp, signature);
      if (!auth.ok) {
        sendJson(res, 401, { status: 'REJECTED', reason: auth.reason });
        return;
      }
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /gen2/status') {
        sendJson(res, 200, await collectStatus(deps));
        return;
      }
      if (route === 'POST /gen2/execute') {
        const order = JSON.parse(raw) as DecisionOrder;
        const ack = await deps.bridge.execute(order);
        sendJson(res, 200, ack);
        return;
      }
      if (route === 'GET /gen2/events' || route === 'POST /gen2/events') {
        const after =
          route === 'GET /gen2/events'
            ? Number(url.searchParams.get('after') || 0)
            : Number((JSON.parse(raw || '{}') as { after_sequence?: number }).after_sequence || 0);
        if (Number.isNaN(after) || after < 0) {
          sendJson(res, 400, { status: 'REJECTED', reason: 'AFTER_SEQUENCE_INVALID' });
          return;
        }
        sendJson(res, 200, { schema: 'gen2_events_page_v1', after_sequence: after, events: deps.bridge.drainEvents(after) });
        return;
      }
      if (route === 'POST /gen2/kill') {
        const body = JSON.parse(raw || '{}') as { reason?: string };
        deps.bridge.engageKill(body.reason || 'REMOTE_KILL');
        sendJson(res, 200, { status: 'KILL_ENGAGED', reason: body.reason || 'REMOTE_KILL' });
        return;
      }
      sendJson(res, 404, { status: 'REJECTED', reason: 'UNKNOWN_ROUTE' });
    } catch (err: any) {
      sendJson(res, 500, { status: 'REJECTED', reason: `INTERNAL:${String(err?.message || err).slice(0, 120)}` });
    }
  });
}
