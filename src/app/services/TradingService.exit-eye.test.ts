import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../../infra/config/environment';
import { BotState, Side } from '../../domain/types';
import { AegisTradingSignal } from '../../domain/services/AegisStrategy';
import { TradingService } from './TradingService';

function oppositeSignal(action: 'LONG' | 'SHORT'): AegisTradingSignal {
    return {
        symbol: 'LINKUSDT',
        action: 'PASS',
        confidence: 0,
        source: 'AEGIS_TURBO',
        longProb: action === 'LONG' ? 0.70 : 0.10,
        shortProb: action === 'SHORT' ? 0.70 : 0.10,
        neutralProb: 0.20,
        metadata: {
            aegis: {
                turbo: {
                    action,
                    raw: {
                        action,
                        would_execute: true,
                        turbo_score: 0.72,
                        votes: action === 'SHORT' ? { long: 0, short: 2, neutral: 1 } : { long: 2, short: 0, neutral: 1 },
                        reason: 'raw_opposite_signal'
                    },
                    gated: {
                        action,
                        would_execute: true,
                        reason: 'gated_opposite_signal'
                    }
                }
            }
        }
    };
}

function neutralSignal(): AegisTradingSignal {
    return {
        symbol: 'LINKUSDT',
        action: 'PASS',
        confidence: 0,
        source: 'AEGIS_TURBO',
        longProb: 0.10,
        shortProb: 0.10,
        neutralProb: 0.80,
        metadata: {
            aegis: {
                turbo: {
                    action: 'HOLD',
                    raw: {
                        action: 'HOLD',
                        would_execute: false,
                        turbo_score: 0.58,
                        votes: { long: 0, short: 0, neutral: 3 },
                        reason: 'neutral_momentum_decay'
                    },
                    gated: {
                        action: 'HOLD',
                        would_execute: false,
                        reason: 'neutral_momentum_decay'
                    }
                }
            }
        }
    };
}

