import { wilderAdxSeries } from '../../../../../domain/services/regime-v2/WilderAdx';
import { validateDataQuality } from '../../../../../core/market-data/CandleIntegrity';
import { REGIME_CONTEXT_AUTHORITY } from '../../../../../core/risk/RegimeAuthority';
import {
  AegisEntryContext,
  AegisEntryGuardPolicy,
  AegisEntryGuardResult,
  AegisRegimeContext,
  AegisRegimeContextRuntimeConfig,
  guardDisabledResult,
  isGuardEnforced,
} from '../AegisEntryDecisionTypes';
import { AegisRegimeGuard, AegisRegimeLabel } from '../../services/AegisRegimeGuard';

export interface RegimeContextGuardAdapterResult {
  guard: AegisEntryGuardResult;
  regimeContext?: AegisRegimeContext;
}

export class RegimeContextGuardAdapter {
  static evaluate(
    context: AegisEntryContext,
    policy: AegisEntryGuardPolicy,
  ): RegimeContextGuardAdapterResult {
    const config = context.regime?.contextConfig;
    if (
      policy.enabled !== true ||
      policy.mode === 'OFF' ||
      config?.enabled !== true ||
      config.mode === 'OFF'
    ) {
      return { guard: guardDisabledResult('regime_context', 'regime_context_disabled') };
    }

    const timeframe = /^(\d+)(m|h)$/.exec(config.timeframe);
    const intervalMs = timeframe
      ? Number(timeframe[1]) * (timeframe[2] === 'h' ? 3_600_000 : 60_000)
      : NaN;
    const quality = validateDataQuality(
      context.entryQuality.ruleGate.recentCandles ?? [],
      intervalMs,
      context.operational.timestamp,
      {
        maxAgeMs: Number.MAX_SAFE_INTEGER,
        maxLastCandleAgeMs: intervalMs,
        ageReference: 'CLOSE_TIME',
        maxFutureSkewMs: 0,
      },
    );
    quality.reasons.push(...(context.entryQuality.ruleGate.candleDataQualityReasons ?? []));
    const atrPercentile = context.entryQuality.ruleGate.atrPercentile;
    if (
      atrPercentile !== undefined &&
      (!Number.isFinite(atrPercentile) || atrPercentile < 0 || atrPercentile > 1)
    )
      quality.reasons.push('invalid_atr_percentile');
    if (
      Object.values(config.indicators).some((window) => !Number.isSafeInteger(window) || window < 2)
    )
      quality.reasons.push('invalid_indicator_window');
    quality.valid = quality.reasons.length === 0;
    let indicators = quality.valid ? buildIndicators(context, config.indicators) : {};
    if (Object.values(indicators).some((value) => value !== undefined && !Number.isFinite(value))) {
      quality.valid = false;
      quality.reasons.push('nonfinite_indicator');
      indicators = {};
    }
    const hasEnoughData =
      indicators.volumeRatio !== undefined ||
      indicators.emaFast !== undefined ||
      context.regime?.config !== undefined;
    if (!hasEnoughData || !context.regime?.config) {
      return {
        guard: {
          name: 'regime_context',
          enabled: true,
          mode: policy.mode,
          decision: 'NOT_APPLICABLE',
          reason: 'regime_context_insufficient_data',
          wouldBlock: false,
          enforced: isGuardEnforced(policy),
          metadata: {
            mode: policy.mode,
            insufficientData: true,
            indicators,
            source: 'aegis_regime_guard_plus_indicators',
            technicalRegimePending: true,
            globalBlockingDisabled: true,
          },
        },
      };
    }

    const decision = AegisRegimeGuard.evaluate({
      symbol: context.symbol,
      side: context.side,
      isAltSymbol: context.eventRisk.isAltSymbol,
      turboScore: context.turboScore,
      votes: context.votes,
      setupGrade: context.setupGrade,
      entryQualityScore: context.entryQuality.entryQualityScore,
      tailRiskScore: context.entryQuality.tailRiskScore,
      eventRiskMode: context.eventRisk.mode,
      eventRiskReason: context.eventRisk.reason,
      eventRiskWouldBlock: context.eventRisk.wouldBlock,
      eventRiskAuto: context.eventRisk.auto,
      btcAction: context.regime.btcAction ?? context.eventRisk.btcAction,
      btcScore: context.regime.btcScore ?? context.eventRisk.btcScore,
      btcVotes: context.regime.btcVotes,
      ethAction: context.regime.ethAction ?? context.eventRisk.ethAction,
      ethScore: context.regime.ethScore ?? context.eventRisk.ethScore,
      ethVotes: context.regime.ethVotes,
      marketDistribution: context.regime.marketDistribution,
      snapshotAgeSeconds: context.regime.snapshotAgeSeconds,
      nowMs: context.operational.timestamp,
      config: {
        ...context.regime.config,
        enabled: true,
        mode: 'SHADOW',
      },
    });

    const regimeContext = buildRegimeContext(
      quality.valid ? decision.regime : 'UNKNOWN',
      quality.valid ? decision.confidence : 0,
      indicators,
      config.thresholds,
      quality.valid ? [decision.reason] : quality.reasons,
    );
    regimeContext.indicatorWindows = { ...config.indicators };
    regimeContext.dataQuality = quality;

    return {
      guard: {
        name: 'regime_context',
        enabled: true,
        mode: policy.mode,
        decision: 'ALLOW',
        reason: 'regime_context_available',
        wouldBlock: false,
        enforced: isGuardEnforced(policy),
        metadata: {
          regimeContext,
          authority: REGIME_CONTEXT_AUTHORITY,
          source: 'aegis_regime_guard_plus_indicators',
          technicalRegimePending: true,
          policyMode: policy.mode,
          effectiveMode: policy.mode,
          decisionReason: decision.reason,
          wouldBlockIgnored: decision.wouldBlock,
          // ENFORCE is deliberately informational for now.
          globalBlockingDisabled: true,
        },
      },
      regimeContext,
    };
  }
}

