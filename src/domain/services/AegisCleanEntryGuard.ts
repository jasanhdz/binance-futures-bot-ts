export type AegisCleanEntryGuardMode = 'SHADOW' | 'ENFORCE';

export type AegisCleanEntryGuardDecision =
    | 'ALLOW_CLEAN'
    | 'WAIT_CONFIRMATION'
    | 'SHADOW_WAIT_CONFIRMATION'
    | 'DISABLED';

export type AegisCleanEntrySetupGrade = 'A_PLUS' | 'A' | 'WEAK';

export interface AegisCleanEntryGuardVotes {
    long?: number;
    short?: number;
    neutral?: number;
}

export interface AegisCleanEntryGuardConfig {
    enabled: boolean;
    mode: AegisCleanEntryGuardMode;
    useEntryQualityModelAsSourceOfTruth: boolean;
    ignoreRuleGateInsufficientDataWhenModelOk: boolean;
    minFeatureParityPct: number;
    applyTo: {
        long: boolean;
        short: boolean;
    };
    dirtyConditions: {
        blockWhenEntryQualityInsufficient: boolean;
        blockWhenEventRiskWouldBlock: boolean;
        blockWhenTailRiskGte: number;
        blockWhenEntryQualityNotAllow: boolean;
    };
    requireCleanForPremiumSymbols: boolean;
    cleanConditions: {
        requireDecisionBrainEnterNow: boolean;
        requireEntryQualityAllow: boolean;
        requireNoInsufficientData: boolean;
        requireEventRiskWouldBlockFalse: boolean;
        maxTailRiskScore: number;
    };
    exception: {
        allowExtremeMomentumInShadowOnly: boolean;
        minTurboScore: number;
        requireVotes3Of3: boolean;
        maxTailRiskScore: number;
    };
    telemetry: {
        logAllEvaluations: boolean;
        includeInEntryMetadata: boolean;
    };
}

export interface AegisCleanEntryGuardInput extends AegisCleanEntryGuardConfig {
    symbol: string;
    side: 'LONG' | 'SHORT';
    turboScore?: number;
    votes?: AegisCleanEntryGuardVotes;
    setupGrade?: AegisCleanEntrySetupGrade;
    decisionBrain?: string;
    entryQualityRecommendation?: string;
    entryQualityGateReason?: string;
    entryQualityGateAction?: string;
    entryQualityModelPresent?: boolean;
    entryQualityModelRecommendation?: string;
    entryQualityModelScore?: number | null;
    entryQualityModelFeatureStatus?: string;
    entryQualityModelFeatureParityPct?: number | null;
    entryQualityModelMissingFeaturesCount?: number | null;
    entryQualityModelScope?: string;
    entryQualityModelVersion?: string;
    featureStatus?: string;
    featureParityPct?: number | null;
    missingFeaturesCount?: number | null;
    modelScope?: string;
    modelVersion?: string;
    entryQualityRuleGateReason?: string;
    entryQualityRuleGateDecision?: string;
    entryQualityScore?: number | null;
    tailRiskScore?: number | null;
    eventRiskMode?: string;
    eventRiskWouldBlock?: boolean;
    eventRiskReason?: string;
    isPremiumSymbol?: boolean;
}

export interface AegisCleanEntryGuardOutput {
    decision: AegisCleanEntryGuardDecision;
    allowed: boolean;
    wouldBlock: boolean;
    reasons: string[];
    clean: boolean;
    dirty: boolean;
    mode: AegisCleanEntryGuardMode;
    metadata: {
        enabled: boolean;
        mode: AegisCleanEntryGuardMode;
        decision: AegisCleanEntryGuardDecision;
        allowed: boolean;
        wouldBlock: boolean;
        clean: boolean;
        dirty: boolean;
        reasons: string[];
        symbol: string;
        side: 'LONG' | 'SHORT';
        turboScore?: number;
        votes?: AegisCleanEntryGuardVotes;
        setupGrade?: AegisCleanEntrySetupGrade;
        decisionBrain?: string;
        entryQualityRecommendation?: string;
        entryQualityGateReason?: string;
        entryQualityGateAction?: string;
        entryQualityModelPresent?: boolean;
        entryQualityModelRecommendation?: string;
        entryQualityModelScore?: number | null;
        entryQualityModelFeatureStatus?: string;
        entryQualityModelFeatureParityPct?: number | null;
        entryQualityModelMissingFeaturesCount?: number | null;
        entryQualityModelScope?: string;
        entryQualityModelVersion?: string;
        featureStatus?: string;
        featureParityPct?: number | null;
        missingFeaturesCount?: number | null;
        modelScope?: string;
        modelVersion?: string;
        entryQualityRuleGateReason?: string;
        entryQualityRuleGateDecision?: string;
        entryQualityScore?: number | null;
        tailRiskScore?: number | null;
        eventRiskMode?: string;
        eventRiskWouldBlock?: boolean;
        eventRiskReason?: string;
        isPremiumSymbol?: boolean;
        extremeMomentumCandidate?: boolean;
        clean_entry_rule_gate_insufficient_context_ignored_due_to_model_ok?: boolean;
    };
}

