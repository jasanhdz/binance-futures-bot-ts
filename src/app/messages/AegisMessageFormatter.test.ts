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
            freshnessIsFresh: true,
            featureTimestamp: '2026-05-07T07:45:00.000Z'
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

    it('does not include repeated or aggressive startup fields', () => {
        const text = startup();

        expect(text).not.toContain('Trading mode: AEGIS_TURBO_MICRO_LIVE');
        expect(text).not.toContain('Turbo raw');
        expect(text).not.toContain('Turbo gated');
        expect(text).not.toContain('**');
    });

    it('shows mode as MICRO-LIVE', () => {
        expect(startup()).toContain('🧠 MICRO-LIVE | Live ON | Shorts OFF');
    });

    it('shows entry threshold as 60.0%', () => {
        expect(startup({ config: { entryThreshold: 0.60 } as any })).toContain('⚙️ Lev 20x | Th 60.0% | Max 8.0h');
    });

    it('shows account balances in one compact line', () => {
        const text = startup();

        expect(text).toContain('💰 Wallet $499.64 | Equity $560.42 | Disp. N/D');
    });

    it('shows compact config lines', () => {
        const text = startup({ config: { entryThreshold: 0.60 } as any });

        expect(text).toContain('⚙️ Lev 20x | Th 60.0% | Max 8.0h');
        expect(text).toContain('🛡️ SL -40.0% | TP +50.0% ROE');
        expect(text).toContain('🔁 Trail +15.0% | Callback 8.0%');
        expect(text).toContain('🚨 Daily stop 10.0% | Max losses 1');
        expect(text).toContain('🧷 Brackets obligatorios ✅');
        expect(text).not.toContain('Configuración AEGIS_TURBO');
    });

    it('shows compact initial radar with score and votes', () => {
        const text = startup();

        expect(text).toContain('🛰️ Radar ETHUSDT');
        expect(text).toContain('HOLD | Score 28.4% | L=1 S=0 N=2');
        expect(text).toContain('Sin acuerdo suficiente entre modelos recientes');
        expect(text).toContain('Snapshot fresco ✅ | Feature 07:45 UTC');
    });

    it('shows compact active position', () => {
        const text = startup();

        expect(text).toContain('💼 ETHUSDT SHORT 📉');
        expect(text).toContain('ROI -6.6% | PnL -$4.32 | 2.4h');
        expect(text).toContain('Size 0.561 ETH | Margin $65.09');
        expect(text).toContain('TP $2,285.46 | SL $2,390.94');
        expect(text).not.toContain('Brackets\n');
    });

    it('shows no active positions when flat', () => {
        const text = startup({ activePositions: [] });

        expect(text).toContain('💼 Posiciones');
        expect(text).toContain('Ninguna');
    });

    it('does not render invalid placeholders', () => {
        expect(startup()).not.toMatch(/undefined|null|NaN/);
    });

    it('supports multiple symbols and positions', () => {
        const text = startup({
            mode: { activeSymbols: ['ETHUSDT', 'BTCUSDT'] } as any,
            activePositions: [
                {
                    symbol: 'ETHUSDT',
                    side: 'LONG',
                    size: 0.577,
                    margin: 66.49,
                    roi: 0.189,
                    pnl: 12.67,
                    durationHours: 6.5,
                    tpPrice: 2379.69,
                    slPrice: 2340.03,
                    tpRoe: 0.50,
                    slRoe: -0.40
                },
                {
                    symbol: 'BTCUSDT',
                    side: 'SHORT',
                    size: 0.001,
                    margin: 70,
                    roi: -0.02,
                    pnl: -1.40,
                    durationHours: 1.2,
                    tpPrice: 92000,
                    slPrice: 97000,
                    tpRoe: 0.25,
                    slRoe: -0.15
                }
            ]
        });

        expect(text).toContain('🎯 AEGIS_TURBO | ETHUSDT, BTCUSDT');
        expect(text).toContain('💼 ETHUSDT LONG 📈');
        expect(text).toContain('💼 BTCUSDT SHORT 📉');
    });
});
