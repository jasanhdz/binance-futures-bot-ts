/** Local, read-only evidence audit. Does not import runtime bootstrap or exchange adapters. */
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { advanceMicroBurstExit, initialMicroBurstExitEngineState } from '../src/strategies/micro-burst/domain/MicroBurstExitPolicy';
import type { MicroBurstConfig, MicroBurstExitContext } from '../src/strategies/micro-burst/domain/MicroBurstTypes';

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? '.');
  const entries = readFileSync(resolve(root, 'data/runtime/entry-mutations-binance-futures-bot-primary-production.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const trades = new Map<string, {
    side: 'LONG' | 'SHORT'; config: MicroBurstConfig;
    state: ReturnType<typeof initialMicroBurstExitEngineState>;
    matches: number; mismatches: unknown[]; source: unknown; decisions: unknown[];
  }>();
  for (const row of entries) {
    const intent = row.metadata?.request?.intent;
    if (row.event !== 'PREPARED' || !intent?.metadata?.contextualPolicy ||
      !/202609(18|19)-/.test(intent.tradeId)) continue;
    trades.set(intent.tradeId, {
      side: intent.side, config: intent.metadata.contextualPolicy.config,
      state: initialMicroBurstExitEngineState(), matches: 0, mismatches: [], decisions: [],
      source: { sha: intent.identity.codeCommitSha, configHash: intent.identity.configHash,
        quantity: row.metadata.request.quantity, requestedAt: intent.requestedAt,
        stop: intent.structuralStopPrice, target: intent.destinationPrice,
        policy: intent.metadata.contextualPolicy },
    });
  }
  for (const day of ['18', '19']) {
    const path = resolve(root, `logs/history-2026-09-${day}.log`);
    let lineNumber = 0;
    for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
      lineNumber++;
      if (!line.includes('micro_burst_exit_decision')) continue;
      const row = JSON.parse(line);
      const ctx = row.ctx;
      const trade = trades.get(ctx?.tradeId);
      if (!trade || ctx.phase !== 'DECISION' || !ctx.context || !ctx.decision) continue;
      const context: MicroBurstExitContext = ctx.context;
      const transition = advanceMicroBurstExit(trade.state, context, trade.config, trade.side);
      trade.state = transition.state;
      const actual = transition.decision;
      const expected = ctx.decision;
      const match = actual.action === expected.action && actual.reason === expected.reason &&
        actual.requestedStopPrice === expected.requestedStopPrice;
      if (match) trade.matches++;
      else trade.mismatches.push({ lineNumber, expected, actual });
      trade.decisions.push({ line: lineNumber, at: ctx.observedAtMs,
        decisionId: ctx.decisionId, action: expected.action, reason: expected.reason,
        phase: expected.diagnostics?.phase, age: context.timeInTradeMs, match });
    }
  }
  for (const [tradeId, trade] of trades) {
    console.log(JSON.stringify({ tradeId, ...trade, state: undefined,
      status: trade.matches && !trade.mismatches.length ? 'RECORDED_DECISIONS_REPRODUCED' : 'NO_EVALUABLE',
      coverage: 'Recorded reducer observations only; not fills, continuous stop triggers or post-close paths.' }));
  }
  console.log(JSON.stringify({ symbol: 'ADAUSDT', side: 'SHORT', screenshotLocalDate: '2026-09-18',
    status: 'NO_EVALUABLE', reason: 'No matching September 18 entry in the current durable journal.' }));
  if ([...trades.values()].some(t => t.mismatches.length)) process.exitCode = 1;
}

void main().catch(error => { console.error(String(error)); process.exitCode = 1; });
