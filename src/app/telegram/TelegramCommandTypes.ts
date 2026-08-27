import { Exchange } from '../ports/Exchange';
import { Logger } from '../ports/Logger';
import { MLService } from '../ports/MLService';
import { StateStore } from '../ports/StateStore';
import { NinjaConfigManager } from '../../infra/config/ConfigLoader';
import { AegisBlocksReportService } from './AegisBlocksReportService';
import { AegisMomentumReportService } from './AegisMomentumReportService';
import { AegisProbeReportService } from './AegisProbeReportService';

export type TelegramCommandName =
  | 'help'
  | 'status'
  | 'account'
  | 'positions'
  | 'trade'
  | 'trades'
  | 'config'
  | 'signal'
  | 'signals'
  | 'risk'
  | 'riskmode'
  | 'brackets'
  | 'report'
  | 'blocks'
  | 'momentum'
  | 'probe';

export type TelegramCommandResponse = string | string[];

export interface TelegramInboundMessage {
  chatId: string;
  text?: string;
  messageId?: number;
  fromUsername?: string;
}

export interface ParsedTelegramCommand {
  name: TelegramCommandName | 'unknown';
  args: string[];
  raw: string;
}

export interface AegisRuntimeSnapshot {
  tradingMode: string;
  isRunning?: boolean;
  tradesToday?: number;
  consecutiveLosses?: number;
  dailyStartBalance?: number | null;
  dailyPnlPct?: number;
  lastTradeDayReset?: number;
  liquidityStressBySymbol?: Record<string, number>;
}

export interface TelegramCommandHandlerDeps {
  exchange: Exchange;
  mlService: MLService;
  state: StateStore;
  configManager: NinjaConfigManager;
  logger?: Logger;
  tradingMode: string;
  liveEnabled: boolean;
  getRuntimeSnapshot?: () => AegisRuntimeSnapshot;
  getActiveSymbols?: () => string[];
  blocksReportService?: AegisBlocksReportService;
  momentumReportService?: AegisMomentumReportService;
  probeReportService?: AegisProbeReportService;
}

export interface TelegramCommandRouterOptions {
  allowedChatIds: string[];
  rateLimitMs?: number;
  now?: () => number;
}

export interface TelegramCommandHandlersPort {
  handleHelp(): Promise<TelegramCommandResponse> | TelegramCommandResponse;
  handleStatus(): Promise<TelegramCommandResponse>;
  handleAccount(): Promise<TelegramCommandResponse>;
  handlePositions(): Promise<TelegramCommandResponse>;
  handleTrade(symbol?: string): Promise<TelegramCommandResponse>;
  handleTrades(): Promise<TelegramCommandResponse>;
  handleConfig(): Promise<TelegramCommandResponse>;
  handleSignal(symbol?: string): Promise<TelegramCommandResponse>;
  handleSignals(): Promise<TelegramCommandResponse>;
  handleRisk(): Promise<TelegramCommandResponse>;
  handleRiskMode(mode?: string): Promise<TelegramCommandResponse> | TelegramCommandResponse;
  handleBrackets(): Promise<TelegramCommandResponse>;
  handleReportToday(): Promise<TelegramCommandResponse>;
  handleBlocks(args?: string[]): Promise<TelegramCommandResponse>;
  handleMomentum(args?: string[]): Promise<TelegramCommandResponse>;
  handleProbe(args?: string[]): Promise<TelegramCommandResponse>;
}
