import { promises as fs } from 'fs';
import path from 'path';
import { isVerifiedAegisMetricRecord } from '../../infra/logging/AegisTradeOwnership';
import {
  AegisLongRiskShadowAssessment,
  evaluateAegisLongRiskShadow,
} from '../../domain/services/aegis-entry/guards/AegisLongRiskShadowGuardAdapter';

type JsonRecord = Record<string, any>;

export interface LongRiskShadowAuditOptions {
  repoRoot?: string;
  logsDir?: string;
  outDir?: string;
  from?: string;
  to?: string;
  writeReports?: boolean;
  generatedAt?: string;
}

export interface LongRiskShadowTradeAudit {
  tradeId: string;
  symbol: string;
  side: string;
  finalStrategy: string;
  openedAt?: string;
  closedAt?: string;
  entryPrice?: number;
  exitPrice?: number;
  pnlUsdt?: number;
  roe?: number;
  assessment: AegisLongRiskShadowAssessment;
  probeAllowed: boolean;
  wouldBlockProbeLongCritical: boolean;
}

export interface LongRiskShadowAuditReport {
  generatedAt: string;
  options: Required<Pick<LongRiskShadowAuditOptions, 'repoRoot' | 'logsDir' | 'outDir'>> &
    LongRiskShadowAuditOptions;
  trades: LongRiskShadowTradeAudit[];
  summary: {
    longTrades: number;
    highCriticalWarnings: number;
    winnersWarned: number;
    losersWarned: number;
    truePositiveWarnings: number;
    falsePositiveWarnings: number;
    pnlSavedEstimatedIfReduced50Pct: number;
    pnlMissedEstimatedIfReduced50Pct: number;
    netSavedPnlEstimatedIfReduced50Pct: number;
    roeAvoidedEstimatedIfReduced50Pct: number;
    blockedProbeLongCriticalCount: number;
    blockedProbeLongCriticalWinners: number;
    blockedProbeLongCriticalLosers: number;
    estimatedSavedIfBlocked: number;
    estimatedMissedIfBlocked: number;
    netEstimatedIfBlocked: number;
    bySymbol: Record<string, JsonRecord>;
    byFinalStrategy: Record<string, JsonRecord>;
    byRiskLevel: Record<string, number>;
    byReason: Record<string, number>;
  };
  warnings: string[];
  outputFiles?: {
    markdown: string;
    json: string;
    csv: string;
  };
}

type TradePair = {
  tradeId: string;
  symbol: string;
  open?: JsonRecord;
  close?: JsonRecord;
};

const DEFAULT_OUT_DIR = '/home/jasan/Develop';

export async function auditLongRiskShadow(
  options: LongRiskShadowAuditOptions = {},
): Promise<LongRiskShadowAuditReport> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const logsDir = options.logsDir ?? path.join(repoRoot, 'logs', 'aegis');
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const fromMs = parseDateBoundary(options.from, 'start');
  const toMs = parseDateBoundary(options.to, 'end');
  const warnings: string[] = [];
  const rows = await loadJsonlByPrefix(
    logsDir,
    'turbo_trades',
    dateKeysBetween(fromMs, toMs),
    warnings,
  );
  const pairs = pairTrades(rows);
  const trades = Array.from(pairs.values())
    .filter((pair) => {
      const openedMs = parseTimestamp(pair.open?.opened_at ?? pair.close?.opened_at);
      return (
        pair.symbol &&
        pair.open &&
        pair.close &&
        openedMs >= fromMs &&
        openedMs <= toMs &&
        (pair.open.side ?? pair.close.side) === 'LONG'
      );
    })
    .sort((a, b) => parseTimestamp(a.open?.opened_at) - parseTimestamp(b.open?.opened_at))
    .map(buildTradeAudit);
  const report: LongRiskShadowAuditReport = {
    generatedAt,
    options: { ...options, repoRoot, logsDir, outDir },
    trades,
    summary: summarize(trades),
    warnings,
  };
  if (options.writeReports !== false) {
    report.outputFiles = await writeReports(report, outDir);
  }
  return report;
}

