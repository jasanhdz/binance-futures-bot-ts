import path from 'path';
import { promises as fs } from 'fs';
import { Logger } from '../../app/ports/Logger';
import { StrategyId } from '../../domain/strategy/StrategyIdentity';

export type HistoryStrategy = StrategyId;

export type StrategyProvenanceFields = {
  strategy_version?: string;
  strategy_hash?: string;
  config_hash?: string;
  code_commit_sha?: string;
};

export type StrategyTradeOwnershipFields = {
  owner: 'AEGIS' | 'EXTERNAL' | 'UNKNOWN';
  origin: 'BOT' | 'MANUAL_EXTERNAL' | 'UNKNOWN';
  ownership_status: 'VERIFIED' | 'TAINTED' | 'UNKNOWN';
  eligible_for_bot_metrics: boolean;
  exclusion_reason: string | null;
};

export type StrategyVotes = {
  long?: number;
  short?: number;
  neutral?: number;
};

export type StrategySignalHistoryInput = StrategyProvenanceFields & {
  timestamp?: string;
  signal_id?: string;
  portfolio_session_id?: string;
  symbol: string;
  strategy: HistoryStrategy;
  mode: string;
  price?: number;
  raw_action?: string;
  gated_action?: string;
  final_action?: string;
  reason?: string;
  turbo_score?: number;
  confidence?: string;
  votes?: StrategyVotes;
  recent_scores?: Record<string, unknown>;
  freshness?: Record<string, unknown>;
  gate_allowed?: boolean;
  gate_reason?: string;
  gated_blocked_by?: string | null;
  executed?: boolean;
  trade_id?: string;
  leverage?: number;
  position_fraction?: number;
  stop_roe?: number;
  take_profit_roe?: number;
  trailing_activation_roe?: number;
  trailing_callback_roe?: number;
  metadata?: Record<string, unknown>;
};

export type StrategyTradeOpenInput = StrategyProvenanceFields &
  StrategyTradeOwnershipFields & {
    timestamp?: string;
    trade_id: string;
    portfolio_session_id?: string;
    symbol: string;
    strategy: HistoryStrategy;
    mode: string;
    side: 'LONG' | 'SHORT';
    opened_at: string;
    entry_price: number;
    quantity: number;
    leverage: number;
    position_fraction: number;
    margin_estimated?: number;
    notional_estimated?: number;
    turbo_score?: number;
    votes?: Record<string, unknown>;
    stop_roe?: number;
    take_profit_roe?: number;
    trailing_activation_roe?: number;
    trailing_callback_roe?: number;
    sl_price?: number;
    tp_price?: number;
    brackets_confirmed?: boolean;
    status: 'OPEN';
    metadata?: Record<string, unknown>;
  };

export type StrategyTradeCloseInput = StrategyProvenanceFields &
  StrategyTradeOwnershipFields & {
    timestamp?: string;
    trade_id: string;
    portfolio_session_id?: string;
    symbol: string;
    strategy: HistoryStrategy;
    mode: string;
    side?: 'LONG' | 'SHORT';
    opened_at?: string;
    closed_at: string;
    entry_price?: number;
    exit_price?: number;
    quantity?: number;
    leverage?: number;
    position_fraction?: number;
    exit_reason: string;
    pnl_usdt?: number;
    roe?: number;
    fees_estimated?: number;
    net_pnl_usdt?: number;
    duration_minutes?: number;
    mfe_roe?: number;
    mae_roe?: number;
    max_drawdown_roe?: number;
    status: 'CLOSED';
    metadata?: Record<string, unknown>;
  };