function buildRegimeContext(
  label: AegisRegimeLabel,
  confidence: number,
  indicators: AegisRegimeContext['indicators'],
  thresholds: AegisRegimeContextRuntimeConfig['thresholds'],
  reasons: string[],
): AegisRegimeContext {
  const trendDirection =
    label === 'MOMENTUM_UP' || label === 'TREND_UP' || label === 'BREAKOUT_UP'
      ? 'UP'
      : label === 'MOMENTUM_DOWN' || label === 'TREND_DOWN' || label === 'BREAKOUT_DOWN'
        ? 'DOWN'
        : inferTrendDirection(indicators);
  const chopRisk =
    indicators.choppiness !== undefined
      ? clamp01(indicators.choppiness / 100)
      : label === 'CHOP'
        ? 0.85
        : 0.3;
  const exhaustionRisk =
    label === 'EXHAUSTION'
      ? 0.85
      : indicators.atrPercentile !== undefined && indicators.atrPercentile >= 0.9
        ? indicators.atrPercentile
        : 0.2;
  const adxOk = indicators.adx !== undefined && indicators.adx >= thresholds.minAdxForMomentum;
  const chopOk =
    indicators.choppiness === undefined ||
    indicators.choppiness <= thresholds.maxChoppinessForMomentum;
  const volumeOk =
    indicators.volumeRatio === undefined ||
    indicators.volumeRatio >= thresholds.minVolumeRatioForMomentum;
  const exhaustionOk = exhaustionRisk <= thresholds.maxExhaustionScore;
  const longLabelAllowed =
    label === 'MOMENTUM_UP' || label === 'TREND_UP' || label === 'BREAKOUT_UP';
  const shortLabelAllowed =
    label === 'MOMENTUM_DOWN' || label === 'TREND_DOWN' || label === 'BREAKOUT_DOWN';

  return {
    label,
    confidence,
    momentumLongAllowed: longLabelAllowed && adxOk && chopOk && volumeOk && exhaustionOk,
    momentumShortAllowed: shortLabelAllowed && adxOk && chopOk && volumeOk && exhaustionOk,
    trendDirection,
    chopRisk: round(chopRisk) ?? chopRisk,
    exhaustionRisk: round(clamp01(exhaustionRisk)) ?? clamp01(exhaustionRisk),
    volatilityState:
      indicators.atrPercentile === undefined
        ? 'UNKNOWN'
        : indicators.atrPercentile >= thresholds.maxAtrPercentileForAggressive
          ? 'HIGH'
          : 'NORMAL',
    volumeState:
      indicators.volumeRatio === undefined
        ? 'UNKNOWN'
        : indicators.volumeRatio >= thresholds.minVolumeRatioForMomentum
          ? 'HIGH'
          : 'NORMAL',
    reasons,
    indicators,
  };
}

