import { MicroBurstPaperPosition } from '../../strategies/micro-burst/research/MicroBurstPaperTrading';
import { DEFAULT_COST_SCENARIOS } from '../../strategies/micro-burst/research/MicroBurstOutcomeTypes';
import { MicroBurstPaperLifecycleEvent } from '../../strategies/micro-burst/research/MicroBurstPaperTrading';
import { MicroBurstSuppressionAccounting } from '../../strategies/micro-burst/research/MicroBurstPaperTradeJournal';

export interface MicroBurstPaperTradeReport {
  sampleSize: number;
  independentTrades: number;
  longCount: number;
  shortCount: number;
  perSymbol: Record<string, number>;
  grossWinRate: number;
  netWinRate: number;
  meanGrossBps: number | null;
  medianGrossBps: number | null;
  meanNetBps: number | null;
  medianNetBps: number | null;
  meanMfeBps: number | null;
  meanMaeBps: number | null;
  meanDurationMs: number | null;
  exitReasons: Record<string, number>;
  breakEvenUsed: number;
  costBps: {
    fees: number | null;
    spread: number | null;
    slippage: number | null;
    other: number | null;
    total: number | null;
  };
  openCount: number;
  dataUncertainCount: number;
  completedTradeCount: number;
  openTradeCount: number;
  dataUncertainTradeCount: number;
  unfilledDataUncertainCount: number;
  incompleteCanonicalTradeCount: number;
  suppressedCandidateCount: number;
  suppressionEpisodeCount: number;
  recoveryBlockedCount: number | null;
  scenarioMetrics: Record<
    string,
    { netWinRate: number | null; meanNetBps: number | null; medianNetBps: number | null }
  >;
}

export function analyzeMicroBurstPaperTrades(
  positions: MicroBurstPaperPosition[],
  suppressedEntryCount = 0,
  incompleteCount = 0,
  events: MicroBurstPaperLifecycleEvent[] = [],
  suppressionAccounting: MicroBurstSuppressionAccounting[] = [],
): MicroBurstPaperTradeReport & { suppressedEntryCount: number; incompleteCount: number } {
  const closed = [
    ...new Map(
      positions
        .filter((position) => position.state === 'CLOSED')
        .map((position) => [position.tradeId, position]),
    ).values(),
  ];
  const values = (key: 'grossPriceReturnBps' | 'netBps' | 'mfeBps' | 'maeBps' | 'closedAtMs') =>
    closed
      .map((position) => position[key])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const gross = values('grossPriceReturnBps');
  const net = values('netBps');
  const suppressionCandidates = suppressionAccounting.reduce(
    (total, accounting) => total + accounting.candidateCount,
    0,
  );
  const suppressionEpisodes = suppressionAccounting.length;
  const fallbackSuppressionEvents = events.filter(
    (event) => event.event === 'ENTRY_SUPPRESSED_POSITION_OPEN',
  );
  const derivedSuppressed = suppressionAccounting.length
    ? suppressionCandidates
    : fallbackSuppressionEvents.length;
  const derivedEpisodes = suppressionAccounting.length
    ? suppressionEpisodes
    : new Set(fallbackSuppressionEvents.map((event) => event.tradeId).filter(Boolean)).size;
  const dataUncertainTradeCount = new Set(
    positions
      .filter((position) => position.state === 'DATA_UNCERTAIN')
      .map((position) => position.tradeId),
  ).size;
  const openTradeCount = new Set(
    positions
      .filter((position) => position.state === 'OPEN_SHADOW' || position.state === 'MANAGING')
      .map((position) => position.tradeId),
  ).size;
  const unfilledDataUncertainCount = new Set(
    events
      .filter((event) => event.event === 'UNFILLED_DATA_UNCERTAIN')
      .map((event) =>
        String(event.metadata?.parentSignalId ?? `${event.symbol}:${event.eventAtMs}`),
      ),
  ).size;
  const incompleteCanonicalTradeCount = new Set(
    positions.filter((position) => position.state !== 'CLOSED').map((position) => position.tradeId),
  ).size;
  const scenarioMetrics = Object.fromEntries(
    DEFAULT_COST_SCENARIOS.map((scenario) => {
      const scenarioValues = closed
        .map(
          (position) =>
            position.costScenarios?.[scenario.label]?.netBps ??
            position.netBpsByCostScenario?.[scenario.label],
        )
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      return [
        scenario.label,
        {
          netWinRate: scenarioValues.length ? winRate(scenarioValues) : null,
          meanNetBps: mean(scenarioValues),
          medianNetBps: median(scenarioValues),
        },
      ];
    }),
  );
  const durations = closed
    .map((position) => (position.closedAtMs ?? 0) - position.openedAtMs)
    .filter((value) => value >= 0);
  return {
    sampleSize: closed.length,
    independentTrades: closed.length,
    longCount: closed.filter((position) => position.side === 'LONG').length,
    shortCount: closed.filter((position) => position.side === 'SHORT').length,
    perSymbol: counts(closed.map((position) => position.symbol)),
    grossWinRate: winRate(gross),
    netWinRate: winRate(net),
    meanGrossBps: mean(gross),
    medianGrossBps: median(gross),
    meanNetBps: mean(net),
    medianNetBps: median(net),
    meanMfeBps: mean(values('mfeBps')),
    meanMaeBps: mean(values('maeBps')),
    meanDurationMs: mean(durations),
    exitReasons: counts(closed.map((position) => position.exitReason ?? 'UNKNOWN')),
    breakEvenUsed: closed.filter((position) => position.breakEvenArmed).length,
    costBps: {
      fees: sum(closed, 'feesBps'),
      spread: sum(closed, 'spreadImpactBps'),
      slippage: sum(closed, 'slippageBps'),
      other: sum(closed, 'otherCostsBps'),
      total: sum(closed, 'totalCostBps'),
    },
    suppressedEntryCount: suppressedEntryCount || derivedSuppressed,
    incompleteCount: incompleteCount || incompleteCanonicalTradeCount + unfilledDataUncertainCount,
    openCount: openTradeCount,
    dataUncertainCount: dataUncertainTradeCount,
    completedTradeCount: closed.length,
    openTradeCount,
    dataUncertainTradeCount,
    unfilledDataUncertainCount,
    incompleteCanonicalTradeCount,
    suppressedCandidateCount: suppressedEntryCount || derivedSuppressed,
    suppressionEpisodeCount: derivedEpisodes,
    recoveryBlockedCount: null,
    scenarioMetrics,
  };
}

function counts(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}
function sum(
  positions: MicroBurstPaperPosition[],
  key: 'feesBps' | 'spreadImpactBps' | 'slippageBps' | 'otherCostsBps' | 'totalCostBps',
): number | null {
  const values = positions
    .map((position) => position[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}
function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function winRate(values: number[]): number {
  return values.length ? values.filter((value) => value > 0).length / values.length : 0;
}
