import { Side } from '../../../../core/types';

export type AegisPortfolioRiskReason =
  | 'portfolio_risk_disabled'
  | 'max_open_positions_reached'
  | 'max_same_direction_positions_reached'
  | 'max_margin_used_pct_reached'
  | 'max_notional_to_equity_reached'
  | 'allowed';

export interface AegisPortfolioRiskConfig {
  enabled?: boolean;
  max_open_positions?: number;
  max_same_direction_positions?: number;
  max_margin_used_pct?: number;
  max_notional_to_equity?: number;
}

export interface AegisPortfolioRiskInput {
  symbol: string;
  side: Side;
  currentOpenPositions: number;
  currentLongPositions: number;
  currentShortPositions: number;
  walletBalance?: number;
  equityTotal?: number;
  currentMarginUsed: number;
  currentNotional: number;
  newTradeEstimatedMargin: number;
  newTradeEstimatedNotional: number;
  config?: AegisPortfolioRiskConfig;
}

export interface AegisPortfolioRiskDecision {
  allowed: boolean;
  reason: AegisPortfolioRiskReason;
  metadata: Record<string, unknown>;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteLimit(value: unknown): number | undefined {
  return finiteNumber(value) && value >= 0 ? value : undefined;
}

export class AegisPortfolioRiskGuard {
  static evaluate(input: AegisPortfolioRiskInput): AegisPortfolioRiskDecision {
    const config = input.config || {};
    const sameDirectionPositions =
      input.side === 'LONG' ? input.currentLongPositions : input.currentShortPositions;
    const equityBase =
      finiteNumber(input.equityTotal) && input.equityTotal > 0
        ? input.equityTotal
        : finiteNumber(input.walletBalance) && input.walletBalance > 0
          ? input.walletBalance
          : undefined;
    const nextMarginUsed = input.currentMarginUsed + input.newTradeEstimatedMargin;
    const nextNotional = input.currentNotional + input.newTradeEstimatedNotional;
    const marginUsedPct = equityBase ? nextMarginUsed / equityBase : undefined;
    const notionalToEquity = equityBase ? nextNotional / equityBase : undefined;
    const limits = {
      maxOpenPositions: finiteLimit(config.max_open_positions),
      maxSameDirectionPositions: finiteLimit(config.max_same_direction_positions),
      maxMarginUsedPct: finiteLimit(config.max_margin_used_pct),
      maxNotionalToEquity: finiteLimit(config.max_notional_to_equity),
    };
    const metadata = {
      symbol: input.symbol,
      side: input.side,
      openPositions: input.currentOpenPositions,
      sameDirectionPositions,
      longPositions: input.currentLongPositions,
      shortPositions: input.currentShortPositions,
      walletBalance: input.walletBalance,
      equityTotal: input.equityTotal,
      equityBase,
      currentMarginUsed: input.currentMarginUsed,
      currentNotional: input.currentNotional,
      newTradeEstimatedMargin: input.newTradeEstimatedMargin,
      newTradeEstimatedNotional: input.newTradeEstimatedNotional,
      nextMarginUsed,
      nextNotional,
      marginUsedPct,
      notionalToEquity,
      limits,
    };

    if (config.enabled !== true) {
      return { allowed: true, reason: 'portfolio_risk_disabled', metadata };
    }

    if (
      limits.maxOpenPositions !== undefined &&
      input.currentOpenPositions >= limits.maxOpenPositions
    ) {
      return { allowed: false, reason: 'max_open_positions_reached', metadata };
    }

    if (
      limits.maxSameDirectionPositions !== undefined &&
      sameDirectionPositions >= limits.maxSameDirectionPositions
    ) {
      return { allowed: false, reason: 'max_same_direction_positions_reached', metadata };
    }

    if (
      limits.maxMarginUsedPct !== undefined &&
      marginUsedPct !== undefined &&
      marginUsedPct > limits.maxMarginUsedPct
    ) {
      return { allowed: false, reason: 'max_margin_used_pct_reached', metadata };
    }

    if (
      limits.maxNotionalToEquity !== undefined &&
      notionalToEquity !== undefined &&
      notionalToEquity > limits.maxNotionalToEquity
    ) {
      return { allowed: false, reason: 'max_notional_to_equity_reached', metadata };
    }

    return { allowed: true, reason: 'allowed', metadata };
  }
}
