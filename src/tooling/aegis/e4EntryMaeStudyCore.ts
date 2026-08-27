import { createReadStream, promises as fs } from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import { isVerifiedAegisMetricRecord } from '../../infra/logging/AegisTradeOwnership';

type JsonRecord = Record<string, any>;

export type RoeObservation = {
  timestamp: string;
  timestampMs: number;
  roe: number;
};

export type E4EntryMaeStudyOptions = {
  repoRoot?: string;
  logsDir?: string;
  outDir?: string;
  from?: string;
  to?: string;
  writeReports?: boolean;
  generatedAt?: string;
};

export type TradePathStudyInput = {
  tradeId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  openedAt: string;
  closedAt: string;
  entryPrice: number;
  exitPrice: number;
  leverage: number;
  finalRoe: number;
  pnlUsdt: number;
  recordedMaeRoe: number;
  recordedMfeRoe: number;
  observations: RoeObservation[];
  openRecord: JsonRecord;
  closeRecord: JsonRecord;
  e4Event: JsonRecord;
};

export type TradePathStudy = ReturnType<typeof analyzeTradePath>;

const E4_OPERATIONAL_CUTOFF = '2026-08-22T18:45:24.241Z';
const DELAY_MINUTES = [1, 5, 15, 30] as const;
const PROTECTION_POLICIES = [
  { name: 'trigger_5_floor_0', triggerRoe: 0.05, floorRoe: 0 },
  { name: 'trigger_5_floor_2', triggerRoe: 0.05, floorRoe: 0.02 },
  { name: 'trigger_8_floor_2', triggerRoe: 0.08, floorRoe: 0.02 },
  { name: 'trigger_8_floor_5', triggerRoe: 0.08, floorRoe: 0.05 },
] as const;
const STRESS_LEVERAGES = [20, 25, 30] as const;

