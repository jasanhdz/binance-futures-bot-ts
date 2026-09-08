import {
  calculateMarginBudgetSizing,
  type MarginBudgetSizingResult,
  type QuantityFilters,
} from '../../../core/risk/SizingEngine';
import type { StrategyExecutionIntent } from '../../../core/strategy/StrategyExecution';
import { validateMicroBurstEntryMarket } from './MicroBurstEntryMarketGuard';
import type { MicroBurstConfig, OrderBookSnapshot } from './MicroBurstTypes';

export interface MicroBurstLossBudgetInput extends QuantityFilters {
  sizingMode?: 'LOSS_BUDGET';
  intent: StrategyExecutionIntent;
  now: number;
  book: OrderBookSnapshot | undefined;
  marginBudget: number;
  /** Required USDT budget approved independently of margin allocation and leverage. */
  lossBudget: number;
  approvedLeverageCap: number;
  /** Conservative liquidation boundary supplied for this account/tier, not 1/leverage. */
  liquidationPrice: number;
  stopStressBps: number;
  residualCostBps: number;
  maxQuantity?: number;
}

export interface MicroBurstMarginFractionInput
  extends Omit<MicroBurstLossBudgetInput, 'sizingMode' | 'marginBudget' | 'lossBudget'> {
  sizingMode: 'MARGIN_FRACTION';
  /** Available collateral, not total wallet equity or position notional. */
  availableWallet: number;
  marginFraction: number;
  /** Reserve inside the allocation, expressed on entry notional. */
  feeReserveBps: number;
  lossBudget?: never;
  marginBudget?: never;
}

/** Offline proposal only: no account reads, execution port, or default monetary budget. */
export function sizeMicroBurstLossBudget(
  input: MicroBurstLossBudgetInput | MicroBurstMarginFractionInput,
  config: MicroBurstConfig,
): MarginBudgetSizingResult {
  const fail = (reason: string): MarginBudgetSizingResult => ({
    valid: false,
    reason,
    quantity: 0,
    notional: 0,
    marginRequired: 0,
  });
  if (
    input.sizingMode !== undefined &&
    input.sizingMode !== 'LOSS_BUDGET' &&
    input.sizingMode !== 'MARGIN_FRACTION'
  )
    return fail('MICRO_SIZING_MODE_INVALID');
  let marginBudget: number;
  if (input.sizingMode === 'MARGIN_FRACTION') {
    if (input.lossBudget !== undefined || input.marginBudget !== undefined)
      return fail('MICRO_SIZING_MODE_CONFLICT');
    if (
      !Number.isFinite(input.availableWallet) ||
      input.availableWallet <= 0 ||
      !Number.isFinite(input.marginFraction) ||
      input.marginFraction <= 0 ||
      input.marginFraction > 0.9 ||
      !Number.isFinite(input.feeReserveBps) ||
      input.feeReserveBps <= 0 ||
      input.feeReserveBps < input.residualCostBps
    )
      return fail('MICRO_MARGIN_FRACTION_INVALID');
    // Margin plus the explicit cost reserve must fit inside the allocation.
    marginBudget =
      (input.availableWallet * input.marginFraction) /
      (1 + (input.intent.leverage * input.feeReserveBps) / 10_000);
  } else if (!Number.isFinite(input.lossBudget) || input.lossBudget <= 0) {
    return fail('MICRO_EXPLICIT_LOSS_BUDGET_REQUIRED');
  } else {
    marginBudget = input.marginBudget;
  }
  if (
    !Number.isFinite(input.approvedLeverageCap) ||
    input.approvedLeverageCap <= 0 ||
    !Number.isInteger(input.intent.leverage) ||
    input.intent.leverage < 1 ||
    (input.sizingMode === 'MARGIN_FRACTION' && ![20, 30].includes(input.intent.leverage)) ||
    input.intent.leverage > Math.min(30, input.approvedLeverageCap, config.maxLeverageHardCap)
  )
    return fail('MICRO_LEVERAGE_NOT_APPROVED');
  if (
    ![input.stopStressBps, input.residualCostBps].every((v) => Number.isFinite(v) && v >= 0) ||
    input.residualCostBps < config.exitEstimatedRoundTripCostBps
  )
    return fail('MICRO_COST_STRESS_INVALID');
  const side = input.intent.side;
  const sign = side === 'LONG' ? 1 : -1;
  const stop = input.intent.structuralStopPrice ?? NaN;
  const stressedStop = stop * (1 - (sign * input.stopStressBps) / 10_000);
  if (
    ![stop, stressedStop, input.liquidationPrice].every((v) => Number.isFinite(v) && v > 0) ||
    sign * (stressedStop - input.liquidationPrice) <= 0
  )
    return fail('MICRO_LIQUIDATION_BOUND_UNSAFE');
  const depth = side === 'LONG' ? input.book?.askDepth : input.book?.bidDepth;
  if (!depth?.length) return fail('MICRO_EXECUTABLE_DEPTH_INSUFFICIENT');
  let available = 0;
  let worstPrice = depth[0].price;
  for (const level of depth) {
    if (
      ![level.price, level.qty].every(Number.isFinite) ||
      level.price <= 0 ||
      level.qty < 0 ||
      sign * (level.price - worstPrice) < 0
    )
      return fail('MICRO_EXECUTABLE_DEPTH_INVALID');
    available += level.qty;
    worstPrice = level.price;
  }
  // Use the worst visible entry for loss, and the largest price for margin/costs.
  // This intentionally under-allocates instead of assuming depth survives a market send.
  const marginPrice = Math.max(depth[0].price, worstPrice);
  const riskPerUnit =
    sign * (worstPrice - stressedStop) + (marginPrice * input.residualCostBps) / 10_000;
  if (!Number.isFinite(riskPerUnit) || sign * (worstPrice - stop) <= 0)
    return fail('MICRO_EXECUTABLE_GEOMETRY_INVALID');
  const sized = calculateMarginBudgetSizing({
    ...input,
    marginBudget,
    entryPrice: marginPrice,
    leverage: input.intent.leverage,
    maxQuantity: Math.min(available, input.maxQuantity ?? Infinity),
    riskPerUnit,
  });
  if (!sized.valid) return sized;
  const denial = validateMicroBurstEntryMarket(
    input.intent,
    sized.quantity,
    input.book,
    input.now,
    { ...config, exitEstimatedRoundTripCostBps: input.residualCostBps },
    'REACTION',
  );
  return denial ? fail(denial) : sized;
}
