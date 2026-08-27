import { describe, expect, it } from 'vitest';
import { AegisProbeMode, AegisProbeModeInput, AegisProbeModeRuntimeConfig } from './AegisProbeMode';

function config(overrides: Partial<AegisProbeModeRuntimeConfig> = {}): AegisProbeModeRuntimeConfig {
  return {
    enabled: true,
    mode: 'ENFORCE',
    apply_when_event_risk: ['CAUTION'],
    min_turbo_score: 0.9,
    max_tail_risk_score: 0.3,
    require_decision_brain: 'ENTER_NOW',
    require_entry_quality_allow: true,
    require_feature_status_ok: true,
    min_feature_parity_pct: 95,
    allow_if_blocked_only_by: [
      'clean_entry_event_risk_would_block',
      'caution_btc_eth_not_confirmed',
    ],
    max_probe_entries_per_hour: 1,
    min_minutes_between_probe_entries: 60,
    max_open_probe_positions: 1,
    max_total_open_positions_when_probe: 2,
    block_after_consecutive_losses: 2,
    block_after_recent_stop_loss_minutes: 60,
    ...overrides,
  };
}

function input(overrides: Partial<AegisProbeModeInput> = {}): AegisProbeModeInput {
  return {
    config: config(),
    nowMs: Date.parse('2026-05-20T12:00:00Z'),
    symbol: 'ADAUSDT',
    side: 'LONG',
    turboScore: 0.94,
    votes: { long: 2, short: 1, neutral: 0 },
    setupGrade: 'A',
    decisionBrain: 'ENTER_NOW',
    entryQualityRecommendation: 'ALLOW_SHADOW',
    entryQualityGateAction: 'SHADOW_ALLOW',
    featureStatus: 'ok',
    featureParityPct: 100,
    tailRiskScore: 0.2,
    eventRiskMode: 'CAUTION',
    eventRiskReason: 'caution_btc_eth_not_confirmed',
    eventRiskWouldBlock: true,
    cleanEntryReasons: ['clean_entry_event_risk_would_block'],
    probeEntryTimestamps: [],
    openProbePositions: 0,
    totalOpenPositions: 0,
    sameSymbolOpen: false,
    consecutiveLosses: 0,
    ...overrides,
  };
}

describe('AegisProbeMode', () => {
  it('allows CAUTION clean setup blocked only by EventRisk', () => {
    expect(AegisProbeMode.evaluate(input()).allowed).toBe(true);
  });

  it('denies when TailRisk is above 0.30', () => {
    expect(AegisProbeMode.evaluate(input({ tailRiskScore: 0.31 })).reason).toBe(
      'probe_tail_risk_too_high',
    );
  });

  it('denies when turbo score is below 0.90', () => {
    expect(AegisProbeMode.evaluate(input({ turboScore: 0.899 })).reason).toBe(
      'probe_turbo_score_too_low',
    );
  });

  it('denies DecisionBrain WAIT_CONFIRMATION', () => {
    expect(AegisProbeMode.evaluate(input({ decisionBrain: 'WAIT_CONFIRMATION' })).reason).toBe(
      'probe_decision_brain_not_enter_now',
    );
  });

  it('denies EntryQuality BLOCK_SHADOW', () => {
    expect(
      AegisProbeMode.evaluate(input({ entryQualityRecommendation: 'BLOCK_SHADOW' })).reason,
    ).toBe('probe_entry_quality_block_shadow');
  });

  it('denies RISK_OFF', () => {
    expect(AegisProbeMode.evaluate(input({ eventRiskMode: 'RISK_OFF' })).reason).toBe(
      'probe_event_risk_risk_off',
    );
  });

  it('denies MANUAL_ONLY', () => {
    expect(AegisProbeMode.evaluate(input({ eventRiskMode: 'MANUAL_ONLY' })).reason).toBe(
      'probe_event_risk_manual_only',
    );
  });

  it('respects min_minutes_between_probe_entries', () => {
    const nowMs = Date.parse('2026-05-20T12:00:00Z');
    expect(
      AegisProbeMode.evaluate(input({ nowMs, lastProbeAt: nowMs - 30 * 60 * 1000 })).reason,
    ).toBe('probe_min_minutes_between_entries');
  });

  it('respects max_probe_entries_per_hour', () => {
    const nowMs = Date.parse('2026-05-20T12:00:00Z');
    expect(
      AegisProbeMode.evaluate(input({ nowMs, probeEntryTimestamps: [nowMs - 45 * 60 * 1000] }))
        .reason,
    ).toBe('probe_entries_per_hour_exceeded');
  });

  it('respects max_open_probe_positions', () => {
    expect(AegisProbeMode.evaluate(input({ openProbePositions: 1 })).reason).toBe(
      'probe_open_probe_positions_exceeded',
    );
  });

  it('respects max_total_open_positions_when_probe', () => {
    expect(AegisProbeMode.evaluate(input({ totalOpenPositions: 2 })).reason).toBe(
      'probe_total_open_positions_exceeded',
    );
  });

  it('does not allow after configured consecutive losses', () => {
    expect(AegisProbeMode.evaluate(input({ consecutiveLosses: 2 })).reason).toBe(
      'probe_consecutive_losses',
    );
  });

  it('does not allow after recent stop loss', () => {
    const nowMs = Date.parse('2026-05-20T12:00:00Z');
    expect(
      AegisProbeMode.evaluate(input({ nowMs, lastStopLossAt: nowMs - 10 * 60 * 1000 })).reason,
    ).toBe('probe_recent_stop_loss');
  });

  it('denies non-EventRisk Clean Entry block reasons', () => {
    expect(
      AegisProbeMode.evaluate(input({ cleanEntryReasons: ['clean_entry_tail_risk_high'] })).reason,
    ).toBe('probe_clean_entry_block_reasons_not_allowed');
  });
});