export async function runE4EntryMaeStudy(
  options: E4EntryMaeStudyOptions = {},
): Promise<JsonRecord> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const logsDir = options.logsDir ?? path.join(repoRoot, 'logs', 'aegis');
  const outDir = options.outDir ?? path.join(repoRoot, 'reports');
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const fromMs = Date.parse(options.from ?? E4_OPERATIONAL_CUTOFF);
  const toMs = options.to ? endOfUtcDay(options.to) : Number.POSITIVE_INFINITY;
  const warnings: string[] = [];
  const files = await fs.readdir(logsDir);
  const tradeFiles = selectDatedLogFiles(files, 'turbo_trades', fromMs, toMs);
  const eventFiles = selectDatedLogFiles(files, 'turbo_trade_events', fromMs, toMs);
  const pairs = new Map<string, { open?: JsonRecord; close?: JsonRecord }>();

  await streamJsonlFiles(logsDir, tradeFiles, warnings, (row) => {
    const tradeId = text(row.trade_id);
    const timestampMs = Date.parse(text(row.timestamp));
    if (!tradeId || !Number.isFinite(timestampMs) || timestampMs < fromMs || timestampMs > toMs)
      return;
    const pair = pairs.get(tradeId) ?? {};
    if (row.status === 'OPEN') pair.open = row;
    if (row.status === 'CLOSED' && isVerifiedAegisMetricRecord(row)) pair.close = row;
    pairs.set(tradeId, pair);
  });

  const eligibleIds = new Set(
    Array.from(pairs.entries())
      .filter(([, pair]) => pair.open && pair.close)
      .map(([tradeId]) => tradeId),
  );
  const evidence = new Map<string, { e4Event?: JsonRecord; observations: RoeObservation[] }>();
  for (const tradeId of eligibleIds) evidence.set(tradeId, { observations: [] });

  await streamJsonlFiles(logsDir, eventFiles, warnings, (row) => {
    const tradeId = text(row.trade_id);
    if (!eligibleIds.has(tradeId)) return;
    const item = evidence.get(tradeId)!;
    if (row.event === 'E4_TAIL_RISK_PASSED') item.e4Event = row;
    if (row.event !== 'EXIT_EYE_V2_SHADOW_OBSERVATION') return;
    const timestamp = text(row.timestamp);
    const timestampMs = Date.parse(timestamp);
    const roe = finite(row.metadata?.context?.currentRoe);
    if (Number.isFinite(timestampMs) && roe !== undefined)
      item.observations.push({ timestamp, timestampMs, roe });
  });

  const trades: TradePathStudy[] = [];
  for (const [tradeId, pair] of pairs) {
    if (!pair.open || !pair.close) continue;
    const item = evidence.get(tradeId);
    if (!item?.e4Event) continue;
    item.observations.sort((a, b) => a.timestampMs - b.timestampMs);
    const input = toStudyInput(
      tradeId,
      pair.open,
      pair.close,
      item.e4Event,
      item.observations,
      warnings,
    );
    if (input) trades.push(analyzeTradePath(input));
  }
  trades.sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));

  const delayPolicies = aggregateDelayPolicies(trades);
  const protectionPolicies = aggregateProtectionPolicies(trades);
  const report: JsonRecord = {
    generatedAt,
    scope: {
      from: new Date(fromMs).toISOString(),
      to: Number.isFinite(toMs) ? new Date(toMs).toISOString() : null,
      ownership: 'AEGIS/BOT/VERIFIED/eligible_for_bot_metrics',
      e4Requirement: 'E4_TAIL_RISK_PASSED',
      observationSource: 'EXIT_EYE_V2_SHADOW_OBSERVATION sampled currentRoe',
      limitations: [
        'Sampled ROE can understate intratick MAE/MFE.',
        'Delay and protection results are counterfactual path replays, not live fills.',
        'A small cohort supports hypotheses, not live threshold promotion.',
      ],
    },
    definitions: {
      earlyEntrySuffering: 'first_30m_mae <= -5% ROE or -5% reached before +5%',
      lateReversal: 'first_30m_mae > -5%, total_mae <= -10%, and +5% reached before -5%',
      cleanPath: 'neither early-entry suffering nor late reversal',
      protectionSimulation: 'after trigger, exit at first sampled ROE at or below floor',
    },
    summary: buildSummary(trades),
    delayPolicies,
    protectionPolicies,
    proposals: buildProposals(trades, delayPolicies, protectionPolicies),
    trades,
    warnings,
  };

  if (options.writeReports !== false) {
    await fs.mkdir(outDir, { recursive: true });
    const stamp = generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const jsonPath = path.join(outDir, `aegis_e4_entry_mae_study_${stamp}.json`);
    const markdownPath = path.join(outDir, `aegis_e4_entry_mae_study_${stamp}.md`);
    await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await fs.writeFile(markdownPath, renderE4EntryMaeStudyMarkdown(report), 'utf8');
    report.outputFiles = { json: jsonPath, markdown: markdownPath };
  }
  return report;
}

