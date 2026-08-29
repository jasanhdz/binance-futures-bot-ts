import { Side } from '../../../../core/types';

// Legacy/compatibility detector.
// Keep this guard for existing runtime metadata, historical logs and previous audits.
// RegimeEngineV2 is the new isolated OHLCV-first momentum environment detector and
// should be used for future Momentum Ride regime validation before any live migration.
export type AegisRegimeLabel =
  | 'MOMENTUM_UP'
  | 'MOMENTUM_DOWN'
  | 'BREAKOUT_UP'
  | 'BREAKOUT_DOWN'
  | 'TREND_UP'
  | 'TREND_DOWN'
  | 'CHOP'
  | 'EXHAUSTION'
  | 'RISK_OFF'
  | 'HIGH_VOL_RISK'
  | 'UNKNOWN';

export type AegisRegimeGuardMode = 'OFF' | 'SHADOW' | 'ENFORCE';
export type AegisRegimeSource = 'HYBRID_HEURISTIC' | 'ML_MODEL';
export type AegisRegimeModelScope = 'GLOBAL' | 'SYMBOL_CALIBRATED' | 'SYMBOL_SPECIFIC';

export type AegisRegimeGuardReason =
  | 'regime_trade_allowed'
  | 'regime_disabled'
  | 'regime_shadow_would_block'
  | 'regime_chop_block'
  | 'regime_risk_off_block'
  | 'regime_exhaustion_block'
  | 'regime_high_vol_risk_block'
  | 'regime_unknown_block'
  | 'regime_low_confidence'
  | 'regime_btc_eth_not_aligned'
  | 'regime_alt_long_btc_short_block'
  | 'regime_alt_short_btc_long_block'
  | 'regime_tail_risk_high'
  | 'regime_stale_snapshot'
  | 'regime_model_unavailable'
  | 'regime_invalid_source';

export interface AegisRegimeDecision {
  regime: AegisRegimeLabel;
  confidence: number;
  allowed: boolean;
  wouldBlock: boolean;
  reason: AegisRegimeGuardReason;
  source: AegisRegimeSource;
  metadata: Record<string, unknown>;
}

export interface AegisRegimeGuardConfig {
  enabled: boolean;
  mode: AegisRegimeGuardMode;
  source: AegisRegimeSource;
  allowWhen: AegisRegimeLabel[];
  blockWhen: AegisRegimeLabel[];
  minConfidence: number;
  maxSnapshotAgeSeconds: number;
  requireBtcEthAlignmentForAlts: boolean;
  allowAltLongWhenBtcShort: boolean;
  allowAltShortWhenBtcLong: boolean;
  highTailRiskThreshold: number;
  telemetry: {
    logAllEvaluations: boolean;
    includeInEntryMetadata: boolean;
  };
}

export interface AegisRegimeGuardInput {
  symbol: string;
  side: Side;
  isAltSymbol: boolean;
  turboScore?: number;
  votes?: { long?: number; short?: number; neutral?: number };
  setupGrade?: string;
  entryQualityScore?: number | null;
  tailRiskScore?: number | null;
  eventRiskMode?: string;
  eventRiskReason?: string;
  eventRiskWouldBlock?: boolean;
  eventRiskAuto?: unknown;
  btcAction?: string;
  btcScore?: number;
  btcVotes?: { long?: number; short?: number; neutral?: number };
  ethAction?: string;
  ethScore?: number;
  ethVotes?: { long?: number; short?: number; neutral?: number };
  marketDistribution?: {
    long?: number;
    short?: number;
    hold?: number;
  };
  snapshotAgeSeconds?: number;
  nowMs?: number;
  config: AegisRegimeGuardConfig;
}

export const DEFAULT_AEGIS_REGIME_GUARD_CONFIG: AegisRegimeGuardConfig = {
  enabled: false,
  mode: 'SHADOW',
  source: 'HYBRID_HEURISTIC',
  allowWhen: [
    'MOMENTUM_UP',
    'MOMENTUM_DOWN',
    'BREAKOUT_UP',
    'BREAKOUT_DOWN',
    'TREND_UP',
    'TREND_DOWN',
  ],
  blockWhen: ['RISK_OFF', 'HIGH_VOL_RISK'],
  minConfidence: 0.6,
  maxSnapshotAgeSeconds: 900,
  requireBtcEthAlignmentForAlts: true,
  allowAltLongWhenBtcShort: false,
  allowAltShortWhenBtcLong: false,
  highTailRiskThreshold: 0.45,
  telemetry: {
    logAllEvaluations: false,
    includeInEntryMetadata: true,
  },
};

