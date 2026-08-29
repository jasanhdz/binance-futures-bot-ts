import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG } from '../services/AegisCleanEntryGuard';
import { AegisEntryGuardOrchestrator } from './AegisEntryGuardOrchestrator';
import {
  AegisEntryContext,
  AegisEntryGuardName,
  AegisEntryPolicyRuntimeConfig,
} from './AegisEntryDecisionTypes';
import { CleanEntryGuardAdapter } from './guards/CleanEntryGuardAdapter';
import { DecisionBrainGuardAdapter } from './guards/DecisionBrainGuardAdapter';

const guardNames: AegisEntryGuardName[] = [
  'regime_context',
  'regime',
  'short_gate',
  'entry_quality',
  'event_risk',
  'decision_brain',
  'clean_entry',
  'probe_mode',
  'long_risk_shadow',
  'e4_tail_risk',
];

function policy(): AegisEntryPolicyRuntimeConfig {
  return {
    enabled: true,
    guards: Object.fromEntries(
      guardNames.map((name) => [name, { enabled: false, mode: 'OFF' }]),
    ) as AegisEntryPolicyRuntimeConfig['guards'],
  };
}

function context(): AegisEntryContext {
  return {
    symbol: 'ADAUSDT',
    side: 'LONG',
    rawAction: 'LONG',
    finalAction: 'LONG',
    turboScore: 0.94,
    votes: { long: 3, short: 0, neutral: 0 },
    leverage: 20,
    requestedPositionFraction: 0.1,
    basePositionFraction: 0.1,
    signal: {
      symbol: 'ADAUSDT',
      action: 'LONG',
      confidence: 0.94,
      source: 'AEGIS_TURBO',
      longProb: 0.94,
      shortProb: 0.03,
      neutralProb: 0.03,
    },
    gate: {
      allowed: true,
      side: 'LONG',
      reason: 'test_allowed',
      leverage: 20,
      positionFraction: 0.1,
      stopRoe: -0.15,
      takeProfitRoe: 0.25,
      trailingActivationRoe: 0.15,
      trailingCallbackRoe: 0.08,
      turboScore: 0.94,
      votes: { long: 3, short: 0, neutral: 0 },
    },
    entryQuality: {
      ruleGate: {
        enabled: false,
        mode: 'OFF',
        config: {
          minScoreLong: 0.65,
          minScoreShort: 0.7,
          requireMomentumConfirm: false,
          antiFallingKnifeEnabled: false,
          antiFallingKnifeLookbackCandles: 3,
          maxAdverseRecentReturn: 0.003,
          overextensionEnabled: false,
          emaDistanceLimit: 0.006,
          volatilityEnabled: false,
          maxAtrPercentile: 0.75,
        },
      },
    },
    eventRisk: { enabled: false, mode: 'NORMAL', enforce: false, isAltSymbol: true },
    cleanEntry: {
      config: { ...DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG, enabled: false, mode: 'SHADOW' },
    },
    probe: {
      config: {
        enabled: false,
        mode: 'OFF',
        apply_when_event_risk: [],
        min_turbo_score: 0.9,
        max_tail_risk_score: 0.3,
        require_decision_brain: 'ENTER_NOW',
        require_entry_quality_allow: true,
        require_feature_status_ok: true,
        min_feature_parity_pct: 95,
        allow_if_blocked_only_by: [],
        max_probe_entries_per_hour: 1,
        min_minutes_between_probe_entries: 60,
        max_open_probe_positions: 1,
        max_total_open_positions_when_probe: 2,
        block_after_consecutive_losses: 2,
        block_after_recent_stop_loss_minutes: 60,
      },
    },
    shortGate: { config: { enabled: false, mode: 'OFF' } },
    decisionEnforcement: {
      config: {
        enabled: false,
        mode: 'OFF',
        block_do_not_enter: false,
        block_wait_confirmation: false,
        block_manual_only: false,
        block_entry_quality_shadow_block_when_event_risk: { enabled: false, event_modes: [] },
        event_risk_enforcement: {
          caution_blocks_weak_entries: false,
          risk_off_blocks_non_a_plus: false,
          manual_only_blocks_all_new_entries: false,
        },
        block_caution_would_block_unless_a_plus: false,
        block_all_entry_quality_shadow_block: false,
        block_all_tail_risk_high: false,
      },
    },
    operational: {
      consecutiveLosses: 0,
      tradesToday: 0,
      openPositionsCount: 0,
      openProbePositions: 0,
      sameSymbolPositionExists: false,
      timestamp: 1,
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('AegisEntryGuardOrchestrator strategy authority', () => {
  it('keeps an Aegis allow attributed to Aegis only', async () => {
    const result = await AegisEntryGuardOrchestrator.evaluate(context(), policy());

    expect(result).toMatchObject({
      finalDecision: 'ALLOW',
      finalStrategy: 'aegis_turbo',
      strategy: 'aegis_turbo',
      adjustedLeverage: 20,
      adjustedPositionFraction: 0.1,
    });
    expect(result.strategyCandidates).toEqual({
      aegis_turbo: { decision: 'ALLOW', reason: 'all_enforced_guards_allowed' },
    });
    expect(result.guards.map((guard) => guard.name)).toEqual(guardNames);
    expect(JSON.stringify(result)).not.toContain('momentum_ride');
  });

  it('never converts an Aegis denial into Momentum', async () => {
    vi.spyOn(DecisionBrainGuardAdapter, 'evaluate').mockReturnValue({
      guard: {
        name: 'decision_brain',
        enabled: true,
        mode: 'ENFORCE',
        decision: 'DENY',
        reason: 'decision_brain_do_not_enter',
        wouldBlock: true,
        enforced: true,
        metadata: {},
      },
    });

    const result = await AegisEntryGuardOrchestrator.evaluate(context(), policy());

    expect(result).toMatchObject({
      finalDecision: 'DENY',
      finalStrategy: 'none',
      shouldOpen: false,
      deniedBy: 'decision_brain',
    });
    expect(JSON.stringify(result)).not.toContain('momentum_ride');
  });

  it('never converts an Aegis abstain into Momentum', async () => {
    vi.spyOn(CleanEntryGuardAdapter, 'evaluate').mockReturnValue({
      guard: {
        name: 'clean_entry',
        enabled: true,
        mode: 'ENFORCE',
        decision: 'WAIT',
        reason: 'clean_entry_wait_confirmation',
        wouldBlock: true,
        enforced: true,
        metadata: {},
      },
      decision: {
        allowed: false,
        decision: 'WAIT_CONFIRMATION',
        reason: 'clean_entry_wait_confirmation',
        metadata: {},
      } as any,
    });

    const result = await AegisEntryGuardOrchestrator.evaluate(context(), policy());

    expect(result).toMatchObject({
      finalDecision: 'WAIT_CONFIRMATION',
      finalStrategy: 'none',
      shouldOpen: false,
    });
    expect(JSON.stringify(result)).not.toContain('momentum_ride');
  });
});
