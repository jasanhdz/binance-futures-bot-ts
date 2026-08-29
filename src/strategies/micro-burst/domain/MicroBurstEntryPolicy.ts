import { Side } from '../../../core/types';
import { MicroBurstConfig, MicroBurstContext, MicroBurstEntryDecision } from './MicroBurstTypes';
import { selectLeverageTier } from './MicroBurstLeveragePolicy';
import { bpsToDecimalReturn, priceDistanceToBps } from './MicroBurstUnits';

export function evaluateMicroBurstEntry(
  ctx: MicroBurstContext,
  config: MicroBurstConfig,
): MicroBurstEntryDecision {
  // ── Data quality gate ──
  if (!ctx.dataQuality.contextValid) {
    return {
      action: 'NO_TRADE',
      reason: `CONTEXT_INVALID:${ctx.dataQuality.invalidReasons.join(',')}`,
      confirmationStrength: 0,
      diagnostics: { dataQuality: ctx.dataQuality },
    };
  }

  if (ctx.bookPressure.status !== 'HEALTHY' || ctx.bookPressure.anomalyFlag) {
    return {
      action: 'NO_TRADE',
      reason: 'BOOK_NOT_HEALTHY',
      confirmationStrength: 0,
      diagnostics: { bookStatus: ctx.bookPressure.status },
    };
  }

  if (!ctx.btcContext) {
    return {
      action: 'NO_TRADE',
      reason: 'BTC_UNAVAILABLE',
      confirmationStrength: 0,
      diagnostics: {},
    };
  }

  // ── Structural clarity gate ──
  if (!ctx.structuralClarity) {
    return {
      action: 'NO_TRADE',
      reason: 'NO_STRUCTURAL_CLARITY',
      confirmationStrength: 0,
      diagnostics: {
        regime: ctx.microRegime,
        bookHealthy: ctx.bookPressure.status === 'HEALTHY',
        momentumDir: ctx.momentum.direction,
      },
    };
  }

  // ── BTC conflict gate ──
  if (ctx.btcContext.conflictFlag) {
    return {
      action: 'NO_TRADE',
      reason: 'BTC_CONFLICT',
      confirmationStrength: 0,
      diagnostics: { btcConflict: true },
    };
  }

  // ── Momentum continuation gate ──
  if (ctx.momentum.continuationScore < config.momentumMinContinuationScore) {
    return {
      action: 'NO_TRADE',
      reason: 'INSUFFICIENT_CONTINUATION',
      confirmationStrength: ctx.momentum.strength,
      diagnostics: { continuationScore: ctx.momentum.continuationScore },
    };
  }

  // ── Direction ──
  const structuralSide: Side | null =
    ctx.levels.nearest.structuralPosition === 'near_support'
      ? 'LONG'
      : ctx.levels.nearest.structuralPosition === 'near_resistance'
        ? 'SHORT'
        : null;
  if (!structuralSide) {
    return {
      action: 'NO_TRADE',
      reason: 'MID_RANGE_NO_EDGE',
      confirmationStrength: ctx.momentum.strength,
      diagnostics: { structuralPosition: ctx.levels.nearest.structuralPosition },
    };
  }
  if (ctx.momentum.direction !== structuralSide) {
    return {
      action: 'NO_TRADE',
      reason: 'MOMENTUM_DIRECTION_MISMATCH',
      confirmationStrength: ctx.momentum.strength,
      diagnostics: { structuralSide, momentumDirection: ctx.momentum.direction },
    };
  }
  const side = structuralSide;

  // ── Structural levels required (no fallback) ──
  // For LONG near support: target = resistance (above), stop = below support
  // For SHORT near resistance: target = support (below), stop = above resistance
  const targetLevel = side === 'LONG' ? ctx.levels.nearest.resistance : ctx.levels.nearest.support;
  const structuralLevel =
    side === 'LONG' ? ctx.levels.nearest.support : ctx.levels.nearest.resistance;

  if (!structuralLevel || !targetLevel) {
    return {
      action: 'NO_TRADE',
      reason: 'MISSING_STRUCTURAL_LEVEL',
      confirmationStrength: ctx.momentum.strength,
      diagnostics: {
        support: !!ctx.levels.nearest.support,
        resistance: !!ctx.levels.nearest.resistance,
      },
    };
  }

  const stopInvalidationPrice =
    side === 'LONG'
      ? structuralLevel.price * (1 - bpsToDecimalReturn(config.structuralInvalidationBufferBps))
      : structuralLevel.price * (1 + bpsToDecimalReturn(config.structuralInvalidationBufferBps));
  const targetPrice = targetLevel.price;

  // ── Room gate ──
  const validGeometry =
    side === 'LONG'
      ? stopInvalidationPrice < ctx.currentPrice && targetPrice > ctx.currentPrice
      : stopInvalidationPrice > ctx.currentPrice && targetPrice < ctx.currentPrice;
  if (!validGeometry) {
    return {
      action: 'NO_TRADE',
      reason: 'INVALID_STRUCTURAL_GEOMETRY',
      confirmationStrength: ctx.momentum.strength,
      diagnostics: { side, stopInvalidationPrice, targetPrice, currentPrice: ctx.currentPrice },
    };
  }

  const roomToTargetBps = priceDistanceToBps(ctx.currentPrice, targetPrice);
  const riskToInvalidationBps = priceDistanceToBps(ctx.currentPrice, stopInvalidationPrice);

  if (!Number.isFinite(roomToTargetBps) || roomToTargetBps < config.minRoomBps) {
    return {
      action: 'NO_TRADE',
      reason: 'INSUFFICIENT_ROOM',
      confirmationStrength: ctx.momentum.strength,
      diagnostics: { roomToTargetBps, minRoomBps: config.minRoomBps },
    };
  }

  const rewardRisk = roomToTargetBps / riskToInvalidationBps;
  if (
    !Number.isFinite(riskToInvalidationBps) ||
    riskToInvalidationBps <= 0 ||
    !Number.isFinite(rewardRisk)
  ) {
    return {
      action: 'NO_TRADE',
      reason: 'INVALID_REWARD_RISK',
      confirmationStrength: ctx.momentum.strength,
      diagnostics: { roomToTargetBps, riskToInvalidationBps, rewardRisk },
    };
  }
  if (rewardRisk < config.minRewardRisk) {
    return {
      action: 'NO_TRADE',
      reason: 'INSUFFICIENT_REWARD_RISK',
      confirmationStrength: ctx.momentum.strength,
      diagnostics: {
        roomToTargetBps,
        riskToInvalidationBps,
        rewardRisk,
        minRewardRisk: config.minRewardRisk,
      },
    };
  }

  // ── Leverage selection ──
  const leverageResult = selectLeverageTier(ctx.momentum.strength, config);
  if (leverageResult.tier === 'NO_TRADE') {
    return {
      action: 'NO_TRADE',
      reason: 'LOW_CONFIRMATION',
      confirmationStrength: ctx.momentum.strength,
      diagnostics: { strength: ctx.momentum.strength },
    };
  }

  const effectiveLeverage = Math.min(leverageResult.leverage, config.maxLeverageHardCap);

  return {
    action: 'ENTRY_INTENT',
    side,
    leverageTier: leverageResult.tier,
    leverage: effectiveLeverage,
    positionFraction: leverageResult.positionFraction,
    stopInvalidationPrice,
    targetPrice,
    roomToTargetBps,
    riskToInvalidationBps,
    rewardRisk,
    reason: 'SIGNAL_CONFIRMED',
    confirmationStrength: ctx.momentum.strength,
    diagnostics: {
      regime: ctx.microRegime,
      momentumDir: ctx.momentum.direction,
      bookPressure: ctx.bookPressure.status,
      structuralPosition: ctx.levels.nearest.structuralPosition,
      leverage: effectiveLeverage,
      positionFraction: leverageResult.positionFraction,
      roomToTargetBps,
      riskToInvalidationBps,
      rewardRisk,
    },
  };
}
