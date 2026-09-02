export interface MicroBurstSymbolConfig {
  enabled: boolean;
  btcConflictThresholdBps?: number;
  bookDepthLevels?: number;
  bookDepthSpeed?: '100ms' | '250ms' | '500ms';
}

export interface MicroBurstRuntimeConfig {
  enabled: boolean;
  mode: 'OFF' | 'SHADOW' | 'LIVE';
  symbols: Record<string, MicroBurstSymbolConfig>;
  prospectiveValidation?: {
    enabled: boolean;
    cohortId?: string;
    horizonsMs?: number[];
    conservativeEntrySlippageBps?: number;
  };
  marketArchive?: {
    enabled: boolean;
    rootDir?: string;
    sqlitePath?: string;
    tradeRetentionMs?: number;
    bookCheckpointIntervalMs?: number;
    rawTradeArchive?: boolean;
    rawDepthArchive?: boolean;
    compression?: 'gzip';
    maxActiveSegmentRecords?: number;
    maxActiveSegmentBytes?: number;
    maxActiveSegmentDurationMs?: number;
    durabilityFlushIntervalMs?: number;
  };
}

export interface MicroBurstLiveEntryRequest {
  symbol: string;
  side: 'LONG' | 'SHORT';
  signalId: string;
  strategyVersion: string;
  requestedAt: number;
  leverage: number;
  positionFraction: number;
  structuralStopPrice: number;
  destinationPrice: number;
  diagnostics: Record<string, unknown>;
}

export interface MicroBurstExitMarketSnapshot {
  currentPrice: number;
  observedAtMs: number;
  currentBookPressure: import('../domain/MicroBurstTypes').BookPressureSignal | null;
  currentBtcContext: import('../domain/MicroBurstTypes').BtcContext | null;
  marketEvidence: import('../domain/MicroBurstTypes').MicroBurstExitMarketEvidence | null;
}
