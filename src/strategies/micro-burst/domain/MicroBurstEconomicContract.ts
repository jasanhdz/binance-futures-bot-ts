import type { OrderBookDepthLevel } from '../../../app/ports/MarketData';
import type { Side } from '../../../core/types';

export type EconomicDataQuality = 'ACTUAL' | 'ESTIMATED' | 'DERIVED';

export interface EconomicDatum<T> {
  value: T;
  source: string;
  observedAtMs: number;
  receivedAtMs?: number;
  quality: EconomicDataQuality;
}

export type EconomicUnavailableReason =
  | 'MISSING_INPUT'
  | 'INVALID_INPUT'
  | 'STALE_INPUT'
  | 'FUTURE_INPUT'
  | 'INSUFFICIENT_DEPTH'
  | 'UNSUPPORTED_PRICE_BASIS';

export type EconomicAvailability<T> =
  | { status: 'AVAILABLE'; value: T }
  | {
      status: 'UNAVAILABLE';
      reason: EconomicUnavailableReason;
      missing: readonly string[];
    };

export interface MicroBurstEconomicExecution {
  price: EconomicDatum<number>;
  quantity: EconomicDatum<number>;
  depth?: EconomicDatum<readonly OrderBookDepthLevel[]>;
  slippageBps?: EconomicDatum<number>;
  /** True when price is already executable/VWAP and includes slippage. */
  priceIncludesSlippage: boolean;
}

export interface MicroBurstEconomicInput {
  asOfMs: number;
  side: Side;
  entry: MicroBurstEconomicExecution;
  exit: MicroBurstEconomicExecution;
  funding: EconomicDatum<number>;
  entryCommission: EconomicDatum<number>;
  exitCommission: EconomicDatum<number>;
  structuralInvalidationPrice: EconomicDatum<number>;
  favorableObstaclePrice: EconomicDatum<number>;
  maxAgeMs: number;
}

export interface MicroBurstEconomicValueProvenance {
  source: string;
  observedAtMs: number;
  receivedAtMs: number | null;
  quality: EconomicDataQuality;
}

export interface MicroBurstEconomicResult {
  status: 'AVAILABLE';
  side: Side;
  quantity: number;
  quantityCovered: true;
  entryPrice: number;
  exitPrice: number;
  executableExitPrice: number;
  grossPnlUsdt: number;
  netPnlUsdt: number;
  entryCommissionUsdt: number;
  exitCommissionUsdt: number;
  fundingUsdt: number;
  /** Diagnostic only. Already included in effective prices, never subtracted twice. */
  slippageUsdt: number;
  riskToInvalidationUsdt: number;
  favorablePathGrossUsdt: number;
  favorablePathNetUsdt: number;
  breakEvenExitPrice: number;
  incremental: {
    /** Baseline from the current executable liquidation value; excludes sunk entry costs. */
    closeNowNetUsdt: number;
    riskToInvalidationUsdt: number;
    favorablePathNetUsdt: number;
  };
  provenance: Readonly<Record<string, MicroBurstEconomicValueProvenance>>;
}

export interface MicroBurstUnavailableResult {
  status: 'UNAVAILABLE';
  reason: EconomicUnavailableReason;
  missing: readonly string[];
}

const BPS = 10_000;

function unavailable(
  reason: EconomicUnavailableReason,
  ...missing: string[]
): MicroBurstUnavailableResult {
  return { status: 'UNAVAILABLE', reason, missing };
}

function validDatum<T>(datum: EconomicDatum<T> | undefined, name: string, asOfMs: number, maxAgeMs: number): MicroBurstUnavailableResult | null {
  if (!datum) return unavailable('MISSING_INPUT', name);
  if (!Number.isFinite(datum.observedAtMs) || datum.observedAtMs > asOfMs) {
    return unavailable(datum.observedAtMs > asOfMs ? 'FUTURE_INPUT' : 'INVALID_INPUT', name);
  }
  if (asOfMs - datum.observedAtMs > maxAgeMs) return unavailable('STALE_INPUT', name);
  return null;
}

function validNumber(datum: EconomicDatum<number>, name: string): MicroBurstUnavailableResult | null {
  return Number.isFinite(datum.value)
    ? null
    : unavailable('INVALID_INPUT', name);
}

function adversePrice(price: number, side: Side, slippageBps: number, entry: boolean): number {
  const direction = entry
    ? (side === 'LONG' ? 1 : -1)
    : (side === 'LONG' ? -1 : 1);
  return price * (1 + direction * slippageBps / BPS);
}

