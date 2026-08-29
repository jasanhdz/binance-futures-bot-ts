import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AegisMicroLiveGateConfig,
  AegisMicroLiveGateContext,
  shouldEnterAegisTurboMicroLive,
} from '../strategies/aegis/domain/services/AegisMicroLiveGate';
import { AegisPortfolioRiskGuard } from '../strategies/aegis/domain/services/AegisPortfolioRiskGuard';
import {
  CURRENT_BRAIN_AUTHORITY,
  CURRENT_BRAIN_BUNDLE_SHA256,
  CURRENT_BRAIN_CONFIGURATION_SHA256,
  CURRENT_BRAIN_CONTRACT_VERSION,
  CURRENT_BRAIN_FEATURE_COUNT,
  CURRENT_BRAIN_FEATURE_SCHEMA,
  CURRENT_BRAIN_MODEL_ID,
  CURRENT_BRAIN_MODEL_SHA256,
} from '../strategies/aegis/domain/CurrentBrainCanonicalDecision';

const BASELINE = '7f47abd216e7ac419e3d54006ce945bafcc83d90';
const repoRoot = resolve(__dirname, '../..');

function sha256(path: string): string {
  return createHash('sha256')
    .update(readFileSync(resolve(repoRoot, path)))
    .digest('hex');
}

const baselineOperationalDigests: Record<string, string> = {
  // Phase 3: capability ports split while operational method contracts remain unchanged.
  'src/app/ports/Exchange.ts': 'a90246d4ac1c015c6a6d6ba5f8d00fa09bda601360227928fc77c6e6f65d84f5',
  'src/infra/adapters/BinanceAdapter.ts':
    'd0a73dad2dcbb48511772a6e3764de4f07b17e52e4758f4fa5a7ce56f6b3e69f',
  'src/infra/config/environment.ts':
    '5bddf440b6dfb598531042477e6ea2a00a15d8be8372e44063196045168bfa05',
  'src/strategies/aegis/domain/services/AegisPortfolioRiskGuard.ts':
    'acf0dcf1583c9b72bef06ffaeb932abe04a3f9ea803220f725cec97d733b8b2d',
  'src/domain/services/ProfitGuardian.ts':
    'f95512ac4ecd82449dff30a1f63441f7297e57adf8b58ca32d8cca5409aa62fd',
  'src/infra/logging/FsStateStore.ts':
    'fed954908b5b5fb6c80079a8aadc6d01651cdab509abea7e2466984803c6ee07',
};

