import { describe, expect, it } from 'vitest';
import { AegisExitEyeInput, evaluateAegisExitEye } from './AegisExitEye';

function baseInput(overrides: Partial<AegisExitEyeInput> = {}): AegisExitEyeInput {
    return {
        enabled: true,
        mode: 'SHADOW',
        symbol: 'LINKUSDT',
        positionSide: 'LONG',
        currentRoe: 0.16,
        peakRoe: 0.24,
        lowestRoe: -0.02,
        minutesInTrade: 10,
        currentTurboAction: 'HOLD',
        rawAction: 'HOLD',
        gatedAction: 'HOLD',
        turboScore: 0.58,
        votes: { long: 0, short: 0, neutral: 3 },
        minRoeToProtect: 0.08,
        minPeakRoeToProtect: 0.12,
        minGivebackFromPeakRoe: 0.04,
        neutralVotesToProtect: 2,
        oppositeVotesToClose: 2,
        minRoeToCloseOnOpposite: 0.06,
        minPeakRoeToCloseOnOpposite: 0.10,
        closeOnNeutralDecay: false,
        neutralCloseVotes: 3,
        minRoeToCloseOnNeutral: 0.08,
        minPeakRoeToCloseOnNeutral: 0.12,
        minGivebackToCloseOnNeutral: 0.04,
        requireConsecutiveNeutralClose: 2,
        requireConsecutiveNeutral: 2,
        requireConsecutiveOpposite: 1,
        consecutiveNeutralCount: 2,
        consecutiveNeutralCloseCount: 2,
        consecutiveOppositeCount: 0,
        ...overrides,
    };
}

