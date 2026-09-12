import type { MicroBurstStrategyContext } from './MicroBurstStrategy';
import type { MicroBurstConfig } from './MicroBurstTypes';
import { defaultMicroBurstConfig } from './MicroBurstTypes';
import { evaluateMicroBurstReactionEntry } from './MicroBurstReactionEntryPolicy';
import { copyObservation } from '../../../core/blackbox/BoundedObservationQueue';

export const MICRO_EXACT_REPLAY_SCHEMA = 'MICRO_EXACT_INPUT' as const;
export const MICRO_EVALUATOR_REVISION = 'micro-reaction-at-use-freshness-2' as const;
export const MICRO_EVIDENCE_LIMITS = {
  maxRecords: 16,
  maxBytes: 8 * 1024 * 1024,
  maxRecordBytes: 2 * 1024 * 1024,
  maxNodes: 100_000,
  maxDepth: 32,
};
export const MICRO_INPUT_COPY_LIMITS = {
  ...MICRO_EVIDENCE_LIMITS,
  maxBytes: MICRO_EVIDENCE_LIMITS.maxRecordBytes,
};

export interface MicroBurstExactReplay {
  schema: typeof MICRO_EXACT_REPLAY_SCHEMA;
  schemaVersion: 1;
  evaluatorRevision: typeof MICRO_EVALUATOR_REVISION;
  codeCommitSha: string;
  context: MicroBurstStrategyContext;
  config: MicroBurstConfig;
  sourcesPresent: { executionBook: boolean; aggTradeFlow: boolean; builderInputs: boolean };
}

export function captureMicroBurstReplay(
  context: MicroBurstStrategyContext,
  config: MicroBurstConfig,
  codeCommitSha: string,
): MicroBurstExactReplay {
  return copyObservation(
    {
      schema: MICRO_EXACT_REPLAY_SCHEMA,
      schemaVersion: 1 as const,
      evaluatorRevision: MICRO_EVALUATOR_REVISION,
      codeCommitSha,
      context: {
        ...context,
        exchangeObservedAtMs: context.exchangeObservedAtMs ?? context.observedAtMs ?? NaN,
      },
      config,
      sourcesPresent: {
        executionBook: context.executionBook !== undefined,
        aggTradeFlow: context.aggTradeFlow !== undefined,
        builderInputs: context.inputSources !== undefined,
      },
    },
    MICRO_INPUT_COPY_LIMITS,
  ).value;
}

/** Non-finite numeric sentinels are losslessly tagged, never silently serialized as null. */
export function encodeMicroReplay(value: MicroBurstExactReplay): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === 'number' && !Number.isFinite(item) ? { microNumber: String(item) } : item,
    ),
  );
}