// Phase 1 owner-authorized architecture checkpoint. These are operational
// source/config digests, not scientific model or freeze-manifest hashes.
const ownerAuthorizedCurrentBrainContractDigests: Record<string, string> = {
  // Owner-authorized process entry point and application composition root.
  'src/main.ts': '2f4cd5e58561cb034cbb87311cfdaecf58401ecb49f69110d4dc99d8272e7a35',
  'config/regime_config.example.yaml':
    'c9ccac14d769da29497f38538f21ba1f3e0abf96c8dbc8647407e8007750ede5',
  // Phase 1 cleanup: removed the dormant Sentinel config surface.
  'regime_config.live.yaml': '2d6cca27e6c0d8efad5c78957e7ce9772d2ea7dd396731251298dc46ee6b2165',
  'src/app/services/TradingService.ts':
    '7334ddf23c77d2ebeccb2a97ecc7cf4ba48aadeebd79ba0811bcae75f9459ab1',
  'src/app/telegram/AegisBlocksReportService.ts':
    'b0941744ffa3911da4b9a56958dabbba4d0f9208ff0e040283c33bb25f9dd973',
  'src/app/telegram/TelegramCommandHandlers.ts':
    '50f7637f38a66b07cd8a9d2e9d423c89fb7c13fdec4b7a045b476abf93fec31c',
  'src/domain/index.ts': 'f101e9903e71c0a84118c09a9a0a0809dbe55fb72513c3785fa108a777443f63',
  'src/strategies/aegis/domain/AegisStrategy.ts':
    '13ed0714ec4c7e00cf9814d1761e478b0dd349e4f024a81ae3277395202cc51f',
  'src/strategies/aegis/domain/services/AegisOperationalDispositionShadow.ts':
    '56a91f34c47d934259b27a5d4acaa1f06811c2eeef0191f0bcb3801d948b1756',
  'src/strategies/aegis/domain/services/AegisExitEyeV2Shadow.ts':
    'c42df7df36033370442b24d0c49ccbfaf40745cbbe25380c508536f34f084172',
  'src/strategies/aegis/domain/services/AegisCleanEntryGuard.ts':
    '87c20efe19e2a36816be9ffa2951be5ed5c023b112d5865531f1296e5c144e8c',
  'src/strategies/aegis/domain/services/AegisEntryQualityGate.ts':
    'a3703fb5739eb59715ade631befa0a4ed08871b0e7c7e652effbfd003ec9f18f',
  'src/strategies/aegis/domain/services/AegisMicroLiveGate.ts':
    '7ea25e0988fd311a9e8241323ccdfdcc0962828b0ee4dfe152722abdd66d3a14',
  'src/strategies/aegis/domain/services/AegisProbeMode.ts':
    'f16c3b1f2328acaa49aa8081eb624ab96f8d16114dcc5dd89cd419dcca50926b',
  'src/strategies/aegis/domain/services/AegisRegimeGuard.ts':
    '45275cf077d32ec12535b428f1534181ed10cfaa1e702ddfb2045b66e320437a',
  'src/strategies/aegis/domain/services/AegisShortGate.ts':
    '5e2ad3ffd093575c60e1efcb500135d9e4fa5812b0b7747a86a359a76345f9b6',
  'src/strategies/aegis/domain/CurrentBrainCanonicalDecision.ts':
    'a32681b0c93eb9990ec942013196c213cb0487922e4045baa9ab13d2979b2bca',
  'src/strategies/aegis/domain/entry/AegisEntryDecisionTypes.ts':
    '00910364266e2f25a98822b51720e24b63408a0776aa5e1abc38bdb8c78eda3b',
  'src/strategies/aegis/domain/entry/AegisEntryGuardOrchestrator.ts':
    '208dd77c73729451e41abbdb5c072baac1181b369f34ed72e80b89a9b4afe59a',
  'src/strategies/aegis/domain/entry/guards/ProbeModeGuardAdapter.ts':
    '79003b07caf40b6d63f9c47d1193bbc026c236ccc46566073ae2a9fe934d5642',
  'src/strategies/aegis/domain/entry/guards/ShortGateGuardAdapter.ts':
    '9cc230e70c42162798356bda4dd3db971d5c9d2bab457799aabf92bb453ce370',
  // Phase 1 cleanup: removed the dormant Sentinel config surface.
  'src/infra/config/ConfigLoader.ts':
    '9dd24581a9964bba54aed2a124a2e56f8e497bc1ae59af463e27103cb21f1d53',
};

type GuardFixture = [
  string,
  {
    config?: Partial<AegisMicroLiveGateConfig>;
    context?: Partial<AegisMicroLiveGateContext>;
  },
];

const guardFixtures: GuardFixture[] = [
  ['trading_mode_not_turbo_micro_live', { config: { tradingMode: 'AEGIS_SHADOW' } }],
  ['aegis_live_disabled', { config: { liveEnabled: false } }],
  ['aegis_turbo_yaml_disabled', { config: { yamlEnabled: false } }],
  ['aegis_turbo_yaml_live_disabled', { config: { yamlLiveEnabled: false } }],
  ['current_brain_canonical_contract_required', { context: { signal: {} } }],
  ['position_already_open', { context: { hasOpenPosition: true } }],
  ['max_trades_per_day_reached', { context: { tradesToday: 2 } }],
  ['max_consecutive_losses_reached', { context: { consecutiveLosses: 2 } }],
  ['cooldown_active', { context: { timeSinceLastExitMs: 10 } }],
  ['liquidity_stress_block', { context: { liquidityStress: 0.8 } }],
  ['daily_loss_stop_reached', { context: { dailyPnlPct: -0.1 } }],
];

const baseConfig: AegisMicroLiveGateConfig = {
  tradingMode: 'AEGIS_TURBO_MICRO_LIVE',
  liveEnabled: true,
  yamlEnabled: true,
  yamlLiveEnabled: true,
  maxTradesPerDay: 2,
  maxConsecutiveLosses: 2,
  cooldownAfterExitMs: 60_000,
  maxLiquidityStress: 0.7,
  dailyLossStopPct: 0.05,
};

