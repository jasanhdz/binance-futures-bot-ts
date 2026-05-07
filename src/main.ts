/**
 * Main Entry Point
 * 
 * Wires up infrastructure adapters and starts the trading bot.
 * 
 * Hexagonal Architecture:
 * - Domain: Business logic (AegisStrategy, AegisMicroLiveGate, ProfitGuardian)
 * - Application: Use cases (TradingService)
 * - Infrastructure: Adapters (Binance, Telegram, ML, Logger, State)
 */

import { BinanceExchange } from './infra/adapters/BinanceAdapter';
import { TelegramService } from './infra/adapters/TelegramAdapter';
import { FsLogger } from './infra/logging/FsLogger';
import { FsStateStore } from './infra/logging/FsStateStore';
import { AegisMLService } from './app/services/AegisMLService';
import { NinjaConfigManager } from './infra/config/ConfigLoader';
import { TradingService, TradingServiceConfig } from './app/services/TradingService';
import { MLService } from './app/ports/MLService';
import { Notifier } from './app/ports/Notifier';
import { CONFIG } from './infra/config/environment';
import { TelegramCommandHandlers } from './app/telegram/TelegramCommandHandlers';
import { TelegramCommandRouter } from './app/telegram/TelegramCommandRouter';
import { TelegramBotCommandListener } from './infra/telegram/TelegramBotCommandListener';

// ═══════════════════════════════════════════════════════════════════════════
// ADAPTER WRAPPERS (to match port interfaces)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Notifier adapter wrapper (uses static TelegramService)
 */
class TelegramNotifier implements Notifier {
    async sendMessage(message: string): Promise<void> {
        await TelegramService.sendAlert(message);
    }

    async sendAlert(title: string, body: string): Promise<void> {
        await TelegramService.sendAlert(`⚠️ ${title}\n${body}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('🛡️ Aegis Trading Bot - Hexagonal Architecture');
    console.log('================================================');
    console.log(`Trading mode: ${CONFIG.TRADING_MODE}`);
    if (CONFIG.TRADING_MODE === 'AEGIS_SHADOW') {
        console.log('🛡️ AEGIS SHADOW MODE');
        console.log('No live entries');
        console.log('Aegis API integrated');
    } else if (CONFIG.TRADING_MODE === 'AEGIS_TURBO_MICRO_LIVE') {
        console.log('⚡ AEGIS TURBO MICRO-LIVE MODE');
        console.log(`Live requires AEGIS_LIVE_ENABLED=true (current=${CONFIG.AEGIS_LIVE_ENABLED})`);
    } else {
        console.log('🛡️ Unknown mode requested; Aegis runtime remains safety-gated');
    }

    // Create infrastructure adapters
    const logger = new FsLogger();
    const exchange = new BinanceExchange(logger);
    const stateStore = new FsStateStore('aegis_state.json');
    const mlService: MLService = new AegisMLService();
    const notifier = new TelegramNotifier();
    const configManager = new NinjaConfigManager();

    // Trading configuration
    const tradingConfig: TradingServiceConfig = {
        symbols: configManager.getActiveSymbols().length > 0
            ? configManager.getActiveSymbols()
            : ['ETHUSDT'],
        tickIntervalMs: configManager.system.tick_interval_ms || 10000,
        maxTradesPerDay: configManager.system.max_trades_per_day || 100
    };

    console.log(`📊 Active symbols: ${tradingConfig.symbols.join(', ')}`);
    console.log(`⏱️  Tick interval: ${tradingConfig.tickIntervalMs}ms`);

    // Create trading service
    const tradingService = new TradingService(
        {
            exchange,
            mlService,
            logger,
            state: stateStore,
            notifier,
            configManager
        },
        tradingConfig
    );

    const commandListener = CONFIG.TELEGRAM_COMMANDS_ENABLED && CONFIG.TELEGRAM_ALLOWED_CHAT_IDS.length > 0
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
                    getActiveSymbols: () => tradingConfig.symbols
                }),
                {
                    allowedChatIds: CONFIG.TELEGRAM_ALLOWED_CHAT_IDS
                }
            )
        })
        : null;

    if (CONFIG.TELEGRAM_COMMANDS_ENABLED && CONFIG.TELEGRAM_ALLOWED_CHAT_IDS.length === 0) {
        logger.warn('telegram_commands_disabled_no_allowed_chats', {});
    }

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n⚠️ Received SIGINT, stopping bot...');
        commandListener?.stop();
        tradingService.stop();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('\n⚠️ Received SIGTERM, stopping bot...');
        commandListener?.stop();
        tradingService.stop();
        process.exit(0);
    });

    // Start trading
    try {
        commandListener?.start();
        await tradingService.start();
    } catch (error) {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    }
}

// Run
main().catch(console.error);
