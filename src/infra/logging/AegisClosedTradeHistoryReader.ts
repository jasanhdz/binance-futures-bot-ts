import { promises as fs } from 'fs';
import path from 'path';
import type { ClosedTradeOutcome } from '../../domain/services/ConsecutiveLossTracker';
import type { AegisClosedTradeOutcome } from '../../domain/services/AegisConsecutiveLossTracker';
import { isVerifiedAegisMetricRecord } from './AegisTradeOwnership';

export async function readAegisClosedTradeOutcomes(
  baseDir = path.join(process.cwd(), 'logs', 'aegis'),
  mode = 'AEGIS_TURBO_MICRO_LIVE',
): Promise<AegisClosedTradeOutcome[]> {
  let files: string[];
  try {
    files = (await fs.readdir(baseDir))
      .filter((file) => /^turbo_trades_\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const outcomes: AegisClosedTradeOutcome[] = [];
  for (const file of files) {
    const content = await fs.readFile(path.join(baseDir, file), 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (record.status !== 'CLOSED' || record.strategy !== 'AEGIS_TURBO' || record.mode !== mode)
        continue;
      if (!isVerifiedAegisMetricRecord(record)) continue;
      if (typeof record.trade_id !== 'string' || typeof record.closed_at !== 'string') continue;
      if (typeof record.pnl_usdt !== 'number' || !Number.isFinite(record.pnl_usdt)) continue;
      if (!Number.isFinite(Date.parse(record.closed_at))) continue;
      outcomes.push({
        tradeId: record.trade_id,
        closedAt: record.closed_at,
        pnlUsdt: record.pnl_usdt,
      });
    }
  }
  return outcomes;
}

export async function readStrategyClosedTradeOutcomes(
  baseDir = path.join(process.cwd(), 'logs', 'aegis'),
  mode = 'AEGIS_TURBO_MICRO_LIVE',
): Promise<ClosedTradeOutcome[]> {
  let files: string[];
  try {
    files = (await fs.readdir(baseDir))
      .filter((file) => /^turbo_trades_\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const outcomes: ClosedTradeOutcome[] = [];
  for (const file of files) {
    const content = await fs.readFile(path.join(baseDir, file), 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (
        record.status !== 'CLOSED' ||
        (record.strategy !== 'AEGIS_TURBO' && record.strategy !== 'MOMENTUM_RIDE') ||
        record.mode !== mode
      )
        continue;
      if (!isVerifiedAegisMetricRecord(record)) continue;
      if (typeof record.trade_id !== 'string' || typeof record.closed_at !== 'string') continue;
      if (typeof record.pnl_usdt !== 'number' || !Number.isFinite(record.pnl_usdt)) continue;
      if (!Number.isFinite(Date.parse(record.closed_at))) continue;
      outcomes.push({
        tradeId: record.trade_id,
        closedAt: record.closed_at,
        pnlUsdt: record.pnl_usdt,
      });
    }
  }
  return outcomes;
}
