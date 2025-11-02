import fs from 'fs';
import path from 'path';

export type SymbolOutcome = 'win' | 'loss';

export type TradeRecordEntry = {
  outcome: SymbolOutcome;
  entryTime?: number;
  exitTime?: number;
  entryPrice?: number;
  exitPrice?: number;
  qty?: number;
  reason?: string;
  roiPct?: number;
  pnlUsd?: number;
};

export type SymbolStats = {
  wins: number;
  losses: number;
  history: TradeRecordEntry[];
};

export type SymbolPerformanceData = {
  blocked: string[];
  winners: string[];
  performance: Record<string, SymbolStats>;
};

const DATA_PATH = path.resolve(__dirname, '../../data/symbol_performance.json');
const HISTORY_LIMIT = Number(process.env.SYMBOL_PERF_HISTORY_LIMIT ?? 50);

let cache: SymbolPerformanceData | null = null;

function ensureDir() {
  const dir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function load(): SymbolPerformanceData {
  if (cache) return cache;
  ensureDir();
  if (!fs.existsSync(DATA_PATH)) {
    cache = { blocked: [], winners: [], performance: {} };
    return cache;
  }
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const parsed = JSON.parse(raw) as SymbolPerformanceData;
    cache = {
      blocked: Array.isArray(parsed.blocked) ? parsed.blocked : [],
      winners: Array.isArray(parsed.winners) ? parsed.winners : [],
      performance:
        parsed.performance && typeof parsed.performance === 'object'
          ? parsed.performance
          : {},
    };
  } catch {
    cache = { blocked: [], winners: [], performance: {} };
  }
  return cache!;
}

function save(data: SymbolPerformanceData) {
  cache = data;
  ensureDir();
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
}

export function isSymbolBlocked(symbol: string): boolean {
  const data = load();
  const target = symbol.toUpperCase();
  return data.blocked.includes(target);
}

export function recordSymbolOutcome(symbol: string, entry: TradeRecordEntry) {
  const data = load();
  const target = symbol.toUpperCase();
  if (!data.performance[target]) {
    data.performance[target] = { wins: 0, losses: 0, history: [] };
  }
  const stats = data.performance[target];
  if (entry.outcome === 'win') {
    stats.wins += 1;
    if (!data.winners.includes(target)) {
      data.winners.push(target);
    }
  } else {
    stats.losses += 1;
    if (!data.blocked.includes(target)) {
      data.blocked.push(target);
    }
  }
  stats.history.push(entry);
  if (HISTORY_LIMIT > 0 && stats.history.length > HISTORY_LIMIT) {
    stats.history.splice(0, stats.history.length - HISTORY_LIMIT);
  }
  save(data);
}

export function getSymbolStats(symbol: string): SymbolStats | undefined {
  const data = load();
  return data.performance[symbol.toUpperCase()];
}

export function getPerformanceSnapshot(): SymbolPerformanceData {
  const data = load();
  return {
    blocked: [...data.blocked],
    winners: [...data.winners],
    performance: { ...data.performance },
  };
}