function makeHarness(options: {
    mode: 'SHADOW' | 'PROTECT' | 'CLOSE';
    currentRoe?: number;
    peakRoe?: number;
    side?: Side;
    closeOnNeutralDecay?: boolean;
    exitSignal?: AegisTradingSignal;
    stateOverrides?: Partial<BotState>;
}) {
    (CONFIG as any).TRADING_MODE = 'AEGIS_TURBO_MICRO_LIVE';
    (CONFIG as any).AEGIS_LIVE_ENABLED = true;
    const side = options.side ?? 'LONG';
    const entryPrice = 100;
    const leverage = 2;
    const currentRoe = options.currentRoe ?? 0.12;
    const markPrice = side === 'LONG'
        ? entryPrice * (1 + currentRoe / leverage)
        : entryPrice * (1 - currentRoe / leverage);
    let stateValue: BotState = {
        mode: side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE',
        lastSide: side,
        lastEntryPrice: entryPrice,
        lastLeverage: leverage,
        lastActualLeverage: leverage,
        lastEntryAt: Date.now() - 10 * 60 * 1000,
        lastEntryQty: 1,
        lastEntryMargin: 5,
        lastTradeId: 'trade-1',
        lastPeakPrice: side === 'LONG' ? 112 : 88,
        peakRoe: options.peakRoe ?? 0.20,
        lowestRoe: -0.02,
        lastAtrFetchedAt: Date.now(),
        lastAtrValue: 1,
        lastTrailingActivationRoe: 99,
        lastTrailingCallbackRoe: 0.08,
        posSideMode: side,
        ...options.stateOverrides
    };
    const state = {
        get: vi.fn(() => stateValue),
        set: vi.fn((patch: Partial<BotState>) => {
            stateValue = { ...stateValue, ...patch };
            return stateValue;
        }),
        reset: vi.fn()
    };
    const closeSideMarketSafe = vi.fn();
    const cancelStopOrdersForSide = vi.fn();
    const exchange = {
        readActivePosition: vi.fn(async () => ({
            sideMode: side,
            qtyAbs: 1,
            entryPrice,
            leverage
        })),
        getUSDTBalance: vi.fn(async () => 100),
        getMarkPrice: vi.fn(async () => markPrice),
        getLastCandle: vi.fn(async () => null),
        getServerTime: vi.fn(async () => Date.now()),
        getCandles: vi.fn(),
        getSymbolFilters: vi.fn(async () => ({
            tickSize: 0.01,
            stepSize: 0.001,
            pricePrecision: 2,
            qtyPrecision: 3,
            minNotional: 5
        })),
        placeStopClose: vi.fn(),
        placeTpClose: vi.fn(),
        closeSideMarketSafe,
        cancelStopOrdersForSide,
        listCloseOrdersForSide: vi.fn(async () => []),
        subscribeToCandles: vi.fn()
    };
    const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
    };
    const notifier = {
        sendMessage: vi.fn(),
        sendAlert: vi.fn()
    };
    const historyLogger = {
        logSignal: vi.fn(),
        logTradeOpen: vi.fn(),
        logTradeClose: vi.fn(),
        logTradeEvent: vi.fn(),
        logAccountSnapshot: vi.fn()
    };
    const mlService = {
        getSignal: vi.fn(async () => options.exitSignal ?? oppositeSignal(side === 'LONG' ? 'SHORT' : 'LONG')),
        getExitSignal: vi.fn(),
        checkHealth: vi.fn()
    };
    const service = new TradingService({
        exchange: exchange as any,
        mlService: mlService as any,
        logger,
        state: state as any,
        notifier,
        historyLogger: historyLogger as any,
        configManager: {
            getSymbolMode: vi.fn(() => 'LIVE'),
            getLiveAegisSymbols: vi.fn(() => ['LINKUSDT']),
            getAegisTurboConfig: vi.fn(() => ({
                enabled: true,
                live_enabled: true,
                require_brackets: false
            })),
            getAegisExitEyeConfig: vi.fn(() => ({
                enabled: true,
                mode: options.mode,
                min_roe_to_protect: 0.08,
                min_peak_roe_to_protect: 0.12,
                min_giveback_from_peak_roe: 0.04,
                neutral_votes_to_protect: 2,
                opposite_votes_to_close: 2,
                min_roe_to_close_on_opposite: 0.06,
                min_peak_roe_to_close_on_opposite: 0.10,
                close_on_neutral_decay: options.closeOnNeutralDecay ?? false,
                neutral_close_votes: 3,
                min_roe_to_close_on_neutral: 0.08,
                min_peak_roe_to_close_on_neutral: 0.12,
                min_giveback_to_close_on_neutral: 0.04,
                require_consecutive_neutral_close: 2,
                require_consecutive_neutral: 2,
                require_consecutive_opposite: 1,
                min_minutes_in_trade: 3
            })),
            getRegimeConfig: vi.fn(() => ({
                leverage,
                hardStopRoe: -0.40,
                tpRoe: 0.50,
                entryThreshold: 0.60,
                maxHoldMs: 8 * 60 * 60 * 1000,
                trailingActivationRoe: 99,
                trailingCallbackRoe: 0.08
            })),
            getGuardianConfig: vi.fn(() => ({
                beTriggerRoe: 99,
                beOffsetPct: 0.003,
                trailingDev: 0.015,
                trailingActivationRoe: 99,
                trailingCallbackRoe: 0.08,
                useAtrTrailing: true,
                atrMultiplier: 1.5
            })),
            trading: { fee_buffer_pct: 0.03 }
        } as any
    }, {
        symbols: ['LINKUSDT'],
        tickIntervalMs: 0,
        maxTradesPerDay: 100,
        tradingMode: 'AEGIS_TURBO_MICRO_LIVE'
    });

    return { service, exchange, historyLogger, logger, mlService, notifier, state };
}

