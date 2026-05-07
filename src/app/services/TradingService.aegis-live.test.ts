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
	    closeOrders?: any[];
	    balance?: number;
	    readActivePosition?: any;
	    readActivePositionSequence?: any[];
	    placeStopCloseReject?: boolean;
	    placeTpCloseReject?: boolean;
	    closeSideMarketSafeReject?: boolean;
	    markPrice?: number;
	    initialState?: any;
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
        hasOpenPosition: vi.fn().mockResolvedValue(false),
        getServerTime: vi.fn().mockResolvedValue(Date.now()),
        getLastCandle: vi.fn().mockResolvedValue(null),
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
    };
    const notifier = { sendMessage: vi.fn(), sendAlert: vi.fn() };
    const configManager = {
        getAegisTurboConfig: vi.fn(() => options.yaml ?? yamlTurbo()),
        getRegimeConfig: vi.fn(() => regimeConfig()),
        system: { enable_sentinel: false },
        trading: { fee_buffer_pct: 0.05 }
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
            configManager: configManager as any
        },
        {
            symbols: ['ETHUSDT'],
            tickIntervalMs: 0,
            maxTradesPerDay: 100,
            tradingMode: 'AEGIS_TURBO_MICRO_LIVE'
        }
    );

	    return { exchange, logger, notifier, service, state };
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
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('💰 Wallet Actual: $565.39 USDT'));
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('📊 Balance Aprox.: ~$565.39 USDT'));
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('💼 POSICIÓN ACTIVA: FLAT'));
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

        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('💰 Wallet Actual: $500.00 USDT'));
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('📊 Balance Aprox.: ~$555.00 USDT'));
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('💼 POSICIÓN ACTIVA: LONG'));
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
        expect(notifier.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Equity total: N/D'));
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
});
