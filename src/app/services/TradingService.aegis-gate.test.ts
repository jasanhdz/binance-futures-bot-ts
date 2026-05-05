import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../../infra/config/environment';
import { PhantomSignal } from '../../domain/services/PhantomStrategy';
import { TradingService } from './TradingService';

const originalConfig = {
    TRADING_MODE: CONFIG.TRADING_MODE,
    AEGIS_LIVE_ENABLED: CONFIG.AEGIS_LIVE_ENABLED,
    AEGIS_TURBO_ALLOW_SHORT: CONFIG.AEGIS_TURBO_ALLOW_SHORT,
    AEGIS_TURBO_MIN_SCORE: CONFIG.AEGIS_TURBO_MIN_SCORE,
    AEGIS_TURBO_LEVERAGE: CONFIG.AEGIS_TURBO_LEVERAGE,
    AEGIS_TURBO_POSITION_FRACTION: CONFIG.AEGIS_TURBO_POSITION_FRACTION,
    AEGIS_TURBO_MAX_TRADES_PER_DAY: CONFIG.AEGIS_TURBO_MAX_TRADES_PER_DAY,
    AEGIS_TURBO_DAILY_LOSS_STOP_PCT: CONFIG.AEGIS_TURBO_DAILY_LOSS_STOP_PCT,
    AEGIS_TURBO_MAX_CONSECUTIVE_LOSSES: CONFIG.AEGIS_TURBO_MAX_CONSECUTIVE_LOSSES
};

function setAegisTurboConfig(liveEnabled: boolean): void {
    (CONFIG as any).TRADING_MODE = 'AEGIS_TURBO_MICRO_LIVE';
    (CONFIG as any).AEGIS_LIVE_ENABLED = liveEnabled;
    (CONFIG as any).AEGIS_TURBO_ALLOW_SHORT = false;
    (CONFIG as any).AEGIS_TURBO_MIN_SCORE = 0.60;
    (CONFIG as any).AEGIS_TURBO_LEVERAGE = 15;
    (CONFIG as any).AEGIS_TURBO_POSITION_FRACTION = 0.10;
    (CONFIG as any).AEGIS_TURBO_MAX_TRADES_PER_DAY = 2;
    (CONFIG as any).AEGIS_TURBO_DAILY_LOSS_STOP_PCT = 0.10;
    (CONFIG as any).AEGIS_TURBO_MAX_CONSECUTIVE_LOSSES = 2;
}

function restoreConfig(): void {
    Object.assign(CONFIG as any, originalConfig);
}

function validTurboSignal(): PhantomSignal {
    return {
        symbol: 'ETHUSDT',
        action: 'PASS',
        confidence: 0,
        longProb: 0.72,
        shortProb: 0.12,
        neutralProb: 0.16,
        metadata: {
            aegis: {
                turbo: {
                    raw: {
                        action: 'LONG',
                        would_execute: true,
                        turbo_score: 0.72,
                        leverage_suggestion: 25,
                        position_fraction: 0.18,
                        votes: { long: 2, short: 0, neutral: 1 },
                        reason: 'raw_long_agreement'
                    },
                    gated: {
                        action: 'HOLD',
                        would_execute: false,
                        reason: 'safe_regime_block',
                        blocked_by: 'safe_regime'
                    },
                    stop_roe: -0.15,
                    take_profit_roe: 0.25,
                    trailing_activation_roe: 0.15,
                    trailing_callback_roe: 0.08
                }
            }
        }
    };
}

