import { describe, expect, it } from 'vitest';
import {
  AegisRegimeGuard,
  AegisRegimeGuardConfig,
  AegisRegimeGuardInput,
  DEFAULT_AEGIS_REGIME_GUARD_CONFIG,
} from './AegisRegimeGuard';

function config(overrides: Partial<AegisRegimeGuardConfig> = {}): AegisRegimeGuardConfig {
  return {
    ...DEFAULT_AEGIS_REGIME_GUARD_CONFIG,
    enabled: true,
    mode: 'ENFORCE',
    blockWhen: ['CHOP', 'EXHAUSTION', 'RISK_OFF', 'HIGH_VOL_RISK', 'UNKNOWN'],
    telemetry: {
      ...DEFAULT_AEGIS_REGIME_GUARD_CONFIG.telemetry,
    },
    ...overrides,
  };
}

function input(overrides: Partial<AegisRegimeGuardInput> = {}): AegisRegimeGuardInput {
  return {
    symbol: 'ADAUSDT',
    side: 'LONG',
    isAltSymbol: true,
    turboScore: 0.94,
    votes: { long: 3, short: 0, neutral: 0 },
    setupGrade: 'A',
    entryQualityScore: 0.82,
    tailRiskScore: 0.2,
    eventRiskMode: 'NORMAL',
    eventRiskReason: 'event_risk_normal',
    eventRiskWouldBlock: false,
    btcAction: 'LONG',
    btcScore: 0.82,
    btcVotes: { long: 3, short: 0, neutral: 0 },
    ethAction: 'LONG',
    ethScore: 0.8,
    ethVotes: { long: 3, short: 0, neutral: 0 },
    snapshotAgeSeconds: 60,
    nowMs: Date.parse('2026-05-21T12:00:00Z'),
    config: config(),
    ...overrides,
  };
}

