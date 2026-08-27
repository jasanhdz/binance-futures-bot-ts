import { Side } from '../../types';
import { MicroBurstConfig, MicroBurstContext, MicroBurstEntryDecision } from './MicroBurstTypes';
import { selectLeverageTier } from './MicroBurstLeveragePolicy';

function toBps(a: number, b: number): number {
  if (b === 0) return Infinity;
  return (Math.abs(a - b) / Math.min(Math.abs(a), Math.abs(b))) * 10_000;
}

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
  if (ctx.btcContext?.conflictFlag) {
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
  const side: Side = ctx.levels.nearest.structuralPosition === 'near_support' ? 'LONG' : 'SHORT';

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
      ? structuralLevel.price * (1 - config.structuralInvalidationBufferBps / 10_000)
      : structuralLevel.price * (1 + config.structuralInvalidationBufferBps / 10_000);
  const targetPrice = targetLevel.price;

  // ── Room gate ──
  const roomToTargetBps = toBps(targetPrice, ctx.currentPrice) / 10_000;
  const riskToInvalidationBps = toBps(stopInvalidationPrice, ctx.currentPrice) / 10_000;

  if (roomToTargetBps < config.minRoomBps / 10_000) {
    return {
      action: 'NO_TRADE',
      reason: 'INSUFFICIENT_ROOM',
      confirmationStrength: ctx.momentum.strength,
      diagnostics: { roomToTargetBps, minRoomBps: config.minRoomBps },
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
    reason: 'SIGNAL_CONFIRMED',
    confirmationStrength: ctx.momentum.strength,
    diagnostics: {
      regime: ctx.microRegime,
      momentumDir: ctx.momentum.direction,
      bookPressure: ctx.bookPressure.status,
      structuralPosition: ctx.levels.nearest.structuralPosition,
      leverage: effectiveLeverage,
      positionFraction: leverageResult.positionFraction,
    },
  };
}
