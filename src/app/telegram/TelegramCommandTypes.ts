import { Exchange } from '../ports/Exchange';
import { Logger } from '../ports/Logger';
import { MLService } from '../ports/MLService';
import { StateStore } from '../ports/StateStore';
import { NinjaConfigManager } from '../../infra/config/ConfigLoader';

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
    | 'report';

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
}

export interface TelegramCommandRouterOptions {
    allowedChatIds: string[];
    rateLimitMs?: number;
    now?: () => number;
}

export interface TelegramCommandHandlersPort {
    handleHelp(): Promise<string> | string;
    handleStatus(): Promise<string>;
    handleAccount(): Promise<string>;
    handlePositions(): Promise<string>;
    handleTrade(symbol?: string): Promise<string>;
    handleTrades(): Promise<string>;
    handleConfig(): Promise<string>;
    handleSignal(symbol?: string): Promise<string>;
    handleSignals(): Promise<string>;
    handleRisk(): Promise<string>;
    handleRiskMode(mode?: string): Promise<string> | string;
    handleBrackets(): Promise<string>;
    handleReportToday(): Promise<string>;
}
