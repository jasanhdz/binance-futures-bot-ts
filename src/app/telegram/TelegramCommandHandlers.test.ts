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

function predictionWithEntryQuality(symbol = 'ETHUSDT') {
    const base = prediction(symbol);
    return {
        ...base,
        aegis: {
            ...base.aegis,
            entry_quality_model: {
                mode: 'SHADOW',
                execute: false,
                production_allowed: false,
                entry_quality_score: 0.64,
                tail_risk_score: 0.37,
                recommendation: 'ALLOW_SHADOW'
            }
        }
    };
}

function predictionWithEventRiskAuto(symbol = 'ETHUSDT') {
    const base = prediction(symbol);
    return {
        ...base,
        aegis: {
            ...base.aegis,
            event_risk_auto: {
                mode: 'SHADOW',
                suggested_mode: 'CAUTION',
                confidence: 0.72,
                reasons: ['btc_weak_or_hold'],
                execute: false,
                production_allowed: false,
                does_not_change_event_risk_mode: true
            }
        }
    };
}

function predictionWithDecisionBrain(symbol = 'ETHUSDT') {
    const base = prediction(symbol);
    return {
        ...base,
        aegis: {
            ...base.aegis,
            decision_brain: {
                mode: 'SHADOW',
                status: 'RESEARCH_CANDIDATE_NOT_LIVE',
                model_version: 'v010',
                decision: 'DO_NOT_ENTER',
                enter_now_prob: 0.18,
                wait_confirmation_prob: 0.22,
                manual_only_prob: 0.08,
                do_not_enter_prob: 0.52,
                recommendation: 'DO_NOT_ENTER_SHADOW',
                execute: false,
                production_allowed: false
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
        })),
        getAegisPortfolioRiskConfig: vi.fn(() => overrides.portfolioRisk ?? {
            enabled: false
        }),
        getAegisShortGateConfig: vi.fn(() => overrides.shortGate ?? {
            enabled: true,
            mode: 'PREMIUM_ONLY',
            min_score: 0.80,
            require_votes: 3,
            position_fraction_multiplier: 1.0,
            max_leverage: 10,
            block_symbols: [],
            allow_if_regime_bearish: false
        }),
        getAegisEventRiskConfig: vi.fn(() => overrides.eventRisk ?? {
            enabled: true,
            mode: 'NORMAL',
            enforce: false,
            manual_override_enabled: true,
            caution: {
                min_quality_score: 0.65,
                max_tail_risk_score: 0.45,
                require_btc_eth_confirmation: true
            },
            risk_off: {
                min_quality_score: 0.75,
                max_tail_risk_score: 0.35,
                allow_only_a_plus: true
            },
            manual_only: {
                block_new_entries: false
            }
        }),
        setAegisEventRiskMode: vi.fn((mode: string) => ({
            ...(overrides.eventRisk ?? {
                enabled: true,
                enforce: false,
                manual_override_enabled: true,
                caution: {
                    min_quality_score: 0.65,
                    max_tail_risk_score: 0.45,
                    require_btc_eth_confirmation: true
                },
                risk_off: {
                    min_quality_score: 0.75,
                    max_tail_risk_score: 0.35,
                    allow_only_a_plus: true
                },
                manual_only: {
                    block_new_entries: false
                }
            }),
            mode
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
    return { handlers, exchange, mlService, state, configManager, logger };
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

    it('/signal shows entry quality model when present', async () => {
        const { handlers, mlService } = makeHandlers();
        mlService.getAegisPrediction.mockResolvedValueOnce(predictionWithEntryQuality('ETHUSDT'));

        const text = await handlers.handleSignal('ETHUSDT');

        expect(text).toContain('EQ: **64.0%**');
        expect(text).toContain('Tail: **37.0%**');
        expect(text).toContain('Rec: **ALLOW_SHADOW**');
    });

    it('/signal shows event risk auto when present', async () => {
        const { handlers, mlService } = makeHandlers();
        mlService.getAegisPrediction.mockResolvedValueOnce(predictionWithEventRiskAuto('ETHUSDT'));

        const text = await handlers.handleSignal('ETHUSDT');

        expect(text).toContain('EventRisk: **CAUTION**');
        expect(text).toContain('72.0%');
        expect(text).toContain('btc_weak_or_hold');
    });

    it('/signal shows decision brain when present', async () => {
        const { handlers, mlService } = makeHandlers();
        mlService.getAegisPrediction.mockResolvedValueOnce(predictionWithDecisionBrain('ETHUSDT'));

        const text = await handlers.handleSignal('ETHUSDT');

        expect(text).toContain('DecisionBrain: **DO_NOT_ENTER**');
        expect(text).toContain('52.0%');
        expect(text).toContain('Enter 18.0%');
        expect(text).toContain('Wait 22.0%');
        expect(text).toContain('Manual 8.0%');
    });

    it('/signals supports multiple symbols', async () => {
        const { handlers } = makeHandlers({ symbols: ['ETHUSDT', 'BTCUSDT'] });

        const text = await handlers.handleSignals();

        expect(text).toContain('ETHUSDT | LONG | score 63.2%');
        expect(text).toContain('BTCUSDT | LONG | score 28.4%');
    });

    it('/signals does not break when entry quality model is missing', async () => {
        const { handlers } = makeHandlers({ symbols: ['ETHUSDT'] });

        const text = await handlers.handleSignals();

        expect(text).toContain('ETHUSDT | LONG | score 63.2%');
        expect(text).not.toContain('EQ N/D');
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

    it('/risk shows portfolio risk OFF', async () => {
        const { handlers } = makeHandlers();

        const text = await handlers.handleRisk();

        expect(text).toContain('Portfolio risk: **OFF**');
        expect(text).toContain('Open positions: **0**');
        expect(text).toContain('Event Risk: **NORMAL**');
        expect(text).toContain('enforce **No**');
    });

    it('/risk shows short gate', async () => {
        const { handlers } = makeHandlers();

        const text = await handlers.handleRisk();

        expect(text).toContain('Short gate: **PREMIUM_ONLY**');
        expect(text).toContain('min score **80.0%**');
        expect(text).toContain('votes **3/3**');
        expect(text).toContain('max lev **10x**');
        expect(text).toContain('size **1.00x**');
        expect(text).toContain('Short blocked: **Ninguno**');
    });

    it('/config shows short gate', async () => {
        const { handlers } = makeHandlers();

        const text = await handlers.handleConfig();

        expect(text).toContain('Short gate: **Sí** | PREMIUM_ONLY');
        expect(text).toContain('min score 80.0%');
        expect(text).toContain('size x1.00');
        expect(text).toContain('Short blocked: **Ninguno**');
        expect(text).toContain('Event Risk: **Sí** | mode **NORMAL**');
        expect(text).toContain('Event Risk rules: CAUTION');
    });

    it('/riskmode muestra Event Risk actual', async () => {
        const { handlers } = makeHandlers();

        const text = await handlers.handleRiskMode();

        expect(text).toContain('Event Risk Mode');
        expect(text).toContain('Mode: **NORMAL**');
        expect(text).toContain('Manual override: **Sí**');
    });

    it('/riskmode cambia modo y loggea cuando está autorizado por config', async () => {
        const { handlers, configManager, logger } = makeHandlers();

        const text = await handlers.handleRiskMode('RISK_OFF');

        expect(configManager.setAegisEventRiskMode).toHaveBeenCalledWith('RISK_OFF');
        expect(logger.warn).toHaveBeenCalledWith('EVENT_RISK_MODE_CHANGED', expect.objectContaining({
            previousMode: 'NORMAL',
            mode: 'RISK_OFF'
        }));
        expect(text).toContain('Nuevo: **RISK_OFF**');
    });

    it('/riskmode no cambia si manual override está desactivado', async () => {
        const { handlers, configManager } = makeHandlers({
            eventRisk: {
                enabled: true,
                mode: 'NORMAL',
                enforce: false,
                manual_override_enabled: false,
                caution: {
                    min_quality_score: 0.65,
                    max_tail_risk_score: 0.45,
                    require_btc_eth_confirmation: true
                },
                risk_off: {
                    min_quality_score: 0.75,
                    max_tail_risk_score: 0.35,
                    allow_only_a_plus: true
                },
                manual_only: {
                    block_new_entries: false
                }
            }
        });

        const text = await handlers.handleRiskMode('CAUTION');

        expect(configManager.setAegisEventRiskMode).not.toHaveBeenCalled();
        expect(text).toContain('manual override está desactivado');
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
