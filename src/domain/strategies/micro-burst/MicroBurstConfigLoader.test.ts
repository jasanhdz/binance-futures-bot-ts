import { describe, expect, it } from 'vitest';
import {
  parseMicroBurstConfig,
  mergeMicroBurstConfigs,
  isMicroBurstShadowMode,
  isMicroBurstLiveMode,
} from './MicroBurstConfigLoader';

describe('MicroBurstConfigLoader', () => {
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
    });

    expect(merged.enabled).toBe(true);
    expect(merged.mode).toBe('SHADOW');
    expect(merged.symbols.BTCUSDT.enabled).toBe(true);
    expect(merged.symbols.ETHUSDT.enabled).toBe(true);
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
