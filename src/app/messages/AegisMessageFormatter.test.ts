import { describe, expect, it } from 'vitest';
import {
    AegisStartupMessageInput,
    formatAegisStartupMessage,
    formatAllSignalsMessage
} from './AegisMessageFormatter';

function startup(overrides: Partial<AegisStartupMessageInput> = {}): string {
    const base: AegisStartupMessageInput = {
        mode: {
            tradingMode: 'AEGIS_TURBO_MICRO_LIVE',
            liveEnabled: true,
            strategy: 'AEGIS_TURBO+MOMENTUM_RIDE',
            shortsEnabled: false,
            activeSymbols: ['ETHUSDT', 'BTCUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'SUIUSDT', 'LTCUSDT']
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
        aegisTurbo: {
            enabled: true,
            mode: 'LIVE',
            fallbackEnabled: true,
            leverage: 20,
            entryThreshold: 0.60,
            trailingActivationRoe: 0.15,
            trailingCallbackRoe: 0.08,
            stopRoe: -0.40,
            takeProfitRoe: 0.50,
            requireBrackets: true
        },
        momentumRide: {
            enabled: true,
            mode: 'ENFORCE',
            researchMode: true,
            maxPositionFraction: 0.02,
            maxOpenMomentumPositions: 1,
            maxMomentumTradesPerDay: 3,
            maxConsecutiveMomentumLosses: 2,
            cooldownAfterLossMinutes: 60,
            requireAegisDirectionConfirmation: true,
            requireBtcEthNotContradicting: true,
            examples: [
                { symbol: 'BTCUSDT', side: 'LONG', positionFraction: 0.02 },
                { symbol: 'ETHUSDT', side: 'LONG', positionFraction: 0.02 },
                { symbol: 'XRPUSDT', side: 'LONG', positionFraction: 0.02 },
                { symbol: 'ADAUSDT', side: 'LONG', positionFraction: 0.015 },
                { symbol: 'AVAXUSDT', side: 'SHORT', positionFraction: 0.008 }
            ]
        },
        regimeEngineV2: {
            metadataEnabled: true,
            useAsGate: false,
            ignoreForEntry: true
        },
        probeMode: {
            enabled: true,
            mode: 'ENFORCE',
            maxOpenProbePositions: 1,
            maxProbeEntriesPerHour: 1
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
            strategy: 'MOMENTUM_RIDE',
            size: 0.561,
            margin: 65.09,
            leverage: 30,
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
        aegisTurbo: { ...base.aegisTurbo, ...overrides.aegisTurbo },
        momentumRide: { ...base.momentumRide, ...overrides.momentumRide },
        regimeEngineV2: { ...base.regimeEngineV2, ...overrides.regimeEngineV2 },
        probeMode: { ...base.probeMode, ...overrides.probeMode },
        initialRadar: overrides.initialRadar === undefined
            ? base.initialRadar
            : { ...base.initialRadar, ...overrides.initialRadar },
        activePositions: overrides.activePositions ?? base.activePositions
    });
}

describe('formatAegisStartupMessage', () => {
    it('labels directional output as single-estimator telemetry, not consensus', () => {
        const text = formatAllSignalsMessage({
            signals: [{
                symbol: 'ETHUSDT',
                rawAction: 'SHORT',
                rawScore: 0.7,
                gatedAction: 'SHORT',
                votes: { long: 0, short: 1, neutral: 0 },
                reason: 'CURRENT_BRAIN_SELECTED',
                freshnessIsFresh: true
            }]
        });

        expect(text).toContain('Salida direccional');
        expect(text).toContain('estimador único; no consenso');
        expect(text).not.toContain('🗳️ Votes');
    });

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

    it('shows live system title and mode', () => {
        expect(startup()).toContain('🔥 AEGIS + MOMENTUM LIVE ✅');
        expect(startup()).toContain('🧠 MICRO-LIVE | Live ON | Shorts OFF');
        expect(startup()).toContain('Trading mode: AEGIS_TURBO+MOMENTUM_RIDE');
    });

    it('shows compact active symbols without depending on ETHUSDT as the only symbol', () => {
        const text = startup();

        expect(text).toContain('🎯 Símbolos activos (11)');
        expect(text).toContain('ETH BTC SOL BNB XRP DOGE ADA AVAX LINK SUI LTC');
        expect(text).not.toContain('🎯 AEGIS_TURBO | ETHUSDT');
    });

    it('shows account balances in one compact line', () => {
        const text = startup();

        expect(text).toContain('💰 Wallet $499.64 | Equity $560.42 | Disp. N/D');
    });

    it('shows Aegis Turbo fallback and risk bracket config from effective input', () => {
        const text = startup({ config: { entryThreshold: 0.60 } as any });

        expect(text).toContain('🛡️ Aegis Turbo');
        expect(text).toContain('Mode: LIVE | Fallback: ON');
        expect(text).toContain('Lev base: 20x | Threshold: 60.0%');
        expect(text).toContain('SL -40.0% | TP +50.0% ROE');
        expect(text).toContain('Trail +15.0% | Callback 8.0%');
        expect(text).toContain('🧷 Brackets obligatorios ✅');
        expect(text).not.toContain('Configuración AEGIS_TURBO');
    });

    it('shows Momentum Ride live caps and confirmation requirements', () => {
        const text = startup();

        expect(text).toContain('⚡ Momentum Ride');
        expect(text).toContain('Mode: ENFORCE | Prioridad: alta');
        expect(text).toContain('Max position: 2.0% wallet');
        expect(text).toContain('Max open momentum: 1 | Max trades/day: 3');
        expect(text).toContain('Max consecutive losses: 2 | Cooldown loss: 60m');
        expect(text).toContain('Requires Aegis direction ✅ | BTC/ETH contradiction block ✅');
        expect(text).toContain('Research/experimental mode ON');
        expect(text).toContain('BTC/ETH/XRP LONG 2.0%');
        expect(text).toContain('ADA LONG 1.5%');
        expect(text).toContain('AVAX SHORT 0.8%');
    });

    it('shows RegimeEngineV2 as metadata-only and Probe Mode when enabled', () => {
        const text = startup();

        expect(text).toContain('🧭 RegimeEngineV2');
        expect(text).toContain('Metadata ON | Gate OFF');
        expect(text).toContain('useAsGate=false | ignoreForEntry=true');
        expect(text).toContain('Observa régimen, no decide entradas');
        expect(text).toContain('🧪 Probe Mode');
        expect(text).toContain('Mode: ENFORCE | Max open: 1 | Max/hour: 1');
    });

    it('does not render the single-symbol startup radar by default', () => {
        const text = startup();

        expect(text).not.toContain('🛰️ Radar ETHUSDT');
        expect(text).not.toContain('Radar ETHUSDT');
        expect(text).not.toContain('HOLD | Score 28.4% | L=1 S=0 N=2');
    });

    it('shows compact active position', () => {
        const text = startup();

        expect(text).toContain('💼 ETHUSDT SHORT 📉');
        expect(text).toContain('Strategy MOMENTUM_RIDE | Lev 30x');
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
                    strategy: 'AEGIS_TURBO',
                    size: 0.577,
                    margin: 66.49,
                    leverage: 20,
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
                    strategy: 'MOMENTUM_RIDE',
                    size: 0.001,
                    margin: 70,
                    leverage: 30,
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

        expect(text).toContain('🎯 Símbolos activos (2)');
        expect(text).toContain('ETH BTC');
        expect(text).toContain('💼 ETHUSDT LONG 📈');
        expect(text).toContain('Strategy AEGIS_TURBO | Lev 20x');
        expect(text).toContain('💼 BTCUSDT SHORT 📉');
        expect(text).toContain('Strategy MOMENTUM_RIDE | Lev 30x');
    });
});
