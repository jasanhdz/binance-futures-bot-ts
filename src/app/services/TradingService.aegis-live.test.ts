import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../../infra/config/environment';
import { AegisTradingSignal } from '../../domain/services/AegisStrategy';
import { TradingService } from './TradingService';

const originalConfig = { ...CONFIG };

function setConfig(liveEnabled: boolean): void {
    (CONFIG as any).TRADING_MODE = 'AEGIS_TURBO_MICRO_LIVE';
    (CONFIG as any).AEGIS_LIVE_ENABLED = liveEnabled;
    (CONFIG as any).AEGIS_TURBO_ALLOW_SHORT = false;
    (CONFIG as any).AEGIS_TURBO_MIN_SCORE = 0.60;
    (CONFIG as any).AEGIS_TURBO_LEVERAGE = 20;
    (CONFIG as any).AEGIS_TURBO_POSITION_FRACTION = 1.0;
    (CONFIG as any).AEGIS_TURBO_MAX_TRADES_PER_DAY = 2;
    (CONFIG as any).AEGIS_TURBO_DAILY_LOSS_STOP_PCT = 0.10;
    (CONFIG as any).AEGIS_TURBO_MAX_CONSECUTIVE_LOSSES = 2;
}

function restoreConfig(): void {
    Object.assign(CONFIG as any, originalConfig);
}

function yamlTurbo(overrides: Record<string, unknown> = {}) {
    return {
        enabled: true,
        live_enabled: true,
        allow_short: false,
        position_fraction_cap: 1.0,
        max_trades_per_day: 1,
        max_consecutive_losses: 1,
        daily_loss_stop_pct: 0.10,
        min_cooldown_ms: 15 * 60 * 1000,
        max_liquidity_stress: 0.70,
        require_brackets: true,
        close_if_bracket_fails: true,
        ...overrides
    };
}

function regimeConfig(overrides: Record<string, unknown> = {}) {
    return {
        leverage: 20,
        hardStopRoe: -0.15,
        tpRoe: 0.25,
        entryThreshold: 0.60,
        maxHoldMs: 8 * 60 * 60 * 1000,
        beRoe: 0.08,
        trailingActivationRoe: 0.15,
        trailingCallbackRoe: 0.08,
        ...overrides
    };
}

