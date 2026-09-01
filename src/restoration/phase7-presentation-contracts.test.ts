import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');

describe('Phase 7 presentation contracts', () => {
  it('keeps exit classification and numeric formatting outside TradingService', () => {
    const tradingService = readFileSync(
      resolve(repoRoot, 'src/app/services/TradingService.ts'),
      'utf8',
    );
    expect(tradingService).toContain('describeAegisExit');
    expect(tradingService).not.toMatch(
      /private (?:formatScore|formatRoe|formatSignedUsd|formatBracketLine|describeAegisExit)\b/,
    );
  });

  it('keeps the presentation formatter independent from TradingService', () => {
    const formatter = readFileSync(
      resolve(repoRoot, 'src/app/telegram/presentation/AegisExitMessageFormatter.ts'),
      'utf8',
    );
    expect(formatter).not.toContain('TradingService');
    expect(formatter).toContain('computeBracketPrice');
  });

  it('removes pure runtime-config forwarding methods from TradingService', () => {
    const tradingService = readFileSync(
      resolve(repoRoot, 'src/app/services/TradingService.ts'),
      'utf8',
    );
    const removedProxyNames = [
      'getMicroBurstConfig',
      'getMicroBurstProvenance',
      'getAegisTurboYamlConfig',
      'getAegisPhaseOShortLiveConfig',
      'getAegisExitEyeConfig',
      'getAegisProfitProtectionConfig',
      'getAegisPortfolioRiskConfig',
      'getAegisShortGateConfig',
      'getAegisEventRiskConfig',
      'getAegisDecisionEnforcementConfig',
      'getAegisTelegramNotificationsConfig',
      'getAegisPositionFractionOverride',
      'getAegisCleanEntryGuardConfig',
      'getAegisProbeModeConfig',
      'getAegisRegimeGuardConfig',
      'getAegisRegimeContextConfig',
      'getAegisMomentumRideConfig',
      'getAegisEntryPolicyConfig',
      'getEntryQualityGateConfig',
      'getAegisTurboRegimeConfig',
      'getAegisTurboGateConfig',
      'getAegisGuardianConfig',
    ];
    for (const name of removedProxyNames) {
      expect(tradingService).not.toMatch(new RegExp(`private ${name}\\s*\\(`));
    }
  });
});
