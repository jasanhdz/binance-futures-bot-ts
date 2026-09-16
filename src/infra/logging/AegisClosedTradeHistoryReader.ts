import { promises as fs } from 'fs';
import path from 'path';
import type { ClosedTradeOutcome } from '../../domain/services/ConsecutiveLossTracker';
import type { AegisClosedTradeOutcome } from '../../strategies/aegis/domain/services/AegisConsecutiveLossTracker';
import { isVerifiedAegisMetricRecord } from './AegisTradeOwnership';
import { isMicroBurstStrategy } from '../../core/strategy/MicroBurstLegacy';

type CachedFile<T> = { mtimeMs: number; size: number; outcomes: T[] };

const aegisCache = new Map<string, Map<string, CachedFile<AegisClosedTradeOutcome>>>();
const strategyCache = new Map<string, Map<string, CachedFile<ClosedTradeOutcome>>>();

async function readCachedOutcomeFiles<T>(
  baseDir: string,
  cacheKey: string,
  accept: (record: Record<string, unknown>) => T | undefined,
  cache: Map<string, Map<string, CachedFile<T>>>,
): Promise<T[]> {
  let files: string[];
  try {
    files = (await fs.readdir(baseDir))
      .filter((file) => /^turbo_trades_\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const previous = cache.get(cacheKey) ?? new Map<string, CachedFile<T>>();
  const current = new Map<string, CachedFile<T>>();
  for (const file of files) {
    const filePath = path.join(baseDir, file);
    const stat = await fs.stat(filePath);
    const cached = previous.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      current.set(file, cached);
      continue;
    }
    const outcomes: T[] = [];
    const content = await fs.readFile(filePath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const outcome = accept(JSON.parse(line) as Record<string, unknown>);
        if (outcome !== undefined) outcomes.push(outcome);
      } catch {
        // Ignore incomplete or malformed journal lines.
      }
    }
    current.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, outcomes });
  }
  cache.set(cacheKey, current);
  return files.flatMap((file) => current.get(file)?.outcomes ?? []);
}

function parseAegisOutcome(
  record: Record<string, unknown>,
  mode: string,
): AegisClosedTradeOutcome | undefined {
  if (record.status !== 'CLOSED' || record.strategy !== 'AEGIS_TURBO' || record.mode !== mode)
    return undefined;
  if (!isVerifiedAegisMetricRecord(record)) return undefined;
  const metadata = record.metadata;
  if (
    metadata &&
    typeof metadata === 'object' &&
    (metadata as Record<string, unknown>).pnl_status === 'ESTIMATED_FROM_MARK_PRICE'
  )
    return undefined;
  if (typeof record.trade_id !== 'string' || typeof record.closed_at !== 'string') return undefined;
  if (typeof record.pnl_usdt !== 'number' || !Number.isFinite(record.pnl_usdt)) return undefined;
  if (!Number.isFinite(Date.parse(record.closed_at))) return undefined;
  return { tradeId: record.trade_id, closedAt: record.closed_at, pnlUsdt: record.pnl_usdt };
}

function parseStrategyOutcome(
  record: Record<string, unknown>,
  mode: string,
): ClosedTradeOutcome | undefined {
  if (
    record.status !== 'CLOSED' ||
    (record.strategy !== 'AEGIS_TURBO' &&
      record.strategy !== 'MOMENTUM_RIDE' &&
      !isMicroBurstStrategy(record.strategy)) ||
    record.mode !== mode
  )
    return undefined;
  if (!isVerifiedAegisMetricRecord(record)) return undefined;
  const metadata = record.metadata;
  if (
    metadata &&
    typeof metadata === 'object' &&
    (metadata as Record<string, unknown>).pnl_status === 'ESTIMATED_FROM_MARK_PRICE'
  )
    return undefined;
  if (typeof record.trade_id !== 'string' || typeof record.closed_at !== 'string') return undefined;
  if (typeof record.pnl_usdt !== 'number' || !Number.isFinite(record.pnl_usdt)) return undefined;
  if (!Number.isFinite(Date.parse(record.closed_at))) return undefined;
  return { tradeId: record.trade_id, closedAt: record.closed_at, pnlUsdt: record.pnl_usdt };
}

export async function readAegisClosedTradeOutcomes(
  baseDir = path.join(process.cwd(), 'logs', 'aegis'),
  mode = 'AEGIS_TURBO_MICRO_LIVE',
): Promise<AegisClosedTradeOutcome[]> {
  return readCachedOutcomeFiles(
    baseDir,
    `${baseDir}|${mode}`,
    (record) => parseAegisOutcome(record, mode),
    aegisCache,
  );
}

export async function readStrategyClosedTradeOutcomes(
  baseDir = path.join(process.cwd(), 'logs', 'aegis'),
  mode = 'AEGIS_TURBO_MICRO_LIVE',
): Promise<ClosedTradeOutcome[]> {
  return readCachedOutcomeFiles(
    baseDir,
    `${baseDir}|${mode}`,
    (record) => parseStrategyOutcome(record, mode),
    strategyCache,
  );
}
