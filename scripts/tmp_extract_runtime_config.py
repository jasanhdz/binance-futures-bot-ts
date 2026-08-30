from pathlib import Path

path = Path('src/app/services/TradingService.ts')
text = path.read_text()

old_import = "import {\n  parseMicroBurstConfig,\n  mergeMicroBurstConfigs,\n  isMicroBurstShadowMode,\n} from '../../strategies/micro-burst/application/MicroBurstConfigLoader';"
new_import = "import {\n  parseMicroBurstConfig,\n  isMicroBurstShadowMode,\n} from '../../strategies/micro-burst/application/MicroBurstConfigLoader';"
if old_import in text:
    text = text.replace(old_import, new_import, 1)
text = text.replace("import { createHash } from 'node:crypto';\n", "", 1)

anchor = "import { PositionRecoveryService } from '../position/PositionRecoveryService';\n"
addition = anchor + "import { TradingRuntimeConfigService } from '../config/TradingRuntimeConfigService';\n"
if "TradingRuntimeConfigService" not in text:
    if anchor not in text:
        raise SystemExit('import anchor missing')
    text = text.replace(anchor, addition, 1)

prop_anchor = "  private readonly positionRecovery: PositionRecoveryService;\n"
if "private readonly runtimeConfig: TradingRuntimeConfigService;" not in text:
    if prop_anchor not in text:
        raise SystemExit('property anchor missing')
    text = text.replace(prop_anchor, prop_anchor + "  private readonly runtimeConfig: TradingRuntimeConfigService;\n", 1)

ctor_anchor = "    this.historyLogger = deps.historyLogger ?? new AegisTurboHistoryLogger({ logger: deps.logger });\n"
ctor_add = ctor_anchor + "    this.runtimeConfig = new TradingRuntimeConfigService(\n      deps.configManager,\n      () => this.getEntryQualityGateConfig(),\n    );\n"
if "this.runtimeConfig = new TradingRuntimeConfigService" not in text:
    if ctor_anchor not in text:
        raise SystemExit('constructor anchor missing')
    text = text.replace(ctor_anchor, ctor_add, 1)

start = text.find("  private getMicroBurstConfig(): ReturnType<typeof parseMicroBurstConfig> {")
end = text.find("  private asRecord(value: unknown): Record<string, any> | undefined {", start)
if start < 0 or end < 0:
    raise SystemExit('config block anchors missing')

wrappers = '''  private getMicroBurstConfig(): ReturnType<typeof parseMicroBurstConfig> {
    return this.runtimeConfig.getMicroBurstConfig();
  }

  private getMicroBurstProvenance(config: ReturnType<typeof parseMicroBurstConfig>) {
    return this.runtimeConfig.getMicroBurstProvenance(config);
  }

  private getAegisTurboYamlConfig(): AegisTurboYamlConfig | undefined {
    return this.runtimeConfig.getAegisTurboYamlConfig();
  }

  private getAegisPhaseOShortLiveConfig(): AegisPhaseOShortLiveYamlConfig | undefined {
    return this.runtimeConfig.getAegisPhaseOShortLiveConfig();
  }

  private getAegisExitEyeConfig(): AegisExitEyeYamlConfig {
    return this.runtimeConfig.getAegisExitEyeConfig();
  }

  private getAegisProfitProtectionConfig(): AegisProfitProtectionRuntimeConfig {
    return this.runtimeConfig.getAegisProfitProtectionConfig();
  }

  private getAegisPortfolioRiskConfig(): Required<AegisPortfolioRiskYamlConfig> {
    return this.runtimeConfig.getAegisPortfolioRiskConfig();
  }

  private getAegisShortGateConfig(): Required<AegisShortGateYamlConfig> {
    return this.runtimeConfig.getAegisShortGateConfig();
  }

  private getAegisEventRiskConfig(): AegisEventRiskRuntimeConfig {
    return this.runtimeConfig.getAegisEventRiskConfig();
  }

  private getAegisDecisionEnforcementConfig(): AegisDecisionEnforcementRuntimeConfig {
    return this.runtimeConfig.getAegisDecisionEnforcementConfig();
  }

  private getAegisTelegramNotificationsConfig(): AegisTelegramNotificationsRuntimeConfig {
    return this.runtimeConfig.getAegisTelegramNotificationsConfig();
  }

  private getAegisPositionFractionOverride(
    symbol: string,
    side: Side,
  ): AegisPositionFractionOverride | undefined {
    return this.runtimeConfig.getAegisPositionFractionOverride(symbol, side);
  }

  private getAegisCleanEntryGuardConfig(): AegisCleanEntryGuardRuntimeConfig {
    return this.runtimeConfig.getAegisCleanEntryGuardConfig();
  }

  private getAegisProbeModeConfig(): AegisProbeModeRuntimeConfig {
    return this.runtimeConfig.getAegisProbeModeConfig();
  }

  private getAegisRegimeGuardConfig(): AegisRegimeGuardConfig {
    return this.runtimeConfig.getAegisRegimeGuardConfig();
  }

  private getAegisRegimeContextConfig(): AegisRegimeContextRuntimeConfig {
    return this.runtimeConfig.getAegisRegimeContextConfig();
  }

  private getAegisMomentumRideConfig(): AegisMomentumRideRuntimeConfig {
    return this.runtimeConfig.getAegisMomentumRideConfig();
  }

  private getE4TailRiskConfig(): AegisEntryGuardPolicy {
    return this.runtimeConfig.getE4TailRiskConfig();
  }

  private getAegisEntryPolicyConfig(): AegisEntryPolicyRuntimeConfig {
    return this.runtimeConfig.getAegisEntryPolicyConfig();
  }

'''
text = text[:start] + wrappers + text[end:]
path.write_text(text)