describe('AegisRegimeGuard', () => {
  it('does not block when OFF', () => {
    const result = AegisRegimeGuard.evaluate(
      input({
        config: config({ enabled: false, mode: 'OFF' }),
      }),
    );

    expect(result.allowed).toBe(true);
    expect(result.wouldBlock).toBe(false);
    expect(result.reason).toBe('regime_disabled');
  });

  it('marks SHADOW wouldBlock without enforcing at domain level', () => {
    const result = AegisRegimeGuard.evaluate(
      input({
        setupGrade: 'WEAK',
        votes: { long: 2, short: 0, neutral: 1 },
        turboScore: 0.72,
        btcAction: 'HOLD',
        ethAction: 'HOLD',
        config: config({ mode: 'SHADOW' }),
      }),
    );

    expect(result.regime).toBe('CHOP');
    expect(result.allowed).toBe(false);
    expect(result.wouldBlock).toBe(true);
    expect(result.reason).toBe('regime_btc_eth_not_aligned');
  });

  it('blocks CHOP in ENFORCE', () => {
    const result = AegisRegimeGuard.evaluate(
      input({
        setupGrade: 'WEAK',
        votes: { long: 2, short: 0, neutral: 1 },
        turboScore: 0.72,
        btcAction: 'LONG',
        ethAction: 'SHORT',
      }),
    );

    expect(result.regime).toBe('CHOP');
    expect(result.wouldBlock).toBe(true);
    expect(result.allowed).toBe(false);
  });

  it('blocks RISK_OFF in ENFORCE', () => {
    const result = AegisRegimeGuard.evaluate(
      input({
        eventRiskMode: 'RISK_OFF',
      }),
    );

    expect(result.regime).toBe('RISK_OFF');
    expect(result.reason).toBe('regime_risk_off_block');
    expect(result.wouldBlock).toBe(true);
  });

  it('blocks UNKNOWN when UNKNOWN is in blockWhen', () => {
    const result = AegisRegimeGuard.evaluate(
      input({
        turboScore: undefined,
        votes: undefined,
        setupGrade: undefined,
        btcAction: undefined,
        ethAction: undefined,
        isAltSymbol: false,
      }),
    );

    expect(result.regime).toBe('UNKNOWN');
    expect(result.reason).toBe('regime_unknown_block');
    expect(result.wouldBlock).toBe(true);
  });

  it('does not block UNKNOWN when UNKNOWN is not in blockWhen', () => {
    const result = AegisRegimeGuard.evaluate(
      input({
        turboScore: undefined,
        votes: undefined,
        setupGrade: undefined,
        btcAction: undefined,
        ethAction: undefined,
        isAltSymbol: false,
        config: config({ blockWhen: ['RISK_OFF', 'HIGH_VOL_RISK'] }),
      }),
    );

    expect(result.regime).toBe('UNKNOWN');
    expect(result.reason).toBe('regime_low_confidence');
    expect(result.wouldBlock).toBe(false);
  });

  it('blocks alt LONG when BTC is SHORT and configured disallowed', () => {
    const result = AegisRegimeGuard.evaluate(
      input({
        btcAction: 'SHORT',
        ethAction: 'LONG',
      }),
    );

    expect(result.reason).toBe('regime_alt_long_btc_short_block');
    expect(result.wouldBlock).toBe(true);
  });

  it('blocks alt SHORT when BTC is LONG and configured disallowed', () => {
    const result = AegisRegimeGuard.evaluate(
      input({
        side: 'SHORT',
        votes: { long: 0, short: 3, neutral: 0 },
        btcAction: 'LONG',
        ethAction: 'SHORT',
      }),
    );

    expect(result.reason).toBe('regime_alt_short_btc_long_block');
    expect(result.wouldBlock).toBe(true);
  });

  it('allows aligned momentum LONG with high score and 3 of 3 votes', () => {
    const result = AegisRegimeGuard.evaluate(input());

    expect(result.regime).toBe('MOMENTUM_UP');
    expect(result.reason).toBe('regime_trade_allowed');
    expect(result.allowed).toBe(true);
  });

  it('allows aligned momentum SHORT with high score and 3 of 3 votes', () => {
    const result = AegisRegimeGuard.evaluate(
      input({
        side: 'SHORT',
        votes: { long: 0, short: 3, neutral: 0 },
        btcAction: 'SHORT',
        ethAction: 'SHORT',
      }),
    );

    expect(result.regime).toBe('MOMENTUM_DOWN');
    expect(result.reason).toBe('regime_trade_allowed');
    expect(result.allowed).toBe(true);
  });

  it('classifies high tail risk as HIGH_VOL_RISK', () => {
    const result = AegisRegimeGuard.evaluate(
      input({
        tailRiskScore: 0.5,
      }),
    );

    expect(result.regime).toBe('HIGH_VOL_RISK');
    expect(result.reason).toBe('regime_tail_risk_high');
    expect(result.wouldBlock).toBe(true);
  });

  it('marks stale snapshots', () => {
    const result = AegisRegimeGuard.evaluate(
      input({
        snapshotAgeSeconds: 901,
      }),
    );

    expect(result.regime).toBe('UNKNOWN');
    expect(result.reason).toBe('regime_stale_snapshot');
    expect(result.wouldBlock).toBe(true);
  });

  it('marks low confidence when an otherwise allowed regime is below minConfidence', () => {
    const result = AegisRegimeGuard.evaluate(
      input({
        config: config({ minConfidence: 0.9 }),
      }),
    );

    expect(result.regime).toBe('MOMENTUM_UP');
    expect(result.reason).toBe('regime_low_confidence');
    expect(result.wouldBlock).toBe(true);
  });

  it('returns model unavailable for ML_MODEL until the client exists', () => {
    const result = AegisRegimeGuard.evaluate(
      input({
        config: config({ source: 'ML_MODEL' }),
      }),
    );

    expect(result.regime).toBe('UNKNOWN');
    expect(result.source).toBe('ML_MODEL');
    expect(result.reason).toBe('regime_model_unavailable');
    expect(result.metadata.modelUnavailable).toBe(true);
  });
});