const baseContext: AegisMicroLiveGateContext = {
  signal: {
    direction: 'LONG',
    confidence: 0.8,
    leverage: 2,
    positionFraction: 0.1,
    brain_contract: {
      contract_version: CURRENT_BRAIN_CONTRACT_VERSION,
      authority: CURRENT_BRAIN_AUTHORITY,
      model_id: CURRENT_BRAIN_MODEL_ID,
      model_sha256: CURRENT_BRAIN_MODEL_SHA256,
      bundle_sha256: CURRENT_BRAIN_BUNDLE_SHA256,
      configuration_sha256: CURRENT_BRAIN_CONFIGURATION_SHA256,
      feature_schema: CURRENT_BRAIN_FEATURE_SCHEMA,
      feature_count: CURRENT_BRAIN_FEATURE_COUNT,
    },
  },
  hasOpenPosition: false,
  tradesToday: 0,
  consecutiveLosses: 0,
  timeSinceLastExitMs: Number.POSITIVE_INFINITY,
  liquidityStress: 0,
  dailyPnlPct: 0,
};

describe('original TypeScript operational semantics', () => {
  it('binds the exact pre-Phase-0 parent', () => {
    expect(BASELINE).toBe('7f47abd216e7ac419e3d54006ce945bafcc83d90');
  });

  it('keeps the authoritative baseline operational sources byte-identical', () => {
    for (const [path, digest] of Object.entries(baselineOperationalDigests)) {
      expect(sha256(path), path).toBe(digest);
    }
  });

  it('binds the exact owner-authorized current-brain contract exception', () => {
    for (const [path, digest] of Object.entries(ownerAuthorizedCurrentBrainContractDigests)) {
      expect(sha256(path), path).toBe(digest);
    }
  });

  it('keeps Shadow, prospective, brain, and audit modules out of the operational path', () => {
    const operationalFiles = ['src/main.ts', 'src/app/services/TradingService.ts'];
    const forbidden = [
      'aegis_prospective',
      'aegis_shadow',
      'shadow_dataset',
      'brain_v2',
      'aegis_entry_quality_v2',
      'aegis_regime_guard_v2',
      'aegis_entry_quality_w',
    ];
    for (const path of operationalFiles) {
      const source = readFileSync(resolve(repoRoot, path), 'utf8').toLowerCase();
      for (const token of forbidden) expect(source, `${path}: ${token}`).not.toContain(token);
    }
  });

  it.each(guardFixtures)('preserves guard ordering and reason %s', (expectedReason, overrides) => {
    const decision = shouldEnterAegisTurboMicroLive(
      { ...baseConfig, ...overrides.config },
      { ...baseContext, ...overrides.context },
    );
    expect(decision.reason).toBe(expectedReason);
  });

  it('uses the canonical current-brain decision without fabricating directional votes', () => {
    const decision = shouldEnterAegisTurboMicroLive(baseConfig, baseContext);
    expect(decision.allowed).toBe(true);
    expect(decision.direction).toBe('LONG');
  });

  it('preserves baseline disabled portfolio-risk behavior', () => {
    const guard = new AegisPortfolioRiskGuard({ enabled: false });
    expect(guard.evaluate({ openPositions: [] })).toEqual({ allowed: true, reason: 'disabled' });
  });

  it('preserves baseline enabled portfolio guard classification', () => {
    const guard = new AegisPortfolioRiskGuard({ enabled: true, maxOpenPositions: 1 });
    expect(guard.evaluate({ openPositions: [{ symbol: 'BTCUSDT', side: 'LONG' }] }).allowed).toBe(false);
  });

  it('preserves sizing, rounding, order, bracket, retry, recovery, and exit sources', () => {
    const operationalSources = [
      'src/app/services/TradingService.ts',
      'src/infra/adapters/BinanceAdapter.ts',
      'src/domain/services/ProfitGuardian.ts',
    ];
    for (const path of operationalSources) expect(readFileSync(resolve(repoRoot, path), 'utf8')).toBeTruthy();
  });
});
