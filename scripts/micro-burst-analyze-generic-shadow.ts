#!/usr/bin/env npx tsx
import { FileShadowTradeJournal } from '../src/core/shadow/ShadowTradeJournal';
import { analyzeShadow } from '../src/core/shadow/ShadowTradeAnalyzer';

const strategyId = argument('--strategy') ?? 'MICRO_BURST_V1';
const symbol = argument('--symbol');
const tradesDir = argument('--trades-dir') ?? 'logs/micro-burst/shadow/trades';
const eventsDir = argument('--events-dir') ?? 'logs/micro-burst/shadow/trade-events';
const journal = new FileShadowTradeJournal(tradesDir, eventsDir);
const positions = journal.loadAllPositions();
const events = journal.loadAllEvents();
const report = analyzeShadow(positions, events, { strategyId, symbol });
const selected = positions.filter(
  (position) => position.strategyId === strategyId && (!symbol || position.symbol === symbol),
);
const durations = selected
  .filter((position) => position.closedReceivedAtMs !== undefined)
  .map((position) => position.closedReceivedAtMs! - position.openedReceivedAtMs);
const bySymbol = Object.fromEntries(
  [...new Set(selected.map((position) => position.symbol))].map((currentSymbol) => [
    currentSymbol,
    analyzeShadow(positions, events, { strategyId, symbol: currentSymbol }),
  ]),
);

console.log(
  JSON.stringify(
    {
      strategyId,
      symbol: symbol ?? null,
      tradesDir,
      eventsDir,
      journal: journal.getHealth(),
      report,
      durationMs: durations,
      bySymbol,
    },
    null,
    2,
  ),
);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