function buildIndicators(
  context: AegisEntryContext,
  windows: AegisRegimeContextRuntimeConfig['indicators'],
): AegisRegimeContext['indicators'] {
  const candles = context.entryQuality.ruleGate.recentCandles ?? [];
  const latest = candles[candles.length - 1];
  const volumeHistory = candles
    .slice(Math.max(0, candles.length - windows.volumeWindow - 1), -1)
    .map((candle) => candle.volume)
    .filter((value): value is number => isFiniteNumber(value));
  const avgVolume =
    volumeHistory.length === windows.volumeWindow ? average(volumeHistory) : undefined;
  const volumeRatio =
    latest?.volume !== undefined && avgVolume && avgVolume > 0
      ? latest.volume / avgVolume
      : undefined;
  const ema = (period: number): { value?: number; slope?: number } => {
    if (candles.length < period) return {};
    let value = candles.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period;
    let previous: number | undefined;
    for (const c of candles.slice(period)) {
      previous = value;
      value += ((c.close - value) * 2) / (period + 1);
    }
    return { value, slope: previous === undefined ? undefined : (value - previous) / previous };
  };
  const fast = ema(windows.emaFast),
    mid = ema(windows.emaMid),
    slow = ema(windows.emaSlow);
  const bollingerWidth =
    candles.length < windows.bollingerWindow
      ? undefined
      : calculateBollingerWidth(
          candles.slice(-windows.bollingerWindow).map((candle) => candle.close),
        );
  const choppiness =
    candles.length < windows.choppinessWindow
      ? undefined
      : calculateChoppiness(candles.slice(-windows.choppinessWindow));
  const adxValues = wilderAdxSeries(candles, windows.adxWindow);
  const adx = round(adxValues[adxValues.length - 1]);
  const ranges = candles
    .slice(1)
    .map((c, i) =>
      Math.max(
        c.high - c.low,
        Math.abs(c.high - candles[i].close),
        Math.abs(c.low - candles[i].close),
      ),
    );
  let atr =
    ranges.length < windows.atrWindow ? undefined : average(ranges.slice(0, windows.atrWindow));
  if (atr !== undefined) {
    for (const range of ranges.slice(windows.atrWindow))
      atr = (atr * (windows.atrWindow - 1) + range) / windows.atrWindow;
  }

  return {
    emaFast: fast.value,
    emaMid: mid.value,
    emaSlow: slow.value,
    emaFastSlope: fast.slope,
    emaMidSlope: mid.slope,
    emaSlowSlope: slow.slope,
    ema25: ema(25).value,
    atrPct: atr === undefined || !latest ? undefined : atr / latest.close,
    atrPercentile: context.entryQuality.ruleGate.atrPercentile,
    volumeRatio,
    bollingerWidth,
    adx,
    choppiness,
  };
}

function inferTrendDirection(
  indicators: AegisRegimeContext['indicators'],
): AegisRegimeContext['trendDirection'] {
  if (
    indicators.emaFast !== undefined &&
    indicators.emaMid !== undefined &&
    indicators.emaSlow !== undefined
  ) {
    if (indicators.emaFast > indicators.emaMid && indicators.emaMid > indicators.emaSlow)
      return 'UP';
    if (indicators.emaFast < indicators.emaMid && indicators.emaMid < indicators.emaSlow)
      return 'DOWN';
  }
  if ((indicators.emaFastSlope ?? 0) > 0) return 'UP';
  if ((indicators.emaFastSlope ?? 0) < 0) return 'DOWN';
  return 'UNKNOWN';
}

function calculateBollingerWidth(values: number[]): number | undefined {
  if (values.length < 2) return undefined;
  const mean = average(values);
  if (!mean) return undefined;
  const variance = average(values.map((value) => (value - mean) ** 2));
  if (variance === undefined) return undefined;
  return round((4 * Math.sqrt(variance)) / mean);
}

function calculateChoppiness(
  candles: Array<{ high: number; low: number; close: number }>,
): number | undefined {
  if (candles.length < 2) return undefined;
  let trSum = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    trSum += Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    );
  }
  const high = Math.max(...candles.map((candle) => candle.high));
  const low = Math.min(...candles.map((candle) => candle.low));
  const range = high - low;
  if (range <= 0 || trSum <= 0) return undefined;
  return round((100 * Math.log10(trSum / range)) / Math.log10(candles.length));
}

function average(values: number[]): number | undefined {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: unknown, digits = 6): number | undefined {
  if (!isFiniteNumber(value)) return undefined;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
