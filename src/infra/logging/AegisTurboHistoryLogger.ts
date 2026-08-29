import {
  StrategyAccountSnapshotInput,
  StrategyHistoryLogger,
  StrategyProvenanceFields as GenericStrategyProvenanceFields,
  StrategySignalHistoryInput,
  StrategyTradeCloseInput,
  StrategyTradeEventInput,
  StrategyTradeOpenInput,
  StrategyTradeOwnershipFields,
  StrategyVotes,
  sanitizeJsonValue,
} from './StrategyHistoryLogger';
import { StrategyId } from '../../core/strategy/StrategyIdentity';
import { Logger } from '../../app/ports/Logger';
import path from 'path';

export type AegisTurboVotes = StrategyVotes;
export type AegisResearchStrategy = Extract<StrategyId, 'AEGIS_TURBO' | 'MOMENTUM_RIDE'>;
export type StrategyProvenanceFields = GenericStrategyProvenanceFields;
export type AegisTradeOwnershipFields = StrategyTradeOwnershipFields;
export type AegisTurboSignalHistoryInput = StrategySignalHistoryInput;
export type AegisTurboTradeOpenInput = StrategyTradeOpenInput;
export type AegisTurboTradeCloseInput = StrategyTradeCloseInput;
export type AegisTurboTradeEventInput = StrategyTradeEventInput;
export type AegisAccountSnapshotInput = StrategyAccountSnapshotInput;

export function generateSignalId(symbol: string, timestamp: Date = new Date()): string {
  return `AEGIS-SIGNAL-${safeToken(symbol)}-${formatIdTimestamp(timestamp)}`;
}

export function generateTradeId(symbol: string, timestamp: Date = new Date()): string {
  return generateStrategyTradeId('AEGIS_TURBO', symbol, timestamp);
}

export { sanitizeJsonValue };

export function generateStrategyTradeId(
  strategy: AegisResearchStrategy,
  symbol: string,
  timestamp: Date = new Date(),
): string {
  const prefix = strategy === 'MOMENTUM_RIDE' ? 'MOMENTUM-RIDE' : 'AEGIS-TURBO';
  return `${prefix}-${safeToken(symbol)}-${formatIdTimestamp(timestamp)}`;
}

export function getPortfolioSessionId(timestamp: Date = new Date()): string {
  return `AEGIS-SESSION-${formatDate(timestamp).replace(/-/g, '')}`;
}

export class AegisTurboHistoryLogger extends StrategyHistoryLogger {
  constructor(options: { baseDir?: string; logger?: Logger } = {}) {
    super({
      ...options,
      baseDir: options.baseDir ?? path.join(process.cwd(), 'logs', 'aegis'),
      filePrefixes: {
        signals: 'turbo_signals',
        trades: 'turbo_trades',
        trade_events: 'turbo_trade_events',
        account_snapshots: 'account_snapshots',
      },
      writeFailureMessage: 'aegis_turbo_history_write_failed',
    });
  }
}

function safeToken(value: string): string {
  return String(value || 'UNKNOWN')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function formatIdTimestamp(timestamp: Date): string {
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return [
    timestamp.getUTCFullYear(),
    pad(timestamp.getUTCMonth() + 1),
    pad(timestamp.getUTCDate()),
    '-',
    pad(timestamp.getUTCHours()),
    pad(timestamp.getUTCMinutes()),
    pad(timestamp.getUTCSeconds()),
    '-',
    pad(timestamp.getUTCMilliseconds(), 3),
  ].join('');
}

function formatDate(timestamp: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${timestamp.getUTCFullYear()}-${pad(timestamp.getUTCMonth() + 1)}-${pad(timestamp.getUTCDate())}`;
}