function sidePnl(side: Side, entryPrice: number, exitPrice: number, quantity: number): number {
  return (side === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice) * quantity;
}

function provenance(datum: EconomicDatum<unknown>): MicroBurstEconomicValueProvenance {
  return {
    source: datum.source,
    observedAtMs: datum.observedAtMs,
    receivedAtMs: datum.receivedAtMs ?? null,
    quality: datum.quality,
  };
}

/** Resolves a complete executable VWAP without inventing uncovered quantity. */
export function resolveMicroBurstExecutablePrice(input: {
  side: Side;
  quantity: number;
  depth: readonly OrderBookDepthLevel[];
  observedAtMs: number;
  asOfMs: number;
  maxAgeMs: number;
}): EconomicAvailability<number> {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    return unavailable('INVALID_INPUT', 'quantity');
  }
  if (!Number.isFinite(input.observedAtMs) || input.observedAtMs > input.asOfMs) {
    return unavailable(input.observedAtMs > input.asOfMs ? 'FUTURE_INPUT' : 'INVALID_INPUT', 'depth');
  }
  if (input.asOfMs - input.observedAtMs > input.maxAgeMs) {
    return unavailable('STALE_INPUT', 'depth');
  }
  let remaining = input.quantity;
  let notional = 0;
  let previous: number | null = null;
  for (const level of input.depth) {
    if (!Number.isFinite(level.price) || !Number.isFinite(level.qty) || level.price <= 0 || level.qty < 0) {
      return unavailable('INVALID_INPUT', 'depth');
    }
    if (previous !== null && (input.side === 'LONG' ? level.price > previous : level.price < previous)) {
      return unavailable('INVALID_INPUT', 'depth_order');
    }
    const taken = Math.min(remaining, level.qty);
    notional += taken * level.price;
    remaining -= taken;
    previous = level.price;
    if (remaining <= 0) break;
  }
  if (remaining > 0) return unavailable('INSUFFICIENT_DEPTH', 'depth');
  return { status: 'AVAILABLE', value: notional / input.quantity };
}