function makeHarness(signal: PhantomSignal) {
    const exchange = {
        getUSDTBalance: vi.fn(),
        setLeverage: vi.fn(),
        ensureMarginType: vi.fn(),
        marketOpen: vi.fn(),
        placeStopClose: vi.fn(),
        placeTpClose: vi.fn(),
        getSymbolFilters: vi.fn(),
        getLastCandle: vi.fn(),
        getServerTime: vi.fn(),
        subscribeToCandles: vi.fn()
    };
    const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
    };
    const state = {
        get: vi.fn(() => ({ mode: 'IDLE' as const, currentRegime: 'PHANTOM' as const })),
        set: vi.fn(),
        reset: vi.fn()
    };
    const mlService = {
        getSignal: vi.fn().mockResolvedValue(signal),
        getExitSignal: vi.fn(),
        checkHealth: vi.fn()
    };
    const service = new TradingService(
        {
            exchange: exchange as any,
            mlService: mlService as any,
            logger,
            state,
            notifier: { sendMessage: vi.fn(), sendAlert: vi.fn() },
            configManager: {} as any
        },
        {
            symbols: ['ETHUSDT'],
            tickIntervalMs: 0,
            maxTradesPerDay: 100,
            tradingMode: 'AEGIS_TURBO_MICRO_LIVE'
        }
    );

    return { exchange, logger, mlService, service, state };
}

describe('TradingService Aegis micro-live gate dry-run', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAegisTurboConfig(false);
    });

    afterEach(() => {
        restoreConfig();
    });

    it('denies in AEGIS_TURBO_MICRO_LIVE when AEGIS_LIVE_ENABLED=false without execution calls', async () => {
        setAegisTurboConfig(false);
        const { exchange, logger, mlService, service, state } = makeHarness(validTurboSignal());

        await service.tick('ETHUSDT');

        expect(mlService.getSignal).toHaveBeenCalledWith('ETHUSDT');
        expect(logger.info).toHaveBeenCalledWith('aegis_scan', expect.objectContaining({
            symbol: 'ETHUSDT',
            turboRawAction: 'LONG',
            turboRawScore: 0.72,
            turboRawWouldExecute: true
        }));
        expect(logger.info).toHaveBeenCalledWith('aegis_micro_live_gate_denied', expect.objectContaining({
            symbol: 'ETHUSDT',
            reason: 'aegis_live_disabled',
            turboScore: 0.72,
            liveEnabled: false,
            tradingMode: 'AEGIS_TURBO_MICRO_LIVE',
            gatedReason: 'safe_regime_block',
            gatedBlockedBy: 'safe_regime'
        }));
        expect(exchange.getUSDTBalance).not.toHaveBeenCalled();
        expect(exchange.setLeverage).not.toHaveBeenCalled();
        expect(exchange.ensureMarginType).not.toHaveBeenCalled();
        expect(exchange.marketOpen).not.toHaveBeenCalled();
        expect(exchange.placeStopClose).not.toHaveBeenCalled();
        expect(exchange.placeTpClose).not.toHaveBeenCalled();
        expect(state.set).not.toHaveBeenCalled();
    });

    it('logs allowed dry-run when AEGIS_LIVE_ENABLED=true and signal passes, without execution calls', async () => {
        setAegisTurboConfig(true);
        const { exchange, logger, service, state } = makeHarness(validTurboSignal());

        await service.tick('ETHUSDT');

        expect(logger.warn).toHaveBeenCalledWith('aegis_micro_live_gate_allowed_dry_run', expect.objectContaining({
            symbol: 'ETHUSDT',
            side: 'LONG',
            leverage: 15,
            positionFraction: 0.10,
            stopRoe: -0.15,
            takeProfitRoe: 0.25,
            trailingActivationRoe: 0.15,
            trailingCallbackRoe: 0.08,
            turboScore: 0.72,
            votes: { long: 2, short: 0, neutral: 1 },
            rawReason: 'raw_long_agreement',
            gatedReason: 'safe_regime_block',
            gatedBlockedBy: 'safe_regime',
            dryRun: true,
            message: 'Gate allowed but execution is intentionally disabled in Phase 3'
        }));
        expect(exchange.getUSDTBalance).not.toHaveBeenCalled();
        expect(exchange.setLeverage).not.toHaveBeenCalled();
        expect(exchange.ensureMarginType).not.toHaveBeenCalled();
        expect(exchange.marketOpen).not.toHaveBeenCalled();
        expect(exchange.placeStopClose).not.toHaveBeenCalled();
        expect(exchange.placeTpClose).not.toHaveBeenCalled();
        expect(state.set).not.toHaveBeenCalled();
    });
});
