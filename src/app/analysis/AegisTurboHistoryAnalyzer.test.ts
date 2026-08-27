import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { analyzeAegisTurboHistory } from './AegisTurboHistoryAnalyzer';

describe('analyzeAegisTurboHistory', () => {
  let tempDir: string;
  let logsDir: string;
  let reportsDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-analyze-'));
    logsDir = path.join(tempDir, 'logs', 'aegis');
    reportsDir = path.join(tempDir, 'reports');
    await fs.mkdir(logsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('generates zero report for empty logs', async () => {
    const report = await analyzeAegisTurboHistory({
      date: '2026-05-06',
      allSymbols: true,
      baseDir: logsDir,
      reportsDir,
    });

    expect(report.summary.total_signals).toBe(0);
    expect(report.summary.total_trades).toBe(0);
    expect(report.summary.closed_trades).toBe(0);
  });

  it('calculates win_rate correctly', async () => {
    await writeTrades([
      openTrade('t1', 'ETHUSDT', 0.62),
      closeTrade('t1', 'ETHUSDT', 10, 0.12),
      openTrade('t2', 'ETHUSDT', 0.63),
      closeTrade('t2', 'ETHUSDT', -5, -0.05),
    ]);

    const report = await run();

    expect(report.summary.win_rate).toBe(50);
  });

  it('calculates profit_factor correctly', async () => {
    await writeTrades([
      openTrade('t1', 'ETHUSDT', 0.62),
      closeTrade('t1', 'ETHUSDT', 12, 0.12),
      openTrade('t2', 'ETHUSDT', 0.63),
      closeTrade('t2', 'ETHUSDT', -4, -0.04),
    ]);

    const report = await run();

    expect(report.summary.profit_factor).toBe(3);
  });

  it('groups by_symbol', async () => {
    await writeTrades([
      openTrade('t1', 'ETHUSDT', 0.62),
      closeTrade('t1', 'ETHUSDT', 10, 0.12),
      openTrade('t2', 'BTCUSDT', 0.66),
      closeTrade('t2', 'BTCUSDT', -5, -0.05),
    ]);

    const report = await run();

    expect(report.by_symbol.ETHUSDT.trades).toBe(1);
    expect(report.by_symbol.BTCUSDT.trades).toBe(1);
  });

  it('groups by_score_bucket', async () => {
    await writeSignals([
      { symbol: 'ETHUSDT', turbo_score: 0.57, executed: true },
      { symbol: 'ETHUSDT', turbo_score: 0.71, executed: false },
    ]);
    await writeTrades([openTrade('t1', 'ETHUSDT', 0.57), closeTrade('t1', 'ETHUSDT', 10, 0.12)]);

    const report = await run();

    expect(report.by_score_bucket['0.55-0.60'].signals).toBe(1);
    expect(report.by_score_bucket['0.55-0.60'].trades).toBe(1);
    expect(report.by_score_bucket['>=0.70'].signals).toBe(1);
  });

  it('handles corrupted JSONL lines', async () => {
    await fs.writeFile(
      path.join(logsDir, 'turbo_trades_2026-05-06.jsonl'),
      `${JSON.stringify(openTrade('t1', 'ETHUSDT', 0.62))}\n{bad-json}\n${JSON.stringify(closeTrade('t1', 'ETHUSDT', 10, 0.12))}\n`,
    );

    const report = await run();

    expect(report.summary.closed_trades).toBe(1);
    expect(report.warnings[0]).toContain('corrupted');
  });

  it('supports --symbol equivalent filtering', async () => {
    await writeTrades([
      openTrade('t1', 'ETHUSDT', 0.62),
      closeTrade('t1', 'ETHUSDT', 10, 0.12),
      openTrade('t2', 'BTCUSDT', 0.66),
      closeTrade('t2', 'BTCUSDT', -5, -0.05),
    ]);

    const report = await analyzeAegisTurboHistory({
      date: '2026-05-06',
      symbol: 'ETHUSDT',
      baseDir: logsDir,
      reportsDir,
    });

    expect(report.summary.closed_trades).toBe(1);
    expect(report.by_symbol.ETHUSDT.net_pnl).toBe(10);
    expect(report.by_symbol.BTCUSDT).toBeUndefined();
  });

  it('supports --all-symbols equivalent mode', async () => {
    await writeTrades([
      openTrade('t1', 'ETHUSDT', 0.62),
      closeTrade('t1', 'ETHUSDT', 10, 0.12),
      openTrade('t2', 'BTCUSDT', 0.66),
      closeTrade('t2', 'BTCUSDT', -5, -0.05),
    ]);

    const report = await run();

    expect(report.summary.closed_trades).toBe(2);
    expect(Object.keys(report.by_symbol)).toEqual(['ETHUSDT', 'BTCUSDT']);
  });

  it('excludes manual, unknown, and legacy closes from bot analytics', async () => {
    await writeTrades([
      openTrade('verified', 'ETHUSDT', 0.62),
      closeTrade('verified', 'ETHUSDT', 2, 0.02),
      {
        ...closeTrade('manual', 'ETHUSDT', 50, 0.5),
        owner: 'EXTERNAL',
        origin: 'MANUAL_EXTERNAL',
        ownership_status: 'UNKNOWN',
        eligible_for_bot_metrics: false,
      },
      {
        ...closeTrade('unknown', 'ETHUSDT', 40, 0.4),
        ownership_status: 'UNKNOWN',
        eligible_for_bot_metrics: false,
      },
      {
        trade_id: 'legacy',
        symbol: 'ETHUSDT',
        strategy: 'AEGIS_TURBO',
        mode: 'AEGIS_TURBO_MICRO_LIVE',
        status: 'CLOSED',
        closed_at: '2026-05-06T10:30:00.000Z',
        pnl_usdt: 30,
      },
    ]);

    const report = await run();

    expect(report.summary.closed_trades).toBe(1);
    expect(report.summary.net_pnl).toBe(2);
  });

  it('counts Aegis Exit Eye events', async () => {
    await writeEvents([
      exitEyeEvent('AEGIS_EXIT_EYE_SHADOW_PROTECT', 0.14, 0.05),
      exitEyeEvent('AEGIS_EXIT_EYE_SHADOW_CLOSE', 0.18, 0.04),
      exitEyeEvent('AEGIS_EXIT_EYE_CLOSE_POSITION', 0.12, 0.07),
    ]);

    const report = await run();

    expect(report.summary.exit_eye_shadow_protect_count).toBe(1);
    expect(report.summary.exit_eye_shadow_close_count).toBe(1);
    expect(report.summary.exit_eye_close_count).toBe(1);
    expect(report.summary.avg_roe_when_exit_eye_triggered).toBeCloseTo(0.146667);
    expect(report.summary.avg_giveback_when_exit_eye_triggered).toBeCloseTo(0.053333);
  });

  async function run() {
    return analyzeAegisTurboHistory({
      date: '2026-05-06',
      allSymbols: true,
      baseDir: logsDir,
      reportsDir,
    });
  }

  async function writeSignals(rows: Array<Record<string, unknown>>) {
    const lines = rows
      .map((row) =>
        JSON.stringify({
          timestamp: '2026-05-06T10:00:00.000Z',
          strategy: 'AEGIS_TURBO',
          mode: 'AEGIS_TURBO_MICRO_LIVE',
          raw_action: 'LONG',
          ...row,
        }),
      )
      .join('\n');
    await fs.writeFile(path.join(logsDir, 'turbo_signals_2026-05-06.jsonl'), `${lines}\n`);
  }

  async function writeTrades(rows: Array<Record<string, unknown>>) {
    await fs.writeFile(
      path.join(logsDir, 'turbo_trades_2026-05-06.jsonl'),
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );
  }

  async function writeEvents(rows: Array<Record<string, unknown>>) {
    await fs.writeFile(
      path.join(logsDir, 'turbo_trade_events_2026-05-06.jsonl'),
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );
  }

  function exitEyeEvent(event: string, roe: number, givebackRoe: number) {
    return {
      timestamp: '2026-05-06T10:10:00.000Z',
      symbol: 'ETHUSDT',
      strategy: 'AEGIS_TURBO',
      mode: 'AEGIS_TURBO_MICRO_LIVE',
      event,
      roe,
      metadata: {
        currentRoe: roe,
        givebackRoe,
      },
    };
  }

  function openTrade(tradeId: string, symbol: string, score: number) {
    return {
      timestamp: '2026-05-06T10:00:00.000Z',
      trade_id: tradeId,
      symbol,
      strategy: 'AEGIS_TURBO',
      mode: 'AEGIS_TURBO_MICRO_LIVE',
      side: 'LONG',
      opened_at: '2026-05-06T10:00:00.000Z',
      entry_price: 100,
      quantity: 1,
      leverage: 20,
      position_fraction: 0.2,
      turbo_score: score,
      status: 'OPEN',
    };
  }

  function closeTrade(tradeId: string, symbol: string, pnl: number, roe: number) {
    return {
      timestamp: '2026-05-06T10:30:00.000Z',
      trade_id: tradeId,
      symbol,
      strategy: 'AEGIS_TURBO',
      mode: 'AEGIS_TURBO_MICRO_LIVE',
      side: 'LONG',
      closed_at: '2026-05-06T10:30:00.000Z',
      exit_reason: pnl >= 0 ? 'TAKE_PROFIT' : 'STOP_LOSS',
      pnl_usdt: pnl,
      roe,
      mfe_roe: Math.max(roe, 0.2),
      mae_roe: Math.min(roe, -0.03),
      duration_minutes: 30,
      owner: 'AEGIS',
      origin: 'BOT',
      ownership_status: 'VERIFIED',
      eligible_for_bot_metrics: true,
      status: 'CLOSED',
    };
  }
});
