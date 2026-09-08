import type { TradingExchangePort, SymbolFilters } from '../../../app/ports/Exchange';
import type { StrategyExecutionIntent } from '../../../core/strategy/StrategyExecution';
import type { MarginBudgetSizingResult } from '../../../core/risk/SizingEngine';
import { isMicroBurstTradePolicy } from '../domain/MicroBurstTradePolicy';
import { sizeMicroBurstLossBudget } from '../domain/MicroBurstLossBudgetSizing';
import type { OrderBookSnapshot } from '../domain/MicroBurstTypes';

export interface MicroBurstLiveSizingResult extends MarginBudgetSizingResult {
  contextualEvidence?: {
    schemaVersion: 1;
    policyDigest: string;
    symbol: string;
    side: 'LONG' | 'SHORT';
    quantity: number;
    validatedAtMs: number;
    account: NonNullable<
      Awaited<ReturnType<NonNullable<TradingExchangePort['readMicroBurstEntryRisk']>>>
    >;
    book: OrderBookSnapshot;
    liquidationPrice: number;
    residualCostBps: number;
    feeReserveBps: number;
  };
}

/** Live evidence is read after isolated margin/leverage setup; no guessed liquidation boundary. */
export async function sizeMicroBurstLiveEntry(
  exchange: TradingExchangePort,
  intent: StrategyExecutionIntent,
  filters: SymbolFilters,
  readBook: () => OrderBookSnapshot | undefined,
  now: () => number = Date.now,
): Promise<MicroBurstLiveSizingResult> {
  const fail = (reason: string): MarginBudgetSizingResult => ({
    valid: false,
    reason,
    quantity: 0,
    notional: 0,
    marginRequired: 0,
  });
  const policy = intent.metadata.contextualPolicy;
  if (
    !isMicroBurstTradePolicy(policy, intent.identity) ||
    ![20, 30].includes(intent.leverage) ||
    intent.positionFraction !== policy.risk.marginFraction
  )
    return fail('MICRO_SIZING_POLICY_UNVERIFIED');
  const evidence = await exchange.readMicroBurstEntryRisk?.(intent.symbol, intent.leverage);
  const observedAt = now();
  if (
    !evidence ||
    evidence.source !== 'BINANCE_ISOLATED_USDT_TIERS_V1' ||
    evidence.marginType !== 'ISOLATED' ||
    evidence.positionSide !== 'BOTH' ||
    evidence.leverage !== intent.leverage ||
    !Number.isFinite(evidence.availableWallet) ||
    evidence.availableWallet <= 0 ||
    !Number.isFinite(evidence.observedAtMs) ||
    evidence.observedAtMs > observedAt ||
    observedAt - evidence.observedAtMs > policy.config.exitIntelligenceMaxObservationGapMs
  )
    return fail('MICRO_LIQUIDATION_EVIDENCE_UNVERIFIED');
  const book = readBook();
  const depth = intent.side === 'LONG' ? book?.askDepth : book?.bidDepth;
  if (!depth?.length) return fail('MICRO_EXECUTABLE_DEPTH_INSUFFICIENT');
  const feeBps = evidence.takerFeeRate * 20_000;
  const residualCostBps = Math.max(feeBps, policy.config.exitEstimatedRoundTripCostBps);
  if (
    !Number.isFinite(feeBps) ||
    feeBps < 0 ||
    !Number.isFinite(evidence.liquidationFeeRate) ||
    evidence.liquidationFeeRate < 0 ||
    policy.risk.feeReserveBps < residualCostBps
  )
    return fail('MICRO_ACTUAL_FEES_EXCEED_RESERVE');
  const maxNotional = evidence.availableWallet * policy.risk.marginFraction * intent.leverage;
  // SHORT liquidation can increase notional. Ignore positive cumulative maintenance deductions
  // and include the published liquidation fee: both move the bound conservatively toward entry.
  const stressNotional = maxNotional * (1 + 1 / intent.leverage);
  let covered = 0,
    maintenance = 0;
  for (const tier of evidence.brackets) {
    if (
      ![
        tier.notionalFloor,
        tier.notionalCap,
        tier.maintMarginRatio,
        tier.initialLeverage,
        tier.cum,
      ].every(Number.isFinite) ||
      tier.notionalFloor !== covered ||
      tier.notionalCap <= covered ||
      tier.maintMarginRatio < 0 ||
      tier.cum < 0 ||
      tier.initialLeverage < intent.leverage
    )
      return fail('MICRO_TIER_COVERAGE_UNVERIFIED');
    maintenance = Math.max(maintenance, tier.maintMarginRatio);
    covered = tier.notionalCap;
    if (covered >= stressNotional) break;
  }
  const rate = maintenance + evidence.liquidationFeeRate + evidence.takerFeeRate;
  if (covered < stressNotional || !Number.isFinite(rate) || rate < 0 || rate >= 1 / intent.leverage)
    return fail('MICRO_TIER_MARGIN_UNSAFE');
  const entry =
    intent.side === 'LONG'
      ? Math.max(...depth.map((l) => l.price))
      : Math.min(...depth.map((l) => l.price));
  const liquidationPrice =
    intent.side === 'LONG'
      ? (entry * (1 - 1 / intent.leverage)) / (1 - rate)
      : (entry * (1 + 1 / intent.leverage)) / (1 + rate);
  const sizing = sizeMicroBurstLossBudget(
    {
      sizingMode: 'MARGIN_FRACTION',
      intent,
      now: observedAt,
      book,
      ...filters,
      maxNotional: filters.notionalCap,
      availableWallet: evidence.availableWallet,
      marginFraction: policy.risk.marginFraction,
      feeReserveBps: policy.risk.feeReserveBps,
      approvedLeverageCap: policy.config.maxLeverageHardCap,
      liquidationPrice,
      stopStressBps: policy.risk.stopStressBps,
      residualCostBps,
    },
    policy.config,
  );
  return sizing.valid && book
    ? {
        ...sizing,
        contextualEvidence: {
          schemaVersion: 1,
          policyDigest: policy.digest,
          symbol: intent.symbol,
          side: intent.side,
          quantity: sizing.quantity,
          validatedAtMs: observedAt,
          account: structuredClone(evidence),
          book: structuredClone(book),
          liquidationPrice,
          residualCostBps,
          feeReserveBps: policy.risk.feeReserveBps,
        },
      }
    : sizing;
}