export type StrategyTradeEventInput = StrategyProvenanceFields & {
  timestamp?: string;
  trade_id?: string;
  portfolio_session_id?: string;
  symbol: string;
  strategy: HistoryStrategy;
  mode: string;
  event: string;
  price?: number;
  roe?: number;
  old_stop?: number;
  new_stop?: number;
  old_tp?: number;
  new_tp?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type StrategyAccountSnapshotInput = {
  timestamp?: string;
  portfolio_session_id?: string;
  mode: string;
  wallet_balance?: number;
  available_balance?: number;
  unrealized_pnl?: number;
  daily_pnl_pct?: number;
  trades_today?: number;
  consecutive_losses?: number;
  open_positions_count?: number;
  total_margin_used?: number;
  total_notional?: number;
  symbols?: Array<{
    symbol: string;
    position_open?: boolean;
    side?: 'LONG' | 'SHORT';
    entry_price?: number;
    mark_price?: number;
    roe?: number;
    unrealized_pnl?: number;
    margin_used?: number;
    notional?: number;
  }>;
  portfolio_exposure?: {
    long_symbols?: number;
    short_symbols?: number;
    total_symbols?: number;
    total_margin_used?: number;
    total_notional?: number;
    estimated_correlation_bucket?: string;
  };
  metadata?: Record<string, unknown>;
};

type HistoryKind = 'signals' | 'trades' | 'trade_events' | 'account_snapshots';

export class StrategyHistoryLogger {
  private readonly baseDir: string;
  private readonly logger?: Logger;

  private readonly filePrefixes: Record<HistoryKind, string>;
  private readonly writeFailureMessage: string;

  constructor(
    options: {
      baseDir?: string;
      logger?: Logger;
      filePrefixes?: Partial<Record<HistoryKind, string>>;
      writeFailureMessage?: string;
    } = {},
  ) {
    this.baseDir = options.baseDir ?? path.join(process.cwd(), 'logs', 'strategy');
    this.logger = options.logger;
    this.writeFailureMessage = options.writeFailureMessage ?? 'strategy_history_write_failed';
    this.filePrefixes = {
      signals: 'signals',
      trades: 'trades',
      trade_events: 'trade_events',
      account_snapshots: 'account_snapshots',
      ...options.filePrefixes,
    };
  }

  async logSignal(input: StrategySignalHistoryInput): Promise<void> {
    await this.writeJsonl('signals', input);
  }

  async logTradeOpen(input: StrategyTradeOpenInput): Promise<void> {
    await this.writeJsonl('trades', input);
  }

  async logTradeClose(input: StrategyTradeCloseInput): Promise<void> {
    await this.writeJsonl('trades', input);
  }

  async logTradeEvent(input: StrategyTradeEventInput): Promise<void> {
    await this.writeJsonl('trade_events', input);
  }

  async logAccountSnapshot(input: StrategyAccountSnapshotInput): Promise<void> {
    await this.writeJsonl('account_snapshots', input);
  }

  private async writeJsonl(kind: HistoryKind, input: Record<string, unknown>): Promise<void> {
    try {
      const timestamp =
        typeof input.timestamp === 'string' && input.timestamp.length > 0
          ? input.timestamp
          : new Date().toISOString();
      const record = sanitizeJsonValue({ timestamp, ...input });
      const line = stringifyRecord(record);
      await fs.mkdir(this.baseDir, { recursive: true });
      await fs.appendFile(this.filePath(kind, timestamp), `${line}\n`, 'utf8');
    } catch (error) {
      this.warn(this.writeFailureMessage, error);
    }
  }

  private filePath(kind: HistoryKind, timestamp: string): string {
    const date = dateFromTimestamp(timestamp);
    return path.join(this.baseDir, `${this.filePrefixes[kind]}_${date}.jsonl`);
  }

  private warn(message: string, error: unknown): void {
    const payload = { error: String(error) };
    if (this.logger) {
      this.logger.warn(message, payload);
      return;
    }
    console.warn(message, payload);
  }
}

export function sanitizeJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol')
    return undefined;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item, seen));
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeJsonValue(nested, seen);
      if (sanitized !== undefined) output[key] = sanitized;
    }
    seen.delete(value);
    return output;
  }
  return String(value);
}

function dateFromTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return formatDate(new Date());
  return formatDate(date);
}

function formatDate(timestamp: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${timestamp.getUTCFullYear()}-${pad(timestamp.getUTCMonth() + 1)}-${pad(timestamp.getUTCDate())}`;
}

function stringifyRecord(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      serialization_error: String(error),
    });
  }
}
