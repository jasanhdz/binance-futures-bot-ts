import type {
  FeatureVector,
  ScoutDecision,
  SuiSrScoutConfig,
  LevelCandidateEvent,
} from './ScoutTypes';

export interface RiskGateResult {
  readonly allowed: boolean;
  readonly reasons: string[];
}

export interface RiskPolicy {
  checkAllGates(
    event: LevelCandidateEvent,
    featureVector: FeatureVector,
    config: SuiSrScoutConfig,
    state: {
      feedHealthy: boolean;
      openPositionCount: number;
      consecutiveLosses: number;
      dailyLossBps: number;
      lastStopTimeMs: number;
      nowMs: number;
    },
  ): RiskGateResult;
}

export function createRiskPolicy(): RiskPolicy {
  return {
    checkAllGates(event, featureVector, config, state) {
      const reasons: string[] = [];

      if (config.killSwitch) {
        reasons.push('kill_switch_active');
        return { allowed: false, reasons };
      }

      if (config.executionMode === 'OBSERVE') {
        reasons.push('observe_mode');
        return { allowed: false, reasons };
      }

      if (config.executionMode === 'LIVE_CANARY' && !config.liveEnabled) {
        reasons.push('live_canary_not_enabled');
        return { allowed: false, reasons };
      }

      if (!state.feedHealthy) {
        reasons.push('feed_unhealthy');
        return { allowed: false, reasons };
      }

      if (featureVector.btcContext.aggressiveAgainstTrade) {
        reasons.push('btc_aggressive_against_trade');
        return { allowed: false, reasons };
      }

      if (featureVector.level.zoneScore < config.srZoneScoreMin) {
        reasons.push('zone_score_below_minimum');
        return { allowed: false, reasons };
      }

      if (featureVector.level.touchCount < config.srMinTouchCount) {
        reasons.push('touch_count_below_minimum');
        return { allowed: false, reasons };
      }

      if (state.openPositionCount >= config.maxOpenPositions) {
        reasons.push('max_open_positions_reached');
        return { allowed: false, reasons };
      }

      if (state.consecutiveLosses >= 3) {
        reasons.push('consecutive_losses_cooldown');
        return { allowed: false, reasons };
      }

      if (state.dailyLossBps >= config.maxDailyLossBps) {
        reasons.push('daily_loss_limit_reached');
        return { allowed: false, reasons };
      }

      if (state.nowMs - state.lastStopTimeMs < config.cooldownAfterStopMs) {
        reasons.push('cooldown_after_stop');
        return { allowed: false, reasons };
      }

      if (featureVector.level.distanceAtr > 3) {
        reasons.push('price_too_far_from_zone');
        return { allowed: false, reasons };
      }

      return { allowed: true, reasons: [] };
    },
  };
}
