#!/usr/bin/env npx tsx
import { MicroBurstPaperTradeJournal } from '../src/app/micro-burst/MicroBurstPaperTradeJournal';
import { analyzeMicroBurstPaperTrades } from '../src/tooling/micro-burst/MicroBurstPaperTradeAnalyzer';

const journal = new MicroBurstPaperTradeJournal(
  process.argv[2] ?? 'logs/micro-burst/shadow-trades',
  process.argv[3] ?? 'logs/micro-burst/shadow-trade-events',
);
console.log(
  JSON.stringify(
    analyzeMicroBurstPaperTrades(
      journal.loadAllPositions(),
      undefined,
      undefined,
      journal.loadAllEvents(),
      journal.loadSuppressionAccounting(),
    ),
    null,
    2,
  ),
);
