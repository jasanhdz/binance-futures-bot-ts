/**
 * GEN2 execution bridge — pure logic (transport-agnostic, fully testable).
 *
 * Aegis (Python) is the brain; this bridge is the ONLY execution path for the
 * Gen2 candidate. Fail-closed: invalid signature/timestamp, unknown schema,
 * disallowed symbol, expired order, kill switch, duplicate clientOrderId or a
 * missing exchange all refuse execution. Idempotency: a repeated clientOrderId
 * returns the original ack with status DUPLICATE and never re-executes.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { PositionOwnershipRegistry, StrategyContext } from '../execution/PositionOwnership';

export interface Gen2ExchangePort {
  ensureMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<void>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  marketOpen(
    symbol: string,
    side: 'LONG' | 'SHORT',
    quantity: number,
    clientOrderId?: string,
  ): Promise<{ orderId?: string | number; avgPrice?: number; executedQty?: number }>;
  placeStopClose(symbol: string, side: 'LONG' | 'SHORT', stopPrice: number, qty?: number): Promise<boolean>;
  marketClose(symbol: string, side: 'LONG' | 'SHORT', quantity: number): Promise<{ orderId?: string | number; avgPrice?: number }>;
  getUSDTBalance(): Promise<number>;
  hasOpenPosition(symbol: string, side: 'LONG' | 'SHORT' | 'ANY'): Promise<boolean>;
}

export interface Gen2BridgeConfig {
  secret: string;
  candidateId: string;
  allowedSymbols: string[];
  stateDir: string;
  executionEnabled: boolean;
  phaseOAllowOrders: boolean;
  maxClockSkewMs?: number;
  exchange?: Gen2ExchangePort;
  now?: () => number;
  /** Optional sink for every emitted execution event (e.g. Telegram). Never
   *  awaited on the hot path and its failures are swallowed by the caller. */
  onEvent?: (event: Record<string, unknown>) => void;
  /** Shared ownership registry file (defaults to logs/execution/position_ownership.json). */
  ownershipRegistryPath?: string;
}

export interface DecisionOrder {
  schema: string;
  candidate_id: string;
  client_order_id: string;
  signal_id: string;
  symbol: string;
  side: string;
  quantity: number;
  leverage: number;
  margin_type: string;
  brackets: { stop_price: number; time_exit_at: string; reduce_only: boolean };
  strategy_context?: {
    owner?: string;
    strategy?: string;
    exit_policy?: string;
    risk_policy?: string;
    notification_policy?: string;
  };
  expires_at: string;
}

export interface ExecutionAck {
  schema: 'gen2_execution_ack_v1';
  client_order_id: string;
  status: 'ACCEPTED' | 'ACCEPTED_DRYRUN' | 'REJECTED' | 'DUPLICATE';
  reason: string;
  exchange_order_id?: string;
  fill_price?: number;
  received_at: string;
}

interface PendingTimeExit {
  symbol: string;
  side: 'SHORT';
  quantity: number;
  time_exit_at: string;
}

interface BridgeState {
  processed: Record<string, ExecutionAck>;
  sequence: number;
  pending_time_exits?: Record<string, PendingTimeExit>;
}

export class Gen2Bridge {
  private state: BridgeState;
  private statePath: string;
  private killPath: string;
  private eventsPath: string;
  private ownership: PositionOwnershipRegistry;
  /** Anti-replay: accepted signatures within the clock-skew window are single-use. */
  private seenSignatures = new Map<string, number>();

  constructor(private cfg: Gen2BridgeConfig) {
    fs.mkdirSync(cfg.stateDir, { recursive: true });
    this.statePath = path.join(cfg.stateDir, 'bridge_state.json');
    this.killPath = path.join(cfg.stateDir, 'BRIDGE_KILL');
    this.eventsPath = path.join(cfg.stateDir, 'events_outbox.jsonl');
    // Shared ownership registry (same file the TS executor reads) so a Gen2
    // position can never be adopted/managed by Phase O.
    const repoRoot = path.resolve(__dirname, '..', '..');
    this.ownership = new PositionOwnershipRegistry(
      cfg.ownershipRegistryPath || path.join(repoRoot, 'logs', 'execution', 'position_ownership.json'),
    );
    this.state = fs.existsSync(this.statePath)
      ? JSON.parse(fs.readFileSync(this.statePath, 'utf-8'))
      : { processed: {}, sequence: 0 };
  }

