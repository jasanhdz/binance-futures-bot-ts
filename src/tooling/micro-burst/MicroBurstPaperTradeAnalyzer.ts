import { MicroBurstPaperPosition } from '../../domain/strategies/micro-burst/MicroBurstPaperTrading';

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
  trailingUsed: number;
  costBps: { fees: number; spread: number; slippage: number; other: number; total: number };
}

export function analyzeMicroBurstPaperTrades(
  positions: MicroBurstPaperPosition[],
  suppressedEntryCount = 0,
  incompleteCount = 0,
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
    trailingUsed: closed.filter((position) => position.trailingActivated).length,
    costBps: {
      fees: sum(closed, 'feesBps'),
      spread: sum(closed, 'spreadImpactBps'),
      slippage: sum(closed, 'slippageBps'),
      other: sum(closed, 'otherCostsBps'),
      total: sum(closed, 'totalCostBps'),
    },
    suppressedEntryCount,
    incompleteCount,
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
): number {
  return positions.reduce((total, position) => total + (position[key] ?? 0), 0);
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