describe('TradingService Aegis Exit Eye', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('in SHADOW mode detects opposite but does not close', async () => {
        const { service, exchange, historyLogger } = makeHarness({ mode: 'SHADOW' });

        await service.tick('LINKUSDT');

        expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
        expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
            event: 'AEGIS_EXIT_EYE_SHADOW_CLOSE'
        }));
    });

    it('in CLOSE mode closes on opposite signal with positive ROE', async () => {
        const { service, exchange, historyLogger } = makeHarness({ mode: 'CLOSE', currentRoe: 0.12 });

        await service.tick('LINKUSDT');

        expect(exchange.closeSideMarketSafe).toHaveBeenCalledWith(
            'LINKUSDT',
            'LONG',
            1,
            'LONG',
            'AEGIS_EXIT_EYE_OPPOSITE_SIGNAL'
        );
        expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
            event: 'AEGIS_EXIT_EYE_CLOSE_POSITION'
        }));
    });

    it('in CLOSE mode does not close when ROE is negative', async () => {
        const { service, exchange, historyLogger } = makeHarness({ mode: 'CLOSE', currentRoe: -0.02 });

        await service.tick('LINKUSDT');

        expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
        expect(historyLogger.logTradeEvent).not.toHaveBeenCalledWith(expect.objectContaining({
            event: 'AEGIS_EXIT_EYE_CLOSE_POSITION'
        }));
    });

    it('in PROTECT mode without safe stop move helper does not close or cancel brackets', async () => {
        const { service, exchange, historyLogger } = makeHarness({ mode: 'PROTECT', currentRoe: 0.12 });

        await service.tick('LINKUSDT');

        expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
        expect(exchange.cancelStopOrdersForSide).not.toHaveBeenCalled();
        expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
            event: 'AEGIS_EXIT_EYE_PROTECT_PROFIT'
        }));
    });

    it('in CLOSE mode does not close neutral decay when config forbids it', async () => {
        const { service, exchange, historyLogger } = makeHarness({
            mode: 'CLOSE',
            currentRoe: 0.0887,
            peakRoe: 0.1405,
            exitSignal: neutralSignal(),
            closeOnNeutralDecay: false,
            stateOverrides: {
                exitEyeNeutralCount: 1,
                exitEyeNeutralCloseCount: 1
            }
        });

        await service.tick('LINKUSDT');

        expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
        expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
            event: 'AEGIS_EXIT_EYE_PROTECT_PROFIT',
            reason: 'neutral_momentum_decay_profit_protection'
        }));
    });

    it('in CLOSE mode closes neutral decay when config explicitly allows it', async () => {
        const { service, exchange, historyLogger, notifier, state } = makeHarness({
            mode: 'CLOSE',
            currentRoe: 0.0887,
            peakRoe: 0.1405,
            exitSignal: neutralSignal(),
            closeOnNeutralDecay: true,
            stateOverrides: {
                exitEyeNeutralCount: 1,
                exitEyeNeutralCloseCount: 1
            }
        });

        await service.tick('LINKUSDT');

        expect(exchange.closeSideMarketSafe).toHaveBeenCalledWith(
            'LINKUSDT',
            'LONG',
            1,
            'LONG',
            'AEGIS_EXIT_EYE_NEUTRAL_DECAY'
        );
        expect(state.set).toHaveBeenCalledWith(expect.objectContaining({
            mode: 'IDLE',
            lastExitReason: 'AEGIS_EXIT_EYE_NEUTRAL_DECAY'
        }));
        expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
            event: 'AEGIS_EXIT_EYE_CLOSE_POSITION',
            reason: 'neutral_momentum_decay_profit_exit'
        }));
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Cierre por pérdida de momentum'));
    });

    it('logs history event metadata for Exit Eye decisions', async () => {
        const { service, historyLogger } = makeHarness({ mode: 'SHADOW' });

        await service.tick('LINKUSDT');

        expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
            event: 'AEGIS_EXIT_EYE_SHADOW_CLOSE',
            metadata: expect.objectContaining({
                decision: expect.objectContaining({ action: 'SHADOW_CLOSE' }),
                currentRoe: expect.any(Number),
                peakRoe: expect.any(Number),
                votes: { long: 0, short: 2, neutral: 1 },
                reason: 'opposite_signal_profit_exit'
            })
        }));
    });
});
