import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { auditRegimeAvoidShadow } from './regimeAvoidShadowAuditCore';

describe('auditRegimeAvoidShadow', () => {
  let tempDir: string;
  let logsDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'regime-avoid-shadow-'));
    logsDir = path.join(tempDir, 'logs', 'aegis');
    await fs.mkdir(logsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('counts avoided winners and losers and computes net impact', async () => {
    await writeTrades([
      openTrade('t1', 'ADAUSDT', 'LONG', 'CHOP'),
      closeTrade('t1', 'ADAUSDT', 'LONG', -4, -0.08),
      openTrade('t2', 'AVAXUSDT', 'SHORT', 'UNKNOWN'),
      closeTrade('t2', 'AVAXUSDT', 'SHORT', 2, 0.04),
      openTrade('t3', 'ETHUSDT', 'LONG', 'MOMENTUM_UP'),
      closeTrade('t3', 'ETHUSDT', 'LONG', 5, 0.1),
    ]);

    const report = await run();

    expect(report.summary.trades).toBe(3);
    expect(report.summary.wouldAvoid).toBe(2);
    expect(report.summary.avoidedLosers).toBe(1);
    expect(report.summary.avoidedWinners).toBe(1);
    expect(report.summary.wouldAvoidPnLImpact).toBe(-2);
    expect(report.summary.netSavedPnlEstimated).toBe(2);
    expect(report.summary.netAvoidedRoe).toBe(0.04);
  });

  it('uses ENTRY_POLICY_DECISION metadata when open trade metadata is missing', async () => {
    await writeTrades([
      { ...openTrade('t1', 'ADAUSDT', 'LONG', 'CHOP'), metadata: undefined },
      closeTrade('t1', 'ADAUSDT', 'LONG', -4, -0.08),
    ]);
    await writeEvents([entryPolicyEvent('t1', 'ADAUSDT', 'LONG', 'CHOP')]);

    const report = await run();

    expect(report.summary.wouldAvoid).toBe(1);
    expect(report.evaluations[0].shadow.reason).toBe('calibrated_avoid_regime');
  });

  it('handles corrupted logs and skips duplicate closes', async () => {
    const rows = [
      JSON.stringify(openTrade('t1', 'ADAUSDT', 'LONG', 'CHOP')),
      '{bad-json}',
      JSON.stringify(closeTrade('t1', 'ADAUSDT', 'LONG', -4, -0.08)),
      JSON.stringify(closeTrade('t1', 'ADAUSDT', 'LONG', -5, -0.1)),
    ];
    await fs.writeFile(
      path.join(logsDir, 'turbo_trades_2026-05-22.jsonl'),
      `${rows.join('\n')}\n`,
      'utf8',
    );

    const report = await run();

    expect(report.summary.trades).toBe(1);
    expect(report.summary.corruptedLines).toBe(1);
    expect(report.summary.duplicateTradesSkipped).toBe(1);
    expect(report.warnings[0]).toContain('corrupted');
  });

  it('groups avoided trades by symbol side and regime', async () => {
    await writeTrades([
      openTrade('t1', 'ADAUSDT', 'LONG', 'CHOP'),
      closeTrade('t1', 'ADAUSDT', 'LONG', -4, -0.08),
      openTrade('t2', 'ADAUSDT', 'SHORT', 'UNKNOWN'),
      closeTrade('t2', 'ADAUSDT', 'SHORT', -3, -0.06),
    ]);

    const report = await run();

    expect(report.bySymbolSide['ADAUSDT LONG'].wouldAvoid).toBe(1);
    expect(report.bySymbolSide['ADAUSDT SHORT'].wouldAvoid).toBe(1);
    expect(report.byRegime.CHOP.wouldAvoid).toBe(1);
    expect(report.byRegime.UNKNOWN.wouldAvoid).toBe(1);
  });

  async function run() {
    return auditRegimeAvoidShadow({
      date: '2026-05-22',
      allSymbols: true,
      baseDir: logsDir,
      reportsDir: path.join(tempDir, 'reports'),
      writeReports: false,
    });
  }

  async function writeTrades(rows: Array<Record<string, unknown>>) {
    await fs.writeFile(
      path.join(logsDir, 'turbo_trades_2026-05-22.jsonl'),
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      'utf8',
    );
  }

  async function writeEvents(rows: Array<Record<string, unknown>>) {
    await fs.writeFile(
      path.join(logsDir, 'turbo_trade_events_2026-05-22.jsonl'),
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      'utf8',
    );
  }
});

function openTrade(tradeId: string, symbol: string, side: 'LONG' | 'SHORT', regime: string) {
  return {
    timestamp: '2026-05-22T10:00:00.000Z',
    trade_id: tradeId,
    symbol,
    strategy: 'AEGIS_TURBO',
    mode: 'AEGIS_TURBO_MICRO_LIVE',
    side,
    opened_at: '2026-05-22T10:00:00.000Z',
    entry_price: 100,
    quantity: 1,
    leverage: 20,
    position_fraction: 0.2,
    status: 'OPEN',
    metadata: {
      entryPolicy: {
        finalDecision: 'ALLOW',
        finalStrategy: 'aegis_turbo',
        regimeContext: { label: regime, confidence: 0.8 },
      },
    },
  };
}

function closeTrade(
  tradeId: string,
  symbol: string,
  side: 'LONG' | 'SHORT',
  pnl: number,
  roe: number,
) {
  return {
    timestamp: '2026-05-22T10:30:00.000Z',
    trade_id: tradeId,
    symbol,
    strategy: 'AEGIS_TURBO',
    mode: 'AEGIS_TURBO_MICRO_LIVE',
    side,
    opened_at: '2026-05-22T10:00:00.000Z',
    closed_at: '2026-05-22T10:30:00.000Z',
    exit_reason: pnl >= 0 ? 'TAKE_PROFIT' : 'STOP_LOSS',
    pnl_usdt: pnl,
    roe,
    mfe_roe: Math.max(roe, 0.12),
    mae_roe: Math.min(roe, -0.04),
    owner: 'AEGIS',
    origin: 'BOT',
    ownership_status: 'VERIFIED',
    eligible_for_bot_metrics: true,
    status: 'CLOSED',
  };
}

function entryPolicyEvent(tradeId: string, symbol: string, side: 'LONG' | 'SHORT', regime: string) {
  return {
    timestamp: '2026-05-22T10:00:00.000Z',
    trade_id: tradeId,
    symbol,
    strategy: 'AEGIS_TURBO',
    mode: 'AEGIS_TURBO_MICRO_LIVE',
    event: 'ENTRY_POLICY_DECISION',
    metadata: {
      symbol,
      side,
      finalDecision: 'ALLOW',
      finalStrategy: 'aegis_turbo',
      regimeContext: { label: regime, confidence: 0.8 },
    },
  };
}
