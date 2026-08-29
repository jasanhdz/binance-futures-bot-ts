import { BinanceExchange } from '../../infra/adapters/BinanceAdapter';
import { TelegramService } from '../../infra/adapters/TelegramAdapter';
import { FsLogger } from '../../infra/logging/FsLogger';
import { FsStateStore } from '../../infra/logging/FsStateStore';
import { NinjaConfigManager } from '../../infra/config/ConfigLoader';
import { CONFIG } from '../../infra/config/environment';
import { TelegramBotCommandListener } from '../../infra/telegram/TelegramBotCommandListener';
import { TelegramMutationAuditWriter } from '../../infra/telegram/TelegramMutationAuditWriter';
import type { Notifier } from '../ports/Notifier';
import { TradingService, type TradingServiceConfig } from '../services/TradingService';
import { TelegramCommandHandlers } from '../telegram/TelegramCommandHandlers';
import { TelegramCommandRouter } from '../telegram/TelegramCommandRouter';
import { AegisBlocksReportService } from '../telegram/AegisBlocksReportService';
import { AegisMLService } from '../../strategies/aegis/application/AegisMLService';
import { AegisConsecutiveLossStateStore } from '../../strategies/aegis/application/AegisConsecutiveLossStateStore';

class TelegramNotifier implements Notifier {
  async sendMessage(message: string): Promise<void> {
    await TelegramService.sendAlert(message);
  }

  async sendAlert(title: string, body: string): Promise<void> {
    await TelegramService.sendAlert(`⚠️ ${title}\n${body}`);
  }
}

export interface TradingApplicationSummary {
  runtimeMode: string;
  symbols: readonly string[];
  tickIntervalMs: number;
}

export interface TradingApplication {
  readonly summary: TradingApplicationSummary;
  start(): Promise<void>;
  stop(signal: 'SIGINT' | 'SIGTERM'): Promise<boolean>;
}

/**
 * Application composition root.
 *
 * This is the explicit boundary where generic infrastructure is wired to installed
 * strategy modules. The process entry point (`main.ts`) remains strategy-neutral.
 * Strategy-specific names are allowed here because this layer is selecting concrete
 * modules, not defining shared infrastructure contracts.
 */
export function createTradingApplication(): TradingApplication {
  const logger = new FsLogger();
  const exchange = new BinanceExchange(logger);

  // Preserve the legacy state filename for backwards compatibility. The store is
  // application state even though the historical filename predates multi-strategy runtime.
  const stateStore = new FsStateStore('aegis_state.json');
  const mlService = new AegisMLService();
  const notifier = new TelegramNotifier();
  const configManager = new NinjaConfigManager();

  // Strategy-specific validation belongs to composition, not the process entry point.
  configManager.validateSingleLiveAegisSymbol();
  const primarySymbols = configManager.getActiveAegisSymbols();
  const legacySymbols = configManager.getActiveSymbols();
  const tradingSymbols = primarySymbols.length > 0 ? primarySymbols : legacySymbols;
  if (tradingSymbols.length === 0) {
    throw new Error('STARTUP_NO_ACTIVE_SYMBOLS: configure at least one enabled strategy symbol');
  }

  const tradingConfig: TradingServiceConfig = {
    symbols: tradingSymbols,
    tickIntervalMs: configManager.system.tick_interval_ms ?? 10_000,
    maxTradesPerDay: configManager.system.max_trades_per_day ?? 100,
    tradingMode: CONFIG.TRADING_MODE,
  };

  const tradingService = new TradingService(
    {
      exchange,
      mlService,
      logger,
      state: stateStore,
      notifier,
      configManager,
      consecutiveLossStateStore: new AegisConsecutiveLossStateStore(),
    },
    tradingConfig,
  );

  const commandListener =
    CONFIG.TELEGRAM_COMMANDS_ENABLED && CONFIG.TELEGRAM_ALLOWED_CHAT_IDS.length > 0
      ? new TelegramBotCommandListener({
          token: TelegramService.getAlertBotToken(),
          logger,
          router: new TelegramCommandRouter(
            new TelegramCommandHandlers({
              exchange,
              mlService,
              state: stateStore,
              configManager,
              logger,
              tradingMode: tradingConfig.tradingMode || CONFIG.TRADING_MODE,
              liveEnabled: CONFIG.AEGIS_LIVE_ENABLED,
              getRuntimeSnapshot: () => tradingService.getAegisRuntimeSnapshot(),
              getActiveSymbols: () => tradingConfig.symbols,
              blocksReportService: new AegisBlocksReportService(),
              telegramMutationsEnabled: CONFIG.TELEGRAM_POLICY_MUTATIONS_ENABLED,
              mutationAuditWriter: new TelegramMutationAuditWriter(),
            }),
            {
              allowedChatIds: CONFIG.TELEGRAM_ALLOWED_CHAT_IDS,
              allowedUserIds: CONFIG.TELEGRAM_ALLOWED_USER_IDS,
              mutationsEnabled: CONFIG.TELEGRAM_POLICY_MUTATIONS_ENABLED,
            },
          ),
        })
      : null;

  if (CONFIG.TELEGRAM_COMMANDS_ENABLED && CONFIG.TELEGRAM_ALLOWED_CHAT_IDS.length === 0) {
    logger.warn('telegram_commands_disabled_no_allowed_chats', {});
  }

  let shutdownStarted = false;

  return {
    summary: Object.freeze({
      runtimeMode: CONFIG.TRADING_MODE,
      symbols: Object.freeze([...tradingSymbols]),
      tickIntervalMs: tradingConfig.tickIntervalMs,
    }),

    async start(): Promise<void> {
      commandListener?.start();
      await tradingService.start();
    },

    async stop(signal: 'SIGINT' | 'SIGTERM'): Promise<boolean> {
      if (shutdownStarted) {
        logger.warn('shutdown_already_in_progress', { signal });
        return false;
      }
      shutdownStarted = true;
      const timeoutMs = 15_000;
      logger.info('shutdown_started', { signal, timeoutMs });
      commandListener?.stop();
      let completed = false;
      try {
        completed = await Promise.race([
          tradingService.stop().then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]);
      } catch (error) {
        logger.error('shutdown_failed', { signal, error: String(error) });
      }
      if (!completed) logger.error('shutdown_timeout', { signal, timeoutMs });
      else logger.info('shutdown_completed', { signal });
      return completed;
    },
  };
}
