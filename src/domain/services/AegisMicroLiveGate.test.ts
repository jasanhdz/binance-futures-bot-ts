import { describe, expect, it } from 'vitest';
import {
    AegisMicroLiveGateConfig,
    AegisMicroLiveGateContext,
    buildAegisMicroLiveGateConfigFromEnv,
    shouldEnterAegisTurboMicroLive
} from './AegisMicroLiveGate';

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
}

function baseSignal() {
    return {
        aegis: {
            turbo: {
                raw: {
                    action: 'LONG' as const,
                    would_execute: true,
                    turbo_score: 0.72,
                    leverage_suggestion: 25,
                    position_fraction: 0.18,
                    votes: { long: 2, short: 0, neutral: 1 },
                    reason: 'raw_long_agreement'
                },
                gated: {
                    action: 'HOLD' as const,
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
    };
}

function baseConfig(): AegisMicroLiveGateConfig {
    return {
        tradingMode: 'AEGIS_TURBO_MICRO_LIVE',
        liveEnabled: true,
        allowShort: false,
        minScore: 0.60,
        leverageCap: 15,
        positionFractionCap: 0.10,
        maxTradesPerDay: 2,
        maxConsecutiveLosses: 2,
        dailyLossStopPct: 0.10,
        minCooldownMs: 15 * 60 * 1000,
        maxLiquidityStress: 0.70
    };
}

function baseCtx(): AegisMicroLiveGateContext {
    return {
        symbol: 'ETHUSDT',
        signal: baseSignal(),
        hasOpenPosition: false,
        tradesToday: 0,
        consecutiveLosses: 0,
        timeSinceLastExitMs: 20 * 60 * 1000,
        liquidityStress: 0.2,
        dailyPnlPct: 0
    };
}

describe('AegisMicroLiveGate', () => {
    it('denies if tradingMode is not AEGIS_TURBO_MICRO_LIVE', () => {
        const config = baseConfig();
        config.tradingMode = 'AEGIS_SHADOW';

        const decision = shouldEnterAegisTurboMicroLive(baseCtx(), config);

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('trading_mode_not_turbo_micro_live');
    });

    it('denies if liveEnabled=false', () => {
        const config = baseConfig();
        config.liveEnabled = false;

        const decision = shouldEnterAegisTurboMicroLive(baseCtx(), config);

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('aegis_live_disabled');
    });

    it('denies if raw is missing', () => {
        const ctx = baseCtx();
        delete ctx.signal.aegis!.turbo!.raw;

        const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('missing_aegis_turbo_raw');
    });

    it('denies if hasOpenPosition=true', () => {
        const ctx = baseCtx();
        ctx.hasOpenPosition = true;

        const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

        expect(decision.reason).toBe('position_already_open');
    });

    it('denies if tradesToday >= max', () => {
        const ctx = baseCtx();
        ctx.tradesToday = 2;

        const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

        expect(decision.reason).toBe('max_trades_per_day_reached');
    });

    it('denies if consecutiveLosses >= max', () => {
        const ctx = baseCtx();
        ctx.consecutiveLosses = 2;

        const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

        expect(decision.reason).toBe('max_consecutive_losses_reached');
    });

    it('denies if cooldown is active', () => {
        const ctx = baseCtx();
        ctx.timeSinceLastExitMs = 14 * 60 * 1000;

        const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

        expect(decision.reason).toBe('cooldown_active');
    });

    it('denies if liquidityStress > max', () => {
        const ctx = baseCtx();
        ctx.liquidityStress = 0.71;

        const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

        expect(decision.reason).toBe('liquidity_stress_block');
    });

    it('denies if dailyPnlPct <= -dailyLossStopPct', () => {
        const ctx = baseCtx();
        ctx.dailyPnlPct = -0.10;

        const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

        expect(decision.reason).toBe('daily_loss_stop_reached');
    });

    it('denies if raw.would_execute=false', () => {
        const ctx = baseCtx();
        ctx.signal.aegis!.turbo!.raw!.would_execute = false;

        const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

        expect(decision.reason).toBe('raw_would_execute_false');
    });

    it('denies if raw.action=HOLD', () => {
        const ctx = baseCtx();
        ctx.signal.aegis!.turbo!.raw!.action = 'HOLD';

        const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

        expect(decision.reason).toBe('raw_action_not_trade');
    });

    it('denies SHORT if allowShort=false', () => {
        const ctx = baseCtx();
        ctx.signal.aegis!.turbo!.raw!.action = 'SHORT';
        ctx.signal.aegis!.turbo!.raw!.votes = { long: 0, short: 2, neutral: 1 };

        const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

        expect(decision.reason).toBe('short_disabled');
    });

    it('allows SHORT if allowShort=true and votes.short >= 2', () => {
        const ctx = baseCtx();
        ctx.signal.aegis!.turbo!.raw!.action = 'SHORT';
        ctx.signal.aegis!.turbo!.raw!.votes = { long: 0, short: 2, neutral: 1 };
        const config = baseConfig();
        config.allowShort = true;

        const decision = shouldEnterAegisTurboMicroLive(ctx, config);

        expect(decision.allowed).toBe(true);
        expect(decision.side).toBe('SHORT');
        expect(decision.reason).toBe('allowed_aegis_turbo_micro_live');
    });

    it('denies if score < threshold', () => {
        const ctx = baseCtx();
        ctx.signal.aegis!.turbo!.raw!.turbo_score = 0.59;

        const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

        expect(decision.reason).toBe('turbo_score_below_threshold');
    });

    it('denies LONG if votes.long < 2', () => {
        const ctx = baseCtx();
        ctx.signal.aegis!.turbo!.raw!.votes = { long: 1, short: 0, neutral: 2 };

        const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

        expect(decision.reason).toBe('insufficient_long_votes');
    });

    it('allows LONG if all checks pass', () => {
        const decision = shouldEnterAegisTurboMicroLive(baseCtx(), baseConfig());

        expect(decision.allowed).toBe(true);
        expect(decision.side).toBe('LONG');
        expect(decision.reason).toBe('allowed_aegis_turbo_micro_live');
    });

    it('caps leverage at 15 even if raw suggests 25', () => {
        const decision = shouldEnterAegisTurboMicroLive(baseCtx(), baseConfig());

        expect(decision.leverage).toBe(15);
    });

    it('caps positionFraction at 0.10 even if raw suggests 0.18', () => {
        const decision = shouldEnterAegisTurboMicroLive(baseCtx(), baseConfig());

        expect(decision.positionFraction).toBe(0.10);
    });

    it('normalizes stop/tp/trailing values', () => {
        const ctx = baseCtx();
        ctx.signal = clone(ctx.signal);
        ctx.signal.aegis!.turbo!.stop_roe = 0.15;
        ctx.signal.aegis!.turbo!.take_profit_roe = -0.25;
        ctx.signal.aegis!.turbo!.trailing_activation_roe = -0.15;
        ctx.signal.aegis!.turbo!.trailing_callback_roe = -0.08;

        const decision = shouldEnterAegisTurboMicroLive(ctx, baseConfig());

        expect(decision.stopRoe).toBe(-0.15);
        expect(decision.takeProfitRoe).toBe(0.25);
        expect(decision.trailingActivationRoe).toBe(0.15);
        expect(decision.trailingCallbackRoe).toBe(0.08);
    });

    it('preserves gatedReason and gatedBlockedBy in decision', () => {
        const decision = shouldEnterAegisTurboMicroLive(baseCtx(), baseConfig());

        expect(decision.rawReason).toBe('raw_long_agreement');
        expect(decision.gatedReason).toBe('safe_regime_block');
        expect(decision.gatedBlockedBy).toBe('safe_regime');
    });

    it('builds config from CONFIG-shaped env object', () => {
        const config = buildAegisMicroLiveGateConfigFromEnv({
            TRADING_MODE: 'AEGIS_TURBO_MICRO_LIVE',
            AEGIS_LIVE_ENABLED: true,
            AEGIS_TURBO_ALLOW_SHORT: false,
            AEGIS_TURBO_MIN_SCORE: 0.60,
            AEGIS_TURBO_LEVERAGE: 15,
            AEGIS_TURBO_POSITION_FRACTION: 0.10,
            AEGIS_TURBO_MAX_TRADES_PER_DAY: 2,
            AEGIS_TURBO_MAX_CONSECUTIVE_LOSSES: 2,
            AEGIS_TURBO_DAILY_LOSS_STOP_PCT: 0.10
        });

        expect(config).toEqual({
            tradingMode: 'AEGIS_TURBO_MICRO_LIVE',
            liveEnabled: true,
            allowShort: false,
            minScore: 0.60,
            leverageCap: 15,
            positionFractionCap: 0.10,
            maxTradesPerDay: 2,
            maxConsecutiveLosses: 2,
            dailyLossStopPct: 0.10,
            minCooldownMs: 15 * 60 * 1000,
            maxLiquidityStress: 0.70
        });
    });
});
