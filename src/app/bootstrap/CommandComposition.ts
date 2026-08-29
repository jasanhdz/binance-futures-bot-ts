import { TelegramService } from '../../infra/adapters/TelegramAdapter';
import { CONFIG } from '../../infra/config/environment';
import { TelegramBotCommandListener } from '../../infra/telegram/TelegramBotCommandListener';
import { TelegramMutationAuditWriter } from '../../infra/telegram/TelegramMutationAuditWriter';
import { AegisBlocksReportService } from '../telegram/AegisBlocksReportService';
import { TelegramCommandHandlers } from '../telegram/TelegramCommandHandlers';
import { TelegramCommandRouter } from '../telegram/TelegramCommandRouter';
import type { ApplicationInfrastructure } from './ApplicationInfrastructure';
import type { ReturnTypeOfStrategyRuntime } from './StrategyComposition.types';

export function createCommandListener(
  infrastructure: ApplicationInfrastructure,
  runtime: ReturnTypeOfStrategyRuntime,
): TelegramBotCommandListener | null {
  if (!CONFIG.TELEGRAM_COMMANDS_ENABLED) return null;
  if (CONFIG.TELEGRAM_ALLOWED_CHAT_IDS.length === 0) {
    infrastructure.logger.warn('telegram_commands_disabled_no_allowed_chats', {});
    return null;
  }

  const { exchange, stateStore: state, configManager, logger } = infrastructure;
  const { service: tradingService, config: tradingConfig, mlService } = runtime;

  return new TelegramBotCommandListener({
    token: TelegramService.getAlertBotToken(),
    logger,
    router: new TelegramCommandRouter(
      new TelegramCommandHandlers({
        exchange,
        mlService,
        state,
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
  });
}
