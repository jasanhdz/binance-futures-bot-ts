import { Side } from '../core/types';

export type EquityPoint = {
  time: number;
  equity: number;
};

export type BacktestTrade = {
  id: number;
  side: Side;
  entryIdx: number;
  entryTs: number;
  entryPx: number;
  exitIdx: number;
  exitTs: number;
  exitPx: number;
  exitReason: 'TP' | 'SL' | 'Timeout' | 'StrategyExit' | 'Reverse' | 'Flat';
  barsHeld: number;
  pnlPct: number;
  mfePct: number;
  maePct: number;
  signalReason?: string;
};

export type BacktestOptions = {
  symbol: string;
  timeframe: string;
  dataSymbol?: string;
  additionalTimeframes?: string[];
  startTime?: number | string;
  endTime?: number | string;
  warmupBars?: number;
  takeProfitPct?: number;
  stopLossPct?: number;
  trailingStopPct?: number;
  maxHoldBars?: number;
  tradeFeePct?: number;
};

export type BacktestSummary = {
  totalTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgPnlPct: number;
  expectancyPct: number;
  cumPnlPct: number;
  bestPct: number;
  worstPct: number;
  avgWinPct: number;
  avgLossPct: number;
};

export type BacktestResult = {
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  summary: BacktestSummary;
};
