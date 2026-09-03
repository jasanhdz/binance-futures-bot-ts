import { MicroBurstRuntimeConfig, MicroBurstSymbolConfig } from './MicroBurstRuntimeTypes';
import type { MicroBurstConfig } from '../domain/MicroBurstTypes';

const DEFAULT_SYMBOLS: Record<string, MicroBurstSymbolConfig> = {};

const DEFAULT_CONFIG: MicroBurstRuntimeConfig = {
  enabled: false,
  mode: 'OFF',
  symbols: DEFAULT_SYMBOLS,
  prospectiveValidation: { enabled: false },
  marketArchive: { enabled: false },
};

const EXIT_POLICY_NUMBER_FIELDS = {
  exit_proof_window_ms: 'exitProofWindowMs',
  exit_min_proof_excursion_bps: 'exitMinProofExcursionBps',
  exit_proof_extension_ms: 'exitProofExtensionMs',
  exit_immediate_adverse_bps: 'exitImmediateAdverseBps',
  exit_immediate_adverse_risk_fraction: 'exitImmediateAdverseRiskFraction',
  exit_immediate_adverse_max_bps: 'exitImmediateAdverseMaxBps',
  exit_max_hold_ms: 'exitMaxHoldMs',
  exit_max_hold_extension_ms: 'exitMaxHoldExtensionMs',
  exit_estimated_round_trip_cost_bps: 'exitEstimatedRoundTripCostBps',
  exit_cost_cover_buffer_bps: 'exitCostCoverBufferBps',
  exit_break_even_activation_bps: 'exitBreakEvenActivationBps',
  exit_intelligence_min_hold_ms: 'exitIntelligenceMinHoldMs',
  exit_intelligence_confirmation_ms: 'exitIntelligenceConfirmationMs',
  exit_intelligence_max_observation_gap_ms: 'exitIntelligenceMaxObservationGapMs',
  exit_intelligence_min_evidence_families: 'exitIntelligenceMinEvidenceFamilies',
  exit_intelligence_score_threshold: 'exitIntelligenceScoreThreshold',
  exit_continuation_support_threshold: 'exitContinuationSupportThreshold',
  exit_intelligence_exit_pressure_threshold: 'exitIntelligenceExitPressureThreshold',
  exit_winner_exit_pressure_threshold: 'exitWinnerExitPressureThreshold',
  exit_momentum_reversal_bps: 'exitMomentumReversalBps',
  exit_flow_reversal_ratio: 'exitFlowReversalRatio',
  exit_flow_min_trades: 'exitFlowMinTrades',
  exit_book_reversal_imbalance: 'exitBookReversalImbalance',
  exit_book_reversal_slope: 'exitBookReversalSlope',
  exit_structural_exhaustion_progress: 'exitStructuralExhaustionProgress',
  exit_structural_lock_progress: 'exitStructuralLockProgress',
  exit_protection_min_distance_bps: 'exitProtectionMinDistanceBps',
} as const satisfies Record<string, keyof MicroBurstConfig>;

function parseExitPolicy(raw: unknown): Partial<MicroBurstConfig> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const parsed: Partial<MicroBurstConfig> = {};
  for (const [yamlKey, configKey] of Object.entries(EXIT_POLICY_NUMBER_FIELDS) as Array<
    [
      keyof typeof EXIT_POLICY_NUMBER_FIELDS,
      (typeof EXIT_POLICY_NUMBER_FIELDS)[keyof typeof EXIT_POLICY_NUMBER_FIELDS],
    ]
  >) {
    const candidate = value[yamlKey] ?? value[configKey];
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0)
      (parsed as Record<string, unknown>)[configKey] = candidate;
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseSymbolConfig(raw: unknown): MicroBurstSymbolConfig {
  if (!raw || typeof raw !== 'object') {
    return { enabled: false };
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: obj.enabled === true,
    btcConflictThresholdBps:
      typeof obj.btcConflictThresholdBps === 'number' ? obj.btcConflictThresholdBps : undefined,
    bookDepthLevels: typeof obj.bookDepthLevels === 'number' ? obj.bookDepthLevels : undefined,
    bookDepthSpeed:
      obj.bookDepthSpeed === '100ms' ||
      obj.bookDepthSpeed === '250ms' ||
      obj.bookDepthSpeed === '500ms'
        ? obj.bookDepthSpeed
        : undefined,
  };
}

function parseMode(raw: unknown): 'OFF' | 'SHADOW' | 'LIVE' {
  if (raw === 'SHADOW') return 'SHADOW';
  if (raw === 'LIVE') return 'LIVE';
  return 'OFF';
}