export function analyzeTradePath(input: TradePathStudyInput) {
  const openedMs = Date.parse(input.openedAt);
  const observations = input.observations.filter((row) => row.timestampMs >= openedMs);
  const first30 = observations.filter((row) => row.timestampMs <= openedMs + 30 * 60_000);
  const mae = minBy(observations, (row) => row.roe);
  const mfe = maxBy(observations, (row) => row.roe);
  const plus5 = observations.find((row) => row.roe >= 0.05);
  const minus5 = observations.find((row) => row.roe <= -0.05);
  const first30MaeRoe = minimum(first30.map((row) => row.roe));
  const first30MfeRoe = maximum(first30.map((row) => row.roe));
  const plus5BeforeMinus5 = Boolean(plus5 && (!minus5 || plus5.timestampMs < minus5.timestampMs));
  const classification =
    first30MaeRoe !== undefined &&
    (first30MaeRoe <= -0.05 ||
      Boolean(minus5 && (!plus5 || minus5.timestampMs < plus5.timestampMs)))
      ? 'EARLY_ENTRY_SUFFERING'
      : first30MaeRoe !== undefined &&
          first30MaeRoe > -0.05 &&
          input.recordedMaeRoe <= -0.1 &&
          plus5BeforeMinus5
        ? 'LATE_REVERSAL'
        : 'CLEAN_PATH';
  const clean = input.openRecord.metadata?.cleanEntryGuard ?? {};
  const policy = input.openRecord.metadata?.entryPolicy ?? {};
  const e4Score = finite(input.e4Event.metadata?.e4Score);

  return {
    tradeId: input.tradeId,
    symbol: input.symbol,
    side: input.side,
    openedAt: input.openedAt,
    closedAt: input.closedAt,
    leverage: input.leverage,
    pnlUsdt: input.pnlUsdt,
    finalRoe: input.finalRoe,
    recordedMaeRoe: input.recordedMaeRoe,
    recordedMfeRoe: input.recordedMfeRoe,
    sampledMaeRoe: mae?.roe,
    sampledMfeRoe: mfe?.roe,
    first30MaeRoe,
    first30MfeRoe,
    minutesToMae: mae ? minutesBetween(openedMs, mae.timestampMs) : undefined,
    minutesToMfe: mfe ? minutesBetween(openedMs, mfe.timestampMs) : undefined,
    minutesToPlus5: plus5 ? minutesBetween(openedMs, plus5.timestampMs) : undefined,
    minutesToMinus5: minus5 ? minutesBetween(openedMs, minus5.timestampMs) : undefined,
    plus5BeforeMinus5,
    classification,
    entryEvidence: {
      e4Score,
      turboScore: finite(input.openRecord.turbo_score),
      setupGrade: text(clean.setupGrade),
      cleanEntryDecision: text(clean.decision),
      clean: clean.clean === true,
      dirty: clean.dirty === true,
      cleanEntryReasons: Array.isArray(clean.reasons) ? clean.reasons : [],
      entryQualityScore: finite(clean.entryQualityScore),
      tailRiskScore: finite(clean.tailRiskScore),
      eventRiskMode: text(clean.eventRiskMode),
      eventRiskWouldBlock: clean.eventRiskWouldBlock === true,
      regime: text(policy.regime?.regime),
      positionFraction: finite(input.openRecord.position_fraction),
    },
    delayCounterfactuals: DELAY_MINUTES.map((delay) => simulateDelayedEntry(input, delay)),
    protectionCounterfactuals: PROTECTION_POLICIES.map((proposal) =>
      simulateProtection(input, proposal),
    ),
    leverageStress: STRESS_LEVERAGES.map((leverage) => ({
      leverage,
      estimatedMaeRoe: (input.recordedMaeRoe * leverage) / input.leverage,
      breachesConfiguredStop: (input.recordedMaeRoe * leverage) / input.leverage <= -0.4,
    })),
  };
}

export function simulateDelayedEntry(input: TradePathStudyInput, delayMinutes: number) {
  const delayedAt = Date.parse(input.openedAt) + delayMinutes * 60_000;
  const start = input.observations.find((row) => row.timestampMs >= delayedAt);
  if (!start) return { delayMinutes, available: false };
  const delayedEntryPrice = markFromRoe(input.entryPrice, input.side, input.leverage, start.roe);
  const futureRoes = input.observations
    .filter((row) => row.timestampMs >= start.timestampMs)
    .map((row) =>
      roeFromPrice(
        markFromRoe(input.entryPrice, input.side, input.leverage, row.roe),
        delayedEntryPrice,
        input.side,
        input.leverage,
      ),
    );
  const finalRoe = roeFromPrice(input.exitPrice, delayedEntryPrice, input.side, input.leverage);
  return {
    delayMinutes,
    available: true,
    entryAt: start.timestamp,
    entryPrice: delayedEntryPrice,
    maeRoe: minimum(futureRoes),
    mfeRoe: maximum(futureRoes),
    finalRoe,
    finalRoeDelta: finalRoe - input.finalRoe,
  };
}

export function simulateProtection(
  input: TradePathStudyInput,
  policy: { name: string; triggerRoe: number; floorRoe: number },
) {
  const trigger = input.observations.find((row) => row.roe >= policy.triggerRoe);
  if (!trigger)
    return {
      ...policy,
      triggered: false,
      exited: false,
      simulatedFinalRoe: input.finalRoe,
      finalRoeDelta: 0,
      simulatedMaeRoe: input.recordedMaeRoe,
      maeImprovement: 0,
    };
  const exit = input.observations.find(
    (row) => row.timestampMs > trigger.timestampMs && row.roe <= policy.floorRoe,
  );
  const simulatedFinalRoe = exit?.roe ?? input.finalRoe;
  const observedPath = exit
    ? input.observations.filter((row) => row.timestampMs <= exit.timestampMs)
    : input.observations;
  const simulatedMaeRoe = exit
    ? (minimum(observedPath.map((row) => row.roe)) ?? input.recordedMaeRoe)
    : input.recordedMaeRoe;
  return {
    ...policy,
    triggered: true,
    triggerAt: trigger.timestamp,
    exited: Boolean(exit),
    exitAt: exit?.timestamp,
    simulatedFinalRoe,
    finalRoeDelta: simulatedFinalRoe - input.finalRoe,
    simulatedMaeRoe,
    maeImprovement: simulatedMaeRoe - input.recordedMaeRoe,
  };
}