describe('evaluateAegisExitEye', () => {
    it('returns NONE when disabled', () => {
        const decision = evaluateAegisExitEye(baseInput({ enabled: false }));

        expect(decision.action).toBe('NONE');
        expect(decision.shouldClose).toBe(false);
        expect(decision.reason).toBe('exit_eye_disabled');
    });

    it('detects LONG neutral momentum decay in SHADOW mode', () => {
        const decision = evaluateAegisExitEye(baseInput());

        expect(decision.action).toBe('SHADOW_PROTECT');
        expect(decision.shouldProtect).toBe(true);
        expect(decision.shouldClose).toBe(false);
        expect(decision.reason).toBe('neutral_momentum_decay_profit_protection');
    });

    it('detects LONG opposite reversal as SHADOW_CLOSE in SHADOW mode', () => {
        const decision = evaluateAegisExitEye(baseInput({
            currentTurboAction: 'SHORT',
            rawAction: 'SHORT',
            votes: { long: 0, short: 2, neutral: 1 },
            consecutiveOppositeCount: 1,
        }));

        expect(decision.action).toBe('SHADOW_CLOSE');
        expect(decision.shouldClose).toBe(false);
    });

    it('detects LONG opposite reversal as CLOSE_POSITION in CLOSE mode', () => {
        const decision = evaluateAegisExitEye(baseInput({
            mode: 'CLOSE',
            currentTurboAction: 'SHORT',
            rawAction: 'SHORT',
            votes: { long: 0, short: 2, neutral: 1 },
            consecutiveOppositeCount: 1,
        }));

        expect(decision.action).toBe('CLOSE_POSITION');
        expect(decision.shouldClose).toBe(true);
        expect(decision.shouldProtect).toBe(true);
    });

    it('does not close neutral decay in CLOSE mode when closeOnNeutralDecay is false', () => {
        const decision = evaluateAegisExitEye(baseInput({
            mode: 'CLOSE',
            closeOnNeutralDecay: false,
            currentRoe: 0.0887,
            peakRoe: 0.1405,
            votes: { long: 0, short: 0, neutral: 3 },
            consecutiveNeutralCount: 2,
            consecutiveNeutralCloseCount: 2,
        }));

        expect(decision.action).toBe('PROTECT_PROFIT');
        expect(decision.shouldClose).toBe(false);
        expect(decision.reason).toBe('neutral_momentum_decay_profit_protection');
    });

    it('closes neutral decay in CLOSE mode when explicitly enabled and thresholds pass', () => {
        const decision = evaluateAegisExitEye(baseInput({
            mode: 'CLOSE',
            closeOnNeutralDecay: true,
            currentRoe: 0.0887,
            peakRoe: 0.1405,
            currentTurboAction: 'HOLD',
            rawAction: 'HOLD',
            gatedAction: 'HOLD',
            votes: { long: 0, short: 0, neutral: 3 },
            consecutiveNeutralCount: 2,
            consecutiveNeutralCloseCount: 2,
        }));

        expect(decision.action).toBe('CLOSE_POSITION');
        expect(decision.shouldClose).toBe(true);
        expect(decision.shouldProtect).toBe(true);
        expect(decision.reason).toBe('neutral_momentum_decay_profit_exit');
    });

    it('does not close neutral decay when current ROE is not profitable', () => {
        const decision = evaluateAegisExitEye(baseInput({
            mode: 'CLOSE',
            closeOnNeutralDecay: true,
            currentRoe: -0.01,
            peakRoe: 0.1405,
            votes: { neutral: 3 },
            consecutiveNeutralCloseCount: 2,
        }));

        expect(decision.action).toBe('NONE');
        expect(decision.shouldClose).toBe(false);
    });

    it('does not close neutral decay when giveback is below the neutral close minimum', () => {
        const decision = evaluateAegisExitEye(baseInput({
            mode: 'CLOSE',
            closeOnNeutralDecay: true,
            currentRoe: 0.09,
            peakRoe: 0.14,
            minGivebackToCloseOnNeutral: 0.06,
            votes: { neutral: 3 },
            consecutiveNeutralCloseCount: 2,
        }));

        expect(decision.action).toBe('PROTECT_PROFIT');
        expect(decision.shouldClose).toBe(false);
    });

    it('does not close neutral decay when neutral votes are below neutralCloseVotes', () => {
        const decision = evaluateAegisExitEye(baseInput({
            mode: 'CLOSE',
            closeOnNeutralDecay: true,
            votes: { long: 0, short: 0, neutral: 2 },
            neutralCloseVotes: 3,
            consecutiveNeutralCloseCount: 2,
        }));

        expect(decision.action).toBe('PROTECT_PROFIT');
        expect(decision.shouldClose).toBe(false);
    });

    it('does not close neutral decay when consecutive neutral close count is insufficient', () => {
        const decision = evaluateAegisExitEye(baseInput({
            mode: 'CLOSE',
            closeOnNeutralDecay: true,
            votes: { long: 0, short: 0, neutral: 3 },
            consecutiveNeutralCount: 2,
            consecutiveNeutralCloseCount: 1,
            requireConsecutiveNeutralClose: 2,
        }));

        expect(decision.action).toBe('PROTECT_PROFIT');
        expect(decision.shouldClose).toBe(false);
    });

    it('does not close a losing LONG even with opposite signal', () => {
        const decision = evaluateAegisExitEye(baseInput({
            mode: 'CLOSE',
            currentRoe: -0.01,
            peakRoe: 0.20,
            currentTurboAction: 'SHORT',
            rawAction: 'SHORT',
            votes: { short: 3 },
            consecutiveOppositeCount: 1,
        }));

        expect(decision.action).toBe('NONE');
        expect(decision.shouldClose).toBe(false);
    });

    it('does not close without enough peak ROE', () => {
        const decision = evaluateAegisExitEye(baseInput({
            mode: 'CLOSE',
            peakRoe: 0.05,
            currentTurboAction: 'SHORT',
            rawAction: 'SHORT',
            votes: { short: 3 },
            consecutiveOppositeCount: 1,
        }));

        expect(decision.action).toBe('NONE');
        expect(decision.shouldClose).toBe(false);
    });

    it('detects SHORT opposite LONG reversal in CLOSE mode', () => {
        const decision = evaluateAegisExitEye(baseInput({
            mode: 'CLOSE',
            positionSide: 'SHORT',
            currentTurboAction: 'LONG',
            rawAction: 'LONG',
            votes: { long: 2, short: 0, neutral: 1 },
            consecutiveOppositeCount: 1,
        }));

        expect(decision.action).toBe('CLOSE_POSITION');
        expect(decision.shouldClose).toBe(true);
    });

    it('keeps opposite signal close behavior unchanged when neutral close is enabled', () => {
        const decision = evaluateAegisExitEye(baseInput({
            mode: 'CLOSE',
            closeOnNeutralDecay: true,
            currentTurboAction: 'SHORT',
            rawAction: 'SHORT',
            votes: { long: 0, short: 2, neutral: 0 },
            consecutiveOppositeCount: 1,
        }));

        expect(decision.action).toBe('CLOSE_POSITION');
        expect(decision.shouldClose).toBe(true);
        expect(decision.reason).toBe('opposite_signal_profit_exit');
    });

    it('requires enough consecutive neutral observations', () => {
        const decision = evaluateAegisExitEye(baseInput({
            consecutiveNeutralCount: 1,
            requireConsecutiveNeutral: 2,
        }));

        expect(decision.action).toBe('NONE');
    });

    it('requires enough consecutive opposite observations', () => {
        const decision = evaluateAegisExitEye(baseInput({
            mode: 'CLOSE',
            currentTurboAction: 'SHORT',
            rawAction: 'SHORT',
            votes: { short: 2 },
            consecutiveOppositeCount: 0,
            requireConsecutiveOpposite: 1,
        }));

        expect(decision.action).toBe('NONE');
    });

    it('PROTECT mode protects but does not close on opposite reversal', () => {
        const decision = evaluateAegisExitEye(baseInput({
            mode: 'PROTECT',
            currentTurboAction: 'SHORT',
            rawAction: 'SHORT',
            votes: { short: 2 },
            consecutiveOppositeCount: 1,
        }));

        expect(decision.action).toBe('PROTECT_PROFIT');
        expect(decision.shouldProtect).toBe(true);
        expect(decision.shouldClose).toBe(false);
    });
});