function buildTradeAudit(pair: TradePair): LongRiskShadowTradeAudit {
  const open = pair.open!;
  const close = pair.close!;
  const entryPolicy = open.metadata?.entryPolicy ?? {};
  const guards = entryPolicy.guards ?? {};
  const regime = entryPolicy.regime ?? {};
  const assessment = evaluateAegisLongRiskShadow({
    symbol: pair.symbol,
    side: 'LONG',
    entryQualityReason: guards.entry_quality?.reason,
    entryQualityRecommendation:
      guards.entry_quality?.metadata?.recommendation ?? entryPolicy.entryQualityRecommendation,
    entryQualityScore: num(
      guards.entry_quality?.metadata?.entryQualityScore ??
        guards.decision_brain?.metadata?.entryQualityModelScore,
    ),
    tailRiskScore: num(
      guards.entry_quality?.metadata?.tailRiskScore ??
        guards.decision_brain?.metadata?.tailRiskScore,
    ),
    cleanEntryDecision: guards.clean_entry?.decision,
    eventRiskMode:
      guards.clean_entry?.metadata?.eventRiskMode ??
      guards.event_risk?.mode ??
      guards.event_risk?.metadata?.mode,
    eventRiskWouldBlock:
      guards.event_risk?.wouldBlock ?? guards.clean_entry?.metadata?.eventRiskWouldBlock,
    btcAction: regime.btcAction,
    btcScore: num(regime.btcScore),
    ethAction: regime.ethAction,
    ethScore: num(regime.ethScore),
    regimeLogged: regime.regime,
    regimeWouldBlock: regime.wouldBlock,
    regimeEngineV2Environment: entryPolicy.momentumRide?.regimeEngineV2?.momentumEnvironment,
    regimeEngineV2TechnicalRegime: entryPolicy.momentumRide?.regimeEngineV2?.technicalRegime,
    regimeEngineV2TransitionRisk: entryPolicy.momentumRide?.regimeEngineV2?.transitionRisk,
  });
  const probeAllowed =
    entryPolicy.finalReason === 'probe_mode_allowed' ||
    entryPolicy.allowedBy === 'probe_mode' ||
    entryPolicy.probeMode?.allowed === true ||
    guards.probe_mode?.decision === 'ALLOW' ||
    guards.probe_mode?.metadata?.probeMode?.allowed === true;
  const wouldBlockProbeLongCritical =
    probeAllowed &&
    assessment.riskLevel === 'CRITICAL' &&
    assessment.suggestedAction === 'WOULD_BLOCK_SHADOW';
  return {
    tradeId: pair.tradeId,
    symbol: pair.symbol,
    side: 'LONG',
    finalStrategy: entryPolicy.finalStrategy ?? open.strategy ?? close.strategy ?? 'unknown',
    openedAt: open.opened_at,
    closedAt: close.closed_at,
    entryPrice: num(open.entry_price ?? close.entry_price),
    exitPrice: num(close.exit_price),
    pnlUsdt: num(close.pnl_usdt),
    roe: num(close.roe),
    assessment,
    probeAllowed,
    wouldBlockProbeLongCritical,
  };
}

function summarize(trades: LongRiskShadowTradeAudit[]): LongRiskShadowAuditReport['summary'] {
  const warned = trades.filter((trade) => isHighCritical(trade.assessment));
  const winnersWarned = warned.filter((trade) => (trade.pnlUsdt ?? 0) > 0);
  const losersWarned = warned.filter((trade) => (trade.pnlUsdt ?? 0) < 0);
  const saved = losersWarned.reduce((sum, trade) => sum + Math.abs(trade.pnlUsdt ?? 0) * 0.5, 0);
  const missed = winnersWarned.reduce(
    (sum, trade) => sum + Math.max(0, trade.pnlUsdt ?? 0) * 0.5,
    0,
  );
  const blockedProbeLongCritical = trades.filter((trade) => trade.wouldBlockProbeLongCritical);
  const blockedWinners = blockedProbeLongCritical.filter((trade) => (trade.pnlUsdt ?? 0) > 0);
  const blockedLosers = blockedProbeLongCritical.filter((trade) => (trade.pnlUsdt ?? 0) < 0);
  const savedIfBlocked = blockedLosers.reduce(
    (sum, trade) => sum + Math.abs(trade.pnlUsdt ?? 0),
    0,
  );
  const missedIfBlocked = blockedWinners.reduce(
    (sum, trade) => sum + Math.max(0, trade.pnlUsdt ?? 0),
    0,
  );
  return {
    longTrades: trades.length,
    highCriticalWarnings: warned.length,
    winnersWarned: winnersWarned.length,
    losersWarned: losersWarned.length,
    truePositiveWarnings: losersWarned.length,
    falsePositiveWarnings: winnersWarned.length,
    pnlSavedEstimatedIfReduced50Pct: round(saved),
    pnlMissedEstimatedIfReduced50Pct: round(missed),
    netSavedPnlEstimatedIfReduced50Pct: round(saved - missed),
    roeAvoidedEstimatedIfReduced50Pct: round(
      losersWarned.reduce((sum, trade) => sum + Math.abs(trade.roe ?? 0) * 0.5, 0),
    ),
    blockedProbeLongCriticalCount: blockedProbeLongCritical.length,
    blockedProbeLongCriticalWinners: blockedWinners.length,
    blockedProbeLongCriticalLosers: blockedLosers.length,
    estimatedSavedIfBlocked: round(savedIfBlocked),
    estimatedMissedIfBlocked: round(missedIfBlocked),
    netEstimatedIfBlocked: round(savedIfBlocked - missedIfBlocked),
    bySymbol: groupedSummary(trades, (trade) => trade.symbol),
    byFinalStrategy: groupedSummary(trades, (trade) => trade.finalStrategy),
    byRiskLevel: countBy(trades, (trade) => trade.assessment.riskLevel),
    byReason: countReasons(trades),
  };
}

