import { describe, expect, it, vi } from 'vitest';
import { TelegramCommandHandlers } from './TelegramCommandHandlers';

function prediction(symbol = 'ETHUSDT', score = 0.632, reason = 'rawrecentlongagreement2of3') {
    return {
        symbol,
        long_prob: 0,
        short_prob: 0,
        neutral_prob: 1,
        aegis: {
            prod: { allowed: true, execute: false },
            turbo: {
                execute: false,
                production_allowed: true,
                raw: {
                    action: 'LONG',
                    would_execute: true,
                    turbo_score: score,
                    votes: { long: 2, short: 0, neutral: 1 },
                    reason,
                    freshness: { is_fresh: true, feature_timestamp: '2026-05-07T00:00:00.000Z' }
                },
                gated: {
                    action: 'LONG',
                    would_execute: true,
                    reason
                }
            }
        }
    };
}

function makeHandlers(overrides: Record<string, any> = {}) {
    const symbolModes = overrides.symbolModes ?? Object.fromEntries((overrides.symbols ?? ['ETHUSDT']).map((symbol: string) => [symbol, 'LIVE']));
    const exchange = {
        getUSDTBalance: vi.fn().mockResolvedValue(500),
        getUSDTAccountSnapshot: vi.fn().mockResolvedValue(overrides.accountSnapshot ?? {}),
        readActivePosition: vi.fn().mockResolvedValue(null),
        getMarkPrice: vi.fn().mockResolvedValue(3000),
        listCloseOrdersForSide: vi.fn().mockResolvedValue([]),
        placeStopClose: vi.fn(),
        placeTpClose: vi.fn()
    };
    const mlService = {
        getAegisPrediction: vi.fn(async (symbol: string) => prediction(symbol, symbol === 'BTCUSDT' ? 0.284 : 0.632)),
        getSignal: vi.fn(),
        getExitSignal: vi.fn(),
        checkHealth: vi.fn().mockResolvedValue(true)
    };
    const state = {
        get: vi.fn(() => overrides.state ?? { mode: 'IDLE', currentRegime: 'AEGIS_TURBO' }),
        set: vi.fn(),
        reset: vi.fn()
    };
    const configManager = {
        getActiveSymbols: vi.fn(() => overrides.symbols ?? ['ETHUSDT']),
        getAegisSymbolConfigs: vi.fn(() => Object.fromEntries(Object.entries(symbolModes).map(([symbol, mode]) => [
            symbol,
            { symbol, enabled: mode !== 'OFF', mode }
        ]))),
        getActiveAegisSymbols: vi.fn(() => Object.entries(symbolModes).filter(([, mode]) => mode !== 'OFF').map(([symbol]) => symbol)),
        getSymbolMode: vi.fn((symbol: string) => symbolModes[symbol] ?? 'SHADOW'),
        getRegimeConfig: vi.fn(() => ({
            leverage: 20,
            entryThreshold: 0.60,
            hardStopRoe: -0.40,
            tpRoe: 0.50,
            maxHoldMs: 8 * 60 * 60 * 1000,
            trailingActivationRoe: 0.15,
            trailingCallbackRoe: 0.08
        })),
        getAegisTurboConfig: vi.fn(() => ({
            enabled: true,
            live_enabled: true,
            allow_short: false,
            position_fraction_cap: 1,
            max_trades_per_day: 1,
            max_consecutive_losses: 2,
            daily_loss_stop_pct: 0.10,
            min_cooldown_ms: 15 * 60 * 1000,
            require_brackets: true,
            close_if_bracket_fails: true
        }))
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const handlers = new TelegramCommandHandlers({
        exchange: exchange as any,
        mlService: mlService as any,
        state: state as any,
        configManager: configManager as any,
        logger,
        tradingMode: 'AEGIS_TURBO_MICRO_LIVE',
        liveEnabled: true,
        getRuntimeSnapshot: () => ({
            tradingMode: 'AEGIS_TURBO_MICRO_LIVE',
            isRunning: true,
            tradesToday: 0,
            consecutiveLosses: 0,
            dailyPnlPct: undefined,
            dailyStartBalance: null,
            liquidityStressBySymbol: {}
        }),
        getActiveSymbols: () => overrides.symbols ?? ['ETHUSDT']
    });
    return { handlers, exchange, mlService, state, configManager };
}

describe('TelegramCommandHandlers', () => {
    const massShadowSymbols = [
        'BTCUSDT',
        'SOLUSDT',
        'BNBUSDT',
        'XRPUSDT',
        'DOGEUSDT',
        'ADAUSDT',
        'AVAXUSDT',
        'LINKUSDT',
        'SUIUSDT',
        'LTCUSDT'
    ];

    it('/signal ETHUSDT calls ML and formats reason', async () => {
        const { handlers, mlService } = makeHandlers();

        const text = await handlers.handleSignal('ETHUSDT');

        expect(mlService.getAegisPrediction).toHaveBeenCalledWith('ETHUSDT');
        expect(text).toContain('🎚️ Threshold: **60.0%**');
        expect(text).toContain('Acuerdo LONG reciente 2/3');
    });

    it('/signals supports multiple symbols', async () => {
        const { handlers } = makeHandlers({ symbols: ['ETHUSDT', 'BTCUSDT'] });

        const text = await handlers.handleSignals();

        expect(text).toContain('ETHUSDT | LONG | score 63.2%');
        expect(text).toContain('BTCUSDT | LONG | score 28.4%');
    });

    it('/signals lists LIVE and SHADOW symbols without scanning OFF symbols', async () => {
        const { handlers, mlService } = makeHandlers({
            symbolModes: { ETHUSDT: 'LIVE', BTCUSDT: 'SHADOW', SOLUSDT: 'OFF' }
        });

        const text = await handlers.handleSignals();

        expect(text).toContain('ETHUSDT | LONG');
        expect(text).toContain('BTCUSDT | LONG');
        expect(text).not.toContain('SOLUSDT');
        expect(mlService.getAegisPrediction).not.toHaveBeenCalledWith('SOLUSDT');
    });

    it('/signals handles one LIVE plus ten SHADOW onboarding symbols', async () => {
        const symbolModes = Object.fromEntries([
            ['ETHUSDT', 'LIVE'],
            ...massShadowSymbols.map((symbol) => [symbol, 'SHADOW'])
        ]);
        const { handlers, mlService } = makeHandlers({ symbolModes });

        const text = await handlers.handleSignals();

        expect(text).toContain('ETHUSDT | LONG');
        for (const symbol of massShadowSymbols) {
            expect(text).toContain(`${symbol} | LONG`);
            expect(mlService.getAegisPrediction).toHaveBeenCalledWith(symbol);
        }
        expect(mlService.getAegisPrediction).toHaveBeenCalledTimes(11);
    });

    it('/status shows configured symbol modes including OFF', async () => {
        const { handlers } = makeHandlers({
            symbolModes: { ETHUSDT: 'LIVE', BTCUSDT: 'SHADOW', SOLUSDT: 'OFF' }
        });

        const text = await handlers.handleStatus();

        expect(text).toContain('ETHUSDT LIVE');
        expect(text).toContain('BTCUSDT SHADOW');
        expect(text).toContain('SOLUSDT OFF');
    });

    it('/positions shows Ninguna when there are no active positions', async () => {
        const { handlers } = makeHandlers();

        await expect(handlers.handlePositions()).resolves.toContain('🟢 **Ninguna**');
    });

    it('/config shows threshold from REGIMES.AEGIS_TURBO', async () => {
        const { handlers } = makeHandlers();

        const text = await handlers.handleConfig();

        expect(text).toContain('🎚️ Entry threshold: **60.0%**');
        expect(text).toContain('⚖️ Leverage: **20x**');
    });

    it('/account handles missing fields as N/D', async () => {
        const { handlers } = makeHandlers({ accountSnapshot: { walletBalance: 500 } });

        const text = await handlers.handleAccount();

        expect(text).toContain('👛 Wallet: **$500.00 USDT**');
        expect(text).toContain('🏦 Equity total: **N/D**');
        expect(text).toContain('💵 Disponible: **N/D**');
    });

    it('/brackets does not modify orders', async () => {
        const { handlers, exchange } = makeHandlers();

        await handlers.handleBrackets();

        expect(exchange.placeStopClose).not.toHaveBeenCalled();
        expect(exchange.placeTpClose).not.toHaveBeenCalled();
    });

    it('/status handles Aegis API failure without throwing', async () => {
        const { handlers, mlService } = makeHandlers();
        mlService.checkHealth.mockRejectedValueOnce(new Error('down'));
        mlService.getAegisPrediction.mockRejectedValueOnce(new Error('down'));

        const text = await handlers.handleStatus();

        expect(text).toContain('🧠 Aegis API: **ERROR**');
        expect(text).toContain('🛰️ Última señal: **ERROR**');
    });
});
