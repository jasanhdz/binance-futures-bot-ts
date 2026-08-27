import { Side } from '../../types';
import { MicroBurstConfig, MicroBurstContext, MicroBurstEntryDecision } from './MicroBurstTypes';
import { selectLeverageTier } from './MicroBurstLeveragePolicy';

function noTrade(reason: string, diagnostics: Record<string, unknown> = {}): MicroBurstEntryDecision {
  return { action: 'NO_TRADE', reason, confirmationStrength: 0, diagnostics };
}

function computeConfirmationStrength(
  context: MicroBurstContext,
  side: Side,
): number {
  const { momentum, levels, bookPressure, btcContext } = context;

  let score = 0;

  score += momentum.strength * 0.3;
  score += momentum.continuationScore * 0.2;

  if (side === 'LONG' && levels.nearest.support) {
    const distBps = levels.nearest.distanceToSupportBps;
    score += Math.max(0, 1 - distBps / 100) * 0.2;
  } else if (side === 'SHORT' && levels.nearest.resistance) {
    const distBps = levels.nearest.distanceToResistanceBps;
    score += Math.max(0, 1 - distBps / 100) * 0.2;
  }

  if (!bookPressure.degradedMode) {
    const imbalanceFavorable = side === 'LONG'
      ? bookPressure.topOfBookImbalance > 0
      : bookPressure.topOfBookImbalance < 0;
    if (imbalanceFavorable) score += 0.15;
    if (bookPressure.absorptionDetected) score += 0.1;
  }

  if (btcContext) {
    const btcAligns = side === btcContext.direction || btcContext.direction === 'NEUTRAL';
    if (btcAligns) score += 0.05;
  }

  return Math.min(1, score);
}

function computeStopInvalidation(
  side: Side,
  context: MicroBurstContext,
): number {
  const { currentPrice, levels } = context;

  if (side === 'LONG' && levels.nearest.support) {
    return levels.nearest.support.price * 0.998;
  }
  if (side === 'SHORT' && levels.nearest.resistance) {
    return levels.nearest.resistance.price * 1.002;
  }

  const fallbackPct = side === 'LONG' ? 0.003 : -0.003;
  return currentPrice * (1 + fallbackPct);
}

function computeTarget(
  side: Side,
  context: MicroBurstContext,
): number {
  const { currentPrice, levels } = context;

  if (side === 'LONG' && levels.nearest.resistance) {
    return levels.nearest.resistance.price;
  }
  if (side === 'SHORT' && levels.nearest.support) {
    return levels.nearest.support.price;
  }

  const targetPct = side === 'LONG' ? 0.005 : -0.005;
  return currentPrice * (1 + targetPct);
}

export function evaluateMicroBurstEntry(
  context: MicroBurstContext,
  config: MicroBurstConfig,
): MicroBurstEntryDecision {
  const diag: Record<string, unknown> = {
    symbol: context.symbol,
    price: context.currentPrice,
    regime: context.microRegime,
  };

  if (!context.structuralClarity) {
    return noTrade('NO_STRUCTURAL_CLARITY', diag);
  }

  const { structuralPosition } = context.levels.nearest;
  if (structuralPosition === 'mid_range') {
    return noTrade('MID_RANGE_NO_EDGE', diag);
  }

  const { momentum } = context;

  let side: Side;
  if (structuralPosition === 'near_support' && momentum.direction === 'LONG') {
    side = 'LONG';
  } else if (structuralPosition === 'near_resistance' && momentum.direction === 'SHORT') {
    side = 'SHORT';
  } else {
    return noTrade('MOMENTUM_DIRECTION_MISMATCH', { ...diag, structuralPosition, momentumDir: momentum.direction });
  }

  if (momentum.continuationScore < config.momentumMinContinuationScore) {
    return noTrade('INSUFFICIENT_CONTINUATION', { ...diag, continuationScore: momentum.continuationScore });
  }

  if (context.btcContext?.conflictFlag) {
    return noTrade('BTC_CONFLICT', { ...diag, btcRet3m: context.btcContext.ret3m });
  }

  if (!context.bookPressure.degradedMode && context.bookPressure.anomalyFlag) {
    return noTrade('BOOK_ANOMALY', { ...diag, spreadBps: context.bookPressure.spreadBps });
  }

  const confirmationStrength = computeConfirmationStrength(context, side);
  const tierResult = selectLeverageTier(confirmationStrength, config);

  if (tierResult.tier === 'NO_TRADE') {
    return noTrade('INSUFFICIENT_CONFIRMATION', { ...diag, confirmationStrength });
  }

  const stopInvalidation = computeStopInvalidation(side, context);
  const target = computeTarget(side, context);

  return {
    action: 'ENTRY_INTENT',
    side,
    leverageTier: tierResult.tier,
    leverage: tierResult.leverage,
    positionFraction: tierResult.positionFraction,
    stopInvalidationPrice: stopInvalidation,
    targetPrice: target,
    reason: `MICRO_BURST_${side}_NEAR_${structuralPosition === 'near_support' ? 'SUPPORT' : 'RESISTANCE'}`,
    confirmationStrength,
    diagnostics: {
      ...diag,
      side,
      tier: tierResult.tier,
      leverage: tierResult.leverage,
      stopInvalidation,
      target,
      momentumStrength: momentum.strength,
      continuationScore: momentum.continuationScore,
      bookImbalance: context.bookPressure.topOfBookImbalance,
    },
  };
}
