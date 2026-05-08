import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { NinjaConfigManager } from './ConfigLoader';

const tempFiles: string[] = [];

function writeConfig(symbolsYaml: string, symbolOverridesYaml = '{}'): string {
    const filePath = path.join(os.tmpdir(), `aegis-symbols-${Date.now()}-${Math.random()}.yaml`);
    fs.writeFileSync(filePath, `
SYMBOLS:
  ETHUSDT: 1.0
SYSTEM:
  tick_interval_ms: 2000
  max_trades_per_day: 100
  global_leverage_default: 15
  enable_sentinel: false
REGIME_DETECTOR:
  volatility_spread_low: 0.0008
  volatility_spread_high: 0.0015
  bias_strength_threshold: 0.20
  obi_confirmation_threshold: 0.10
IMMUNE_SYSTEM:
  alpha_slow_rise: 0.15
  alpha_fast_fall: 0.70
  panic_exit_threshold: 0.55
REGIMES:
  AEGIS_TURBO:
    leverage: 20
    entry_threshold: 0.60
    hard_stop_roe: -0.40
    tp_roe: 0.50
aegis:
  turbo:
    enabled: true
    live_enabled: true
${symbolsYaml}
SYMBOL_OVERRIDES: ${symbolOverridesYaml}
`);
    tempFiles.push(filePath);
    return filePath;
}

describe('NinjaConfigManager Aegis symbol modes', () => {
    const massShadowSymbols = [
        'BTCUSDT',
        'SOLUSDT',
        'BNBUSDT',
        'XRPUSDT',
        'DOGEUSDT',
        'ADAUSDT',
        'AVAXUSDT',
        'LINKUSDT',
        'SUIUSDT',
        'LTCUSDT'
    ];

    afterEach(() => {
        for (const filePath of tempFiles.splice(0)) {
            try {
                fs.unlinkSync(filePath);
            } catch {
                // best-effort cleanup
            }
        }
    });

    it('parses OFF, SHADOW and LIVE modes', () => {
        const config = new NinjaConfigManager(writeConfig(`
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
  BTCUSDT:
    enabled: true
    mode: SHADOW
  SOLUSDT:
    enabled: false
    mode: OFF
`));

        expect(config.getSymbolMode('ETHUSDT')).toBe('LIVE');
        expect(config.getSymbolMode('BTCUSDT')).toBe('SHADOW');
        expect(config.getSymbolMode('SOLUSDT')).toBe('OFF');
        expect(config.getActiveAegisSymbols()).toEqual(['ETHUSDT', 'BTCUSDT']);
        expect(config.getLiveAegisSymbols()).toEqual(['ETHUSDT']);
        expect(config.getShadowAegisSymbols()).toEqual(['BTCUSDT']);
    });

    it('defaults missing mode to SHADOW and disabled symbols to OFF', () => {
        const config = new NinjaConfigManager(writeConfig(`
symbols:
  BTCUSDT:
    enabled: true
  SOLUSDT:
    enabled: false
    mode: LIVE
`));

        expect(config.getSymbolMode('BTCUSDT')).toBe('SHADOW');
        expect(config.getSymbolMode('SOLUSDT')).toBe('OFF');
    });

    it('fails validation when more than one symbol is LIVE', () => {
        const config = new NinjaConfigManager(writeConfig(`
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
  BTCUSDT:
    enabled: true
    mode: LIVE
`));

        expect(() => config.validateSingleLiveAegisSymbol()).toThrow(
            'Multi-symbol LIVE is not safe yet: only one LIVE symbol is allowed until portfolio state is implemented.'
        );
    });

    it('accepts one LIVE symbol with ten SHADOW onboarding symbols', () => {
        const shadowYaml = massShadowSymbols
            .map((symbol) => `  ${symbol}:\n    enabled: true\n    mode: SHADOW`)
            .join('\n');
        const config = new NinjaConfigManager(writeConfig(`
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
${shadowYaml}
`));

        expect(config.getLiveAegisSymbols()).toEqual(['ETHUSDT']);
        expect(config.getShadowAegisSymbols()).toEqual(massShadowSymbols);
        expect(config.getActiveAegisSymbols()).toEqual(['ETHUSDT', ...massShadowSymbols]);
        expect(() => config.validateSingleLiveAegisSymbol()).not.toThrow();
    });

    it('applies conservative AEGIS_TURBO leverage overrides per onboarding symbol', () => {
        const shadowYaml = massShadowSymbols
            .map((symbol) => `  ${symbol}:\n    enabled: true\n    mode: SHADOW`)
            .join('\n');
        const leverageBySymbol = {
            ETHUSDT: 20,
            BTCUSDT: 20,
            SOLUSDT: 15,
            BNBUSDT: 15,
            XRPUSDT: 15,
            DOGEUSDT: 10,
            ADAUSDT: 12,
            AVAXUSDT: 12,
            LINKUSDT: 12,
            SUIUSDT: 8,
            LTCUSDT: 15
        };
        const overrideYaml = `
  ETHUSDT:
    AEGIS_TURBO:
      leverage: 20
  BTCUSDT:
    AEGIS_TURBO:
      leverage: 20
  SOLUSDT:
    AEGIS_TURBO:
      leverage: 15
  BNBUSDT:
    AEGIS_TURBO:
      leverage: 15
  XRPUSDT:
    AEGIS_TURBO:
      leverage: 15
  DOGEUSDT:
    AEGIS_TURBO:
      leverage: 10
  ADAUSDT:
    AEGIS_TURBO:
      leverage: 12
  AVAXUSDT:
    AEGIS_TURBO:
      leverage: 12
  LINKUSDT:
    AEGIS_TURBO:
      leverage: 12
  SUIUSDT:
    AEGIS_TURBO:
      leverage: 8
  LTCUSDT:
    AEGIS_TURBO:
      leverage: 15`;
        const config = new NinjaConfigManager(writeConfig(`
symbols:
  ETHUSDT:
    enabled: true
    mode: LIVE
${shadowYaml}
`, overrideYaml));

        for (const [symbol, leverage] of Object.entries(leverageBySymbol)) {
            expect(config.getRegimeConfig('AEGIS_TURBO', symbol).leverage).toBe(leverage);
        }
        expect(config.getRegimeConfig('AEGIS_TURBO', 'UNKNOWNUSDT').leverage).toBe(20);
        expect(config.getRegimeConfig('AEGIS_TURBO', 'SUIUSDT').hardStopRoe).toBe(-0.40);
        expect(config.getRegimeConfig('AEGIS_TURBO', 'SUIUSDT').entryThreshold).toBe(0.60);
    });
});
