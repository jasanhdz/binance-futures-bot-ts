import { ShadowPosition, ShadowTradeEvent } from './ShadowTradingTypes';

export interface ShadowResearchReport {
  strategyId?: string;
  symbol?: string;
  completedTrades: number;
  openTrades: number;
  longCount: number;
  shortCount: number;
  grossBps: number[];
  netBpsByScenario: Record<string, number[]>;
  mfeBps: number[];
  maeBps: number[];
  exitReasons: Record<string, number>;
  suppressionCount: number;
  dataUncertain: number;
  recoveryBlocked: number;
}

export function analyzeShadow(
  positions: ShadowPosition[],
  events: ShadowTradeEvent[],
  filter: { strategyId?: string; symbol?: string } = {},
): ShadowResearchReport {
  const selected = positions.filter(
    (p) =>
      (!filter.strategyId || p.strategyId === filter.strategyId) &&
      (!filter.symbol || p.symbol === filter.symbol),
  );
  const selectedKeys = new Set(selected.map((p) => p.tradeId));
  const relevantEvents = events.filter(
    (e) =>
      (!filter.strategyId || e.strategyId === filter.strategyId) &&
      (!filter.symbol || e.symbol === filter.symbol),
  );
  const completed = selected.filter((p) => p.state === 'CLOSED');
  const net: Record<string, number[]> = {};
  for (const position of completed)
    for (const [scenario, bps] of Object.entries(position.netBpsByCostScenario ?? {}))
      (net[scenario] ??= []).push(bps);
  return {
    ...filter,
    completedTrades: completed.length,
    openTrades: selected.filter((p) => p.state !== 'CLOSED').length,
    longCount: selected.filter((p) => p.side === 'LONG').length,
    shortCount: selected.filter((p) => p.side === 'SHORT').length,
    grossBps: completed.flatMap((p) => (p.grossBps === undefined ? [] : [p.grossBps])),
    netBpsByScenario: net,
    mfeBps: selected.map((p) => p.mfeBps),
    maeBps: selected.map((p) => p.maeBps),
    exitReasons: count(completed.map((p) => p.exitReason).filter((x): x is string => Boolean(x))),
    suppressionCount: relevantEvents.filter(
      (e) => e.event === 'ENTRY_SUPPRESSED' && (!e.tradeId || selectedKeys.has(e.tradeId)),
    ).length,
    dataUncertain:
      selected.filter((p) => p.state === 'DATA_UNCERTAIN').length +
      relevantEvents.filter(
        (e) => e.event === 'DATA_UNCERTAIN' || e.event === 'UNFILLED_DATA_UNCERTAIN',
      ).length,
    recoveryBlocked: selected.filter((p) => p.state === 'RECOVERY_BLOCKED').length,
  };
}

function count(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((out, value) => {
    out[value] = (out[value] ?? 0) + 1;
    return out;
  }, {});
}
