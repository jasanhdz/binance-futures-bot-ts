import type { AuditedResponse } from './binance-usdm-readonly-audit-client';

export const AUDIT_TEMPORAL_TOLERANCE_MS = 30_000;

export type AuditCompleteness =
  | 'COMPLETE'
  | 'INCOMPLETE_AUTHENTICATION'
  | 'INCOMPLETE_ENDPOINT_FAILURE'
  | 'INCOMPLETE_SCHEMA'
  | 'INCOMPLETE_TEMPORAL_COHERENCE'
  | 'INCOMPLETE_SURFACE_INCONSISTENCY';

export type PositionMode = 'ONE_WAY' | 'HEDGE';
export type OrderClassification =
  | 'REGULAR_ENTRY'
  | 'STOP_LOSS'
  | 'TAKE_PROFIT'
  | 'TRAILING_STOP'
  | 'REDUCE_ONLY'
  | 'CLOSE_POSITION'
  | 'CONDITIONAL_ALGO'
  | 'UNKNOWN';

export interface ActivePosition {
  symbol: string;
  position_side: string;
  position_amount: string;
  exposure_direction: 'LONG' | 'SHORT';
  entry_price: string;
  mark_price: string;
  notional: string;
  margin_type: 'ISOLATED' | 'CROSS';
  leverage: string;
  unrealized_profit: string;
}

export interface OpenOrderSummary {
  source: 'REGULAR' | 'ALGO';
  order_identity: string;
  symbol: string;
  side: string;
  position_side: string;
  order_type: string;
  classification: OrderClassification;
  reduce_only: boolean;
  close_position: boolean;
}

export interface ReconciledAudit {
  audit_completeness: AuditCompleteness;
  account_mode: PositionMode | 'UNKNOWN';
  active_positions: ActivePosition[];
  regular_orders: OpenOrderSummary[];
  algo_orders: OpenOrderSummary[];
  counters: {
    active_position_count: number;
    regular_open_order_count: number;
    algo_open_order_count: number;
    stop_order_count: number;
    take_profit_order_count: number;
    trailing_stop_order_count: number;
    reduce_only_order_count: number;
    close_position_order_count: number;
    unknown_order_count: number;
  };
  account_surface_consistency: 'PASS' | 'FAIL';
  failure_codes: string[];
  safe_retirement_exchange_gate: boolean;
}

export interface LocalStateSummary {
  state_file_count: number;
  managed_position_count: number;
  pending_order_count: number;
  mutation_in_flight: boolean;
  incomplete_state_count: number;
  managed_position_files: string[];
  pending_order_files: string[];
}

export type LocalExchangeConsistency =
  | 'CONSISTENT_FLAT'
  | 'CONSISTENT_ACTIVE_EXPOSURE'
  | 'LOCAL_EXCHANGE_STATE_INCONSISTENT'
  | 'LOCAL_STATE_INCOMPLETE'
  | 'MUTATION_IN_FLIGHT'
  | 'UNKNOWN';

export function reconcileLocalExchangeState(
  local: LocalStateSummary,
  exchange: ReconciledAudit,
): LocalExchangeConsistency {
  if (local.mutation_in_flight) return 'MUTATION_IN_FLIGHT';
  if (local.incomplete_state_count > 0 || local.state_file_count === 0)
    return 'LOCAL_STATE_INCOMPLETE';
  if (exchange.audit_completeness !== 'COMPLETE') return 'UNKNOWN';
  const localActive = local.managed_position_count > 0 || local.pending_order_count > 0;
  const exchangeActive =
    exchange.counters.active_position_count > 0 ||
    exchange.counters.regular_open_order_count > 0 ||
    exchange.counters.algo_open_order_count > 0;
  if (localActive !== exchangeActive) return 'LOCAL_EXCHANGE_STATE_INCONSISTENT';
  return localActive ? 'CONSISTENT_ACTIVE_EXPOSURE' : 'CONSISTENT_FLAT';
}

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

export function isExactDecimalZero(value: unknown): boolean {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new Error('AEGIS_AUDIT_DECIMAL_INVALID');
  }
  return /^[+-]?(?:0+(?:\.0*)?|\.0+)$/.test(value);
}