function validSignal(): AegisTradingSignal {
    return {
        symbol: 'ETHUSDT',
        action: 'PASS',
        confidence: 0,
        source: 'AEGIS_TURBO',
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
                        action: 'LONG',
                        would_execute: true,
                        reason: 'raw_long_agreement',
                        blocked_by: null
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

function makeHarness(options: {
    liveEnabled?: boolean;
    yaml?: any;
	    symbols?: string[];
	    symbolModes?: Record<string, 'OFF' | 'SHADOW' | 'LIVE'>;
	    closeOrders?: any[];
	    balance?: number;
	    readActivePosition?: any;
	    readActivePositionSequence?: any[];
	    placeStopCloseReject?: boolean;
	    placeTpCloseReject?: boolean;
	    closeSideMarketSafeReject?: boolean;
	    markPrice?: number;
        lastCandle?: any;
	    initialState?: any;
	    symbolStates?: Record<string, any>;
	    accountSnapshot?: any;
        regime?: any;
        guardian?: any;
	} = {}) {
    setConfig(options.liveEnabled ?? true);
    const closeOrders = options.closeOrders ?? [
        { orderId: 'sl', type: 'STOP_MARKET', stopPrice: 2977.5 },
        { orderId: 'tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 3037.5 }
    ];
    const position = options.readActivePosition ?? {
        sideMode: 'LONG',
        qtyAbs: 0.01,
        entryPrice: 3000,
        leverage: 20,
        isolatedMargin: 2
    };
	    const readActivePosition = vi.fn();
	    if (options.readActivePositionSequence) {
	        for (const value of options.readActivePositionSequence) {
	            readActivePosition.mockResolvedValueOnce(value);
	        }
	        readActivePosition.mockResolvedValue(options.readActivePositionSequence[options.readActivePositionSequence.length - 1] ?? null);
	    } else {
	        readActivePosition.mockResolvedValue(position);
	    }
	    const exchange = {
	        getUSDTBalance: vi.fn().mockResolvedValue(options.balance ?? 20),
        getUSDTAccountSnapshot: vi.fn().mockResolvedValue(options.accountSnapshot ?? {
            walletBalance: options.balance ?? 20,
            availableBalance: options.balance ?? 20,
            equityTotal: options.balance ?? 20
        }),
        getMarkPrice: vi.fn().mockResolvedValue(options.markPrice ?? 3000),
        getSymbolFilters: vi.fn().mockResolvedValue({ qtyPrecision: 3, pricePrecision: 2, minNotional: 5, tickSize: 0.01, stepSize: 0.001 }),
        setLeverage: vi.fn().mockResolvedValue(undefined),
        ensureMarginType: vi.fn().mockResolvedValue(undefined),
        marketOpen: vi.fn().mockResolvedValue({ avgPrice: 3000, orderId: 'entry-1' }),
	        readActivePosition,
	        placeStopClose: options.placeStopCloseReject
	            ? vi.fn().mockRejectedValue(new Error('stop failed'))
	            : vi.fn().mockResolvedValue(true),
	        placeTpClose: options.placeTpCloseReject
	            ? vi.fn().mockRejectedValue(new Error('tp failed'))
	            : vi.fn().mockResolvedValue(true),
	        listCloseOrdersForSide: vi.fn().mockResolvedValue(closeOrders),
        closeSideMarketSafe: options.closeSideMarketSafeReject
            ? vi.fn().mockRejectedValue(new Error('close failed'))
            : vi.fn().mockResolvedValue(undefined),
        cancelStopOrdersForSide: vi.fn().mockResolvedValue(undefined),
        hasOpenPosition: vi.fn().mockResolvedValue(false),
        getServerTime: vi.fn().mockResolvedValue(Date.now()),
        getLastCandle: vi.fn().mockResolvedValue(options.lastCandle ?? null),
        getCandles: vi.fn().mockResolvedValue([]),
        subscribeToCandles: vi.fn()
    };
    const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
    };
    let currentState: any = options.initialState ?? { mode: 'IDLE', currentRegime: 'AEGIS_TURBO', lastExitAt: Date.now() - 20 * 60 * 1000 };
    const state = {
        get: vi.fn(() => currentState),
        set: vi.fn((patch: any) => {
            currentState = { ...currentState, ...patch };
            return currentState;
        }),
        reset: vi.fn()
    } as any;
    const symbolStores = new Map<string, any>();
    if (options.symbolStates) {
        for (const [symbol, initial] of Object.entries(options.symbolStates)) {
            let scopedState: any = initial;
            symbolStores.set(symbol, {
                get: vi.fn(() => scopedState),
                set: vi.fn((patch: any) => {
                    scopedState = { ...scopedState, ...patch };
                    return scopedState;
                }),
                reset: vi.fn(() => {
                    scopedState = { mode: 'IDLE' };
                })
            });
        }
        state.forSymbol = vi.fn((symbol: string) => {
            if (!symbolStores.has(symbol)) {
                let scopedState: any = { mode: 'IDLE', currentRegime: 'AEGIS_TURBO', lastExitAt: Date.now() - 20 * 60 * 1000 };
                symbolStores.set(symbol, {
                    get: vi.fn(() => scopedState),
                    set: vi.fn((patch: any) => {
                        scopedState = { ...scopedState, ...patch };
                        return scopedState;
                    }),
                    reset: vi.fn(() => {
                        scopedState = { mode: 'IDLE' };
                    })
                });
            }
            return symbolStores.get(symbol);
        });
    }
    const notifier = { sendMessage: vi.fn(), sendAlert: vi.fn() };
    const symbolModes = options.symbolModes ?? { ETHUSDT: 'LIVE' as const };
    const configManager = {
        getAegisTurboConfig: vi.fn(() => options.yaml ?? yamlTurbo()),
        getRegimeConfig: vi.fn(() => options.regime ?? regimeConfig()),
        getGuardianConfig: vi.fn(() => options.guardian ?? {
            beTriggerRoe: (options.regime ?? regimeConfig()).beRoe ?? 0.10,
            beOffsetPct: 0.003,
            trailingDev: 0.015,
            trailingActivationRoe: (options.regime ?? regimeConfig()).trailingActivationRoe ?? 0.15,
            trailingCallbackRoe: (options.regime ?? regimeConfig()).trailingCallbackRoe ?? 0.08,
            useAtrTrailing: true,
            atrMultiplier: 1.5
        }),
        getSymbolMode: vi.fn((symbol: string) => symbolModes[symbol] ?? 'SHADOW'),
        getLiveAegisSymbols: vi.fn(() => Object.entries(symbolModes).filter(([, mode]) => mode === 'LIVE').map(([symbol]) => symbol)),
        getActiveAegisSymbols: vi.fn(() => Object.entries(symbolModes).filter(([, mode]) => mode !== 'OFF').map(([symbol]) => symbol)),
        validateSingleLiveAegisSymbol: vi.fn(),
        system: { enable_sentinel: false },
        trading: { fee_buffer_pct: 0.05 }
    };
    const historyLogger = {
        logSignal: vi.fn().mockResolvedValue(undefined),
        logTradeEvent: vi.fn().mockResolvedValue(undefined),
        logAccountSnapshot: vi.fn().mockResolvedValue(undefined),
        logTradeOpen: vi.fn().mockResolvedValue(undefined),
        logTradeClose: vi.fn().mockResolvedValue(undefined)
    };
    const service = new TradingService(
        {
            exchange: exchange as any,
            mlService: {
                getSignal: vi.fn().mockResolvedValue(validSignal()),
                getExitSignal: vi.fn(),
                checkHealth: vi.fn()
            },
            logger,
            state,
            notifier,
            configManager: configManager as any,
            historyLogger: historyLogger as any
        },
        {
            symbols: options.symbols ?? ['ETHUSDT'],
            tickIntervalMs: 0,
            maxTradesPerDay: 100,
            tradingMode: 'AEGIS_TURBO_MICRO_LIVE'
        }
    );

	    return { exchange, historyLogger, logger, notifier, service, state, configManager, symbolStores };
	}

describe('TradingService Aegis live execution', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setConfig(true);
    });

    afterEach(() => {
        restoreConfig();
    });

    it('includes current wallet balance in the startup Telegram message', async () => {
        const { exchange, notifier, service } = makeHarness({ balance: 565.39 });

        await service.start(false);

        expect(exchange.getUSDTBalance).toHaveBeenCalled();
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('🔥 AEGIS TURBO MICRO-LIVE ✅'));
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('🧠 MICRO-LIVE | Live ON | Shorts OFF'));
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('💰 Wallet $565.39 | Equity $565.39 | Disp. $565.39'));
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('💼 Posiciones\nNinguna'));
    });

    it('includes approximate wallet balance with open unrealized PnL in the startup Telegram message', async () => {
        const { notifier, service } = makeHarness({
            balance: 500,
            markPrice: 2990,
            readActivePosition: {
                sideMode: 'LONG',
                qtyAbs: 0.01,
                entryPrice: 3000,
                leverage: 20,
                isolatedMargin: 65,
                unrealizedPnl: -10
            },
            initialState: {
                mode: 'LONG_RIDE',
                currentRegime: 'AEGIS_TURBO',
                lastSide: 'LONG',
                lastEntryPrice: 3000,
                lastEntryQty: 0.01,
                lastEntryMargin: 65,
                lastLeverage: 20,
                lastEntryAt: Date.now() - 30 * 60 * 1000
            }
        });

        await service.start(false);

        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('💰 Wallet $500.00 | Equity $500.00 | Disp. $500.00'));
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('💼 ETHUSDT LONG 📈'));
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('ROI -6.7% | PnL -$10.00 | 0.5h'));
    });

	    it('opens Aegis Turbo position with isolated margin and immediate brackets when env and YAML allow live', async () => {
	        const { exchange, logger, notifier, service, state } = makeHarness();

	        await service.tick('ETHUSDT');

        expect(exchange.setLeverage).toHaveBeenCalledWith('ETHUSDT', 20);
        expect(exchange.ensureMarginType).toHaveBeenCalledWith('ETHUSDT', 'ISOLATED');
        expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.022);
        expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 2977.5);
        expect(exchange.placeTpClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 3037.5);
	        expect(exchange.setLeverage.mock.invocationCallOrder[0]).toBeLessThan(exchange.marketOpen.mock.invocationCallOrder[0]);
	        expect(exchange.ensureMarginType.mock.invocationCallOrder[0]).toBeLessThan(exchange.marketOpen.mock.invocationCallOrder[0]);
	        expect(exchange.placeStopClose.mock.invocationCallOrder[0]).toBeLessThan(state.set.mock.invocationCallOrder[0]);
	        expect(exchange.placeTpClose.mock.invocationCallOrder[0]).toBeLessThan(state.set.mock.invocationCallOrder[0]);
	        expect(state.set).toHaveBeenCalledWith(expect.objectContaining({
	            currentRegime: 'AEGIS_TURBO',
	            lastStrategy: 'AEGIS_TURBO',
	            lastBracketStatus: 'OK',
            lastActualLeverage: 20,
            lastPositionFraction: 0.18,
            lastStopRoe: -0.15,
            lastTakeProfitRoe: 0.25,
            lastTrailingActivationRoe: 0.15,
            lastTrailingCallbackRoe: 0.08
        }));
        expect(logger.warn).toHaveBeenCalledWith('aegis_turbo_micro_live_entry', expect.objectContaining({
            symbol: 'ETHUSDT',
            side: 'LONG',
            leverage: 20,
            positionFraction: 0.18
	        }));
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('🔥 AEGIS TURBO ENTRY'));
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('ETHUSDT | 📈 LONG'));
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('SL: $2977.50 (-15.0% ROE)'));
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('TP: $3037.50 (+25.0% ROE)'));
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Score: 72.0% / 60.0%'));
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Equity total: $20.00'));
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('✅ Brackets confirmados'));
	    });

	    it('blocks before marketOpen when daily loss stop is reached', async () => {
	        const { exchange, logger, service, state } = makeHarness({ balance: 17.9 });
	        (service as any).dailyStartBalance = 20;

	        await service.tick('ETHUSDT');

	        expect(logger.info).toHaveBeenCalledWith('aegis_micro_live_gate_denied', expect.objectContaining({
	            reason: 'daily_loss_stop_reached',
	            balance: 17.9,
	            dailyStartBalance: 20,
	            dailyPnlPct: expect.any(Number),
	            dailyLossStopPct: 0.10
	        }));
	        expect(exchange.marketOpen).not.toHaveBeenCalled();
	        expect(exchange.setLeverage).not.toHaveBeenCalled();
	        expect(exchange.ensureMarginType).not.toHaveBeenCalled();
	        expect(state.set).not.toHaveBeenCalled();
	    });

	    it('allows entry flow when daily loss is inside the limit', async () => {
	        const { exchange, logger, service } = makeHarness({ balance: 19.2 });
	        (service as any).dailyStartBalance = 20;

	        await service.tick('ETHUSDT');

	        expect(logger.info).not.toHaveBeenCalledWith('aegis_micro_live_gate_denied', expect.objectContaining({
	            reason: 'daily_loss_stop_reached'
	        }));
	        expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.021);
	    });

    it('does not treat isolated margin usage as daily loss when equity is unchanged', async () => {
        const { exchange, logger, service } = makeHarness({
            balance: 15,
            accountSnapshot: {
                walletBalance: 20,
                availableBalance: 15,
                equityTotal: 20
            }
        });
        (service as any).dailyStartBalance = 20;

        await service.tick('ETHUSDT');

        expect(logger.info).not.toHaveBeenCalledWith('aegis_micro_live_gate_denied', expect.objectContaining({
            reason: 'daily_loss_stop_reached'
        }));
        expect(exchange.marketOpen).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.017);
    });

	    it('retries readActivePosition after marketOpen until the position is confirmed', async () => {
	        const position = {
	            sideMode: 'LONG',
	            qtyAbs: 0.01,
	            entryPrice: 3000,
	            leverage: 20,
	            isolatedMargin: 2
	        };
	        const { exchange, service } = makeHarness({
	            readActivePositionSequence: [null, null, position]
	        });

	        await service.tick('ETHUSDT');

	        expect(exchange.readActivePosition).toHaveBeenCalledTimes(3);
	        expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
	        expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 2977.5);
	        expect(exchange.placeTpClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 3037.5);
	    });

	    it('emergency closes when position cannot be verified after marketOpen', async () => {
	        const { exchange, logger, service, state } = makeHarness({
	            readActivePositionSequence: [null, null, null, null, null]
	        });

	        await service.tick('ETHUSDT');

	        expect(exchange.marketOpen).toHaveBeenCalled();
	        expect(exchange.readActivePosition).toHaveBeenCalledTimes(5);
	        expect(exchange.closeSideMarketSafe).toHaveBeenCalledWith(
	            'ETHUSDT',
	            'LONG',
	            0.022,
	            'BOTH',
	            'AEGIS_POSITION_VERIFY_FAILED'
	        );
	        expect(exchange.placeStopClose).not.toHaveBeenCalled();
	        expect(exchange.placeTpClose).not.toHaveBeenCalled();
	        expect(state.set).not.toHaveBeenCalledWith(expect.objectContaining({
	            currentRegime: 'AEGIS_TURBO'
	        }));
	        expect(logger.error).toHaveBeenCalledWith('aegis_position_verify_failed_after_market_open', expect.any(Object));
	    });

	    it('alerts if emergency close fails after verify failed', async () => {
	        const { exchange, logger, notifier, service, state } = makeHarness({
	            readActivePositionSequence: [null, null, null, null, null],
	            closeSideMarketSafeReject: true
	        });

	        await service.tick('ETHUSDT');

	        expect(exchange.marketOpen).toHaveBeenCalled();
	        expect(logger.error).toHaveBeenCalledWith('aegis_emergency_close_failed', expect.any(Object));
	        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('AEGIS EMERGENCY CLOSE FAILED'));
	        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('AEGIS_POSITION_VERIFY_FAILED'));
	        expect(state.set).not.toHaveBeenCalledWith(expect.objectContaining({
	            currentRegime: 'AEGIS_TURBO'
	        }));
	    });

    it('closes immediately when bracket validation fails', async () => {
        const { exchange, logger, service, state } = makeHarness({ closeOrders: [] });

        await service.tick('ETHUSDT');

        expect(exchange.closeSideMarketSafe).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.01, 'LONG', 'AEGIS_BRACKET_FAILED');
        expect(state.set).toHaveBeenCalledWith(expect.objectContaining({
            mode: 'IDLE',
            lastExitReason: 'AEGIS_BRACKET_FAILED',
            lastBracketStatus: 'FAILED_CLOSED'
        }));
        expect(logger.error).toHaveBeenCalledWith('aegis_bracket_validation_failed', expect.any(Object));
    });

    it('does not open when AEGIS_LIVE_ENABLED=false', async () => {
        const { exchange, logger, service } = makeHarness({ liveEnabled: false });

        await service.tick('ETHUSDT');

        expect(logger.info).toHaveBeenCalledWith('aegis_micro_live_gate_denied', expect.objectContaining({
            reason: 'aegis_live_disabled'
        }));
        expect(exchange.marketOpen).not.toHaveBeenCalled();
    });

    it('scans a SHADOW symbol without live exchange execution or state mutation', async () => {
        const { exchange, historyLogger, service, state } = makeHarness({
            symbols: ['ETHUSDT', 'BTCUSDT'],
            symbolModes: { ETHUSDT: 'LIVE', BTCUSDT: 'SHADOW' }
        });

        await service.tick('BTCUSDT');

        expect(exchange.marketOpen).not.toHaveBeenCalled();
        expect(exchange.setLeverage).not.toHaveBeenCalled();
        expect(exchange.ensureMarginType).not.toHaveBeenCalled();
        expect(state.set).not.toHaveBeenCalled();
        expect(historyLogger.logSignal).toHaveBeenCalledWith(expect.objectContaining({
            symbol: 'BTCUSDT',
            executed: false,
            metadata: expect.objectContaining({ shadow_only: true })
        }));
    });

    it('does not manage the global ETH BotState while scanning a SHADOW BTC symbol', async () => {
        const { exchange, service, state } = makeHarness({
            symbols: ['ETHUSDT', 'BTCUSDT'],
            symbolModes: { ETHUSDT: 'LIVE', BTCUSDT: 'SHADOW' },
            initialState: {
                mode: 'LONG_RIDE',
                currentRegime: 'AEGIS_TURBO',
                lastStrategy: 'AEGIS_TURBO',
                lastSide: 'LONG',
                lastEntryPrice: 3000,
                lastLeverage: 20,
                lastEntryAt: Date.now(),
                lastPeakPrice: 3000
            }
        });

        await service.tick('BTCUSDT');

        expect(exchange.readActivePosition).not.toHaveBeenCalledWith('BTCUSDT', 'LONG');
        expect(state.set).not.toHaveBeenCalledWith(expect.objectContaining({ mode: 'IDLE' }));
    });

    it('allows a LIVE BTC entry while ETH has its own active symbol state', async () => {
        const { exchange, logger, service } = makeHarness({
            symbols: ['ETHUSDT', 'BTCUSDT'],
            symbolModes: { ETHUSDT: 'LIVE', BTCUSDT: 'LIVE' },
            symbolStates: {
                ETHUSDT: {
                    mode: 'LONG_RIDE',
                    currentRegime: 'AEGIS_TURBO',
                    lastStrategy: 'AEGIS_TURBO',
                    lastSide: 'LONG',
                    lastEntryPrice: 3000,
                    lastLeverage: 20,
                    lastEntryAt: Date.now(),
                    lastPeakPrice: 3000
                },
                BTCUSDT: {
                    mode: 'IDLE',
                    currentRegime: 'AEGIS_TURBO',
                    lastExitAt: Date.now() - 20 * 60 * 1000
                }
            }
        });

        await service.tick('BTCUSDT');

        expect(exchange.marketOpen).toHaveBeenCalledWith('BTCUSDT', 'LONG', 0.022);
        expect(logger.warn).not.toHaveBeenCalledWith(
            'aegis_skip_manage_position_global_state_symbol_mismatch',
            expect.anything()
        );
    });

    it('does not open when YAML live is disabled', async () => {
        const { exchange, logger, service } = makeHarness({ yaml: yamlTurbo({ live_enabled: false }) });

        await service.tick('ETHUSDT');

        expect(logger.info).toHaveBeenCalledWith('aegis_micro_live_gate_denied', expect.objectContaining({
            reason: 'aegis_turbo_yaml_live_disabled'
        }));
        expect(exchange.marketOpen).not.toHaveBeenCalled();
    });

    it('does not open if position is too small', async () => {
        const { exchange, logger, service } = makeHarness({ balance: 1 });

        await service.tick('ETHUSDT');

        expect(logger.warn).toHaveBeenCalledWith('aegis_position_too_small', expect.any(Object));
        expect(exchange.marketOpen).not.toHaveBeenCalled();
    });

	    it('closes if stop placement throws after market open', async () => {
	        const { exchange, logger, service, state } = makeHarness({ placeStopCloseReject: true });

	        await service.tick('ETHUSDT');

	        expect(exchange.marketOpen).toHaveBeenCalled();
	        expect(exchange.placeTpClose).not.toHaveBeenCalled();
	        expect(exchange.closeSideMarketSafe).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.01, 'LONG', 'AEGIS_BRACKET_FAILED');
	        expect(state.set).toHaveBeenCalledWith(expect.objectContaining({
	            mode: 'IDLE',
	            lastExitReason: 'AEGIS_BRACKET_FAILED',
	            lastBracketStatus: 'FAILED_CLOSED'
	        }));
	        expect(logger.error).toHaveBeenCalledWith('aegis_bracket_creation_failed', expect.any(Object));
	    });

	    it('closes if take-profit placement throws after stop is placed', async () => {
	        const { exchange, logger, notifier, service, state } = makeHarness({ placeTpCloseReject: true });

	        await service.tick('ETHUSDT');

	        expect(exchange.marketOpen).toHaveBeenCalled();
	        expect(exchange.placeStopClose).toHaveBeenCalled();
	        expect(exchange.closeSideMarketSafe).toHaveBeenCalledWith('ETHUSDT', 'LONG', 0.01, 'LONG', 'AEGIS_BRACKET_FAILED');
	        expect(state.set).toHaveBeenCalledWith(expect.objectContaining({
	            mode: 'IDLE',
	            lastExitReason: 'AEGIS_BRACKET_FAILED',
	            lastBracketStatus: 'FAILED_CLOSED'
	        }));
	        expect(state.set).not.toHaveBeenCalledWith(expect.objectContaining({
	            currentRegime: 'AEGIS_TURBO',
	            lastBracketStatus: 'OK'
	        }));
	        expect(logger.error).toHaveBeenCalledWith('aegis_bracket_creation_failed', expect.any(Object));
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('BRACKET FAILED'));
    });

    it('recreates missing Aegis brackets from state values while managing an open position', async () => {
        const { exchange, service } = makeHarness({ closeOrders: [] });
        let currentState: any = {
            mode: 'LONG_RIDE',
            currentRegime: 'AEGIS_TURBO',
            lastStrategy: 'AEGIS_TURBO',
            lastSide: 'LONG',
            lastEntryPrice: 3000,
            lastLeverage: 20,
            lastStopRoe: -0.15,
            lastTakeProfitRoe: 0.25,
            lastTrailingActivationRoe: 0.15,
            lastTrailingCallbackRoe: 0.08,
            lastEntryAt: Date.now(),
            lastPeakPrice: 3000
        };
        (service as any).deps.state.get.mockImplementation(() => currentState);
        (service as any).deps.state.set.mockImplementation((patch: any) => {
            currentState = { ...currentState, ...patch };
            return currentState;
        });

        await service.tick('ETHUSDT');

        expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 2977.5, 0.01);
        expect(exchange.placeTpClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 3037.5, 0.01);
    });

    it('executes MOVE_SL_BE for a LONG position', async () => {
        const { exchange, historyLogger, service, state } = makeHarness({
            markPrice: 100.45,
            readActivePosition: { sideMode: 'LONG', qtyAbs: 1, entryPrice: 100, leverage: 20, isolatedMargin: 5 },
            closeOrders: [
                { orderId: 'sl', type: 'STOP_MARKET', stopPrice: 98 },
                { orderId: 'tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 105 }
            ],
            initialState: {
                mode: 'LONG_RIDE',
                currentRegime: 'AEGIS_TURBO',
                lastStrategy: 'AEGIS_TURBO',
                lastSide: 'LONG',
                lastEntryPrice: 100,
                lastLeverage: 20,
                lastEntryAt: Date.now() - 10 * 60 * 1000,
                lastEntryQty: 1,
                lastEntryMargin: 5,
                lastTradeId: 'be-long',
                lastPeakPrice: 100,
                peakRoe: 0,
                lowestRoe: 0,
                lastStopPrice: 98,
                lastBreakEvenRoe: 0.08,
                lastTrailingActivationRoe: 0.15,
                lastTrailingCallbackRoe: 0.08
            }
        });

        await service.tick('ETHUSDT');

        expect(exchange.cancelStopOrdersForSide).toHaveBeenCalledWith('ETHUSDT', 'LONG');
        expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 100.3);
        expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
        expect(exchange.marketOpen).not.toHaveBeenCalled();
        expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
            event: 'BREAK_EVEN_EXECUTED',
            reason: 'MOVE_SL_BE',
            new_stop: 100.3
        }));
        expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
            event: 'SL_MOVED',
            reason: 'MOVE_SL_BE',
            new_stop: 100.3
        }));
        expect(state.set).toHaveBeenCalledWith(expect.objectContaining({
            breakEvenExecuted: true,
            lastBreakEvenStop: 100.3,
            lastStopPrice: 100.3
        }));
    });

    it('executes MOVE_SL_BE for a SHORT position', async () => {
        const { exchange, historyLogger, service, state } = makeHarness({
            markPrice: 99.55,
            readActivePosition: { sideMode: 'SHORT', qtyAbs: 1, entryPrice: 100, leverage: 20, isolatedMargin: 5 },
            closeOrders: [
                { orderId: 'sl', type: 'STOP_MARKET', stopPrice: 102 },
                { orderId: 'tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 95 }
            ],
            initialState: {
                mode: 'SHORT_RIDE',
                currentRegime: 'AEGIS_TURBO',
                lastStrategy: 'AEGIS_TURBO',
                lastSide: 'SHORT',
                lastEntryPrice: 100,
                lastLeverage: 20,
                lastEntryAt: Date.now() - 10 * 60 * 1000,
                lastEntryQty: 1,
                lastEntryMargin: 5,
                lastTradeId: 'be-short',
                lastPeakPrice: 100,
                peakRoe: 0,
                lowestRoe: 0,
                lastStopPrice: 102,
                lastBreakEvenRoe: 0.08,
                lastTrailingActivationRoe: 0.15,
                lastTrailingCallbackRoe: 0.08
            }
        });

        await service.tick('ETHUSDT');

        expect(exchange.cancelStopOrdersForSide).toHaveBeenCalledWith('ETHUSDT', 'SHORT');
        expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'SHORT', 99.7);
        expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
        expect(historyLogger.logTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
            event: 'BREAK_EVEN_EXECUTED',
            reason: 'MOVE_SL_BE',
            new_stop: 99.7
        }));
        expect(state.set).toHaveBeenCalledWith(expect.objectContaining({
            breakEvenExecuted: true,
            lastBreakEvenStop: 99.7,
            lastStopPrice: 99.7
        }));
    });

    it('does not execute break-even twice', async () => {
        const { exchange, service } = makeHarness({
            markPrice: 100.45,
            readActivePosition: { sideMode: 'LONG', qtyAbs: 1, entryPrice: 100, leverage: 20, isolatedMargin: 5 },
            initialState: {
                mode: 'LONG_RIDE',
                currentRegime: 'AEGIS_TURBO',
                lastStrategy: 'AEGIS_TURBO',
                lastSide: 'LONG',
                lastEntryPrice: 100,
                lastLeverage: 20,
                lastEntryAt: Date.now() - 10 * 60 * 1000,
                lastEntryQty: 1,
                lastEntryMargin: 5,
                lastTradeId: 'be-dup',
                lastPeakPrice: 100,
                peakRoe: 0.09,
                lowestRoe: 0,
                breakEvenExecuted: true,
                lastBreakEvenStop: 100.3,
                lastTrailStop: 100.3,
                lastStopPrice: 100.3,
                lastBreakEvenRoe: 0.08
            }
        });

        await service.tick('ETHUSDT');

        expect(exchange.placeStopClose).not.toHaveBeenCalled();
        expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
    });

    it('skips MOVE_SL_BE when the stop would immediately trigger for a LONG', async () => {
        const { exchange, logger, service, state } = makeHarness({
            markPrice: 99.5,
            readActivePosition: { sideMode: 'LONG', qtyAbs: 1, entryPrice: 100, leverage: 20, isolatedMargin: 5 },
            initialState: {
                mode: 'LONG_RIDE',
                currentRegime: 'AEGIS_TURBO',
                lastStrategy: 'AEGIS_TURBO',
                lastSide: 'LONG',
                lastEntryPrice: 100,
                lastLeverage: 20,
                lastEntryAt: Date.now() - 10 * 60 * 1000,
                lastEntryQty: 1,
                lastEntryMargin: 5,
                lastTradeId: 'be-immediate',
                lastPeakPrice: 100.45,
                peakRoe: 0.09,
                lowestRoe: 0,
                lastStopPrice: 98,
                lastBreakEvenRoe: 0.08
            }
        });

        await service.tick('ETHUSDT');

        expect(exchange.cancelStopOrdersForSide).not.toHaveBeenCalled();
        expect(exchange.placeStopClose).not.toHaveBeenCalled();
        expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
        expect(state.set).not.toHaveBeenCalledWith(expect.objectContaining({ breakEvenExecuted: true }));
        expect(logger.warn).toHaveBeenCalledWith('aegis_break_even_stop_move_skipped_immediate_trigger', expect.objectContaining({
            symbol: 'ETHUSDT',
            side: 'LONG',
            markPrice: 99.5,
            attemptedStopPrice: 100.3
        }));
    });

    it('uses be_roe from YAML/config before the fallback threshold', async () => {
        const { exchange, configManager, service } = makeHarness({
            markPrice: 100.45,
            readActivePosition: { sideMode: 'LONG', qtyAbs: 1, entryPrice: 100, leverage: 20, isolatedMargin: 5 },
            regime: regimeConfig({ beRoe: 0.08 }),
            initialState: {
                mode: 'LONG_RIDE',
                currentRegime: 'AEGIS_TURBO',
                lastStrategy: 'AEGIS_TURBO',
                lastSide: 'LONG',
                lastEntryPrice: 100,
                lastLeverage: 20,
                lastEntryAt: Date.now() - 10 * 60 * 1000,
                lastEntryQty: 1,
                lastEntryMargin: 5,
                lastTradeId: 'be-yaml',
                lastPeakPrice: 100,
                peakRoe: 0,
                lowestRoe: 0,
                lastStopPrice: 98
            }
        });

        await service.tick('ETHUSDT');

        expect(configManager.getGuardianConfig).toHaveBeenCalledWith('AEGIS_TURBO', 'ETHUSDT');
        expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 100.3);
    });

    it('falls back to 0.10 BE threshold when config omits be_roe', async () => {
        const { exchange, service } = makeHarness({
            markPrice: 100.45,
            readActivePosition: { sideMode: 'LONG', qtyAbs: 1, entryPrice: 100, leverage: 20, isolatedMargin: 5 },
            regime: regimeConfig({ beRoe: undefined }),
            initialState: {
                mode: 'LONG_RIDE',
                currentRegime: 'AEGIS_TURBO',
                lastStrategy: 'AEGIS_TURBO',
                lastSide: 'LONG',
                lastEntryPrice: 100,
                lastLeverage: 20,
                lastEntryAt: Date.now() - 10 * 60 * 1000,
                lastEntryQty: 1,
                lastEntryMargin: 5,
                lastTradeId: 'be-fallback',
                lastPeakPrice: 100,
                peakRoe: 0,
                lowestRoe: 0,
                lastStopPrice: 98
            }
        });

        await service.tick('ETHUSDT');

        expect(exchange.placeStopClose).not.toHaveBeenCalled();
        expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
    });

    it('logs and alerts when MOVE_SL_BE fails without marking state as executed', async () => {
        const { exchange, logger, notifier, service, state } = makeHarness({
            markPrice: 100.45,
            placeStopCloseReject: true,
            readActivePosition: { sideMode: 'LONG', qtyAbs: 1, entryPrice: 100, leverage: 20, isolatedMargin: 5 },
            initialState: {
                mode: 'LONG_RIDE',
                currentRegime: 'AEGIS_TURBO',
                lastStrategy: 'AEGIS_TURBO',
                lastSide: 'LONG',
                lastEntryPrice: 100,
                lastLeverage: 20,
                lastEntryAt: Date.now() - 10 * 60 * 1000,
                lastEntryQty: 1,
                lastEntryMargin: 5,
                lastTradeId: 'be-fail',
                lastPeakPrice: 100,
                peakRoe: 0,
                lowestRoe: 0,
                lastStopPrice: 98,
                lastBreakEvenRoe: 0.08
            }
        });

        await service.tick('ETHUSDT');

        expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
        expect(exchange.placeTpClose).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith('aegis_break_even_stop_move_failed', expect.objectContaining({
            symbol: 'ETHUSDT',
            attemptedStopPrice: 100.3
        }));
        expect(notifier.sendAlert).toHaveBeenCalledWith('AEGIS BREAK-EVEN FAILED', expect.stringContaining('ETHUSDT LONG'));
        expect(state.set).not.toHaveBeenCalledWith(expect.objectContaining({ breakEvenExecuted: true }));
    });

    it('keeps break-even state scoped to the active symbol', async () => {
        const { exchange, service, symbolStores } = makeHarness({
            symbols: ['ADAUSDT', 'ETHUSDT'],
            symbolModes: { ADAUSDT: 'LIVE', ETHUSDT: 'LIVE' },
            markPrice: 100.45,
            readActivePosition: { sideMode: 'LONG', qtyAbs: 1, entryPrice: 100, leverage: 20, isolatedMargin: 5 },
            symbolStates: {
                ADAUSDT: {
                    mode: 'LONG_RIDE',
                    currentRegime: 'AEGIS_TURBO',
                    lastStrategy: 'AEGIS_TURBO',
                    lastSide: 'LONG',
                    lastEntryPrice: 100,
                    lastLeverage: 20,
                    lastEntryAt: Date.now() - 10 * 60 * 1000,
                    lastEntryQty: 1,
                    lastEntryMargin: 5,
                    lastTradeId: 'be-ada',
                    lastPeakPrice: 100,
                    peakRoe: 0,
                    lowestRoe: 0,
                    lastStopPrice: 98,
                    lastBreakEvenRoe: 0.08
                },
                ETHUSDT: {
                    mode: 'LONG_RIDE',
                    currentRegime: 'AEGIS_TURBO',
                    lastStrategy: 'AEGIS_TURBO',
                    lastSide: 'LONG',
                    lastEntryPrice: 200,
                    lastLeverage: 20,
                    lastEntryAt: Date.now() - 10 * 60 * 1000,
                    lastEntryQty: 1,
                    lastEntryMargin: 10,
                    lastTradeId: 'eth-open',
                    lastPeakPrice: 200,
                    peakRoe: 0,
                    lowestRoe: 0,
                    lastStopPrice: 196,
                    lastBreakEvenRoe: 0.08
                }
            }
        });

        await service.tick('ADAUSDT');

        expect(exchange.placeStopClose).toHaveBeenCalledWith('ADAUSDT', 'LONG', 100.3);
        expect(symbolStores.get('ADAUSDT')?.get()).toEqual(expect.objectContaining({ breakEvenExecuted: true, lastBreakEvenStop: 100.3 }));
        expect(symbolStores.get('ETHUSDT')?.get()).not.toEqual(expect.objectContaining({ breakEvenExecuted: true }));
    });
});