export function renderE4EntryMaeStudyMarkdown(report: JsonRecord): string {
  const lines = [
    '# E4 Entry MAE and Profit Protection Study',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Scope',
    '',
    `- Cohort: ${report.summary.trades} verified bot-owned E4-passed closed trades.`,
    `- Winners/losses: ${report.summary.winners}/${report.summary.losses}.`,
    `- Mean/median MAE: ${pct(report.summary.meanMaeRoe)} / ${pct(report.summary.medianMaeRoe)}.`,
    '- Counterfactual results are research-only and do not authorize live changes.',
    '',
    '## Trade Evidence',
    '',
    '| Symbol | Side | Result | First 30m MAE | Total MAE | +5m | -5m | Class | E4 | Tail |',
    '|---|---|---:|---:|---:|---:|---:|---|---:|---:|',
  ];
  for (const trade of report.trades) {
    lines.push(
      `| ${trade.symbol} | ${trade.side} | ${pct(trade.finalRoe)} | ${pct(trade.first30MaeRoe)} | ${pct(trade.recordedMaeRoe)} | ${num(trade.minutesToPlus5)} | ${num(trade.minutesToMinus5)} | ${trade.classification} | ${num(trade.entryEvidence.e4Score)} | ${num(trade.entryEvidence.tailRiskScore)} |`,
    );
  }
  lines.push(
    '',
    '## Delay Policies',
    '',
    '| Delay | N | Mean MAE | Mean final ROE | Mean delta | Improved final |',
    '|---:|---:|---:|---:|---:|---:|',
  );
  for (const row of report.delayPolicies) {
    lines.push(
      `| ${row.delayMinutes}m | ${row.count} | ${pct(row.meanMaeRoe)} | ${pct(row.meanFinalRoe)} | ${pct(row.meanFinalRoeDelta)} | ${row.improvedFinalCount} |`,
    );
  }
  lines.push(
    '',
    '## Protection Policies',
    '',
    '| Policy | Triggered | Exited | Mean actual | Mean simulated | Mean delta | Mean MAE | MAE improvement |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  );
  for (const row of report.protectionPolicies) {
    lines.push(
      `| ${row.name} | ${row.triggeredCount} | ${row.exitedCount} | ${pct(row.meanActualFinalRoe)} | ${pct(row.meanSimulatedFinalRoe)} | ${pct(row.meanFinalRoeDelta)} | ${pct(row.meanSimulatedMaeRoe)} | ${pct(row.meanMaeImprovement)} |`,
    );
  }
  lines.push('', '## Evidence-backed Proposals', '');
  for (const proposal of report.proposals)
    lines.push(`- **${proposal.status} ${proposal.name}:** ${proposal.evidence}`);
  lines.push(
    '',
    '## Interpretation Rules',
    '',
    '- EARLY_ENTRY_SUFFERING: investigate confirmation or pullback/reclaim.',
    '- LATE_REVERSAL: investigate earlier profit protection, not delayed entry.',
    '- CLEAN_PATH: use as a control; avoid filters that remove these trades.',
    '',
    '## Limitations',
    '',
  );
  for (const limitation of report.scope.limitations) lines.push(`- ${limitation}`);
  return `${lines.join('\n')}\n`;
}

function buildSummary(trades: TradePathStudy[]) {
  const maes = trades.map((trade) => trade.recordedMaeRoe).filter(Number.isFinite);
  return {
    trades: trades.length,
    winners: trades.filter((trade) => trade.finalRoe > 0).length,
    losses: trades.filter((trade) => trade.finalRoe <= 0).length,
    meanMaeRoe: mean(maes),
    medianMaeRoe: median(maes),
    classifications: Object.fromEntries(
      ['EARLY_ENTRY_SUFFERING', 'LATE_REVERSAL', 'CLEAN_PATH'].map((name) => [
        name,
        trades.filter((trade) => trade.classification === name).length,
      ]),
    ),
  };
}

function aggregateDelayPolicies(trades: TradePathStudy[]) {
  return DELAY_MINUTES.map((delayMinutes) => {
    const rows = trades
      .map((trade) => trade.delayCounterfactuals.find((row) => row.delayMinutes === delayMinutes))
      .filter((row) => row?.available) as JsonRecord[];
    return {
      delayMinutes,
      count: rows.length,
      meanMaeRoe: mean(rows.map((row) => row.maeRoe)),
      meanFinalRoe: mean(rows.map((row) => row.finalRoe)),
      meanFinalRoeDelta: mean(rows.map((row) => row.finalRoeDelta)),
      improvedFinalCount: rows.filter((row) => row.finalRoeDelta > 0).length,
    };
  });
}

function aggregateProtectionPolicies(trades: TradePathStudy[]) {
  return PROTECTION_POLICIES.map((policy) => {
    const rows = trades
      .map((trade) => trade.protectionCounterfactuals.find((row) => row.name === policy.name)!)
      .filter(Boolean);
    return {
      name: policy.name,
      triggeredCount: rows.filter((row) => row.triggered).length,
      exitedCount: rows.filter((row) => row.exited).length,
      meanActualFinalRoe: mean(trades.map((trade) => trade.finalRoe)),
      meanSimulatedFinalRoe: mean(rows.map((row) => row.simulatedFinalRoe)),
      meanFinalRoeDelta: mean(rows.map((row) => row.finalRoeDelta)),
      improvedCount: rows.filter((row) => row.finalRoeDelta > 0).length,
      meanSimulatedMaeRoe: mean(rows.map((row) => row.simulatedMaeRoe)),
      worstSimulatedMaeRoe: minimum(rows.map((row) => row.simulatedMaeRoe)),
      meanMaeImprovement: mean(rows.map((row) => row.maeImprovement)),
    };
  });
}

function buildProposals(
  trades: TradePathStudy[],
  delayPolicies: JsonRecord[],
  protectionPolicies: JsonRecord[],
) {
  const bestProtection = protectionPolicies.find((row) => row.name === 'trigger_8_floor_5');
  const avax = trades.find((trade) => trade.symbol === 'AVAXUSDT' && trade.recordedMaeRoe < -0.2);
  const dirtyWinners = trades.filter(
    (trade) => trade.finalRoe > 0 && trade.entryEvidence.dirty,
  ).length;
  const thirtyXBreaches = trades.filter((trade) =>
    trade.leverageStress.some((row) => row.leverage === 30 && row.breachesConfiguredStop),
  ).length;
  const delayEvidence = delayPolicies
    .map((row) => `${row.delayMinutes}m ${pct(row.meanFinalRoeDelta)}`)
    .join(', ');
  return [
    {
      name: 'fixed_entry_delay',
      status: 'REJECT_FOR_LIVE',
      evidence: `All tested fixed delays had non-positive mean final-ROE delta (${delayEvidence}).`,
    },
    {
      name: 'pullback_reclaim_confirmation',
      status: 'RESEARCH_SHADOW',
      evidence: `${trades.filter((trade) => trade.classification === 'EARLY_ENTRY_SUFFERING').length}/${trades.length} trades showed early-entry suffering; target confirmation only to that phenotype instead of delaying every entry.`,
    },
    {
      name: 'trigger_8_floor_5_profit_protection',
      status: 'SHADOW_CANDIDATE',
      evidence: `Mean final-ROE delta ${pct(bestProtection?.meanFinalRoeDelta)} with mean MAE improvement ${pct(bestProtection?.meanMaeImprovement)}; ${bestProtection?.exitedCount ?? 0}/${trades.length} paths would exit early.${avax ? ` AVAX MAE was ${pct(avax.recordedMaeRoe)}.` : ''}`,
    },
    {
      name: 'enforce_current_clean_entry_guard',
      status: 'REJECT_FOR_LIVE',
      evidence: `${dirtyWinners}/${trades.filter((trade) => trade.finalRoe > 0).length} winners were labelled dirty, so current CleanEntry cannot discriminate this cohort.`,
    },
    {
      name: 'increase_leverage',
      status: 'HOLD_15X',
      evidence: `${thirtyXBreaches}/${trades.length} trades would exceed the configured -40% ROE stop under linear 30x stress; the cohort has no losses and is too small for tail-risk estimation.`,
    },
  ];
}

function toStudyInput(
  tradeId: string,
  open: JsonRecord,
  close: JsonRecord,
  e4Event: JsonRecord,
  observations: RoeObservation[],
  warnings: string[],
): TradePathStudyInput | undefined {
  const side = open.side === 'LONG' || open.side === 'SHORT' ? open.side : undefined;
  const values = {
    openedAt: text(close.opened_at ?? open.opened_at),
    closedAt: text(close.closed_at),
    entryPrice: finite(close.entry_price ?? open.entry_price),
    exitPrice: finite(close.exit_price),
    leverage: finite(close.leverage ?? open.leverage),
    finalRoe: finite(close.roe),
    pnlUsdt: finite(close.pnl_usdt),
    recordedMaeRoe: finite(close.mae_roe),
    recordedMfeRoe: finite(close.mfe_roe),
  };
  if (!side || Object.values(values).some((value) => value === undefined)) {
    warnings.push(`Skipped incomplete trade ${tradeId}`);
    return undefined;
  }
  return {
    tradeId,
    symbol: text(close.symbol ?? open.symbol),
    side,
    observations,
    openRecord: open,
    closeRecord: close,
    e4Event,
    openedAt: values.openedAt,
    closedAt: values.closedAt,
    entryPrice: values.entryPrice!,
    exitPrice: values.exitPrice!,
    leverage: values.leverage!,
    finalRoe: values.finalRoe!,
    pnlUsdt: values.pnlUsdt!,
    recordedMaeRoe: values.recordedMaeRoe!,
    recordedMfeRoe: values.recordedMfeRoe!,
  };
}

async function streamJsonlFiles(
  logsDir: string,
  files: string[],
  warnings: string[],
  consume: (row: JsonRecord) => void,
): Promise<void> {
  for (const file of files) {
    const input = createReadStream(path.join(logsDir, file), { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let corrupt = 0;
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        consume(JSON.parse(line));
      } catch {
        corrupt += 1;
      }
    }
    if (corrupt) warnings.push(`${file}: ignored ${corrupt} corrupt JSONL lines`);
  }
}

function selectDatedLogFiles(
  files: string[],
  prefix: string,
  fromMs: number,
  toMs: number,
): string[] {
  const fromDate = new Date(fromMs).toISOString().slice(0, 10);
  const toDate = Number.isFinite(toMs) ? new Date(toMs).toISOString().slice(0, 10) : '9999-12-31';
  return files
    .filter((name) => {
      const match = name.match(new RegExp(`^${prefix}_(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`));
      return Boolean(match && match[1] >= fromDate && match[1] <= toDate);
    })
    .sort();
}

function markFromRoe(
  entryPrice: number,
  side: 'LONG' | 'SHORT',
  leverage: number,
  roe: number,
): number {
  return side === 'LONG' ? entryPrice * (1 + roe / leverage) : entryPrice * (1 - roe / leverage);
}

function roeFromPrice(
  price: number,
  entryPrice: number,
  side: 'LONG' | 'SHORT',
  leverage: number,
): number {
  return side === 'LONG'
    ? (price / entryPrice - 1) * leverage
    : (1 - price / entryPrice) * leverage;
}

function minBy<T>(rows: T[], value: (row: T) => number): T | undefined {
  return rows.reduce<T | undefined>(
    (best, row) => (best === undefined || value(row) < value(best) ? row : best),
    undefined,
  );
}

function maxBy<T>(rows: T[], value: (row: T) => number): T | undefined {
  return rows.reduce<T | undefined>(
    (best, row) => (best === undefined || value(row) > value(best) ? row : best),
    undefined,
  );
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function minimum(values: number[]): number | undefined {
  return values.length ? Math.min(...values) : undefined;
}

function maximum(values: number[]): number | undefined {
  return values.length ? Math.max(...values) : undefined;
}

function mean(values: number[]): number | undefined {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : undefined;
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function minutesBetween(start: number, end: number): number {
  return (end - start) / 60_000;
}

function endOfUtcDay(value: string): number {
  return value.includes('T') ? Date.parse(value) : Date.parse(`${value}T23:59:59.999Z`);
}

function pct(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 100).toFixed(2)}%`
    : 'n/a';
}

function num(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : 'n/a';
}