export function replayMicroBurstExact(
  input: unknown,
  expectedCommitSha: string,
): ReturnType<typeof evaluateMicroBurstReactionEntry> {
  if (!/^[a-f0-9]{40}$/.test(expectedCommitSha))
    throw new Error('MICRO_REPLAY_CODE_REVISION_REQUIRED');
  const bounded = copyObservation(input, MICRO_EVIDENCE_LIMITS).value;
  const replay = JSON.parse(JSON.stringify(bounded), (_key, item) => {
    if (
      item &&
      typeof item === 'object' &&
      Object.keys(item).length === 1 &&
      'microNumber' in item
    ) {
      if (!['Infinity', '-Infinity', 'NaN'].includes(item.microNumber))
        throw new Error('MICRO_REPLAY_INVALID_NUMBER_TAG');
      return Number(item.microNumber);
    }
    return item;
  }) as MicroBurstExactReplay;
  if (!replay || replay.schema !== MICRO_EXACT_REPLAY_SCHEMA || replay.schemaVersion !== 1)
    throw new Error('MICRO_REPLAY_INCOMPLETE_OR_UNSUPPORTED');
  if (
    replay.evaluatorRevision !== MICRO_EVALUATOR_REVISION ||
    replay.codeCommitSha !== expectedCommitSha
  )
    throw new Error('MICRO_REPLAY_CODE_REVISION_MISMATCH');
  const requireFields = (object: unknown, keys: readonly string[], path: string): void => {
    if (
      !object ||
      typeof object !== 'object' ||
      keys.some((key) => !Object.prototype.hasOwnProperty.call(object, key))
    )
      throw new Error(`MICRO_REPLAY_INCOMPLETE:${path}`);
  };
  requireFields(replay.config, Object.keys(defaultMicroBurstConfig()), 'config');
  const requireShape = (value: unknown, template: unknown, path: string): void => {
    if (template !== null && typeof template === 'object') {
      requireFields(value, Object.keys(template), path);
      for (const [key, child] of Object.entries(template))
        requireShape((value as Record<string, unknown>)[key], child, `${path}.${key}`);
    } else if (typeof value !== typeof template)
      throw new Error(`MICRO_REPLAY_INVALID_TYPE:${path}`);
  };
  requireShape(replay.config, defaultMicroBurstConfig(), 'config');
  requireShape(
    replay.sourcesPresent,
    { executionBook: false, aggTradeFlow: false, builderInputs: false },
    'sourcesPresent',
  );
  const ctx = replay.context;
  requireFields(
    ctx,
    [
      'symbol',
      'timestamp',
      'currentPrice',
      'decisionPrice',
      'candles',
      'levels',
      'momentum',
      'bookPressure',
      'btcContext',
      'structuralClarity',
      'microRegime',
      'dataQuality',
      'observedAtMs',
      'exchangeObservedAtMs',
    ],
    'context',
  );
  requireShape(
    ctx,
    {
      symbol: '',
      timestamp: 0,
      currentPrice: 0,
      structuralClarity: false,
      microRegime: '',
      observedAtMs: 0,
      exchangeObservedAtMs: 0,
      decisionPrice: { price: 0, source: '', observedAtMs: 0 },
    },
    'context',
  );
  if (
    !ctx.symbol ||
    !['RANGING', 'VOLATILE', 'TRENDING_UP', 'TRENDING_DOWN'].includes(ctx.microRegime) ||
    ctx.decisionPrice.source !== 'CANDLE'
  )
    throw new Error('MICRO_REPLAY_INVALID_CONTEXT_ENUM');
  requireFields(ctx.candles, ['candles1m', 'candles3m', 'candles5m'], 'candles');
  if (
    replay.sourcesPresent.executionBook !== (ctx.executionBook !== undefined) ||
    replay.sourcesPresent.aggTradeFlow !== (ctx.aggTradeFlow !== undefined) ||
    replay.sourcesPresent.builderInputs !== (ctx.inputSources !== undefined)
  )
    throw new Error('MICRO_REPLAY_INCOMPLETE:sourcePresence');
  for (const candles of Object.values(ctx.candles)) {
    if (!Array.isArray(candles)) throw new Error('MICRO_REPLAY_INVALID_CANDLES');
    for (const candle of candles)
      requireShape(
        candle,
        {
          timestamp: 0,
          openTime: 0,
          closeTime: 0,
          open: 0,
          high: 0,
          low: 0,
          close: 0,
          volume: 0,
          buyVolume: 0,
        },
        'candle',
      );
  }
  requireFields(ctx.levels, ['levels', 'nearest'], 'levels');
  requireFields(
    ctx.levels.nearest,
    [
      'support',
      'resistance',
      'distanceToSupportBps',
      'distanceToResistanceBps',
      'corridorWidthBps',
      'structuralPosition',
    ],
    'nearest',
  );
  if (!Array.isArray(ctx.levels.levels)) throw new Error('MICRO_REPLAY_INVALID_LEVELS');
  const historicalLevels = [];
  if (ctx.levels.history !== undefined) {
    if (!Array.isArray(ctx.levels.history)) throw new Error('MICRO_REPLAY_INVALID_LEVEL_HISTORY');
    for (const [index, version] of ctx.levels.history.entries()) {
      requireShape(version, { asOfMs: 0 }, 'levelHistory');
      if (
        !Array.isArray(version.levels) ||
        !Number.isFinite(version.asOfMs) ||
        version.asOfMs > ctx.timestamp ||
        (index > 0 && version.asOfMs <= ctx.levels.history[index - 1].asOfMs)
      )
        throw new Error('MICRO_REPLAY_INVALID_LEVEL_HISTORY');
      historicalLevels.push(...version.levels);
    }
  }
  for (const level of [
    ...ctx.levels.levels,
    ...historicalLevels,
    ctx.levels.nearest.support,
    ctx.levels.nearest.resistance,
  ]) {
    if (level !== null)
      requireShape(
        level,
        {
          price: 0,
          type: '',
          strength: 0,
          touches: 0,
          lastTouchIndex: 0,
          pivotCandleIndex: 0,
          availableAtCandleIndex: 0,
          pivotAtMs: 0,
          availableAtMs: 0,
          volumeAtLevel: 0,
        },
        'level',
      );
  }
  requireShape(
    ctx.momentum,
    {
      direction: '',
      strength: 0,
      continuationScore: 0,
      slope1m: 0,
      slope3m: 0,
      slope5m: 0,
      bodyStrength: 0,
      wickRejectionUpper: 0,
      wickRejectionLower: 0,
      volumeExpansion: false,
      candleSequenceQuality: 0,
    },
    'momentum',
  );
  requireShape(
    ctx.bookPressure,
    {
      status: '',
      anomalyFlag: false,
      spreadBps: 0,
      signedTopOfBookImbalance: 0,
      topOfBookImbalance: 0,
      temporalAbsorptionDetected: false,
      temporalSweepDetected: false,
      staticBidConcentration: false,
      staticAskConcentration: false,
    },
    'bookPressure',
  );
  requireShape(
    ctx.dataQuality,
    {
      contextValid: false,
      closedCandlesOnly: false,
      snapshotAtMs: 0,
      latestClosed1mAt: 0,
      latestClosed3mAt: 0,
      latestClosed5mAt: 0,
      freshness1mMs: 0,
      freshness3mMs: 0,
      freshness5mMs: 0,
      bookStatus: '',
      btcStatus: '',
    },
    'dataQuality',
  );
  if (
    !Array.isArray(ctx.dataQuality.invalidReasons) ||
    ctx.dataQuality.invalidReasons.some((reason) => typeof reason !== 'string')
  )
    throw new Error('MICRO_REPLAY_INVALID_TYPE:dataQuality.invalidReasons');
  for (const value of [
    ctx.bookPressure.imbalanceSlope,
    ctx.dataQuality.bookAgeMs,
    ctx.dataQuality.btcAgeMs,
    ctx.dataQuality.levelsAvailableAt,
  ])
    if (value !== null && typeof value !== 'number')
      throw new Error('MICRO_REPLAY_INVALID_NULLABLE_NUMBER');
  if (ctx.btcContext !== null)
    requireShape(
      ctx.btcContext,
      {
        ret1m: 0,
        ret3m: 0,
        ret5m: 0,
        acceleration: 0,
        conflictFlag: false,
        direction: '',
        observedAtMs: 0,
        receivedAtMs: 0,
      },
      'btcContext',
    );
  requireFields(
    ctx.momentum,
    [
      'direction',
      'strength',
      'continuationScore',
      'slope1m',
      'slope3m',
      'slope5m',
      'bodyStrength',
      'wickRejectionUpper',
      'wickRejectionLower',
      'volumeExpansion',
      'candleSequenceQuality',
    ],
    'momentum',
  );
  requireFields(
    ctx.bookPressure,
    [
      'status',
      'anomalyFlag',
      'topOfBookImbalance',
      'signedTopOfBookImbalance',
      'spreadBps',
      'imbalanceSlope',
      'temporalAbsorptionDetected',
      'temporalSweepDetected',
      'staticBidConcentration',
      'staticAskConcentration',
    ],
    'bookPressure',
  );
  requireFields(
    ctx.dataQuality,
    [
      'contextValid',
      'invalidReasons',
      'snapshotAtMs',
      'closedCandlesOnly',
      'latestClosed1mAt',
      'latestClosed3mAt',
      'latestClosed5mAt',
      'freshness1mMs',
      'freshness3mMs',
      'freshness5mMs',
      'bookAgeMs',
      'btcAgeMs',
      'bookStatus',
      'btcStatus',
      'levelsAvailableAt',
    ],
    'dataQuality',
  );
  if (ctx.btcContext !== null)
    requireFields(
      ctx.btcContext,
      [
        'observedAtMs',
        'receivedAtMs',
        'ret1m',
        'ret3m',
        'ret5m',
        'acceleration',
        'conflictFlag',
        'direction',
      ],
      'btcContext',
    );
  // Absent optional sources are legitimate inputs to a fail-closed evaluation.
  if (replay.sourcesPresent.executionBook) {
    requireShape(ctx.executionBook, { observedAtMs: 0, status: '' }, 'executionBook');
    requireFields(
      ctx.executionBook,
      ['bidDepth', 'askDepth', 'observedAtMs', 'status'],
      'executionBook',
    );
    for (const depth of [ctx.executionBook!.bidDepth, ctx.executionBook!.askDepth]) {
      if (!Array.isArray(depth)) throw new Error('MICRO_REPLAY_INVALID_DEPTH');
      for (const level of depth) requireShape(level, { price: 0, qty: 0 }, 'depth');
    }
  }
  if (ctx.aggTradeFlow)
    requireFields(
      ctx.aggTradeFlow,
      [
        'buyTakerVolume',
        'sellTakerVolume',
        'netTakerFlow',
        'tradeCount',
        'requestedWindowMs',
        'observedWindowMs',
        'observedSampleCount',
        'eventWatermarkMs',
        'capacityTruncated',
        'coverageStartedAtMs',
        'windowComplete',
        'gapFree',
      ],
      'flow',
    );
  if (replay.sourcesPresent.aggTradeFlow) {
    requireShape(
      ctx.aggTradeFlow,
      {
        buyTakerVolume: 0,
        sellTakerVolume: 0,
        netTakerFlow: 0,
        tradeCount: 0,
        requestedWindowMs: 0,
        observedWindowMs: 0,
        observedSampleCount: 0,
        capacityTruncated: false,
        windowComplete: false,
        gapFree: false,
      },
      'flow',
    );
    for (const value of [ctx.aggTradeFlow!.eventWatermarkMs, ctx.aggTradeFlow!.coverageStartedAtMs])
      if (value !== null && typeof value !== 'number')
        throw new Error('MICRO_REPLAY_INVALID_NULLABLE_NUMBER');
  }
  if (replay.sourcesPresent.builderInputs) {
    requireFields(
      ctx.inputSources,
      ['rawCandles', 'book', 'builderConfig', 'timing'],
      'builderInputs',
    );
    requireShape(ctx.inputSources!.builderConfig, defaultMicroBurstConfig(), 'builderConfig');
    requireFields(
      ctx.inputSources!.rawCandles,
      ['candles1m', 'candles3m', 'candles5m'],
      'rawCandles',
    );
  }
  return evaluateMicroBurstReactionEntry(
    ctx,
    replay.config,
    ctx.executionBook,
    ctx.observedAtMs!,
    ctx.exchangeObservedAtMs!,
  );
}
