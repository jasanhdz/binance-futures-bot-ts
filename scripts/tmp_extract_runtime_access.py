from pathlib import Path

cfg = Path('src/app/config/TradingRuntimeConfigService.ts')
t = cfg.read_text()

# Imports required by the remaining runtime access/config methods.
t = t.replace("import { Side } from '../../core/types';", "import { Side } from '../../core/types';\nimport { DEFAULT_GUARDIAN_CONFIG, GuardianConfig } from '../../domain/services/ProfitGuardian';\nimport { RegimeConfig } from '../ports/RegimeStrategy';\nimport { buildAegisMicroLiveGateConfigFromEnv } from '../../strategies/aegis/domain/services/AegisMicroLiveGate';\nimport { CONFIG } from '../../infra/config/environment';")
t = t.replace("  AegisTurboYamlConfig,\n  NinjaConfigManager,", "  AegisTurboYamlConfig,\n  AegisSymbolMode,\n  NinjaConfigManager,")

# Remove callback dependency: the config facade itself owns the entry-quality fallback.
t = t.replace("  constructor(\n    private readonly manager: NinjaConfigManager,\n    private readonly entryQualityGateConfig: () => AegisEntryQualityGateRuntimeConfig,\n  ) {}", "  constructor(private readonly manager: NinjaConfigManager) {}")
t = t.replace("    const entryQualityGate = this.entryQualityGateConfig();", "    const entryQualityGate = this.getEntryQualityGateConfig();")

insert = '''
  getEntryQualityGateConfig(symbol?: string): AegisEntryQualityGateRuntimeConfig {
    const manager = this.manager as any;
    if (typeof manager.getEntryQualityGateConfig === 'function') {
      return manager.getEntryQualityGateConfig(symbol);
    }
    return {
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
    };
  }

  getAegisTurboRegimeConfig(symbol?: string): RegimeConfig | undefined {
    const manager = this.manager as any;
    return typeof manager.getRegimeConfig === 'function'
      ? manager.getRegimeConfig('AEGIS_TURBO', symbol)
      : undefined;
  }

  getAegisTurboGateConfig(symbol: string) {
    return buildAegisMicroLiveGateConfigFromEnv(
      CONFIG,
      this.getAegisTurboYamlConfig(),
      this.getAegisTurboRegimeConfig(symbol),
    );
  }

  getAegisGuardianConfig(symbol: string, regimeConfig?: RegimeConfig): GuardianConfig {
    const manager = this.manager as any;
    if (typeof manager.getGuardianConfig === 'function') {
      return manager.getGuardianConfig('AEGIS_TURBO', symbol);
    }
    return {
      ...DEFAULT_GUARDIAN_CONFIG,
      beTriggerRoe: regimeConfig?.beRoe ?? DEFAULT_GUARDIAN_CONFIG.beTriggerRoe,
      trailingActivationRoe:
        regimeConfig?.trailingActivationRoe ?? DEFAULT_GUARDIAN_CONFIG.trailingActivationRoe,
      trailingCallbackRoe:
        regimeConfig?.trailingCallbackRoe ?? DEFAULT_GUARDIAN_CONFIG.trailingCallbackRoe,
      atrMultiplier: 1.5,
    };
  }

  getSymbolMode(symbol: string): AegisSymbolMode {
    const manager = this.manager as any;
    return typeof manager.getSymbolMode === 'function' ? manager.getSymbolMode(symbol) : 'LIVE';
  }

  getLiveAegisSymbols(fallbackSymbols: string[]): string[] {
    const manager = this.manager as any;
    return typeof manager.getLiveAegisSymbols === 'function'
      ? manager.getLiveAegisSymbols()
      : [fallbackSymbols[0]].filter(Boolean);
  }

  canExecuteLive(symbol: string, tradingMode: string): boolean {
    const turbo = this.getAegisTurboYamlConfig();
    return (
      tradingMode === 'AEGIS_TURBO_MICRO_LIVE' &&
      CONFIG.AEGIS_LIVE_ENABLED === true &&
      this.getSymbolMode(symbol) === 'LIVE' &&
      turbo?.enabled === true &&
      turbo?.live_enabled === true
    );
  }
'''
if 'getEntryQualityGateConfig(symbol?: string)' not in t:
    idx = t.rfind('\n}')
    if idx < 0: raise SystemExit('config class end missing')
    t = t[:idx] + insert + t[idx:]
cfg.write_text(t)

svc = Path('src/app/services/TradingService.ts')
s = svc.read_text()
s = s.replace("    this.runtimeConfig = new TradingRuntimeConfigService(\n      deps.configManager,\n      () => this.getEntryQualityGateConfig(),\n    );", "    this.runtimeConfig = new TradingRuntimeConfigService(deps.configManager);")

start = s.find('  private getEntryQualityGateConfig(symbol?: string): AegisEntryQualityGateRuntimeConfig {')
end = s.find('  private normalizeSymbol(symbol: string): string {', start)
if start < 0 or end < 0: raise SystemExit('TradingService runtime config block anchors missing')
wrappers = '''  private getEntryQualityGateConfig(symbol?: string): AegisEntryQualityGateRuntimeConfig {
    return this.runtimeConfig.getEntryQualityGateConfig(symbol);
  }

  private getAegisTurboRegimeConfig(symbol?: string): RegimeConfig | undefined {
    return this.runtimeConfig.getAegisTurboRegimeConfig(symbol);
  }

  private getAegisTurboGateConfig(symbol: string) {
    return this.runtimeConfig.getAegisTurboGateConfig(symbol);
  }

  private getAegisGuardianConfig(symbol: string, regimeConfig?: RegimeConfig): GuardianConfig {
    return this.runtimeConfig.getAegisGuardianConfig(symbol, regimeConfig);
  }

  private getSymbolMode(symbol: string): AegisSymbolMode {
    return this.runtimeConfig.getSymbolMode(symbol);
  }

  private getLiveAegisSymbols(): string[] {
    return this.runtimeConfig.getLiveAegisSymbols(this.config.symbols);
  }

  private canExecuteLive(symbol: string): boolean {
    return this.runtimeConfig.canExecuteLive(symbol, this.getTradingMode());
  }

'''
s = s[:start] + wrappers + s[end:]
svc.write_text(s)
