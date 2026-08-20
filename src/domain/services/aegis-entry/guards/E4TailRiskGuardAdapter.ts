import {
    AegisEntryContext,
    AegisEntryGuardPolicy,
    AegisEntryGuardResult,
    AegisEntryPolicyMode,
    guardDisabledResult,
    isGuardEnforced
} from '../AegisEntryDecisionTypes';
import { CONFIG } from '../../../../infra/config/environment';

export interface E4TailRiskResponse {
    available: boolean;
    symbol: string;
    side: string;
    decision_at: string;
    score: number | null;
    threshold: number;
    decision: 'ALLOW' | 'BLOCK';
    reason: string;
    model_version: string;
    feature_snapshot_hash: string;
    feature_available_at: string | null;
    source_feed_lag_ms: Record<string, number> | null;
    computed_at: string | null;
    cache_age_ms: number | null;
    snapshot_id?: string;
}

export interface E4TailRiskGuardAdapterResult {
    guard: AegisEntryGuardResult;
    e4Response: E4TailRiskResponse;
}

const E4_TIMEOUT_MS = 2000;
const FROZEN_THRESHOLD = 0.4522452210875323;

function computeFiveMinuteAlignedDecisionAt(): string {
    const now = new Date();
    const ms = now.getTime();
    const fiveMinMs = 5 * 60 * 1000;
    const alignedMs = Math.floor(ms / fiveMinMs) * fiveMinMs;
    return new Date(alignedMs).toISOString();
}

function buildUnavailableResult(
    symbol: string,
    side: string,
    reason: string
): E4TailRiskGuardAdapterResult {
    const response: E4TailRiskResponse = {
        available: false,
        symbol,
        side,
        decision_at: '',
        score: null,
        threshold: FROZEN_THRESHOLD,
        decision: 'BLOCK',
        reason,
        model_version: 'E4_V1_FROZEN',
        feature_snapshot_hash: '',
        feature_available_at: null,
        source_feed_lag_ms: null,
        computed_at: null,
        cache_age_ms: null
    };

    return {
        guard: {
            name: 'e4_tail_risk',
            enabled: true,
            mode: 'ENFORCE',
            decision: 'DENY',
            reason: `e4_unavailable_${reason}`,
            wouldBlock: true,
            enforced: true,
            metadata: {
                available: false,
                reason,
                score: null,
                threshold: FROZEN_THRESHOLD,
                riskDecision: 'BLOCK',
                modelVersion: 'E4_V1_FROZEN'
            }
        },
        e4Response: response
    };
}

function buildErrorResult(
    symbol: string,
    side: string,
    error: string
): E4TailRiskGuardAdapterResult {
    return buildUnavailableResult(symbol, side, `error_${error}`);
}

