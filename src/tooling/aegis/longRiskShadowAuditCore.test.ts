import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { auditLongRiskShadow } from './longRiskShadowAuditCore';

describe('longRiskShadowAuditCore', () => {
  it('summarizes high-risk LONG warnings without counting SHORT controls', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'long-risk-shadow-'));
    const logsDir = path.join(dir, 'logs');
    await writeFile(path.join(dir, '.keep'), '');
    await import('fs/promises').then((fs) => fs.mkdir(logsDir, { recursive: true }));
    const rows = [
      openTrade('ETH-LOSS', 'ETHUSDT', 'LONG', -20, {
        finalReason: 'probe_mode_allowed',
        probeMode: { allowed: true },
        regime: { regime: 'UNKNOWN', wouldBlock: true, btcAction: 'HOLD', ethAction: 'LONG' },
        guards: {
          entry_quality: { reason: 'insufficient_data', metadata: { recommendation: 'ALLOW' } },
          clean_entry: { decision: 'WAIT' },
          event_risk: { decision: 'SHADOW_DENY', wouldBlock: true, metadata: { mode: 'CAUTION' } },
          probe_mode: { decision: 'ALLOW', metadata: { probeMode: { allowed: true } } },
        },
      }),
      closeTrade('ETH-LOSS', 'ETHUSDT', 'LONG', -20),
      openTrade('SOL-WIN', 'SOLUSDT', 'LONG', 10, {
        regime: { regime: 'MOMENTUM_UP', wouldBlock: false, btcAction: 'LONG', ethAction: 'LONG' },
        guards: {
          entry_quality: { reason: 'allow', metadata: { recommendation: 'ALLOW' } },
          clean_entry: { decision: 'ALLOW' },
          event_risk: { decision: 'ALLOW', metadata: { mode: 'NORMAL' } },
        },
      }),
      closeTrade('SOL-WIN', 'SOLUSDT', 'LONG', 10),
      openTrade('AVAX-WIN', 'AVAXUSDT', 'SHORT', 5, {
        regime: { regime: 'CHOP', wouldBlock: true, btcAction: 'HOLD', ethAction: 'SHORT' },
        guards: {
          entry_quality: { reason: 'insufficient_data' },
          clean_entry: { decision: 'WAIT' },
          event_risk: { decision: 'SHADOW_DENY', wouldBlock: true, metadata: { mode: 'CAUTION' } },
        },
      }),
      closeTrade('AVAX-WIN', 'AVAXUSDT', 'SHORT', 5),
    ];
    await writeFile(
      path.join(logsDir, 'turbo_trades_2026-05-22.jsonl'),
      rows.map((row) => JSON.stringify(row)).join('\n'),
    );

    const report = await auditLongRiskShadow({
      repoRoot: dir,
      logsDir,
      from: '2026-05-22',
      to: '2026-05-22',
      writeReports: false,
    });

    expect(report.summary.longTrades).toBe(2);
    expect(report.summary.losersWarned).toBe(1);
    expect(report.summary.winnersWarned).toBe(0);
    expect(report.summary.netSavedPnlEstimatedIfReduced50Pct).toBe(10);
    expect(report.summary.blockedProbeLongCriticalCount).toBe(1);
    expect(report.summary.blockedProbeLongCriticalLosers).toBe(1);
    expect(report.summary.netEstimatedIfBlocked).toBe(20);
    expect(report.trades.find((trade) => trade.tradeId === 'ETH-LOSS')?.assessment.riskLevel).toBe(
      'CRITICAL',
    );
    expect(
      report.trades.find((trade) => trade.tradeId === 'ETH-LOSS')?.wouldBlockProbeLongCritical,
    ).toBe(true);
    expect(report.trades.find((trade) => trade.tradeId === 'SOL-WIN')?.assessment.riskLevel).toBe(
      'LOW',
    );

    await rm(dir, { recursive: true, force: true });
  });
});

function openTrade(
  tradeId: string,
  symbol: string,
  side: 'LONG' | 'SHORT',
  pnl: number,
  entryPolicy: Record<string, unknown>,
) {
  return {
    trade_id: tradeId,
    status: 'OPEN',
    symbol,
    side,
    opened_at: '2026-05-22T10:00:00.000Z',
    entry_price: 1,
    strategy: 'aegis_turbo',
    metadata: {
      entryPolicy: {
        finalStrategy: 'aegis_turbo',
        ...entryPolicy,
      },
    },
    pnl_usdt: pnl,
  };
}

function closeTrade(tradeId: string, symbol: string, side: 'LONG' | 'SHORT', pnl: number) {
  return {
    trade_id: tradeId,
    status: 'CLOSED',
    symbol,
    side,
    opened_at: '2026-05-22T10:00:00.000Z',
    closed_at: '2026-05-22T11:00:00.000Z',
    entry_price: 1,
    exit_price: pnl < 0 ? 0.95 : 1.05,
    pnl_usdt: pnl,
    roe: pnl / 100,
    owner: 'AEGIS',
    origin: 'BOT',
    ownership_status: 'VERIFIED',
    eligible_for_bot_metrics: true,
    strategy: 'aegis_turbo',
  };
}
