import { Side } from '../../../core/types';

export type RegimeEngineV2Timeframe = '5m';

export type RegimeEngineV2TechnicalRegime =
  | 'ACCUMULATION_RANGE'
  | 'CHOP'
  | 'BREAKOUT_UP_EARLY'
  | 'BREAKOUT_DOWN_EARLY'
  | 'MOMENTUM_UP_EARLY'
  | 'MOMENTUM_DOWN_EARLY'
  | 'MOMENTUM_UP_MATURE'
  | 'MOMENTUM_DOWN_MATURE'
  | 'MOMENTUM_UP_EXHAUSTED'
  | 'MOMENTUM_DOWN_EXHAUSTED'
  | 'TREND_UP_PULLBACK'
  | 'TREND_DOWN_PULLBACK'
  | 'HIGH_VOL_RISK'
  | 'UNKNOWN';

export type RegimeEngineV2MomentumEnvironment =
  | 'ALLOW_LONG_MOMENTUM'
  | 'ALLOW_SHORT_MOMENTUM'
  | 'WATCH_LONG_MOMENTUM'
  | 'WATCH_SHORT_MOMENTUM'
  | 'AVOID_MOMENTUM'
  | 'UNKNOWN';

export type RegimeEngineV2Direction = Side | 'NONE';

export type RegimeEngineV2MarketConfirmationState =
  | 'CONFIRM_LONG'
  | 'CONFIRM_SHORT'
  | 'NEUTRAL'
  | 'MIXED'
  | 'CONTRADICT';

export type RegimeEngineV2TransitionRisk = 'LOW' | 'MODERATE' | 'HIGH';

export type RegimeEngineV2MarketAction = 'LONG' | 'SHORT' | 'HOLD';

export type RegimeEngineV2MarketSignal = {
  action?: RegimeEngineV2MarketAction;
  score?: number;
  direction?: RegimeEngineV2Direction;
};

export type RegimeEngineV2InputCandle = {
  timestamp?: number;
  openTime?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume?: number;
};

export type RegimeEngineV2MarketContext = {
  btc?: RegimeEngineV2MarketSignal;
  eth?: RegimeEngineV2MarketSignal;
};

export type RegimeEngineV2Indicators = {
  ema7?: number;
  ema25?: number;
  ema99?: number;
  ema7Slope?: number;
  ema25Slope?: number;
  emaStackAge?: number;
  adx?: number;
  adxSlope?: number;
  choppiness?: number;
  atrPercentile?: number;
  bollingerWidthPercentile?: number;
  volumeRatio?: number;
  volumeTrend?: number;
  closeLocation?: number;
  wickRatio?: number;
  bodySizePercentile?: number;
  distanceFromEma25Pct?: number;
  distanceFromEma99Pct?: number;
  rangeBreakout?: 'UP' | 'DOWN' | 'NONE';
  failedBreakoutCount?: number;
  structure?: 'HH_HL' | 'LL_LH' | 'MIXED' | 'UNKNOWN';
  breakoutStrengthPct?: number;
  breakoutCloseBeyondRangePct?: number;
  breakoutBodyConfirmation?: number;
  breakoutVolumePersistence?: number;
  breakoutFollowThroughScore?: number;
  adverseWickAgainstBreakout?: number;
  lowerWickRatio?: number;
  breakdownCloseBeyondRangePct?: number;
  lowerWickAgainstBreakdown?: number;
  preBreakoutCompression?: number;
  breakoutTooExtendedFromEma25?: number;
  failedBreakoutPressure?: number;
  shortBreakdownQuality?: number;
  shortSweepRisk?: number;
  shortContinuationScore?: number;
  shortRetestScore?: number;
  shortExtensionRisk?: number;
  shortAbsorptionRisk?: number;
  shortVolumePersistence?: number;
  shortAdverseReboundRisk?: number;
};

export type RegimeEngineV2Scores = {
  trendStrength: number;
  momentumQuality: number;
  chopRisk: number;
  exhaustionRisk: number;
  transitionRisk: number;
  volatilityRisk: number;
  marketConfirmationScore: number;
};

export type RegimeEngineV2Decision = {
  symbol: string;
  timestamp: string;
  timeframe: RegimeEngineV2Timeframe;
  technicalRegime: RegimeEngineV2TechnicalRegime;
  technicalDirection: RegimeEngineV2Direction;
  momentumEnvironment: RegimeEngineV2MomentumEnvironment;
  confidence: number;
  scores: RegimeEngineV2Scores;
  marketConfirmation: {
    state: RegimeEngineV2MarketConfirmationState;
    btc?: RegimeEngineV2MarketSignal;
    eth?: RegimeEngineV2MarketSignal;
  };
  transition: {
    risk: RegimeEngineV2TransitionRisk;
    possibleNextRegime?: string;
    reasons: string[];
  };
  indicators: RegimeEngineV2Indicators;
  reasons: string[];
};

export type RegimeEngineV2EvaluateInput = {
  symbol: string;
  candles: RegimeEngineV2InputCandle[];
  timeframe?: RegimeEngineV2Timeframe;
  market?: RegimeEngineV2MarketContext;
};