function buildFromResponse(
    e4: E4TailRiskResponse,
    policy: AegisEntryGuardPolicy,
    context: AegisEntryContext
): E4TailRiskGuardAdapterResult {
    if (!e4.available) {
        return {
            guard: {
                name: 'e4_tail_risk',
                enabled: true,
                mode: policy.mode ?? 'ENFORCE',
                decision: 'DENY',
                reason: `e4_unavailable_${e4.reason}`,
                wouldBlock: true,
                enforced: isGuardEnforced(policy),
                metadata: {
                    available: false,
                    score: null,
                    threshold: e4.threshold,
                    riskDecision: 'BLOCK',
                    reason: e4.reason,
                    modelVersion: e4.model_version
                }
            },
            e4Response: e4
        };
    }

    // Defect #12: Validate threshold is exact frozen value
    if (e4.threshold !== FROZEN_THRESHOLD) {
        return {
            guard: {
                name: 'e4_tail_risk',
                enabled: true,
                mode: policy.mode ?? 'ENFORCE',
                decision: 'DENY',
                reason: 'e4_threshold_mismatch',
                wouldBlock: true,
                enforced: isGuardEnforced(policy),
                metadata: {
                    available: true,
                    score: e4.score,
                    threshold: e4.threshold,
                    riskDecision: 'BLOCK',
                    reason: `threshold_mismatch: expected ${FROZEN_THRESHOLD}, got ${e4.threshold}`,
                    modelVersion: e4.model_version
                }
            },
            e4Response: e4
        };
    }

    // Defect #12: Validate non-empty model_version and feature_snapshot_hash
    if (!e4.model_version || e4.model_version.length === 0) {
        return {
            guard: {
                name: 'e4_tail_risk',
                enabled: true,
                mode: policy.mode ?? 'ENFORCE',
                decision: 'DENY',
                reason: 'e4_missing_model_version',
                wouldBlock: true,
                enforced: isGuardEnforced(policy),
                metadata: {
                    available: true,
                    score: e4.score,
                    threshold: e4.threshold,
                    riskDecision: 'BLOCK',
                    reason: 'missing_model_version',
                    modelVersion: e4.model_version
                }
            },
            e4Response: e4
        };
    }

    if (!e4.feature_snapshot_hash || e4.feature_snapshot_hash.length === 0) {
        return {
            guard: {
                name: 'e4_tail_risk',
                enabled: true,
                mode: policy.mode ?? 'ENFORCE',
                decision: 'DENY',
                reason: 'e4_missing_feature_hash',
                wouldBlock: true,
                enforced: isGuardEnforced(policy),
                metadata: {
                    available: true,
                    score: e4.score,
                    threshold: e4.threshold,
                    riskDecision: 'BLOCK',
                    reason: 'missing_feature_hash',
                    modelVersion: e4.model_version
                }
            },
            e4Response: e4
        };
    }

    if (e4.score === null || !Number.isFinite(e4.score)) {
        return {
            guard: {
                name: 'e4_tail_risk',
                enabled: true,
                mode: policy.mode ?? 'ENFORCE',
                decision: 'DENY',
                reason: 'e4_invalid_score',
                wouldBlock: true,
                enforced: isGuardEnforced(policy),
                metadata: {
                    available: true,
                    score: e4.score,
                    threshold: e4.threshold,
                    riskDecision: 'BLOCK',
                    reason: 'invalid_score',
                    modelVersion: e4.model_version
                }
            },
            e4Response: e4
        };
    }

    if (e4.score < 0 || e4.score > 1) {
        return {
            guard: {
                name: 'e4_tail_risk',
                enabled: true,
                mode: policy.mode ?? 'ENFORCE',
                decision: 'DENY',
                reason: 'e4_score_out_of_range',
                wouldBlock: true,
                enforced: isGuardEnforced(policy),
                metadata: {
                    available: true,
                    score: e4.score,
                    threshold: e4.threshold,
                    riskDecision: 'BLOCK',
                    reason: 'score_out_of_range',
                    modelVersion: e4.model_version
                }
            },
            e4Response: e4
        };
    }

    // Defect #12: Validate decision consistency with score/threshold
    const expectedDecision = e4.score >= FROZEN_THRESHOLD ? 'BLOCK' : 'ALLOW';
    if (e4.decision !== expectedDecision) {
        return {
            guard: {
                name: 'e4_tail_risk',
                enabled: true,
                mode: policy.mode ?? 'ENFORCE',
                decision: 'DENY',
                reason: 'e4_decision_inconsistent',
                wouldBlock: true,
                enforced: isGuardEnforced(policy),
                metadata: {
                    available: true,
                    score: e4.score,
                    threshold: e4.threshold,
                    riskDecision: 'BLOCK',
                    reason: `decision_inconsistent: expected ${expectedDecision}, got ${e4.decision}`,
                    modelVersion: e4.model_version
                }
            },
            e4Response: e4
        };
    }

    const wouldBlock = e4.decision === 'BLOCK';
    const enforced = isGuardEnforced(policy);

    return {
        guard: {
            name: 'e4_tail_risk',
            enabled: true,
            mode: policy.mode ?? 'ENFORCE',
            decision: wouldBlock ? (enforced ? 'DENY' : 'SHADOW_DENY') : 'ALLOW',
            reason: wouldBlock
                ? `e4_score_${e4.score.toFixed(6)}_above_threshold`
                : `e4_score_${e4.score.toFixed(6)}_below_threshold`,
            wouldBlock,
            enforced,
            metadata: {
                available: true,
                score: e4.score,
                threshold: e4.threshold,
                riskDecision: e4.decision,
                reason: e4.reason,
                featureHash: e4.feature_snapshot_hash,
                featureAvailableAt: e4.feature_available_at,
                sourceFeedLagMs: e4.source_feed_lag_ms,
                cacheAgeMs: e4.cache_age_ms,
                snapshotId: e4.snapshot_id,
                modelVersion: e4.model_version
            }
        },
        e4Response: e4
    };
}

export class E4TailRiskGuardAdapter {
    static async evaluate(
        context: AegisEntryContext,
        policy: AegisEntryGuardPolicy
    ): Promise<E4TailRiskGuardAdapterResult> {
        if (!policy.enabled || policy.mode === 'OFF') {
            return {
                guard: guardDisabledResult('e4_tail_risk'),
                e4Response: {
                    available: false,
                    symbol: context.symbol,
                    side: context.side,
                    decision_at: '',
                    score: null,
                    threshold: FROZEN_THRESHOLD,
                    decision: 'BLOCK',
                    reason: 'guard_disabled',
                    model_version: 'E4_V1_FROZEN',
                    feature_snapshot_hash: '',
                    feature_available_at: null,
                    source_feed_lag_ms: null,
                    computed_at: null,
                    cache_age_ms: null
                }
            };
        }

        const startTime = Date.now();
        const decisionAt = computeFiveMinuteAlignedDecisionAt();

        try {
            const response = await fetch(
                `${CONFIG.ML_SERVICE_URL}/ml-v2/e4_tail_risk`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        symbol: context.symbol,
                        side: context.side,
                        decision_at: decisionAt
                    }),
                    signal: AbortSignal.timeout(E4_TIMEOUT_MS)
                }
            );

            if (!response.ok) {
                return buildErrorResult(
                    context.symbol,
                    context.side,
                    `http_${response.status}`
                );
            }

            const e4: E4TailRiskResponse = await response.json();
            const result = buildFromResponse(e4, policy, context);

            result.guard.metadata = {
                ...result.guard.metadata,
                tsGuardLatencyMs: Date.now() - startTime
            };

            return result;

        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return buildErrorResult(context.symbol, context.side, msg);
        }
    }
}