  private registerOwnership(order: DecisionOrder): void {
    const ctx = order.strategy_context || {};
    const record: StrategyContext & { clientOrderId: string; symbol: string; side: 'LONG' | 'SHORT'; entryTimeMs: number } = {
      clientOrderId: order.client_order_id,
      owner: (ctx.owner as any) || 'GEN2',
      strategy: ctx.strategy || 'GEN2_EQM_TRRM',
      exitPolicy: ctx.exit_policy || 'GEN2_H12',
      riskPolicy: ctx.risk_policy || 'GEN2_EXPERIMENTAL',
      notificationPolicy: ctx.notification_policy || 'GEN2',
      symbol: order.symbol,
      side: order.side === 'LONG' ? 'LONG' : 'SHORT',
      entryTimeMs: this.nowMs(),
    };
    try {
      this.ownership.register(record);
    } catch {
      // registry write failure must not block execution; the GEN2- prefix still
      // identifies ownership even if the explicit record is missing.
    }
  }

  private nowMs(): number {
    return this.cfg.now ? this.cfg.now() : Date.now();
  }

  private persist(): void {
    const tmp = this.statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.statePath);
  }

  verifySignature(body: string, timestamp: string, signature: string): { ok: boolean; reason: string } {
    const now = this.nowMs();
    const skewLimit = this.cfg.maxClockSkewMs ?? 5000;
    const skew = Math.abs(now - Number(timestamp));
    if (!timestamp || Number.isNaN(Number(timestamp)) || skew > skewLimit) {
      return { ok: false, reason: 'TIMESTAMP_INVALID_OR_REPLAY' };
    }
    const expected = crypto.createHmac('sha256', this.cfg.secret).update(`${timestamp}.${body}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature || '');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'SIGNATURE_INVALID' };
    }
    for (const [sig, ts] of this.seenSignatures) {
      if (now - ts > skewLimit * 2) this.seenSignatures.delete(sig);
    }
    if (this.seenSignatures.has(signature)) {
      return { ok: false, reason: 'SIGNATURE_REPLAYED' };
    }
    this.seenSignatures.set(signature, now);
    return { ok: true, reason: 'OK' };
  }

  killEngaged(): boolean {
    return fs.existsSync(this.killPath);
  }

  engageKill(reason: string): void {
    fs.writeFileSync(this.killPath, JSON.stringify({ engaged_at: new Date(this.nowMs()).toISOString(), reason }));
    this.emitEvent('INCIDENT', 'bridge-kill', { reason });
  }

  emitEvent(type: string, clientOrderId: string, payload: Record<string, unknown>): void {
    this.state.sequence += 1;
    const event = {
      schema: 'gen2_execution_event_v1',
      type,
      client_order_id: clientOrderId,
      candidate_id: this.cfg.candidateId,
      payload,
      ts_sequence: this.state.sequence,
      emitted_at: new Date(this.nowMs()).toISOString(),
    };
    fs.appendFileSync(this.eventsPath, JSON.stringify(event) + '\n');
    this.persist();
    if (this.cfg.onEvent) {
      try {
        this.cfg.onEvent(event);
      } catch {
        // an observability sink must never break the execution/persist path
      }
    }
  }

  status(openPositions: unknown[] = [], availableBalance: number | null = null): Record<string, unknown> {
    return {
      schema: 'gen2_status_v1',
      gen2_enabled: true,
      execution_enabled: this.cfg.executionEnabled && !!this.cfg.exchange,
      phase_o_allow_orders: this.cfg.phaseOAllowOrders,
      kill_switch: this.killEngaged(),
      open_positions: openPositions,
      available_balance: availableBalance,
      processed_orders: Object.keys(this.state.processed).length,
      sequence: this.state.sequence,
      clock_ms: this.nowMs(),
    };
  }

  validateOrder(order: DecisionOrder): { ok: boolean; reason: string } {
    if (order.schema !== 'gen2_decision_order_v1') return { ok: false, reason: 'UNKNOWN_SCHEMA' };
    if (order.candidate_id !== this.cfg.candidateId) return { ok: false, reason: 'WRONG_CANDIDATE' };
    if (!order.client_order_id || !order.client_order_id.startsWith('GEN2-')) return { ok: false, reason: 'CLIENT_ORDER_ID_INVALID' };
    if (!this.cfg.allowedSymbols.includes(order.symbol)) return { ok: false, reason: 'SYMBOL_NOT_ALLOWED' };
    if (order.side !== 'SHORT') return { ok: false, reason: 'ONLY_SHORT_ALLOWED' };
    if (!(order.quantity > 0)) return { ok: false, reason: 'QUANTITY_INVALID' };
    if (!(order.leverage >= 1 && order.leverage <= 20)) return { ok: false, reason: 'LEVERAGE_INVALID' };
    if (order.margin_type !== 'ISOLATED') return { ok: false, reason: 'ISOLATED_REQUIRED' };
    if (!order.brackets || !(order.brackets.stop_price > 0) || order.brackets.reduce_only !== true) return { ok: false, reason: 'BRACKETS_INVALID' };
    if (new Date(order.expires_at).getTime() < this.nowMs()) return { ok: false, reason: 'ORDER_EXPIRED' };
    if (this.cfg.phaseOAllowOrders !== false) return { ok: false, reason: 'PHASE_O_NOT_PAUSED' };
    if (this.killEngaged()) return { ok: false, reason: 'KILL_SWITCH_ENGAGED' };
    return { ok: true, reason: 'OK' };
  }

  async execute(order: DecisionOrder): Promise<ExecutionAck> {
    const receivedAt = new Date(this.nowMs()).toISOString();
    const prior = this.state.processed[order.client_order_id];
    if (prior) {
      return { ...prior, status: 'DUPLICATE', reason: `ORIGINAL_${prior.status}`, received_at: receivedAt };
    }
    const ack = await this.executeFresh(order, receivedAt);
    this.state.processed[order.client_order_id] = ack;
    this.persist();
    return ack;
  }

  private async executeFresh(order: DecisionOrder, receivedAt: string): Promise<ExecutionAck> {
    const base = { schema: 'gen2_execution_ack_v1' as const, client_order_id: order.client_order_id, received_at: receivedAt };
    const valid = this.validateOrder(order);
    if (!valid.ok) {
      return { ...base, status: 'REJECTED', reason: valid.reason };
    }
    if (!this.cfg.executionEnabled || !this.cfg.exchange) {
      return { ...base, status: 'ACCEPTED_DRYRUN', reason: 'EXECUTION_DISABLED_VALIDATED_ONLY' };
    }
    const ex = this.cfg.exchange;
    try {
      if (await ex.hasOpenPosition(order.symbol, 'ANY')) {
        return { ...base, status: 'REJECTED', reason: 'POSITION_ALREADY_OPEN' };
      }
      await ex.ensureMarginType(order.symbol, 'ISOLATED');
      await ex.setLeverage(order.symbol, order.leverage);
      // Register ownership BEFORE the position exists so the TS executor can
      // never see a Gen2 position without its GEN2 owner record.
      this.registerOwnership(order);
      const t0 = this.nowMs();
      const fill = await ex.marketOpen(order.symbol, 'SHORT', order.quantity, order.client_order_id);
      const latency = this.nowMs() - t0;
      this.emitEvent('FILL', order.client_order_id, {
        fill_price: fill.avgPrice,
        fill_qty: fill.executedQty ?? order.quantity,
        latency_ms: latency,
        exchange_order_id: String(fill.orderId ?? ''),
      });
      const stopOk = await ex.placeStopClose(order.symbol, 'SHORT', order.brackets.stop_price, order.quantity);
      if (!stopOk) {
        this.engageKill('CRITICAL_EXECUTION_FAILURE_BRACKET');
        this.emitEvent('BRACKET_FAILED', order.client_order_id, { stop_price: order.brackets.stop_price });
        return { ...base, status: 'ACCEPTED', reason: 'FILLED_BUT_BRACKET_FAILED_KILL_ENGAGED', exchange_order_id: String(fill.orderId ?? ''), fill_price: fill.avgPrice };
      }
      this.state.pending_time_exits = this.state.pending_time_exits || {};
      this.state.pending_time_exits[order.client_order_id] = {
        symbol: order.symbol,
        side: 'SHORT',
        quantity: fill.executedQty ?? order.quantity,
        time_exit_at: order.brackets.time_exit_at,
      };
      this.emitEvent('BRACKET_CONFIRMED', order.client_order_id, { stop_price: order.brackets.stop_price, time_exit_at: order.brackets.time_exit_at });
      return { ...base, status: 'ACCEPTED', reason: 'FILLED_AND_BRACKETED', exchange_order_id: String(fill.orderId ?? ''), fill_price: fill.avgPrice };
    } catch (err: any) {
      this.emitEvent('ORDER_REJECTED', order.client_order_id, { error: String(err?.message || err) });
      return { ...base, status: 'REJECTED', reason: `EXCHANGE_ERROR:${String(err?.message || err).slice(0, 120)}` };
    }
  }

  /**
   * Execute due H12 time exits. Risk-REDUCING, so it runs even with the kill
   * switch engaged. If the position is already gone (stop hit / manual close)
   * the pending exit is retired with TIME_EXIT_SKIPPED_NO_POSITION. Exchange
   * errors keep the exit pending and are retried on the next tick.
   */
  async processTimeExits(): Promise<number> {
    const pending = this.state.pending_time_exits || {};
    const ex = this.cfg.exchange;
    let executed = 0;
    for (const [clientOrderId, exit] of Object.entries(pending)) {
      if (new Date(exit.time_exit_at).getTime() > this.nowMs()) continue;
      if (!ex) {
        delete pending[clientOrderId];
        this.emitEvent('TIME_EXIT_SKIPPED_NO_POSITION', clientOrderId, { reason: 'NO_EXCHANGE_DRYRUN' });
        continue;
      }
      try {
        if (!(await ex.hasOpenPosition(exit.symbol, 'ANY'))) {
          delete pending[clientOrderId];
          this.emitEvent('TIME_EXIT_SKIPPED_NO_POSITION', clientOrderId, { symbol: exit.symbol });
          // PnL unknown here (stop or manual close happened on the exchange):
          // never fabricate it — the operator reconciles it (runbook §3.5).
          this.emitEvent('POSITION_CLOSED', clientOrderId, { symbol: exit.symbol, realized_pnl: null, reason: 'CLOSED_BY_STOP_OR_MANUAL_PNL_UNKNOWN' });
          continue;
        }
        const close = await ex.marketClose(exit.symbol, exit.side, exit.quantity);
        delete pending[clientOrderId];
        executed += 1;
        this.emitEvent('TIME_EXIT_EXECUTED', clientOrderId, {
          symbol: exit.symbol,
          close_price: close.avgPrice,
          exchange_order_id: String(close.orderId ?? ''),
          scheduled_at: exit.time_exit_at,
        });
        const entryPrice = this.state.processed[clientOrderId]?.fill_price;
        const pnl =
          entryPrice && close.avgPrice ? (entryPrice - close.avgPrice) * exit.quantity : null; // SHORT: entry - exit
        this.emitEvent('POSITION_CLOSED', clientOrderId, {
          symbol: exit.symbol,
          realized_pnl: pnl,
          estimate: true,
          reason: pnl === null ? 'TIME_EXIT_PNL_UNKNOWN' : 'TIME_EXIT',
        });
      } catch (err: any) {
        this.emitEvent('INCIDENT', clientOrderId, { type: 'TIME_EXIT_FAILED_WILL_RETRY', error: String(err?.message || err).slice(0, 120) });
      }
    }
    return executed;
  }

  drainEvents(afterSequence: number): unknown[] {
    if (!fs.existsSync(this.eventsPath)) return [];
    const events: unknown[] = [];
    for (const line of fs.readFileSync(this.eventsPath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.ts_sequence > afterSequence) events.push(e);
      } catch {
        // torn trailing line after a power cut: skipping keeps the drain alive;
        // the event's payload is also reflected in bridge_state/processed.
      }
    }
    return events;
  }
}