export function classifyPosition(
  raw: Record<string, unknown>,
  mode: PositionMode,
): ActivePosition | null {
  const amount = requiredDecimal(raw.positionAmt, 'positionAmt');
  if (isExactDecimalZero(amount)) return null;
  const side = requiredString(raw.positionSide, 'positionSide');
  if (mode === 'ONE_WAY' && side !== 'BOTH') throw new Error('AEGIS_AUDIT_POSITION_MODE_CONFLICT');
  if (mode === 'HEDGE' && !['LONG', 'SHORT'].includes(side)) {
    throw new Error('AEGIS_AUDIT_POSITION_MODE_CONFLICT');
  }
  const negative = amount.startsWith('-');
  const direction = mode === 'HEDGE' ? (side as 'LONG' | 'SHORT') : negative ? 'SHORT' : 'LONG';
  return {
    symbol: requiredString(raw.symbol, 'symbol'),
    position_side: side,
    position_amount: amount,
    exposure_direction: direction,
    entry_price: optionalDecimal(raw.entryPrice),
    mark_price: optionalDecimal(raw.markPrice),
    notional: optionalDecimal(raw.notional),
    margin_type: raw.isolated === true || raw.marginType === 'isolated' ? 'ISOLATED' : 'CROSS',
    leverage: optionalDecimal(raw.leverage),
    unrealized_profit: optionalDecimal(raw.unRealizedProfit ?? raw.unrealizedProfit),
  };
}

export function classifyOpenOrder(
  raw: Record<string, unknown>,
  source: 'REGULAR' | 'ALGO',
): OpenOrderSummary {
  const type = String(raw.type ?? raw.orderType ?? raw.algoType ?? 'UNKNOWN').toUpperCase();
  const reduceOnly = raw.reduceOnly === true || raw.reduceOnly === 'true';
  const closePosition = raw.closePosition === true || raw.closePosition === 'true';
  let classification: OrderClassification;
  if (closePosition) classification = 'CLOSE_POSITION';
  else if (reduceOnly) classification = 'REDUCE_ONLY';
  else if (type.includes('TRAILING')) classification = 'TRAILING_STOP';
  else if (type.includes('TAKE_PROFIT')) classification = 'TAKE_PROFIT';
  else if (type.includes('STOP')) classification = 'STOP_LOSS';
  else if (source === 'ALGO' && type !== 'UNKNOWN') classification = 'CONDITIONAL_ALGO';
  else if (source === 'REGULAR' && ['LIMIT', 'MARKET'].includes(type))
    classification = 'REGULAR_ENTRY';
  else classification = 'UNKNOWN';
  return {
    source,
    order_identity: String(
      raw.orderId ?? raw.algoId ?? raw.clientAlgoId ?? raw.clientOrderId ?? '',
    ),
    symbol: requiredString(raw.symbol, 'symbol'),
    side: requiredString(raw.side, 'side'),
    position_side: String(raw.positionSide ?? 'BOTH'),
    order_type: type,
    classification,
    reduce_only: reduceOnly,
    close_position: closePosition,
  };
}