const VALID_SOURCES = new Set<AegisRegimeSource>(['HYBRID_HEURISTIC', 'ML_MODEL']);
const ALLOW_GRADES = new Set(['A', 'A_PLUS']);

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeAction(value?: string): string | undefined {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();
  return normalized.length > 0 ? normalized : undefined;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function hasRegime(
  config: AegisRegimeGuardConfig,
  list: 'allowWhen' | 'blockWhen',
  regime: AegisRegimeLabel,
): boolean {
  return Array.isArray(config[list]) && config[list].includes(regime);
}

function baseMetadata(
  input: AegisRegimeGuardInput,
  source: AegisRegimeSource,
): Record<string, unknown> {
  return {
    symbol: input.symbol,
    side: input.side,
    source,
    mode: input.config.mode,
    turboScore: input.turboScore,
    votes: input.votes,
    setupGrade: input.setupGrade,
    entryQualityScore: input.entryQualityScore,
    tailRiskScore: input.tailRiskScore,
    eventRiskMode: input.eventRiskMode,
    eventRiskReason: input.eventRiskReason,
    eventRiskWouldBlock: input.eventRiskWouldBlock,
    btcAction: input.btcAction,
    btcScore: input.btcScore,
    btcVotes: input.btcVotes,
    ethAction: input.ethAction,
    ethScore: input.ethScore,
    ethVotes: input.ethVotes,
    isAltSymbol: input.isAltSymbol,
    marketDistribution: input.marketDistribution,
    snapshotAgeSeconds: input.snapshotAgeSeconds,
    minConfidence: input.config.minConfidence,
    maxSnapshotAgeSeconds: input.config.maxSnapshotAgeSeconds,
    highTailRiskThreshold: input.config.highTailRiskThreshold,
    requireBtcEthAlignmentForAlts: input.config.requireBtcEthAlignmentForAlts,
    allowAltLongWhenBtcShort: input.config.allowAltLongWhenBtcShort,
    allowAltShortWhenBtcLong: input.config.allowAltShortWhenBtcLong,
    modelScope: undefined,
    modelVersion: undefined,
    modelUnavailable: source === 'ML_MODEL',
  };
}

function decision(
  input: AegisRegimeGuardInput,
  regime: AegisRegimeLabel,
  confidence: number,
  reason: AegisRegimeGuardReason,
  source: AegisRegimeSource,
  forcedWouldBlock?: boolean,
  extraMetadata: Record<string, unknown> = {},
): AegisRegimeDecision {
  const normalizedConfidence = clampConfidence(confidence);
  const lowConfidence = normalizedConfidence < input.config.minConfidence;
  const blockedByRegime = hasRegime(input.config, 'blockWhen', regime);
  const allowedByRegime = hasRegime(input.config, 'allowWhen', regime);
  const wouldBlock = forcedWouldBlock ?? (blockedByRegime || !allowedByRegime || lowConfidence);
  let finalReason = reason;
  if (reason === 'regime_trade_allowed' && lowConfidence) {
    finalReason = 'regime_low_confidence';
  } else if (reason === 'regime_trade_allowed' && wouldBlock) {
    finalReason = 'regime_unknown_block';
  }

  return {
    regime,
    confidence: normalizedConfidence,
    allowed: !wouldBlock,
    wouldBlock,
    reason: finalReason,
    source,
    metadata: {
      ...baseMetadata(input, source),
      regime,
      confidence: normalizedConfidence,
      allowedByRegime,
      blockedByRegime,
      lowConfidence,
      wouldBlock,
      reason: finalReason,
      ...extraMetadata,
    },
  };
}

function unknownDecision(
  input: AegisRegimeGuardInput,
  reason: AegisRegimeGuardReason,
): AegisRegimeDecision {
  return decision(
    input,
    'UNKNOWN',
    0.3,
    reason,
    'HYBRID_HEURISTIC',
    hasRegime(input.config, 'blockWhen', 'UNKNOWN'),
  );
}

function btcEthContradictsSide(input: AegisRegimeGuardInput): boolean {
  const btcAction = normalizeAction(input.btcAction);
  const ethAction = normalizeAction(input.ethAction);
  if (input.side === 'LONG') {
    return btcAction === 'SHORT' || ethAction === 'SHORT';
  }
  return btcAction === 'LONG' || ethAction === 'LONG';
}

function btcEthNotAligned(input: AegisRegimeGuardInput): boolean {
  const btcAction = normalizeAction(input.btcAction);
  const ethAction = normalizeAction(input.ethAction);
  if (!btcAction || !ethAction) return true;
  if (btcAction === 'HOLD' || ethAction === 'HOLD') return true;
  if (btcAction !== ethAction) return true;
  return false;
}

function isStrongMomentum(input: AegisRegimeGuardInput): boolean {
  const score = finiteNumber(input.turboScore) ? input.turboScore : 0;
  const grade = String(input.setupGrade || '')
    .trim()
    .toUpperCase();
  return score >= 0.9 && ALLOW_GRADES.has(grade) && !btcEthContradictsSide(input);
}

function isChoppyWeakSetup(input: AegisRegimeGuardInput): boolean {
  const score = finiteNumber(input.turboScore) ? input.turboScore : 0;
  const grade = String(input.setupGrade || '')
    .trim()
    .toUpperCase();
  return grade === 'WEAK' || (score >= 0.6 && score < 0.9 && btcEthNotAligned(input));
}

export class AegisRegimeGuard {
  static evaluate(input: AegisRegimeGuardInput): AegisRegimeDecision {
    const config = input.config || DEFAULT_AEGIS_REGIME_GUARD_CONFIG;

    if (config.enabled !== true || config.mode === 'OFF') {
      return decision(
        { ...input, config },
        'UNKNOWN',
        0,
        'regime_disabled',
        VALID_SOURCES.has(config.source) ? config.source : 'HYBRID_HEURISTIC',
        false,
        { disabled: true },
      );
    }

    if (!VALID_SOURCES.has(config.source)) {
      return decision(
        { ...input, config },
        'UNKNOWN',
        0,
        'regime_invalid_source',
        'HYBRID_HEURISTIC',
        hasRegime(config, 'blockWhen', 'UNKNOWN'),
        { invalidSource: config.source },
      );
    }

    if (config.source === 'ML_MODEL') {
      return decision(
        { ...input, config },
        'UNKNOWN',
        0,
        'regime_model_unavailable',
        'ML_MODEL',
        hasRegime(config, 'blockWhen', 'UNKNOWN'),
        {
          modelScope: undefined,
          modelVersion: undefined,
          modelUnavailable: true,
        },
      );
    }

    if (
      finiteNumber(input.snapshotAgeSeconds) &&
      input.snapshotAgeSeconds > config.maxSnapshotAgeSeconds
    ) {
      return decision(
        { ...input, config },
        'UNKNOWN',
        0.25,
        'regime_stale_snapshot',
        'HYBRID_HEURISTIC',
        hasRegime(config, 'blockWhen', 'UNKNOWN'),
      );
    }

    const eventRiskMode = String(input.eventRiskMode || '')
      .trim()
      .toUpperCase();
    if (eventRiskMode === 'RISK_OFF' || eventRiskMode === 'MANUAL_ONLY') {
      return decision(
        { ...input, config },
        'RISK_OFF',
        0.9,
        'regime_risk_off_block',
        'HYBRID_HEURISTIC',
        true,
      );
    }

    if (finiteNumber(input.tailRiskScore) && input.tailRiskScore >= config.highTailRiskThreshold) {
      return decision(
        { ...input, config },
        'HIGH_VOL_RISK',
        0.8,
        'regime_tail_risk_high',
        'HYBRID_HEURISTIC',
        true,
      );
    }

    if (input.isAltSymbol && config.requireBtcEthAlignmentForAlts) {
      const btcAction = normalizeAction(input.btcAction);
      if (input.side === 'LONG' && btcAction === 'SHORT' && !config.allowAltLongWhenBtcShort) {
        return decision(
          { ...input, config },
          'RISK_OFF',
          0.78,
          'regime_alt_long_btc_short_block',
          'HYBRID_HEURISTIC',
          true,
        );
      }
      if (input.side === 'SHORT' && btcAction === 'LONG' && !config.allowAltShortWhenBtcLong) {
        return decision(
          { ...input, config },
          'CHOP',
          0.72,
          'regime_alt_short_btc_long_block',
          'HYBRID_HEURISTIC',
          true,
        );
      }
      if (btcEthNotAligned(input)) {
        return decision(
          { ...input, config },
          'CHOP',
          0.7,
          'regime_btc_eth_not_aligned',
          'HYBRID_HEURISTIC',
          true,
        );
      }
    }

    if (isStrongMomentum(input)) {
      return decision(
        { ...input, config },
        input.side === 'LONG' ? 'MOMENTUM_UP' : 'MOMENTUM_DOWN',
        0.82,
        'regime_trade_allowed',
        'HYBRID_HEURISTIC',
      );
    }

    if (isChoppyWeakSetup(input)) {
      return decision(
        { ...input, config },
        'CHOP',
        0.65,
        'regime_chop_block',
        'HYBRID_HEURISTIC',
        true,
      );
    }

    return unknownDecision(
      { ...input, config },
      hasRegime(config, 'blockWhen', 'UNKNOWN') ? 'regime_unknown_block' : 'regime_low_confidence',
    );
  }
}
