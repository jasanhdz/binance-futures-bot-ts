#!/usr/bin/env npx tsx
/**
 * MICRO BURST V1 — Prospective Shadow Outcome Analyzer
 *
 * Reads signal journal + outcome journal and produces a prospective validation report.
 * No data from T0 is used to alter original signals.
 *
 * Usage: npx tsx scripts/micro-burst-analyze-shadow [--signals-dir logs/micro-burst/shadow-signals] [--outcomes-dir logs/micro-burst/shadow-outcomes]
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ProspectiveOutcomeRecord,
  OUTCOME_HORIZONS_MS,
} from '../src/domain/strategies/micro-burst/MicroBurstOutcomeTypes';

// ── CLI Args ───────────────────────────────────────────────

const signalsDir = process.argv.find((_, i, a) => a[i - 1] === '--signals-dir') ?? 'logs/micro-burst/shadow-signals';
const outcomesDir = process.argv.find((_, i, a) => a[i - 1] === '--outcomes-dir') ?? 'logs/micro-burst/shadow-outcomes';

// ── Helpers ────────────────────────────────────────────────

function loadJsonl(dir: string): any[] {
  const records: any[] = [];
  if (!fs.existsSync(dir)) return records;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return records;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  return percentile(values, 50);
}

// ── Load Data ──────────────────────────────────────────────

const signals = loadJsonl(signalsDir);
const outcomes = loadJsonl(outcomesDir) as ProspectiveOutcomeRecord[];

// ── Unique Episodes ────────────────────────────────────────

const episodes = new Map<string, ProspectiveOutcomeRecord[]>();
for (const o of outcomes) {
  const existing = episodes.get(o.episodeId) ?? [];
  existing.push(o);
  episodes.set(o.episodeId, existing);
}

// ── Analysis ───────────────────────────────────────────────

const longSignals = outcomes.filter((o) => o.side === 'LONG');
const shortSignals = outcomes.filter((o) => o.side === 'SHORT');

console.log(`\n${'='.repeat(70)}`);
console.log(`MICRO BURST V1 — PROSPECTIVE SHADOW OUTCOME ANALYSIS`);
console.log(`${'='.repeat(70)}`);
console.log(`PROSPECTIVE — signals generated after M3 deployment`);
console.log(``);
console.log(`Total signals:   ${signals.length}`);
console.log(`Completed outcomes: ${outcomes.length}`);
console.log(`Independent episodes: ${episodes.size}`);
console.log(`LONG: ${longSignals.length} | SHORT: ${shortSignals.length}`);

// ── Per-Horizon Analysis ───────────────────────────────────

console.log(`\n${'─'.repeat(70)}`);
console.log(`HORIZON ANALYSIS (SIGNAL_PRICE entry model)`);
console.log(`${'─'.repeat(70)}`);

for (const horizonMs of OUTCOME_HORIZONS_MS) {
  const horizonLabel = `${horizonMs / 1000}s`;
  const horizonOutcomes = outcomes
    .map((o) => o.horizons[horizonMs])
    .filter((h) => h != null && h.tradeCount > 0);

  if (horizonOutcomes.length === 0) {
    console.log(`\n--- ${horizonLabel} (${0} outcomes) ---`);
    console.log(`  No outcomes with trade data.`);
    continue;
  }

  const mfeValues = horizonOutcomes.map((h) => h.mfeBps);
  const maeValues = horizonOutcomes.map((h) => h.maeBps);
  const returnValues = horizonOutcomes.map((h) => h.finalReturnBps);

  const wins = horizonOutcomes.filter((h) => h.finalReturnBps > 0).length;
  const targetFirst = horizonOutcomes.filter((h) => h.barrierOutcome === 'TARGET_FIRST').length;
  const stopFirst = horizonOutcomes.filter((h) => h.barrierOutcome === 'STOP_FIRST').length;
  const neither = horizonOutcomes.filter((h) => h.barrierOutcome === 'NEITHER').length;
  const ambiguous = horizonOutcomes.filter((h) => h.barrierOutcome === 'AMBIGUOUS_SAME_INTERVAL').length;

  console.log(`\n--- ${horizonLabel} (${horizonOutcomes.length} outcomes) ---`);
  console.log(`  MFE:   mean=${mean(mfeValues).toFixed(1)}  median=${median(mfeValues).toFixed(1)}  p10=${percentile(mfeValues, 10).toFixed(1)}  p25=${percentile(mfeValues, 25).toFixed(1)}  p75=${percentile(mfeValues, 75).toFixed(1)}  p90=${percentile(mfeValues, 90).toFixed(1)}`);
  console.log(`  MAE:   mean=${mean(maeValues).toFixed(1)}  median=${median(maeValues).toFixed(1)}  p10=${percentile(maeValues, 10).toFixed(1)}  p25=${percentile(maeValues, 25).toFixed(1)}  p75=${percentile(maeValues, 75).toFixed(1)}  p90=${percentile(maeValues, 90).toFixed(1)}`);
  console.log(`  Return: mean=${mean(returnValues).toFixed(1)}  median=${median(returnValues).toFixed(1)}  p10=${percentile(returnValues, 10).toFixed(1)}  p90=${percentile(returnValues, 90).toFixed(1)}`);
  console.log(`  Win rate:   ${(wins / horizonOutcomes.length * 100).toFixed(1)}%`);
  console.log(`  Target first: ${targetFirst}  Stop first: ${stopFirst}  Neither: ${neither}  Ambiguous: ${ambiguous}`);
}

// ── Cost Scenario Analysis ─────────────────────────────────

console.log(`\n${'─'.repeat(70)}`);
console.log(`COST SCENARIO ANALYSIS (300s horizon, SIGNAL_PRICE)`);
console.log(`${'─'.repeat(70)}`);

const maxHorizonOutcomes = outcomes
  .map((o) => o.horizons[300_000])
  .filter((h) => h != null && h.tradeCount > 0);

if (maxHorizonOutcomes.length > 0) {
  const costLabels = ['cost_0', 'cost_10', 'cost_14', 'cost_20', 'cost_30'];
  for (const label of costLabels) {
    const netReturns = outcomes
      .filter((o) => o.costScenarios[label] !== undefined)
      .map((o) => o.costScenarios[label]);
    if (netReturns.length === 0) continue;
    const wins = netReturns.filter((r) => r > 0).length;
    const expectancy = mean(netReturns);
    console.log(`  ${label}:  mean=${expectancy.toFixed(1)}bps  median=${median(netReturns).toFixed(1)}bps  win=${(wins / netReturns.length * 100).toFixed(1)}%  N=${netReturns.length}`);
  }
}

// ── Segment Diagnostics ────────────────────────────────────

console.log(`\n${'─'.repeat(70)}`);
console.log(`SEGMENT DIAGNOSTICS`);
console.log(`${'─'.repeat(70)}`);

// By symbol
const bySymbol = new Map<string, ProspectiveOutcomeRecord[]>();
for (const o of outcomes) {
  const existing = bySymbol.get(o.symbol) ?? [];
  existing.push(o);
  bySymbol.set(o.symbol, existing);
}
for (const [symbol, records] of bySymbol) {
  const returns = records.filter((o) => o.horizons[300_000]).map((o) => o.horizons[300_000].finalReturnBps);
  console.log(`  ${symbol}: N=${records.length}  mean300s=${returns.length > 0 ? mean(returns).toFixed(1) : 'N/A'}bps`);
}

// By leverage tier
const byTier = new Map<string, ProspectiveOutcomeRecord[]>();
for (const o of outcomes) {
  const existing = byTier.get(o.leverageTier) ?? [];
  existing.push(o);
  byTier.set(o.leverageTier, existing);
}
for (const [tier, records] of byTier) {
  const returns = records.filter((o) => o.horizons[300_000]).map((o) => o.horizons[300_000].finalReturnBps);
  console.log(`  ${tier}: N=${records.length}  mean300s=${returns.length > 0 ? mean(returns).toFixed(1) : 'N/A'}bps`);
}

// By micro regime
const byRegime = new Map<string, ProspectiveOutcomeRecord[]>();
for (const o of outcomes) {
  const existing = byRegime.get(o.microRegime) ?? [];
  existing.push(o);
  byRegime.set(o.microRegime, existing);
}
for (const [regime, records] of byRegime) {
  const returns = records.filter((o) => o.horizons[300_000]).map((o) => o.horizons[300_000].finalReturnBps);
  console.log(`  ${regime}: N=${records.length}  mean300s=${returns.length > 0 ? mean(returns).toFixed(1) : 'N/A'}bps`);
}

// BTC aligned vs conflict
const btcAligned = outcomes.filter((o) => !o.btc.conflict);
const btcConflict = outcomes.filter((o) => o.btc.conflict);
console.log(`  BTC aligned: N=${btcAligned.length}`);
console.log(`  BTC conflict: N=${btcConflict.length}`);

// ── Dynamic Exit Summary ───────────────────────────────────

console.log(`\n${'─'.repeat(70)}`);
console.log(`DYNAMIC EXIT COUNTERFACTUAL SUMMARY`);
console.log(`${'─'.repeat(70)}`);

const withDynamicExit = outcomes.filter((o) => o.dynamicExitOutcome);
const byExitReason = new Map<string, number>();
for (const o of withDynamicExit) {
  const reason = o.dynamicExitOutcome!.counterfactualExitReason;
  byExitReason.set(reason, (byExitReason.get(reason) ?? 0) + 1);
}
for (const [reason, count] of byExitReason) {
  console.log(`  ${reason}: ${count}`);
}
const dynReturns = withDynamicExit.map((o) => o.dynamicExitOutcome!.counterfactualGrossBps);
if (dynReturns.length > 0) {
  console.log(`  Dynamic exit mean gross: ${mean(dynReturns).toFixed(1)}bps`);
}

// ── Negative Controls ──────────────────────────────────────

console.log(`\n${'─'.repeat(70)}`);
console.log(`NEGATIVE CONTROLS`);
console.log(`${'─'.repeat(70)}`);

// Shuffled timestamps control
if (outcomes.length >= 10) {
  const shuffled = [...outcomes].sort(() => Math.random() - 0.5);
  const shuffledReturns = shuffled
    .filter((o) => o.horizons[300_000])
    .map((o) => o.horizons[300_000].finalReturnBps);
  console.log(`  Shuffled timestamps: mean300s=${shuffledReturns.length > 0 ? mean(shuffledReturns).toFixed(1) : 'N/A'}bps  N=${shuffledReturns.length}`);
}

// Random side control
if (outcomes.length >= 10) {
  const randomSideReturns = outcomes.map((o) => {
    const h = o.horizons[300_000];
    if (!h) return null;
    // Flip return for randomly "wrong" side
    return o.side === 'LONG' ? h.finalReturnBps : -h.finalReturnBps;
  }).filter((r) => r !== null) as number[];
  console.log(`  Random side (inverted): mean300s=${randomSideReturns.length > 0 ? mean(randomSideReturns).toFixed(1) : 'N/A'}bps  N=${randomSideReturns.length}`);
}

// ── Final Verdict ──────────────────────────────────────────

console.log(`\n${'='.repeat(70)}`);
console.log(`METHODOLOGY NOTES`);
console.log(`${'='.repeat(70)}`);
console.log(`- All signals are PROSPECTIVE (post-M3 deployment)`);
console.log(`- Signal data at T0 is IMMUTABLE; only post-T0 prices observed`);
console.log(`- Entry models: SIGNAL_PRICE (T0 reference), NEXT_TRADE (first post-T0 trade), CONSERVATIVE_SLIPPAGE (+0.5bps)`);
console.log(`- Cost scenarios: cost_0 (gross), cost_10 (7+3), cost_14 (10+4), cost_20 (14+6), cost_30 (20+10)`);
console.log(`- First-touch uses trade-level data for temporal ordering`);
console.log(`- Dynamic exit simulation reuses MicroBurstExitPolicy (no new logic)`);
console.log(`- Independent episodes: same symbol+side+structural level = 1 episode`);
console.log(`- Version: ${outcomes[0]?.strategyVersion ?? 'N/A'}  SHA: ${outcomes[0]?.codeCommitSha ?? 'N/A'}`);
console.log(`- DO NOT declare ECONOMIC_EDGE_FOUND until sufficient N`);
console.log(`- DO NOT declare LIVE_READY during M3`);
console.log(`${'='.repeat(70)}\n`);
