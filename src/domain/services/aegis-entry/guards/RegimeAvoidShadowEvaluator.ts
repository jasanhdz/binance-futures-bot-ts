import { Side } from '../../../types';
import { AegisRegimeLabel } from '../../AegisRegimeGuard';
import {
    getCalibrationAvoidRules,
    RegimeCalibrationAvoidRuleSet
} from '../regimeCalibrationAvoidRules';
import {
    AegisEntryFinalDecision,
    AegisEntryFinalStrategy
} from '../AegisEntryDecisionTypes';

export type RegimeAvoidShadowReason =
    | 'calibrated_avoid_regime'
    | 'no_avoid_rule'
    | 'missing_regime'
    | 'shadow_rules_disabled';

export type RegimeAvoidShadowInput = {
    symbol: string;
    side: Side;
    technicalRegime?: AegisRegimeLabel | string;
    regimeContext?: { label?: AegisRegimeLabel | string };
    finalStrategy?: AegisEntryFinalStrategy | string;
    finalDecision?: AegisEntryFinalDecision | string;
    tradeId?: string;
    timestamp?: string;
    rules?: RegimeCalibrationAvoidRuleSet;
};

export type RegimeAvoidShadowEvaluation = {
    wouldAvoid: boolean;
    reason: RegimeAvoidShadowReason;
    matchedRegime?: AegisRegimeLabel;
    symbol: string;
    side: Side;
    source: RegimeCalibrationAvoidRuleSet['source'];
    mode: 'SHADOW';
    finalStrategy?: string;
    finalDecision?: string;
    tradeId?: string;
    timestamp?: string;
    notLiveEnforced: true;
};

const VALID_REGIMES = new Set<AegisRegimeLabel>([
    'MOMENTUM_UP',
    'MOMENTUM_DOWN',
    'BREAKOUT_UP',
    'BREAKOUT_DOWN',
    'TREND_UP',
    'TREND_DOWN',
    'CHOP',
    'EXHAUSTION',
    'RISK_OFF',
    'HIGH_VOL_RISK',
    'UNKNOWN'
]);

export class RegimeAvoidShadowEvaluator {
    static evaluate(input: RegimeAvoidShadowInput): RegimeAvoidShadowEvaluation {
        const rules = input.rules ?? getCalibrationAvoidRules();
        const symbol = input.symbol.toUpperCase();
        const base = {
            symbol,
            side: input.side,
            source: rules.source,
            mode: 'SHADOW' as const,
            finalStrategy: input.finalStrategy,
            finalDecision: input.finalDecision,
            tradeId: input.tradeId,
            timestamp: input.timestamp,
            notLiveEnforced: true as const
        };

        if (rules.mode !== 'SHADOW_ONLY' || rules.not_live_enforced !== true) {
            return { ...base, wouldAvoid: false, reason: 'shadow_rules_disabled' };
        }

        const regime = normalizeRegime(input.technicalRegime ?? input.regimeContext?.label);
        if (!regime) {
            return { ...base, wouldAvoid: false, reason: 'missing_regime' };
        }

        const avoidRegimes = rules.rules[symbol]?.[input.side] ?? [];
        if (avoidRegimes.includes(regime)) {
            return {
                ...base,
                wouldAvoid: true,
                reason: 'calibrated_avoid_regime',
                matchedRegime: regime
            };
        }

        return {
            ...base,
            wouldAvoid: false,
            reason: 'no_avoid_rule',
            matchedRegime: regime
        };
    }
}

function normalizeRegime(value: unknown): AegisRegimeLabel | undefined {
    const normalized = String(value || '').trim().toUpperCase();
    return VALID_REGIMES.has(normalized as AegisRegimeLabel)
        ? normalized as AegisRegimeLabel
        : undefined;
}