export const DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG: AegisCleanEntryGuardConfig = {
    enabled: false,
    mode: 'SHADOW',
    useEntryQualityModelAsSourceOfTruth: true,
    ignoreRuleGateInsufficientDataWhenModelOk: true,
    minFeatureParityPct: 95,
    applyTo: {
        long: true,
        short: true
    },
    dirtyConditions: {
        blockWhenEntryQualityInsufficient: true,
        blockWhenEventRiskWouldBlock: true,
        blockWhenTailRiskGte: 0.45,
        blockWhenEntryQualityNotAllow: true
    },
    requireCleanForPremiumSymbols: true,
    cleanConditions: {
        requireDecisionBrainEnterNow: true,
        requireEntryQualityAllow: true,
        requireNoInsufficientData: true,
        requireEventRiskWouldBlockFalse: true,
        maxTailRiskScore: 0.40
    },
    exception: {
        allowExtremeMomentumInShadowOnly: true,
        minTurboScore: 0.97,
        requireVotes3Of3: true,
        maxTailRiskScore: 0.35
    },
    telemetry: {
        logAllEvaluations: false,
        includeInEntryMetadata: true
    }
};

function finiteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function normalized(value?: string): string | undefined {
    const text = String(value ?? '').trim().toUpperCase();
    return text || undefined;
}

function isEntryQualityAllow(value?: string): boolean {
    const recommendation = normalized(value);
    return recommendation === 'ALLOW' || recommendation === 'ALLOW_SHADOW';
}

function isInsufficientData(reason?: string): boolean {
    return normalized(reason) === 'INSUFFICIENT_DATA';
}

function sideVotes(input: AegisCleanEntryGuardInput): number {
    return input.side === 'LONG' ? input.votes?.long ?? 0 : input.votes?.short ?? 0;
}

function appliesToSide(input: AegisCleanEntryGuardInput): boolean {
    return input.side === 'LONG' ? input.applyTo.long !== false : input.applyTo.short !== false;
}

function hasCriticalMissingData(input: AegisCleanEntryGuardInput): boolean {
    return !normalized(input.decisionBrain)
        || !normalized(input.entryQualityModelRecommendation ?? input.entryQualityRecommendation)
        || input.eventRiskWouldBlock === undefined
        || !finiteNumber(input.tailRiskScore);
}

function isExtremeMomentumCandidate(input: AegisCleanEntryGuardInput): boolean {
    if (input.mode !== 'SHADOW') return false;
    if (input.exception.allowExtremeMomentumInShadowOnly !== true) return false;
    if (!finiteNumber(input.turboScore) || input.turboScore < input.exception.minTurboScore) return false;
    if (input.exception.requireVotes3Of3 && sideVotes(input) < 3) return false;
    if (!finiteNumber(input.tailRiskScore) || input.tailRiskScore > input.exception.maxTailRiskScore) return false;
    return true;
}

