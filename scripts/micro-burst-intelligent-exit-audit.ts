#!/usr/bin/env node
/**
 * Micro Burst Intelligent Exit Audit & Simulation
 *
 * Loads all shadow outcomes, replays the exit engine on each signal's price
 * trajectory, and compares:
 *   1. Intelligent exit (structural stop + evidence-based) vs hold-to-horizon
 *   2. Per-symbol: premature profit cut detection
 *   3. Per-symbol: loss avoidance improvement
 *
 * Usage: npx ts-node scripts/micro-burst-intelligent-exit-audit.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  advanceMicroBurstExit,
  initialMicroBurstExitEngineState,
  MicroBurstExitEngineState,
} from '../src/strategies/micro-burst/domain/MicroBurstExitPolicy';
import {
  defaultMicroBurstConfig,
  MicroBurstConfig,
  MicroBurstExitContext,
  MicroBurstExitDecision,
} from '../src/strategies/micro-burst/domain/MicroBurstTypes';
import { ProspectiveOutcomeRecord, HorizonOutcome } from '../src/strategies/micro-burst/research/MicroBurstOutcomeTypes';
import { decimalReturnToBps } from '../src/strategies/micro-burst/domain/MicroBurstUnits';

// ── Helpers ──────────────────────────────────────────────

function loadAllOutcomes(journalDir: string): ProspectiveOutcomeRecord[] {
  const outcomes: ProspectiveOutcomeRecord[] = [];
  if (!fs.existsSync(journalDir)) return outcomes;
  const files = fs.readdirSync(journalDir).filter((f) => f.endsWith('.jsonl'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(journalDir, file), 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        outcomes.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
  }
  return outcomes;
}

function sideAwareReturnBps(entryPrice: number, currentPrice: number, side: 'LONG' | 'SHORT'): number {
  const signedReturn = (currentPrice - entryPrice) / entryPrice;
  return decimalReturnToBps(side === 'LONG' ? signedReturn : -signedReturn);
}

function favorableExcursionBps(
  entryPrice: number,
  peakPrice: number,
  troughPrice: number,
  side: 'LONG' | 'SHORT',
): number {
  const priceReturn =
    side === 'LONG'
      ? (peakPrice - entryPrice) / entryPrice
      : (entryPrice - troughPrice) / entryPrice;
  return Math.max(0, decimalReturnToBps(priceReturn));
}

function adverseExcursionBps(
  entryPrice: number,
  peakPrice: number,
  troughPrice: number,
  side: 'LONG' | 'SHORT',
): number {
  const priceReturn =
    side === 'LONG'
      ? (entryPrice - troughPrice) / entryPrice
      : (peakPrice - entryPrice) / entryPrice;
  return Math.max(0, decimalReturnToBps(priceReturn));
}

// ── Price Trajectory Reconstruction ─────────────────────
// We reconstruct a coarse price trajectory from the horizon outcomes.
// Each horizon tells us: priceAtHorizon, mfeBps, maeBps, timeToMfeMs, timeToMaeMs

interface PricePoint {
  eventTime: number;
  price: number;
}

function reconstructTrajectory(
  signal: ProspectiveOutcomeRecord,
  entryPrice: number,
  side: 'LONG' | 'SHORT',
): PricePoint[] {
  const t0 = signal.signalAtMs;
  const points: PricePoint[] = [{ eventTime: t0, price: entryPrice }];

  const horizons = Object.values(signal.horizons ?? {}).sort(
    (a, b) => a.horizonMs - b.horizonMs,
  );

  for (const h of horizons) {
    // Add the price at horizon end
    if (h.priceAtHorizon && h.priceAtHorizon > 0) {
      points.push({ eventTime: t0 + h.horizonMs, price: h.priceAtHorizon });
    }
    // Add the MFE price (peak favorable excursion)
    if (h.mfeBps > 0 && h.timeToMfeMs > 0) {
      const mfePrice =
        side === 'LONG'
          ? entryPrice * (1 + h.mfeBps / 10000)
          : entryPrice * (1 - h.mfeBps / 10000);
      points.push({ eventTime: t0 + h.timeToMfeMs, price: mfePrice });
    }
    // Add the MAE price (max adverse excursion)
    if (h.maeBps > 0 && h.timeToMaeMs > 0) {
      const maePrice =
        side === 'LONG'
          ? entryPrice * (1 - h.maeBps / 10000)
          : entryPrice * (1 + h.maeBps / 10000);
      points.push({ eventTime: t0 + h.timeToMaeMs, price: maePrice });
    }
  }

  // Sort by time and deduplicate
  points.sort((a, b) => a.eventTime - b.eventTime);
  const deduped: PricePoint[] = [];
  for (const p of points) {
    if (deduped.length === 0 || deduped[deduped.length - 1].eventTime !== p.eventTime) {
      deduped.push(p);
    }
  }
  return deduped;
}

// ── Full Exit Engine Replay ──────────────────────────────
// Replays the exit engine on the reconstructed trajectory with
// synthetic book/momentum data derived from price action.

interface SimulatedExitResult {
  exitReason: string;
  exitAtMs: number;
  exitPrice: number;
  grossBps: number;
  timeInTradeMs: number;
  exitPhase: string;
}

function simulateFullExit(
  signal: ProspectiveOutcomeRecord,
  entryPrice: number,
  config: MicroBurstConfig,
): SimulatedExitResult | null {
  const side = signal.side as 'LONG' | 'SHORT';
  const t0 = signal.signalAtMs;
  const trajectory = reconstructTrajectory(signal, entryPrice, side);

  if (trajectory.length < 2) return null;

  let peakPrice = entryPrice;
  let troughPrice = entryPrice;
  let currentStopPrice: number | null = signal.structuralStopPrice;
  let state = initialMicroBurstExitEngineState();

  for (const point of trajectory) {
    const currentPrice = point.price;
    const timeInTradeMs = point.eventTime - t0;

    if (currentPrice > peakPrice) peakPrice = currentPrice;
    if (currentPrice < troughPrice) troughPrice = currentPrice;

    // Check stop touch
    const stopTouched =
      currentStopPrice !== null &&
      (side === 'LONG' ? currentPrice <= currentStopPrice : currentPrice >= currentStopPrice);

    if (stopTouched) {
      const reason =
        currentStopPrice === entryPrice ? 'BREAK_EVEN' : 'HARD_INVALIDATION';
      return {
        exitReason: reason,
        exitAtMs: point.eventTime,
        exitPrice: currentPrice,
        grossBps: sideAwareReturnBps(entryPrice, currentPrice, side),
        timeInTradeMs,
        exitPhase: 'STRUCTURAL',
      };
    }

    // Reconstruct synthetic momentum from price trajectory
    const prevPoint = trajectory[trajectory.indexOf(point) - 1];
    const shortReturnBps = prevPoint
      ? sideAwareReturnBps(prevPoint.price, currentPrice, side === 'LONG' ? 'LONG' : 'SHORT')
      : 0;

    // Build exit context with synthetic data
    const context: MicroBurstExitContext = {
      unrealizedRoe: sideAwareReturnBps(entryPrice, currentPrice, side) / 100,
      priceReturn: (currentPrice - entryPrice) / entryPrice,
      currentPrice,
      entryPrice,
      peakPrice,
      troughPrice,
      structuralInvalidationPrice: signal.structuralStopPrice,
      destinationPrice: signal.destinationPrice,
      currentStopPrice,
      timeInTradeMs,
      observedAtMs: point.eventTime,
      momentumDecayFlag: timeInTradeMs >= config.exitMaxHoldMs * 0.7 && sideAwareReturnBps(entryPrice, currentPrice, side) <= 0,
      anomalyExitFlag: false,
      currentBookPressure: null,
      currentBtcContext: null,
      marketEvidence: null,
      leverage: signal.leverage,
    };

    const transition = advanceMicroBurstExit(state, context, config, side);
    state = transition.state;

    if (transition.decision.action === 'CLOSE_MARKET') {
      return {
        exitReason: transition.decision.reason,
        exitAtMs: point.eventTime,
        exitPrice: currentPrice,
        grossBps: sideAwareReturnBps(entryPrice, currentPrice, side),
        timeInTradeMs,
        exitPhase: 'INTELLIGENT',
      };
    }
    if (transition.decision.action === 'MOVE_STOP' && transition.decision.requestedStopPrice !== undefined) {
      currentStopPrice =
        side === 'LONG'
          ? Math.max(currentStopPrice ?? transition.decision.requestedStopPrice, transition.decision.requestedStopPrice)
          : Math.min(currentStopPrice ?? transition.decision.requestedStopPrice, transition.decision.requestedStopPrice);
    }
  }

  // Still holding at end
  const lastPoint = trajectory[trajectory.length - 1];
  return {
    exitReason: 'HOLD_AT_HORIZON',
    exitAtMs: lastPoint.eventTime,
    exitPrice: lastPoint.price,
    grossBps: sideAwareReturnBps(entryPrice, lastPoint.price, side),
    timeInTradeMs: lastPoint.eventTime - t0,
    exitPhase: 'HOLD',
  };
}

// ── Analysis ─────────────────────────────────────────────

interface SymbolAnalysis {
  symbol: string;
  totalSignals: number;
  wins: number;
  losses: number;
  // Intelligent exit results
  intelligentExitCount: number;
  intelligentExitWins: number;
  intelligentExitLosses: number;
  intelligentExitAvgBps: number;
  // Hold-to-horizon results (300s)
  holdToHorizonAvgBps: number;
  holdToHorizonWins: number;
  holdToHorizonLosses: number;
  // Structural stop results
  structuralStopCount: number;
  structuralStopAvgBps: number;
  // Comparison
  prematureProfitCuts: number;
  lossAvoidances: number;
  improvedResults: number;
  worsenedResults: number;
  avgImprovementBps: number;
  // Existing dynamic exit comparison
  existingDynamicExitAvgBps: number;
  newSimAvgBps: number;
}

function analyzeOutcomes(outcomes: ProspectiveOutcomeRecord[]): void {
  const bySymbol = new Map<string, ProspectiveOutcomeRecord[]>();
  for (const o of outcomes) {
    const sym = o.symbol;
    if (!bySymbol.has(sym)) bySymbol.set(sym, []);
    bySymbol.get(sym)!.push(o);
  }

  const config = defaultMicroBurstConfig();
  const allResults: Array<{
    symbol: string;
    side: string;
    entryPrice: number;
    existingDynamicBps: number | null;
    simulatedBps: number | null;
    simulatedReason: string;
    holdToHorizonBps: number;
    barrierOutcome: string;
    structuralStop: number;
    destination: number;
  }> = [];

  console.log('\n' + '═'.repeat(120));
  console.log('  MICRO BURST INTELLIGENT EXIT AUDIT — ALL SYMBOLS');
  console.log('═'.repeat(120));

  for (const [symbol, symbolOutcomes] of bySymbol) {
    let wins = 0;
    let losses = 0;
    let intelligentExitCount = 0;
    let intelligentExitWins = 0;
    let intelligentExitLosses = 0;
    let intelligentExitTotalBps = 0;
    let holdToHorizonTotalBps = 0;
    let holdToHorizonWins = 0;
    let holdToHorizonLosses = 0;
    let structuralStopCount = 0;
    let structuralStopTotalBps = 0;
    let prematureProfitCuts = 0;
    let lossAvoidances = 0;
    let improvedResults = 0;
    let worsenedResults = 0;
    let totalImprovementBps = 0;
    let existingDynamicTotalBps = 0;
    let existingDynamicCount = 0;
    let newSimTotalBps = 0;
    let newSimCount = 0;

    for (const outcome of symbolOutcomes) {
      const side = outcome.side as 'LONG' | 'SHORT';
      const entryPrice =
        outcome.entryPriceModels?.find((m) => m.model === 'NEXT_TRADE')?.entryPrice ??
        outcome.entryPriceModels?.find((m) => m.model === 'SIGNAL_PRICE')?.entryPrice ??
        0;
      if (entryPrice <= 0) continue;

      // Existing dynamic exit
      const existingDynamic = outcome.dynamicExitOutcome;
      const existingDynamicBps = existingDynamic?.counterfactualGrossBps ?? null;

      // Simulated full exit
      const simulated = simulateFullExit(outcome, entryPrice, config);
      const simulatedBps = simulated?.grossBps ?? null;
      const simulatedReason = simulated?.exitReason ?? 'UNKNOWN';

      // Hold to 300s horizon
      const h300 = outcome.horizons?.[300000];
      const holdToHorizonBps = h300?.finalReturnBps ?? 0;

      // Barrier
      const barrier = outcome.barrierOutcome ?? 'UNKNOWN';

      if (holdToHorizonBps > 0) holdToHorizonWins++;
      else if (holdToHorizonBps < 0) holdToHorizonLosses++;

      if (existingDynamicBps !== null) {
        existingDynamicTotalBps += existingDynamicBps;
        existingDynamicCount++;
      }

      if (simulatedBps !== null) {
        newSimTotalBps += simulatedBps;
        newSimCount++;

        if (simulatedBps > 0) intelligentExitWins++;
        else if (simulatedBps < 0) intelligentExitLosses++;
        intelligentExitTotalBps += simulatedBps;
        intelligentExitCount++;

        if (simulatedReason === 'HARD_INVALIDATION' || simulatedReason === 'BREAK_EVEN') {
          structuralStopCount++;
          structuralStopTotalBps += simulatedBps;
        }

        // Compare simulated vs hold-to-horizon
        const improvement = simulatedBps - holdToHorizonBps;
        if (simulatedBps > 0 && holdToHorizonBps <= 0) {
          // Intelligent exit was profitable, hold-to-horizon was not → loss avoidance
          lossAvoidances++;
          improvedResults++;
          totalImprovementBps += improvement;
        } else if (simulatedBps <= 0 && holdToHorizonBps > 0) {
          // Intelligent exit was not profitable, hold-to-horizon was → premature profit cut
          prematureProfitCuts++;
          worsenedResults++;
          totalImprovementBps += improvement;
        } else if (simulatedBps > 0 && holdToHorizonBps > 0) {
          // Both profitable
          if (simulatedBps > holdToHorizonBps) {
            improvedResults++;
            totalImprovementBps += improvement;
          } else if (simulatedBps < holdToHorizonBps) {
            worsenedResults++;
            totalImprovementBps += improvement;
          }
        } else {
          // Both losses
          if (Math.abs(simulatedBps) < Math.abs(holdToHorizonBps)) {
            improvedResults++;
            totalImprovementBps += improvement;
          } else if (Math.abs(simulatedBps) > Math.abs(holdToHorizonBps)) {
            worsenedResults++;
            totalImprovementBps += improvement;
          }
        }
      }

      if (holdToHorizonBps > 0) wins++;
      else if (holdToHorizonBps < 0) losses++;

      allResults.push({
        symbol,
        side,
        entryPrice,
        existingDynamicBps,
        simulatedBps,
        simulatedReason,
        holdToHorizonBps,
        barrierOutcome: barrier,
        structuralStop: outcome.structuralStopPrice,
        destination: outcome.destinationPrice,
      });
    }

    const avgImprovement = improvedResults + worsenedResults > 0
      ? totalImprovementBps / (improvedResults + worsenedResults)
      : 0;

    console.log(`\n${'─'.repeat(120)}`);
    console.log(`  ${symbol}`);
    console.log(`${'─'.repeat(120)}`);
    console.log(`  Total signals:           ${symbolOutcomes.length}`);
    console.log(`  Wins (hold 5min):        ${wins}  |  Losses: ${losses}  |  Win rate: ${((wins / symbolOutcomes.length) * 100).toFixed(1)}%`);
    console.log(`  Avg hold-5min return:    ${(holdToHorizonTotalBps / symbolOutcomes.length).toFixed(2)} bps`);
    console.log(`  ─────────────────────────────────────────────────`);
    console.log(`  EXISTING dynamic exit:   ${existingDynamicCount} trades  |  Avg: ${(existingDynamicTotalBps / Math.max(1, existingDynamicCount)).toFixed(2)} bps`);
    console.log(`  NEW simulated exit:      ${newSimCount} trades  |  Avg: ${(newSimTotalBps / Math.max(1, newSimCount)).toFixed(2)} bps`);
    console.log(`  ─────────────────────────────────────────────────`);
    console.log(`  Intelligent exit wins:   ${intelligentExitWins}  |  Losses: ${intelligentExitLosses}`);
    console.log(`  Avg intelligent return:  ${(intelligentExitTotalBps / Math.max(1, intelligentExitCount)).toFixed(2)} bps`);
    console.log(`  ─────────────────────────────────────────────────`);
    console.log(`  Loss avoidances:         ${lossAvoidances}  (intelligent exit saved from loss)`);
    console.log(`  Premature profit cuts:   ${prematureProfitCuts}  (intelligent exit cut profit too early)`);
    console.log(`  Improved results:        ${improvedResults}`);
    console.log(`  Worsened results:        ${worsenedResults}`);
    console.log(`  Avg improvement:         ${avgImprovement.toFixed(2)} bps`);
    console.log(`  ─────────────────────────────────────────────────`);
    console.log(`  Structural stops:        ${structuralStopCount}  |  Avg: ${(structuralStopTotalBps / Math.max(1, structuralStopCount)).toFixed(2)} bps`);
  }

  // Summary
  console.log(`\n${'═'.repeat(120)}`);
  console.log('  SUMMARY — ALL SYMBOLS');
  console.log(`${'═'.repeat(120)}`);
  console.log(`  Total outcomes analyzed:  ${allResults.length}`);
  console.log(`  Total symbols:            ${bySymbol.size}`);

  const totalExistingDynamicBps = allResults
    .filter((r) => r.existingDynamicBps !== null)
    .reduce((s, r) => s + (r.existingDynamicBps ?? 0), 0);
  const totalExistingDynamicCount = allResults.filter((r) => r.existingDynamicBps !== null).length;

  const totalNewSimBps = allResults
    .filter((r) => r.simulatedBps !== null)
    .reduce((s, r) => s + (r.simulatedBps ?? 0), 0);
  const totalNewSimCount = allResults.filter((r) => r.simulatedBps !== null).length;

  const totalHoldBps = allResults.reduce((s, r) => s + r.holdToHorizonBps, 0);

  console.log(`  ─────────────────────────────────────────────────`);
  console.log(`  EXISTING dynamic exit avg:  ${(totalExistingDynamicBps / Math.max(1, totalExistingDynamicCount)).toFixed(2)} bps`);
  console.log(`  NEW simulated exit avg:     ${(totalNewSimBps / Math.max(1, totalNewSimCount)).toFixed(2)} bps`);
  console.log(`  Hold-to-5min avg:           ${(totalHoldBps / allResults.length).toFixed(2)} bps`);
  console.log(`  ─────────────────────────────────────────────────`);

  // Breakdown by exit reason
  const byReason = new Map<string, { count: number; totalBps: number }>();
  for (const r of allResults) {
    if (r.simulatedBps === null) continue;
    const existing = byReason.get(r.simulatedReason) ?? { count: 0, totalBps: 0 };
    existing.count++;
    existing.totalBps += r.simulatedBps;
    byReason.set(r.simulatedReason, existing);
  }
  console.log(`  Exit reason breakdown:`);
  for (const [reason, data] of [...byReason.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`    ${reason.padEnd(20)} ${data.count.toString().padStart(4)} trades  |  Avg: ${(data.totalBps / data.count).toFixed(2)} bps`);
  }

  // Breakdown by symbol
  console.log(`  ─────────────────────────────────────────────────`);
  console.log(`  Per-symbol summary:`);
  const symbolSummary = new Map<string, { count: number; avgSimBps: number; avgHoldBps: number; premature: number; avoided: number }>();
  for (const r of allResults) {
    const existing = symbolSummary.get(r.symbol) ?? { count: 0, avgSimBps: 0, avgHoldBps: 0, premature: 0, avoided: 0 };
    existing.count++;
    if (r.simulatedBps !== null) existing.avgSimBps += r.simulatedBps;
    existing.avgHoldBps += r.holdToHorizonBps;
    symbolSummary.set(r.symbol, existing);
  }
  for (const [sym, data] of symbolSummary) {
    console.log(`    ${sym.padEnd(12)} N=${data.count.toString().padStart(3)}  |  Sim avg: ${(data.avgSimBps / data.count).toFixed(2).padStart(7)} bps  |  Hold avg: ${(data.avgHoldBps / data.count).toFixed(2).padStart(7)} bps`);
  }

  console.log(`\n${'═'.repeat(120)}`);
}

// ── Main ─────────────────────────────────────────────────

function main() {
  const journalDir = path.join(__dirname, '..', 'logs', 'micro-burst', 'shadow-outcomes');
  console.log(`Loading outcomes from: ${journalDir}`);
  const outcomes = loadAllOutcomes(journalDir);
  console.log(`Loaded ${outcomes.length} outcomes`);

  if (outcomes.length === 0) {
    console.log('No outcomes found. Run the shadow evaluator first to generate data.');
    return;
  }

  analyzeOutcomes(outcomes);
}

main();
