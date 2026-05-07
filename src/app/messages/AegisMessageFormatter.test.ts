import { describe, expect, it } from 'vitest';
import { AegisStartupMessageInput, formatAegisStartupMessage } from './AegisMessageFormatter';

function startup(overrides: Partial<AegisStartupMessageInput> = {}): string {
    const base: AegisStartupMessageInput = {
        mode: {
            tradingMode: 'AEGIS_TURBO_MICRO_LIVE',
            liveEnabled: true,
            strategy: 'AEGIS_TURBO',
            shortsEnabled: false,
            activeSymbols: ['ETHUSDT']
        },
        account: {
            walletBalance: 499.64,
            equityTotal: 560.42,
            availableBalance: undefined
        },
        config: {
            leverage: 20,
            entryThreshold: 0.50,
            maxHoldHours: 8,
            trailingEnabled: true,
            trailingActivationRoe: 0.15,
            trailingCallbackRoe: 0.08,
            stopRoe: -0.40,
            takeProfitRoe: 0.50,
            maxTradesPerDay: 1,
            dailyLossStopPct: 0.10,
            maxConsecutiveLosses: 1,
            requireBrackets: true
        },
        initialRadar: {
            symbol: 'ETHUSDT',
            rawAction: 'HOLD',
            rawScore: 0.284,
            gatedAction: 'HOLD',
            votes: { long: 1, short: 0, neutral: 2 },
            reason: 'insufficient_recent_model_agreement',
            freshnessIsFresh: true
        },
        activePositions: [{
            symbol: 'ETHUSDT',
            side: 'SHORT',
            size: 0.561,
            margin: 65.09,
            roi: -0.0657,
            pnl: -4.32,
            durationHours: 2.4,
            tpPrice: 2285.46,
            slPrice: 2390.94,
            tpRoe: 0.50,
            slRoe: -0.40
        }]
    };

    return formatAegisStartupMessage({
        ...base,
        ...overrides,
        mode: { ...base.mode, ...overrides.mode },
        account: { ...base.account, ...overrides.account },
        config: { ...base.config, ...overrides.config },
        initialRadar: overrides.initialRadar === undefined
            ? base.initialRadar
            : { ...base.initialRadar, ...overrides.initialRadar },
        activePositions: overrides.activePositions ?? base.activePositions
    });
}

describe('formatAegisStartupMessage', () => {
    it('does not include legacy AI probabilities', () => {
        const text = startup();

        expect(text).not.toContain('PROBABILIDADES IA');
        expect(text).not.toContain('📈 Long:');
        expect(text).not.toContain('📉 Short:');
        expect(text).not.toContain('🧘 Idle:');
        expect(text).not.toContain('🚪 Close:');
    });

    it('shows entry threshold as 50.0%', () => {
        expect(startup({ config: { entryThreshold: 0.50 } as any })).toContain('• Entry threshold: 50.0%');
    });

    it('shows entry threshold as 60.0%', () => {
        expect(startup({ config: { entryThreshold: 0.60 } as any })).toContain('• Entry threshold: 60.0%');
    });

    it('shows account balances', () => {
        const text = startup();

        expect(text).toContain('• Wallet: $499.64 USDT');
        expect(text).toContain('• Equity total: $560.42 USDT');
        expect(text).toContain('• Disponible: N/D');
    });

    it('shows active position and brackets', () => {
        const text = startup();

        expect(text).toContain('💼 POSICIÓN ACTIVA');
        expect(text).toContain('ETHUSDT | 📉 SHORT');
        expect(text).toContain('• Tamaño: 0.561 ETH');
        expect(text).toContain('• PnL: -$4.32');
        expect(text).toContain('• TP: $2,285.46 (+50.0% ROE)');
        expect(text).toContain('• SL: $2,390.94 (-40.0% ROE)');
    });

    it('shows no active positions when flat', () => {
        const text = startup({ activePositions: [] });

        expect(text).toContain('💼 POSICIONES ACTIVAS');
        expect(text).toContain('• Ninguna');
    });

    it('does not render invalid placeholders', () => {
        expect(startup()).not.toMatch(/undefined|null|NaN/);
    });

    it('shows formatted radar reason', () => {
        expect(startup()).toContain('• Motivo: Sin acuerdo suficiente entre modelos recientes');
    });
});