export function evaluateAegisCleanEntryGuard(input: AegisCleanEntryGuardInput): AegisCleanEntryGuardOutput {
    const mode: AegisCleanEntryGuardMode = input.mode === 'ENFORCE' ? 'ENFORCE' : 'SHADOW';
    const disabled = input.enabled !== true || !appliesToSide(input);
    const reasons: string[] = [];
    const decisionBrain = normalized(input.decisionBrain);
    const entryQualityModelRecommendation = normalized(input.entryQualityModelRecommendation ?? input.entryQualityRecommendation);
    const entryQualityRecommendation = entryQualityModelRecommendation;
    const entryQualityModelFeatureStatus = normalized(input.entryQualityModelFeatureStatus ?? input.featureStatus);
    const entryQualityRuleGateReason = normalized(input.entryQualityRuleGateReason ?? input.entryQualityGateReason);
    const entryQualityRuleGateDecision = normalized(input.entryQualityRuleGateDecision ?? input.entryQualityGateAction);
    const entryQualityGateReason = entryQualityRuleGateReason;
    const eventRiskMode = normalized(input.eventRiskMode);
    const entryQualityModelScore = finiteNumber(input.entryQualityModelScore)
        ? input.entryQualityModelScore
        : input.entryQualityScore;
    const rawFeatureParityPct = input.entryQualityModelFeatureParityPct ?? input.featureParityPct;
    const featureParityPct = finiteNumber(rawFeatureParityPct) ? rawFeatureParityPct : undefined;
    const minFeatureParityPct = finiteNumber(input.minFeatureParityPct) ? input.minFeatureParityPct : 95;
    const inferredModelPresent = Boolean(
        entryQualityModelRecommendation
        || finiteNumber(entryQualityModelScore)
        || finiteNumber(input.tailRiskScore)
        || entryQualityModelFeatureStatus
        || featureParityPct !== undefined
    );
    const modelPresent = input.entryQualityModelPresent !== undefined
        ? input.entryQualityModelPresent === true
        : inferredModelPresent;
    const modelFeaturesOk = modelPresent
        && entryQualityModelFeatureStatus === 'OK'
        && featureParityPct !== undefined
        && featureParityPct >= minFeatureParityPct
        && finiteNumber(entryQualityModelScore)
        && finiteNumber(input.tailRiskScore);
    const useModelSourceOfTruth = input.useEntryQualityModelAsSourceOfTruth !== false;
    const ignoreRuleInsufficientWhenModelOk = input.ignoreRuleGateInsufficientDataWhenModelOk !== false;
    const ruleGateInsufficientData = isInsufficientData(entryQualityRuleGateReason);

    if (disabled) {
        return buildOutput(input, {
            mode,
            decision: 'DISABLED',
            allowed: true,
            wouldBlock: false,
            clean: false,
            dirty: false,
            reasons: []
        });
    }

    const missingCriticalData = hasCriticalMissingData(input);
    if (missingCriticalData) {
        reasons.push('clean_entry_missing_critical_data');
    }

    if (
        useModelSourceOfTruth
        && !modelFeaturesOk
    ) {
        reasons.push('clean_entry_model_features_missing');
    } else if (
        input.dirtyConditions.blockWhenEntryQualityInsufficient
        && ruleGateInsufficientData
        && !(useModelSourceOfTruth && ignoreRuleInsufficientWhenModelOk && modelFeaturesOk)
    ) {
        reasons.push('clean_entry_rule_gate_insufficient_context');
    }

    if (
        input.dirtyConditions.blockWhenEventRiskWouldBlock
        && input.eventRiskWouldBlock === true
    ) {
        reasons.push('clean_entry_event_risk_would_block');
    }

    if (
        finiteNumber(input.tailRiskScore)
        && (
            input.tailRiskScore > input.cleanConditions.maxTailRiskScore
            || input.tailRiskScore >= input.dirtyConditions.blockWhenTailRiskGte
        )
    ) {
        reasons.push('clean_entry_tail_risk_high');
    }

    if (
        input.dirtyConditions.blockWhenEntryQualityNotAllow
        && (!useModelSourceOfTruth || modelFeaturesOk)
        && !isEntryQualityAllow(entryQualityRecommendation)
    ) {
        reasons.push('clean_entry_model_block_shadow');
    }

    if (decisionBrain !== 'ENTER_NOW') {
        reasons.push('clean_entry_decision_brain_not_enter_now');
    }

    const clean = !missingCriticalData
        && (!input.cleanConditions.requireDecisionBrainEnterNow || decisionBrain === 'ENTER_NOW')
        && (!useModelSourceOfTruth || modelFeaturesOk)
        && (!input.cleanConditions.requireEntryQualityAllow || isEntryQualityAllow(entryQualityRecommendation))
        && (
            !input.cleanConditions.requireNoInsufficientData
            || !ruleGateInsufficientData
            || (useModelSourceOfTruth && ignoreRuleInsufficientWhenModelOk && modelFeaturesOk)
        )
        && (!input.cleanConditions.requireEventRiskWouldBlockFalse || input.eventRiskWouldBlock === false)
        && finiteNumber(input.tailRiskScore)
        && input.tailRiskScore <= input.cleanConditions.maxTailRiskScore;

    const dirty = !clean || reasons.length > 0;
    const uniqueReasons = Array.from(new Set(reasons));
    if (!dirty) {
        return buildOutput(input, {
            mode,
            decision: 'ALLOW_CLEAN',
            allowed: true,
            wouldBlock: false,
            clean: true,
            dirty: false,
            reasons: []
        });
    }

    if (mode === 'ENFORCE') {
        return buildOutput(input, {
            mode,
            decision: 'WAIT_CONFIRMATION',
            allowed: false,
            wouldBlock: true,
            clean: false,
            dirty: true,
            reasons: uniqueReasons
        });
    }

    return buildOutput(input, {
        mode,
        decision: 'SHADOW_WAIT_CONFIRMATION',
        allowed: true,
        wouldBlock: true,
        clean: false,
        dirty: true,
        reasons: uniqueReasons
    });

    function buildOutput(
        source: AegisCleanEntryGuardInput,
        result: {
            mode: AegisCleanEntryGuardMode;
            decision: AegisCleanEntryGuardDecision;
            allowed: boolean;
            wouldBlock: boolean;
            clean: boolean;
            dirty: boolean;
            reasons: string[];
        }
    ): AegisCleanEntryGuardOutput {
        const metadata = {
            enabled: source.enabled === true,
            mode: result.mode,
            decision: result.decision,
            allowed: result.allowed,
            wouldBlock: result.wouldBlock,
            clean: result.clean,
            dirty: result.dirty,
            reasons: result.reasons,
            symbol: String(source.symbol || '').trim().toUpperCase(),
            side: source.side,
            turboScore: source.turboScore,
            votes: source.votes,
            setupGrade: source.setupGrade,
            decisionBrain,
            entryQualityRecommendation,
            entryQualityGateReason,
            entryQualityGateAction: source.entryQualityGateAction,
            entryQualityModelPresent: modelPresent,
            entryQualityModelRecommendation,
            entryQualityModelScore,
            entryQualityModelFeatureStatus,
            entryQualityModelFeatureParityPct: featureParityPct,
            entryQualityModelMissingFeaturesCount: source.entryQualityModelMissingFeaturesCount ?? source.missingFeaturesCount,
            entryQualityModelScope: source.entryQualityModelScope ?? source.modelScope,
            entryQualityModelVersion: source.entryQualityModelVersion ?? source.modelVersion,
            featureStatus: entryQualityModelFeatureStatus,
            featureParityPct,
            missingFeaturesCount: source.entryQualityModelMissingFeaturesCount ?? source.missingFeaturesCount,
            modelScope: source.entryQualityModelScope ?? source.modelScope,
            modelVersion: source.entryQualityModelVersion ?? source.modelVersion,
            entryQualityRuleGateReason,
            entryQualityRuleGateDecision,
            entryQualityScore: entryQualityModelScore,
            tailRiskScore: source.tailRiskScore,
            eventRiskMode,
            eventRiskWouldBlock: source.eventRiskWouldBlock,
            eventRiskReason: source.eventRiskReason,
            isPremiumSymbol: source.isPremiumSymbol,
            extremeMomentumCandidate: isExtremeMomentumCandidate(source),
            clean_entry_rule_gate_insufficient_context_ignored_due_to_model_ok:
                ruleGateInsufficientData && useModelSourceOfTruth && ignoreRuleInsufficientWhenModelOk && modelFeaturesOk
                    ? true
                    : undefined
        };

        return {
            decision: result.decision,
            allowed: result.allowed,
            wouldBlock: result.wouldBlock,
            reasons: result.reasons,
            clean: result.clean,
            dirty: result.dirty,
            mode: result.mode,
            metadata
        };
    }
}
