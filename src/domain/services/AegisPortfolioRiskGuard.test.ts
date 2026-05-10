import { describe, expect, it } from 'vitest';
import { AegisPortfolioRiskGuard, AegisPortfolioRiskConfig, AegisPortfolioRiskInput } from './AegisPortfolioRiskGuard';

const config: AegisPortfolioRiskConfig = {
    enabled: true,
    max_open_positions: 4,
    max_same_direction_positions: 3,
    max_margin_used_pct: 0.45,
    max_notional_to_equity: 10
};

function input(overrides: Partial<AegisPortfolioRiskInput> = {}): AegisPortfolioRiskInput {
    return {
        symbol: 'BTCUSDT',
        side: 'LONG',
        currentOpenPositions: 1,
        currentLongPositions: 1,
        currentShortPositions: 0,
        walletBalance: 100,
        equityTotal: 100,
        currentMarginUsed: 20,
        currentNotional: 200,
        newTradeEstimatedMargin: 10,
        newTradeEstimatedNotional: 100,
        config,
        ...overrides
    };
}

describe('AegisPortfolioRiskGuard', () => {
    it('allows when disabled', () => {
        const decision = AegisPortfolioRiskGuard.evaluate(input({
            currentOpenPositions: 99,
            currentLongPositions: 99,
            currentMarginUsed: 1000,
            currentNotional: 10000,
            newTradeEstimatedMargin: 500,
            newTradeEstimatedNotional: 5000,
            config: {
                enabled: false,
                max_open_positions: 1,
                max_same_direction_positions: 1,
                max_margin_used_pct: 0.01,
                max_notional_to_equity: 0.01
            }
        }));

        expect(decision.allowed).toBe(true);
        expect(decision.reason).toBe('portfolio_risk_disabled');
    });

    it('blocks max_open_positions', () => {
        const decision = AegisPortfolioRiskGuard.evaluate(input({ currentOpenPositions: 4 }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('max_open_positions_reached');
    });

    it('blocks max_same_direction_positions', () => {
        const decision = AegisPortfolioRiskGuard.evaluate(input({ currentLongPositions: 3 }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('max_same_direction_positions_reached');
    });

    it('blocks max_margin_used_pct', () => {
        const decision = AegisPortfolioRiskGuard.evaluate(input({
            currentMarginUsed: 40,
            newTradeEstimatedMargin: 6
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('max_margin_used_pct_reached');
    });

    it('blocks max_notional_to_equity', () => {
        const decision = AegisPortfolioRiskGuard.evaluate(input({
            currentNotional: 990,
            newTradeEstimatedNotional: 20
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('max_notional_to_equity_reached');
    });

    it('allows when all limits are respected', () => {
        const decision = AegisPortfolioRiskGuard.evaluate(input());

        expect(decision.allowed).toBe(true);
        expect(decision.reason).toBe('allowed');
        expect(decision.metadata).toMatchObject({
            openPositions: 1,
            sameDirectionPositions: 1,
            marginUsedPct: 0.3,
            notionalToEquity: 3
        });
    });
});
