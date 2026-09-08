import { describe, expect, it } from 'vitest';
import {
  parseMicroBurstConfig,
  mergeMicroBurstConfigs,
  isMicroBurstShadowMode,
  isMicroBurstLiveMode,
} from '../application/MicroBurstConfigLoader';
import { microBurstConfigHash } from './MicroBurstConfigHash';

describe('MicroBurstConfigLoader', () => {
  const risk = {
    sizing_mode: 'MARGIN_FRACTION',
    margin_fraction: 0.9,
    medium_leverage: 20,
    high_leverage: 30,
    max_consecutive_net_losses: 3,
    reset_mode: 'SIGNED_OPERATOR',
    fee_reserve_bps: 14,
    stop_stress_bps: 10,
  };
  const contextual = (contextual_risk: unknown = risk) => ({
    micro_burst: {
      mode: 'SHADOW',
      exit_policy: { contextual_policy_version: 'CONTEXTUAL_V3' },
      contextual_risk,
    },
  });
  it('parses explicit margin mode without a USDT loss budget and binds it into the config hash', () => {
    const parsed = parseMicroBurstConfig(contextual());
    expect(parsed.contextualRisk).toEqual({
      sizingMode: 'MARGIN_FRACTION',
      marginFraction: 0.9,
      mediumLeverage: 20,
      highLeverage: 30,
      maxConsecutiveNetLosses: 3,
      resetMode: 'SIGNED_OPERATOR',
      feeReserveBps: 14,
      stopStressBps: 10,
    });
    expect(microBurstConfigHash(parsed)).not.toBe(
      microBurstConfigHash(parseMicroBurstConfig(contextual({ ...risk, margin_fraction: 0.8 }))),
    );
    expect(mergeMicroBurstConfigs(parsed, {}).contextualRisk).toEqual(parsed.contextualRisk);
    expect(parseMicroBurstConfig({ micro_burst: {} })).not.toHaveProperty('contextualRisk');
  });
  it.each([
    { sizing_mode: 'AUTO' },
    { sizing_mode: 'LOSS_BUDGET' },
    { margin_fraction: 0.91 },
    { margin_fraction: NaN },
    { margin_fraction: '0.9' },
    { medium_leverage: 10 },
    { high_leverage: 40 },
    { max_consecutive_net_losses: 999 },
    { reset_mode: 'DAILY' },
    { fee_reserve_bps: 13 },
    { stop_stress_bps: -1 },
    { loss_budget_usdt: 2 },
  ])('rejects unsafe or contradictory contextual risk %j', (override) => {
    expect(() => parseMicroBurstConfig(contextual({ ...risk, ...override }))).toThrow(
      'MICRO_CONTEXTUAL_RISK_CONFIG_INVALID',
    );
  });
  it('does not apply contextual risk to legacy policies or infer missing risk fields', () => {
    expect(() => parseMicroBurstConfig({ micro_burst: { contextual_risk: risk } })).toThrow(
      'MICRO_CONTEXTUAL_RISK_CONFIG_INVALID',
    );
    expect(() => parseMicroBurstConfig(contextual({ sizing_mode: 'MARGIN_FRACTION' }))).toThrow(
      'MICRO_CONTEXTUAL_RISK_CONFIG_INVALID',
    );
  });
  it('rejects V3 LIVE configuration rather than substituting the research exit manager', () => {
    expect(() =>
      parseMicroBurstConfig({
        micro_burst: {
          mode: 'LIVE',
          exit_policy: {
            contextual_policy_version: 'CONTEXTUAL_V3',
          },
        },
      }),
    ).toThrow('MICRO_CONTEXTUAL_POLICY_RESEARCH_ONLY');
  });
  it('keeps contextual policy opt-in and rejects unknown versions', () => {
    expect(parseMicroBurstConfig({ micro_burst: {} }).exitPolicy).toBeUndefined();
    expect(
      parseMicroBurstConfig({
        micro_burst: {
          mode: 'SHADOW',
          exit_policy: {
            contextual_policy_version: 'CONTEXTUAL_V3',
          },
        },
      }).exitPolicy?.contextualPolicyVersion,
    ).toBe('CONTEXTUAL_V3');
    expect(() =>
      parseMicroBurstConfig({
        micro_burst: {
          exit_policy: {
            contextual_policy_version: true,
          },
        },
      }),
    ).toThrow('MICRO_CONTEXTUAL_POLICY_INVALID');
  });
  it('returns disabled config for empty input', () => {
    const config = parseMicroBurstConfig(null);
    expect(config.enabled).toBe(false);
    expect(config.mode).toBe('OFF');
    expect(Object.keys(config.symbols)).toHaveLength(0);
  });

  it('parses valid micro_burst section', () => {
    const config = parseMicroBurstConfig({
      micro_burst: {
        enabled: true,
        mode: 'SHADOW',
        symbols: {
          BTCUSDT: { enabled: true },
          ETHUSDT: { enabled: false },
        },
      },
    });

    expect(config.enabled).toBe(true);
    expect(config.mode).toBe('SHADOW');
    expect(config.symbols.BTCUSDT.enabled).toBe(true);
    expect(config.symbols.ETHUSDT.enabled).toBe(false);
  });

  it('parses camelCase microBurst section', () => {
    const config = parseMicroBurstConfig({
      microBurst: {
        enabled: true,
        mode: 'SHADOW',
        symbols: { BTCUSDT: { enabled: true } },
      },
    });

    expect(config.enabled).toBe(true);
    expect(config.symbols.BTCUSDT.enabled).toBe(true);
  });

  it('parses deterministic exit-policy overrides and ignores invalid values', () => {
    const config = parseMicroBurstConfig({
      micro_burst: {
        enabled: true,
        mode: 'SHADOW',
        exit_policy: {
          exit_estimated_round_trip_cost_bps: 16,
          exit_winner_exit_pressure_threshold: 0.8,
          exit_proof_extension_ms: 45_000,
          exit_max_hold_ms: Number.NaN,
          unknown_field: 123,
        },
      },
    });

    expect(config.exitPolicy).toEqual({
      exitEstimatedRoundTripCostBps: 16,
      exitWinnerExitPressureThreshold: 0.8,
      exitProofExtensionMs: 45_000,
    });
  });

  it('defaults mode to OFF for unknown values', () => {
    const config = parseMicroBurstConfig({
      micro_burst: { enabled: true, mode: 'INVALID' },
    });
    expect(config.mode).toBe('OFF');
  });

  it('LIVE mode is parsed correctly', () => {
    const config = parseMicroBurstConfig({
      micro_burst: { enabled: true, mode: 'LIVE' },
    });
    expect(config.mode).toBe('LIVE');
  });

  it('mergeMicroBurstConfigs merges symbols', () => {
    const base = parseMicroBurstConfig({
      micro_burst: {
        enabled: false,
        mode: 'OFF',
        symbols: { BTCUSDT: { enabled: true } },
      },
    });

    const merged = mergeMicroBurstConfigs(base, {
      enabled: true,
      mode: 'SHADOW',
      symbols: { ETHUSDT: { enabled: true } },
      exitPolicy: { exitProofExtensionMs: 20_000 },
    });

    expect(merged.enabled).toBe(true);
    expect(merged.mode).toBe('SHADOW');
    expect(merged.symbols.BTCUSDT.enabled).toBe(true);
    expect(merged.symbols.ETHUSDT.enabled).toBe(true);
    expect(merged.exitPolicy?.exitProofExtensionMs).toBe(20_000);
  });

  it('isMicroBurstShadowMode returns true only when enabled+SHADOW', () => {
    expect(isMicroBurstShadowMode({ enabled: true, mode: 'SHADOW', symbols: {} })).toBe(true);
    expect(isMicroBurstShadowMode({ enabled: false, mode: 'SHADOW', symbols: {} })).toBe(false);
    expect(isMicroBurstShadowMode({ enabled: true, mode: 'OFF', symbols: {} })).toBe(false);
  });

  it('isMicroBurstLiveMode returns true only when enabled+LIVE', () => {
    expect(isMicroBurstLiveMode({ enabled: true, mode: 'LIVE', symbols: {} })).toBe(true);
    expect(isMicroBurstLiveMode({ enabled: true, mode: 'SHADOW', symbols: {} })).toBe(false);
  });
});