function groupedSummary(
  trades: LongRiskShadowTradeAudit[],
  keyFn: (trade: LongRiskShadowTradeAudit) => string,
): Record<string, JsonRecord> {
  const out: Record<string, JsonRecord> = {};
  for (const trade of trades) {
    const key = keyFn(trade) || 'unknown';
    const row = out[key] ?? { trades: 0, warned: 0, winnersWarned: 0, losersWarned: 0, pnl: 0 };
    row.trades += 1;
    row.pnl = round(row.pnl + (trade.pnlUsdt ?? 0));
    if (isHighCritical(trade.assessment)) {
      row.warned += 1;
      if ((trade.pnlUsdt ?? 0) > 0) row.winnersWarned += 1;
      if ((trade.pnlUsdt ?? 0) < 0) row.losersWarned += 1;
    }
    if (trade.wouldBlockProbeLongCritical) {
      row.blockedProbeLongCritical = (row.blockedProbeLongCritical ?? 0) + 1;
    }
    out[key] = row;
  }
  return out;
}

async function writeReports(
  report: LongRiskShadowAuditReport,
  outDir: string,
): Promise<NonNullable<LongRiskShadowAuditReport['outputFiles']>> {
  await fs.mkdir(outDir, { recursive: true });
  const stamp = stampFromIso(report.generatedAt);
  const markdown = path.join(outDir, `aegis_long_risk_shadow_audit_${stamp}.md`);
  const json = path.join(outDir, `aegis_long_risk_shadow_audit_${stamp}.json`);
  const csv = path.join(outDir, `aegis_long_risk_shadow_summary_${stamp}.csv`);
  await fs.writeFile(markdown, renderMarkdown(report), 'utf8');
  await fs.writeFile(json, JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(csv, renderCsv(report), 'utf8');
  return { markdown, json, csv };
}

export function renderMarkdown(report: LongRiskShadowAuditReport): string {
  const lines: string[] = [];
  lines.push('# Aegis Long Risk Shadow Audit');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- LONG trades: ${report.summary.longTrades}`);
  lines.push(`- HIGH/CRITICAL warnings: ${report.summary.highCriticalWarnings}`);
  lines.push(`- Winners warned: ${report.summary.winnersWarned}`);
  lines.push(`- Losers warned: ${report.summary.losersWarned}`);
  lines.push(
    `- Estimated saved if warned trades reduced 50%: $${report.summary.pnlSavedEstimatedIfReduced50Pct.toFixed(2)}`,
  );
  lines.push(
    `- Estimated missed if winners reduced 50%: $${report.summary.pnlMissedEstimatedIfReduced50Pct.toFixed(2)}`,
  );
  lines.push(
    `- Net estimated saved: $${report.summary.netSavedPnlEstimatedIfReduced50Pct.toFixed(2)}`,
  );
  lines.push(
    `- Probe LONG CRITICAL would-block count: ${report.summary.blockedProbeLongCriticalCount}`,
  );
  lines.push(
    `- Probe LONG CRITICAL winners blocked: ${report.summary.blockedProbeLongCriticalWinners}`,
  );
  lines.push(
    `- Probe LONG CRITICAL losers blocked: ${report.summary.blockedProbeLongCriticalLosers}`,
  );
  lines.push(
    `- Net estimated if Probe LONG CRITICAL blocked: $${report.summary.netEstimatedIfBlocked.toFixed(2)}`,
  );
  lines.push('');
  lines.push('## Trades');
  lines.push('');
  lines.push('| Trade | Result | Strategy | Level | Score | Action | Probe block | Reasons |');
  lines.push('|---|---:|---|---|---:|---|---|---|');
  for (const trade of report.trades) {
    lines.push(
      `| ${trade.symbol} ${trade.tradeId} | $${(trade.pnlUsdt ?? 0).toFixed(2)} / ${pct(trade.roe)} | ${trade.finalStrategy} | ${trade.assessment.riskLevel} | ${trade.assessment.riskScore.toFixed(2)} | ${trade.assessment.suggestedAction} | ${trade.wouldBlockProbeLongCritical ? 'YES' : 'NO'} | ${trade.assessment.reasons.join(', ') || 'n/a'} |`,
    );
  }
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('## Warnings');
    report.warnings.forEach((warning) => lines.push(`- ${warning}`));
  }
  return lines.join('\n');
}

export function renderCsv(report: LongRiskShadowAuditReport): string {
  const header = [
    'trade_id',
    'symbol',
    'strategy',
    'opened_at',
    'closed_at',
    'pnl_usdt',
    'roe',
    'risk_level',
    'risk_score',
    'suggested_action',
    'probe_allowed',
    'would_block_probe_long_critical',
    'reasons',
  ];
  const rows = report.trades.map((trade) => [
    trade.tradeId,
    trade.symbol,
    trade.finalStrategy,
    trade.openedAt ?? '',
    trade.closedAt ?? '',
    String(trade.pnlUsdt ?? ''),
    String(trade.roe ?? ''),
    trade.assessment.riskLevel,
    String(trade.assessment.riskScore),
    trade.assessment.suggestedAction,
    String(trade.probeAllowed),
    String(trade.wouldBlockProbeLongCritical),
    trade.assessment.reasons.join('|'),
  ]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n');
}

async function loadJsonlByPrefix(
  logsDir: string,
  prefix: string,
  dateKeys: string[],
  warnings: string[],
): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [];
  for (const dateKey of dateKeys) {
    const file = path.join(logsDir, `${prefix}_${dateKey}.jsonl`);
    try {
      const text = await fs.readFile(file, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          warnings.push(`Invalid JSONL line skipped in ${file}`);
        }
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT')
        warnings.push(`Could not read ${file}: ${error?.message ?? error}`);
    }
  }
  return rows;
}

function pairTrades(rows: JsonRecord[]): Map<string, TradePair> {
  const pairs = new Map<string, TradePair>();
  for (const row of rows) {
    const tradeId = row.trade_id;
    if (!tradeId) continue;
    const pair: TradePair = pairs.get(tradeId) ?? { tradeId, symbol: row.symbol };
    pair.symbol = row.symbol ?? pair.symbol;
    if (row.status === 'OPEN' || (row.opened_at && !row.closed_at)) pair.open = row;
    if ((row.status === 'CLOSED' || row.closed_at) && isVerifiedAegisMetricRecord(row))
      pair.close = row;
    pairs.set(tradeId, pair);
  }
  return pairs;
}

function dateKeysBetween(fromMs: number, toMs: number): string[] {
  const keys: string[] = [];
  const start = new Date(fromMs - 24 * 3600000);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(toMs + 24 * 3600000);
  end.setUTCHours(0, 0, 0, 0);
  for (let t = start.getTime(); t <= end.getTime(); t += 24 * 3600000)
    keys.push(new Date(t).toISOString().slice(0, 10));
  return keys;
}

function parseDateBoundary(value: string | undefined, mode: 'start' | 'end'): number {
  if (!value) return mode === 'start' ? Date.now() - 7 * 24 * 3600000 : Date.now();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value))
    return Date.parse(`${value}T${mode === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`);
  return parseTimestamp(value);
}

function parseTimestamp(value: any): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.length === 0) return NaN;
  return Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

function isHighCritical(assessment: AegisLongRiskShadowAssessment): boolean {
  return assessment.riskLevel === 'HIGH' || assessment.riskLevel === 'CRITICAL';
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[keyFn(item)] = (out[keyFn(item)] ?? 0) + 1;
  return out;
}

function countReasons(trades: LongRiskShadowTradeAudit[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const trade of trades) {
    for (const reason of trade.assessment.reasons) out[reason] = (out[reason] ?? 0) + 1;
  }
  return out;
}

function num(value: any): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function stampFromIso(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function pct(value: any): string {
  const n = num(value);
  return n === undefined ? 'n/a' : `${(n * 100).toFixed(2)}%`;
}

function csvEscape(value: any): string {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