export function reconcileAuditResponses(responses: {
  account: AuditedResponse;
  positions: AuditedResponse;
  mode: AuditedResponse;
  regularOrders: AuditedResponse;
  algoOrders: AuditedResponse;
}): ReconciledAudit {
  const failures: string[] = [];
  let completeness: AuditCompleteness = 'COMPLETE';
  const all = Object.values(responses);
  const times = all.flatMap((item) => [
    Date.parse(item.requested_at_utc),
    Date.parse(item.completed_at_utc),
  ]);
  if (
    times.some((value) => !Number.isFinite(value)) ||
    Math.max(...times) - Math.min(...times) > AUDIT_TEMPORAL_TOLERANCE_MS
  ) {
    completeness = 'INCOMPLETE_TEMPORAL_COHERENCE';
    failures.push('AEGIS_AUDIT_TEMPORAL_COHERENCE_FAILED');
  }

  try {
    const account = requiredObject(responses.account.value, 'account');
    const modeObject = requiredObject(responses.mode.value, 'mode');
    if (typeof modeObject.dualSidePosition !== 'boolean') throw new Error('mode.dualSidePosition');
    const mode: PositionMode = modeObject.dualSidePosition ? 'HEDGE' : 'ONE_WAY';
    const positionRows = requiredArray(responses.positions.value, 'positions');
    const regularRows = requiredArray(responses.regularOrders.value, 'regularOrders');
    const algoRows = requiredArray(responses.algoOrders.value, 'algoOrders');
    const activePositions = positionRows
      .map((row) => classifyPosition(requiredObject(row, 'position'), mode))
      .filter((row): row is ActivePosition => row !== null);
    const regularOrders = regularRows.map((row) =>
      classifyOpenOrder(requiredObject(row, 'order'), 'REGULAR'),
    );
    const algoOrders = algoRows.map((row) =>
      classifyOpenOrder(requiredObject(row, 'algoOrder'), 'ALGO'),
    );
    const allOrders = [...regularOrders, ...algoOrders];
    const identities = allOrders.map((order) => `${order.source}:${order.order_identity}`);
    if (
      identities.some((identity) => identity.endsWith(':')) ||
      new Set(identities).size !== identities.length
    ) {
      failures.push('AEGIS_LIVE_ACCOUNT_SURFACES_INCONSISTENT');
    }
    const accountPositionMargin = requiredDecimal(
      account.totalPositionInitialMargin,
      'totalPositionInitialMargin',
    );
    const accountOpenOrderMargin = requiredDecimal(
      account.totalOpenOrderInitialMargin,
      'totalOpenOrderInitialMargin',
    );
    if (!isExactDecimalZero(accountPositionMargin) && activePositions.length === 0) {
      failures.push('AEGIS_LIVE_ACCOUNT_SURFACES_INCONSISTENT');
    }
    if (!isExactDecimalZero(accountOpenOrderMargin) && allOrders.length === 0) {
      failures.push('AEGIS_LIVE_ACCOUNT_SURFACES_INCONSISTENT');
    }
    const uniqueFailures = [...new Set(failures)];
    const consistent = uniqueFailures.length === 0;
    if (!consistent && completeness === 'COMPLETE')
      completeness = 'INCOMPLETE_SURFACE_INCONSISTENCY';
    const count = (kind: OrderClassification) =>
      allOrders.filter((order) => order.classification === kind).length;
    const counters = {
      active_position_count: activePositions.length,
      regular_open_order_count: regularOrders.length,
      algo_open_order_count: algoOrders.length,
      stop_order_count: count('STOP_LOSS'),
      take_profit_order_count: count('TAKE_PROFIT'),
      trailing_stop_order_count: count('TRAILING_STOP'),
      reduce_only_order_count: count('REDUCE_ONLY'),
      close_position_order_count: count('CLOSE_POSITION'),
      unknown_order_count: count('UNKNOWN'),
    };
    return {
      audit_completeness: completeness,
      account_mode: mode,
      active_positions: activePositions,
      regular_orders: regularOrders,
      algo_orders: algoOrders,
      counters,
      account_surface_consistency: consistent ? 'PASS' : 'FAIL',
      failure_codes: uniqueFailures,
      safe_retirement_exchange_gate:
        completeness === 'COMPLETE' &&
        consistent &&
        activePositions.length === 0 &&
        allOrders.length === 0 &&
        counters.unknown_order_count === 0,
    };
  } catch (error) {
    return {
      audit_completeness: 'INCOMPLETE_SCHEMA',
      account_mode: 'UNKNOWN',
      active_positions: [],
      regular_orders: [],
      algo_orders: [],
      counters: {
        active_position_count: 0,
        regular_open_order_count: 0,
        algo_open_order_count: 0,
        stop_order_count: 0,
        take_profit_order_count: 0,
        trailing_stop_order_count: 0,
        reduce_only_order_count: 0,
        close_position_order_count: 0,
        unknown_order_count: 0,
      },
      account_surface_consistency: 'FAIL',
      failure_codes: [
        `AEGIS_AUDIT_SCHEMA_INVALID:${error instanceof Error ? error.message : 'unknown'}`,
      ],
      safe_retirement_exchange_gate: false,
    };
  }
}

function requiredObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(name);
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(name);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(name);
  return value;
}

function requiredDecimal(value: unknown, name: string): string {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw new Error(name);
  return value;
}

function optionalDecimal(value: unknown): string {
  return typeof value === 'string' && DECIMAL.test(value) ? value : 'NOT_PROVIDED';
}