export function parseMicroBurstConfig(yamlData: unknown): MicroBurstRuntimeConfig {
  if (!yamlData || typeof yamlData !== 'object') {
    return DEFAULT_CONFIG;
  }

  const data = yamlData as Record<string, unknown>;
  const mbSection = data.micro_burst ?? data.microBurst;

  if (!mbSection || typeof mbSection !== 'object') {
    return DEFAULT_CONFIG;
  }

  const mb = mbSection as Record<string, unknown>;
  const enabled = mb.enabled === true;
  const mode = parseMode(mb.mode);

  const symbols: Record<string, MicroBurstSymbolConfig> = {};
  const rawSymbols = mb.symbols;
  if (rawSymbols && typeof rawSymbols === 'object') {
    for (const [symbol, symRaw] of Object.entries(rawSymbols as Record<string, unknown>)) {
      symbols[symbol] = parseSymbolConfig(symRaw);
    }
  }

  return {
    enabled,
    mode,
    symbols,
    exitPolicy: parseExitPolicy(mb.exit_policy ?? mb.exitPolicy),
    prospectiveValidation: parseProspectiveValidation(mb.prospective_validation),
    marketArchive: parseMarketArchive(mb.market_archive),
  };
}

function parseProspectiveValidation(
  raw: unknown,
): MicroBurstRuntimeConfig['prospectiveValidation'] {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    enabled: value.enabled === true,
    cohortId: typeof value.cohort_id === 'string' ? value.cohort_id : undefined,
    horizonsMs:
      Array.isArray(value.horizons_ms) && value.horizons_ms.every((v) => typeof v === 'number')
        ? (value.horizons_ms as number[])
        : undefined,
    conservativeEntrySlippageBps:
      typeof value.conservative_entry_slippage_bps === 'number'
        ? value.conservative_entry_slippage_bps
        : undefined,
  };
}

function parseMarketArchive(raw: unknown): MicroBurstRuntimeConfig['marketArchive'] {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    enabled: value.enabled === true,
    rootDir: typeof value.root_dir === 'string' ? value.root_dir : undefined,
    sqlitePath: typeof value.sqlite_path === 'string' ? value.sqlite_path : undefined,
    tradeRetentionMs:
      typeof value.trade_retention_ms === 'number' ? value.trade_retention_ms : undefined,
    bookCheckpointIntervalMs:
      typeof value.book_checkpoint_interval_ms === 'number'
        ? value.book_checkpoint_interval_ms
        : undefined,
    rawTradeArchive: value.raw_trade_archive !== false,
    rawDepthArchive: value.raw_depth_archive !== false,
    compression: value.compression === 'gzip' ? 'gzip' : 'gzip',
    maxActiveSegmentRecords:
      typeof value.max_active_segment_records === 'number'
        ? value.max_active_segment_records
        : undefined,
    maxActiveSegmentBytes:
      typeof value.max_active_segment_bytes === 'number'
        ? value.max_active_segment_bytes
        : undefined,
    maxActiveSegmentDurationMs:
      typeof value.max_active_segment_duration_ms === 'number'
        ? value.max_active_segment_duration_ms
        : undefined,
    durabilityFlushIntervalMs:
      typeof value.durability_flush_interval_ms === 'number'
        ? value.durability_flush_interval_ms
        : undefined,
  };
}

export function microBurstConfigFromEnv(): MicroBurstRuntimeConfig {
  const enabled = process.env.MICRO_BURST_V1_ENABLED === 'true';
  const modeStr = process.env.MICRO_BURST_V1_MODE ?? 'OFF';
  const mode = parseMode(modeStr);

  const symbols: Record<string, MicroBurstSymbolConfig> = {};
  const symbolsEnv = process.env.MICRO_BURST_V1_SYMBOLS;
  if (symbolsEnv) {
    for (const sym of symbolsEnv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      symbols[sym] = { enabled: true };
    }
  }

  return {
    enabled,
    mode,
    symbols,
    prospectiveValidation: {
      enabled: process.env.MICRO_BURST_V1_PROSPECTIVE_VALIDATION === 'true',
    },
    marketArchive: { enabled: process.env.MICRO_BURST_V1_MARKET_ARCHIVE === 'true' },
  };
}

export function mergeMicroBurstConfigs(
  base: MicroBurstRuntimeConfig,
  override: Partial<MicroBurstRuntimeConfig>,
): MicroBurstRuntimeConfig {
  const symbols = { ...base.symbols };
  if (override.symbols) {
    for (const [sym, conf] of Object.entries(override.symbols)) {
      symbols[sym] = { ...symbols[sym], ...conf };
    }
  }

  return {
    enabled: override.enabled ?? base.enabled,
    mode: override.mode ?? base.mode,
    symbols,
    exitPolicy: { ...base.exitPolicy, ...override.exitPolicy },
    prospectiveValidation: {
      ...base.prospectiveValidation,
      ...override.prospectiveValidation,
      enabled:
        override.prospectiveValidation?.enabled ?? base.prospectiveValidation?.enabled ?? false,
    },
    marketArchive: {
      ...base.marketArchive,
      ...override.marketArchive,
      enabled: override.marketArchive?.enabled ?? base.marketArchive?.enabled ?? false,
    },
  };
}

export function isMicroBurstShadowMode(config: MicroBurstRuntimeConfig): boolean {
  return config.enabled && config.mode === 'SHADOW';
}

export function isMicroBurstLiveMode(config: MicroBurstRuntimeConfig): boolean {
  return config.enabled && config.mode === 'LIVE';
}