/** Pure shared economic contract for entry, exit research, and comparison. */
export function calculateMicroBurstEconomicContract(
  input: MicroBurstEconomicInput,
): EconomicAvailability<MicroBurstEconomicResult> {
  if (!Number.isFinite(input.asOfMs) || !Number.isFinite(input.maxAgeMs) || input.maxAgeMs < 0) {
    return unavailable('INVALID_INPUT', 'clock');
  }
  const required: Array<[EconomicDatum<unknown> | undefined, string]> = [
    [input.entry.price, 'entry.price'],
    [input.entry.quantity, 'entry.quantity'],
    [input.exit.price, 'exit.price'],
    [input.exit.quantity, 'exit.quantity'],
    [input.funding, 'funding'],
    [input.entryCommission, 'entryCommission'],
    [input.exitCommission, 'exitCommission'],
    [input.structuralInvalidationPrice, 'structuralInvalidationPrice'],
    [input.favorableObstaclePrice, 'favorableObstaclePrice'],
  ];
  for (const [datum, name] of required) {
    const issue = validDatum(datum, name, input.asOfMs, input.maxAgeMs);
    if (issue) return issue;
  }
  for (const [datum, name] of required) {
    if (validNumber(datum as EconomicDatum<number>, name)) return validNumber(datum as EconomicDatum<number>, name)!;
  }
  if (input.entry.quantity.value !== input.exit.quantity.value || input.entry.quantity.value <= 0) {
    return unavailable('INVALID_INPUT', 'quantity');
  }
  const quantity = input.entry.quantity.value;
  const entryBase = input.entry.price.value;
  const exitBase = input.exit.price.value;
  if (entryBase <= 0 || exitBase <= 0 || input.entryCommission.value < 0 || input.exitCommission.value < 0) {
    return unavailable('INVALID_INPUT', 'price_or_commission');
  }
  if (!input.entry.priceIncludesSlippage && !input.entry.slippageBps) {
    return unavailable('MISSING_INPUT', 'entry.slippageBps');
  }
  if (!input.exit.priceIncludesSlippage && !input.exit.slippageBps) {
    return unavailable('MISSING_INPUT', 'exit.slippageBps');
  }
  const entrySlippage = input.entry.slippageBps?.value ?? 0;
  const exitSlippage = input.exit.slippageBps?.value ?? 0;
  if (![entrySlippage, exitSlippage].every(Number.isFinite) || entrySlippage < 0 || exitSlippage < 0) {
    return unavailable('INVALID_INPUT', 'slippage');
  }
  if (input.entry.depth) {
    const depthIssue = validDatum(input.entry.depth, 'entry.depth', input.asOfMs, input.maxAgeMs);
    if (depthIssue) return depthIssue;
  }
  let executableExit = exitBase;
  if (input.exit.depth) {
    const depth = resolveMicroBurstExecutablePrice({
      side: input.side,
      quantity,
      depth: input.exit.depth.value,
      observedAtMs: input.exit.depth.observedAtMs,
      asOfMs: input.asOfMs,
      maxAgeMs: input.maxAgeMs,
    });
    if (depth.status === 'UNAVAILABLE') return depth;
    executableExit = depth.value;
  }
  const effectiveEntry = input.entry.priceIncludesSlippage
    ? entryBase
    : adversePrice(entryBase, input.side, entrySlippage, true);
  executableExit = input.exit.priceIncludesSlippage
    ? executableExit
    : adversePrice(executableExit, input.side, exitSlippage, false);
  const grossPnlUsdt = sidePnl(input.side, effectiveEntry, executableExit, quantity);
  const netPnlUsdt = grossPnlUsdt - input.entryCommission.value - input.exitCommission.value + input.funding.value;
  const slippageUsdt = sidePnl(input.side, effectiveEntry, entryBase, quantity) +
    sidePnl(input.side, exitBase, executableExit, quantity);
  const riskToInvalidationUsdt = Math.max(0, sidePnl(
    input.side,
    executableExit,
    input.structuralInvalidationPrice.value,
    quantity,
  ) * -1);
  const favorablePathGrossUsdt = Math.max(0, sidePnl(
    input.side,
    executableExit,
    input.favorableObstaclePrice.value,
    quantity,
  ));
  const favorablePathNetUsdt = favorablePathGrossUsdt - input.exitCommission.value;
  const fixedCosts = input.entryCommission.value + input.exitCommission.value - input.funding.value;
  const breakEvenExitPrice = input.side === 'LONG'
    ? effectiveEntry + fixedCosts / quantity
    : effectiveEntry - fixedCosts / quantity;
  return {
    status: 'AVAILABLE',
    value: {
      status: 'AVAILABLE',
      side: input.side,
      quantity,
      quantityCovered: true,
      entryPrice: effectiveEntry,
      exitPrice: executableExit,
      executableExitPrice: executableExit,
      grossPnlUsdt,
      netPnlUsdt,
      entryCommissionUsdt: input.entryCommission.value,
      exitCommissionUsdt: input.exitCommission.value,
      fundingUsdt: input.funding.value,
      slippageUsdt,
      riskToInvalidationUsdt,
      favorablePathGrossUsdt,
      favorablePathNetUsdt,
      breakEvenExitPrice,
      incremental: {
        closeNowNetUsdt: -input.exitCommission.value,
        riskToInvalidationUsdt,
        favorablePathNetUsdt,
      },
      provenance: {
        entryPrice: provenance(input.entry.price),
        entryQuantity: provenance(input.entry.quantity),
        exitPrice: provenance(input.exit.price),
        exitQuantity: provenance(input.exit.quantity),
        ...(input.exit.depth ? { exitDepth: provenance(input.exit.depth) } : {}),
        ...(input.entry.slippageBps ? { entrySlippage: provenance(input.entry.slippageBps) } : {}),
        ...(input.exit.slippageBps ? { exitSlippage: provenance(input.exit.slippageBps) } : {}),
        entryCommission: provenance(input.entryCommission),
        exitCommission: provenance(input.exitCommission),
        funding: provenance(input.funding),
        structuralInvalidationPrice: provenance(input.structuralInvalidationPrice),
        favorableObstaclePrice: provenance(input.favorableObstaclePrice),
      },
    },
  };
}

export function calculateSignedReturnBps(side: Side, entryPrice: number, exitPrice: number): number {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || entryPrice <= 0 || exitPrice <= 0) {
    return Number.NaN;
  }
  return sidePnl(side, entryPrice, exitPrice, 1) / entryPrice * BPS;
}

export function roundEconomicAmount(value: number, decimals = 8): number {
  if (!Number.isFinite(value) || !Number.isInteger(decimals) || decimals < 0) return Number.NaN;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
