/**
 * Main Entry Point
 * 
 * Wires up infrastructure adapters and starts the trading bot.
 * 
 * Hexagonal Architecture:
 * - Domain: Business logic (PhantomStrategy, ProfitGuardian)
 * - Application: Use cases (TradingService)
 * - Infrastructure: Adapters (Binance, Telegram, ML, Logger, State)
 */

import { BinanceExchange } from './infra/adapters/BinanceAdapter';
import { TelegramService } from './infra/adapters/TelegramAdapter';
import { FsLogger } from './infra/logging/FsLogger';
import { FsStateStore } from './infra/logging/FsStateStore';
import { MlProbabilityServiceClient } from './infra/adapters/PhantomMLAdapter';
import { NinjaConfigManager } from './infra/config/ConfigLoader';  // ← NEW
import { TradingService, TradingServiceConfig } from './app/services/TradingService';
import { DEFAULT_PHANTOM_CONFIG } from './domain/services/PhantomStrategy';
import { DEFAULT_GUARDIAN_CONFIG } from './domain/services/ProfitGuardian';
import { MLService } from './app/ports/MLService';
import { PhantomSignal } from './domain/services/PhantomStrategy';
import { Notifier } from './app/ports/Notifier';

// ═══════════════════════════════════════════════════════════════════════════
// ADAPTER WRAPPERS (to match port interfaces)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * MLService adapter wrapper
 */
class PhantomMLService implements MLService {
    private client = new MlProbabilityServiceClient();

    async getSignal(symbol: string): Promise<PhantomSignal> {
        const result = await this.client.fetchProbabilities({ symbol });

        let action: 'LONG' | 'SHORT' | 'PASS' = 'PASS';
        let confidence = 0;

        if (result.long_prob > 0.5) {
            action = 'LONG';
            confidence = result.long_prob;
        } else if (result.short_prob > 0.5) {
            action = 'SHORT';
            confidence = result.short_prob;
        }

        return {
            symbol,
            action,
            confidence,
            longProb: result.long_prob,
            shortProb: result.short_prob,
            neutralProb: result.neutral_prob,
            smart_leverage: result.smart_leverage, // Forward to Service
            features: result.features
        };
    }

    async getExitSignal(payload: any) {
        return this.client.getExitSignal(payload);
    }

    async checkHealth(): Promise<boolean> {
        return this.client.checkHealth();
    }
}

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
    console.log('🦅 PHANTOM Trading Bot - Hexagonal Architecture');
    console.log('================================================');

    // Create infrastructure adapters
    const logger = new FsLogger();
    const exchange = new BinanceExchange(logger);
    const stateStore = new FsStateStore('phantom_state.json');
    const mlService = new PhantomMLService();
    const notifier = new TelegramNotifier();
    const configManager = new NinjaConfigManager();  // ← NEW: Dynamic YAML config

    // Trading configuration (defaults, will be overridden by YAML per symbol)
    const tradingConfig: TradingServiceConfig = {
        symbols: configManager.getActiveSymbols().length > 0
            ? configManager.getActiveSymbols()
            : ['ETHUSDT'],
        phantomConfig: DEFAULT_PHANTOM_CONFIG,  // Default, YAML overrides per symbol
        guardianConfig: configManager.getGuardianConfig('PHANTOM'),
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
            configManager  // ← NEW: Pass config manager
        },
        tradingConfig
    );

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n⚠️ Received SIGINT, stopping bot...');
        tradingService.stop();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('\n⚠️ Received SIGTERM, stopping bot...');
        tradingService.stop();
        process.exit(0);
    });

    // Start trading
    try {
        await tradingService.start();
    } catch (error) {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    }
}

// Run
main().catch(console.error);
