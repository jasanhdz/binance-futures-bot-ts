import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AegisMicroLiveGateConfig,
  AegisMicroLiveGateContext,
  shouldEnterAegisTurboMicroLive,
} from '../domain/services/AegisMicroLiveGate';
import { AegisPortfolioRiskGuard } from '../domain/services/AegisPortfolioRiskGuard';
import {
  CURRENT_BRAIN_AUTHORITY,
  CURRENT_BRAIN_BUNDLE_SHA256,
  CURRENT_BRAIN_CONFIGURATION_SHA256,
  CURRENT_BRAIN_CONTRACT_VERSION,
  CURRENT_BRAIN_FEATURE_COUNT,
  CURRENT_BRAIN_FEATURE_SCHEMA,
  CURRENT_BRAIN_MODEL_ID,
  CURRENT_BRAIN_MODEL_SHA256,
} from '../domain/services/CurrentBrainCanonicalDecision';

const BASELINE = '7f47abd216e7ac419e3d54006ce945bafcc83d90';
const repoRoot = resolve(__dirname, '../..');

function sha256(path: string): string {
  return createHash('sha256')
    .update(readFileSync(resolve(repoRoot, path)))
    .digest('hex');
}

const baselineOperationalDigests: Record<string, string> = {
  'src/main.ts': 'e289a662c2b6ac2b4da4e9f7ded993d7fb551ad908bc18f5c44ec1ab226ae119',
  'src/app/ports/Exchange.ts': '45a4d79b0b380b1d479b7c5c96bae4d944aa060c32e395d3dc162c92860a583a',
  'src/infra/adapters/BinanceAdapter.ts':
    '9ddc164e05fd3f1796de6455cad5755b983332768592bc2d60c00f2543d881b2',
  'src/infra/config/environment.ts':
    '5bddf440b6dfb598531042477e6ea2a00a15d8be8372e44063196045168bfa05',
  'src/domain/services/AegisPortfolioRiskGuard.ts':
    '3715eded7eed195a8757df99813cccfb020ad14f5ee041764f998c122d93c535',
  'src/domain/services/ProfitGuardian.ts':
    'f95512ac4ecd82449dff30a1f63441f7297e57adf8b58ca32d8cca5409aa62fd',
  'src/infra/logging/FsStateStore.ts':
    '12008748b58eb6212068374b6964bc403cc72f7f5e7035275a578da1855b670a',
};

  // Phase 1 owner-authorized architecture checkpoint. These are operational
// source/config digests, not scientific model or freeze-manifest hashes.
const ownerAuthorizedCurrentBrainContractDigests: Record<string, string> = {
  'config/regime_config.example.yaml':
    'c9ccac14d769da29497f38538f21ba1f3e0abf96c8dbc8647407e8007750ede5',
  // Phase 1 cleanup: removed the dormant Sentinel config surface.
  'regime_config.live.yaml': '2d6cca27e6c0d8efad5c78957e7ce9772d2ea7dd396731251298dc46ee6b2165',
  'src/app/services/TradingService.ts':
    'c0aaeac85b41d3bf7379d1198af59b7f723e66c1608e64389b9d17fa4f494ecb',
  'src/app/telegram/AegisBlocksReportService.ts':
    'b0941744ffa3911da4b9a56958dabbba4d0f9208ff0e040283c33bb25f9dd973',
  'src/app/telegram/TelegramCommandHandlers.ts':
    '4f8b7876c91b72ba79ddfb56cfad3b256f1008ec756aedc5541e3195a36f8617',
  'src/domain/index.ts': '0678dbf15543c538cd1654333ac0a3546486e3bdfb499ae1dbd28e94204109a5',
  'src/domain/services/AegisStrategy.ts':
    '13ed0714ec4c7e00cf9814d1761e478b0dd349e4f024a81ae3277395202cc51f',
  'src/domain/services/AegisOperationalDispositionShadow.ts':
    '57c414c834890fec401ddf0cff66dbc9ee66767cf473aee2cf93f65e5d2c176c',
  'src/domain/services/AegisExitEyeV2Shadow.ts':
    'c42df7df36033370442b24d0c49ccbfaf40745cbbe25380c508536f34f084172',
  'src/domain/services/AegisCleanEntryGuard.ts':
    '87c20efe19e2a36816be9ffa2951be5ed5c023b112d5865531f1296e5c144e8c',
  'src/domain/services/AegisEntryQualityGate.ts':
    'a3703fb5739eb59715ade631befa0a4ed08871b0e7c7e652effbfd003ec9f18f',
  'src/domain/services/AegisMicroLiveGate.ts':
    '387eae41dbc56133b2927b16adc8a0f09c97e963149a677d5a49eb09669292f6',
  'src/domain/services/AegisProbeMode.ts':
    'f16c3b1f2328acaa49aa8081eb624ab96f8d16114dcc5dd89cd419dcca50926b',
  'src/domain/services/AegisRegimeGuard.ts':
    '077915c9c8d42b9c7d959ef58d92d251f08c68534268cf15b8b3083c65dbc790',
  'src/domain/services/AegisShortGate.ts':
    '2faeb8de4776ae93402d20a2868def42fca31aeffa3a92df415f056216ed5009',
  'src/domain/services/CurrentBrainCanonicalDecision.ts':
    'a32681b0c93eb9990ec942013196c213cb0487922e4045baa9ab13d2979b2bca',
  'src/domain/services/aegis-entry/AegisEntryDecisionTypes.ts':
    'd2da5d012103cd6aaf55168766c735733f980bc8a0f09a073ae70ef5e5a36acb',
  'src/domain/services/aegis-entry/AegisEntryGuardOrchestrator.ts':
    '208dd77c73729451e41abbdb5c072baac1181b369f34ed72e80b89a9b4afe59a',
  'src/domain/services/aegis-entry/guards/ProbeModeGuardAdapter.ts':
    'fb3932297e23fa7f86441080d0975135b13d1ceab348544ac0201ad8ee9c270a',
  'src/domain/services/aegis-entry/guards/ShortGateGuardAdapter.ts':
    '863f1b429d43f6e527120cafa01ef0dc82bce34d72161558e9ddf7f887236a07',
  // Phase 1 cleanup: removed the dormant Sentinel config surface.
  'src/infra/config/ConfigLoader.ts':
    '9421e6a8a38f353835b7010171fe3b1a06757250f6629263066a7d5d8172f1b7',
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
  allowShort: true,
  minScore: 0.5,
  leverageCap: 10,
  positionFractionCap: 0.1,
  maxTradesPerDay: 2,
  maxConsecutiveLosses: 2,
  dailyLossStopPct: 0.1,
  minCooldownMs: 60_000,
  maxLiquidityStress: 0.7,
  stopRoe: -0.15,
  takeProfitRoe: 0.25,
  trailingActivationRoe: 0.15,
  trailingCallbackRoe: 0.08,
};

const baseContext: AegisMicroLiveGateContext = {
  symbol: 'BTCUSDT',
  signal: {
    aegis: {
      candidate: CURRENT_BRAIN_MODEL_ID,
      candidate_status: CURRENT_BRAIN_AUTHORITY,
      live_enabled: true,
      prod: {
        allowed: true,
        execute: true,
        action: 'LONG',
      },
      decision_brain: {
        contract_version: CURRENT_BRAIN_CONTRACT_VERSION,
        authority: CURRENT_BRAIN_AUTHORITY,
        mode: 'CURRENT_BRAIN_LIVE',
        execute: true,
        selected: true,
        production_allowed: true,
        status: 'LOADED',
        model_version: CURRENT_BRAIN_MODEL_ID,
        model_sha256: CURRENT_BRAIN_MODEL_SHA256,
        bundle_sha256: CURRENT_BRAIN_BUNDLE_SHA256,
        configuration_sha256: CURRENT_BRAIN_CONFIGURATION_SHA256,
        feature_schema: CURRENT_BRAIN_FEATURE_SCHEMA,
        feature_count: CURRENT_BRAIN_FEATURE_COUNT,
        fallback: false,
        symbol: 'BTCUSDT',
        side: 'LONG',
        decision: 'ENTER_NOW',
        recommendation: 'ENTER_NOW',
      },
      turbo: {
        raw: {
          action: 'LONG',
          would_execute: true,
          turbo_score: 0.8,
          votes: { long: 1, short: 0, neutral: 0 },
          leverage_suggestion: 15,
          position_fraction: 0.2,
        },
      },
    },
  },
  hasOpenPosition: false,
  tradesToday: 0,
  consecutiveLosses: 0,
  timeSinceLastExitMs: 120_000,
  liquidityStress: 0.2,
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
    const forbidden =
      /(?:from|require\()\s*['"][^'"]*(?:\/tooling\/|\/brain\/|\/prospective\/|\/audit\/)/;
    const operationalPaths = [
      ...Object.keys(baselineOperationalDigests),
      ...Object.keys(ownerAuthorizedCurrentBrainContractDigests),
    ];
    const leaking = operationalPaths.filter((path) =>
      forbidden.test(readFileSync(resolve(repoRoot, path), 'utf8')),
    );
    expect(leaking).toEqual([]);
  });

  it.each(guardFixtures)('preserves guard ordering and reason %s', (reason, overrides) => {
    const context = { ...baseContext, ...(overrides.context ?? {}) } as AegisMicroLiveGateContext;
    const config = { ...baseConfig, ...(overrides.config ?? {}) } as AegisMicroLiveGateConfig;
    expect(shouldEnterAegisTurboMicroLive(context, config)).toMatchObject({
      allowed: false,
      reason,
    });
  });

  it('uses the canonical current-brain decision without fabricating directional votes', () => {
    expect(shouldEnterAegisTurboMicroLive(baseContext, baseConfig)).toMatchObject({
      allowed: true,
      reason: 'allowed_current_brain_canonical_live',
      leverage: 10,
      positionFraction: 0.08,
    });
  });

  it('preserves baseline disabled portfolio-risk behavior', () => {
    expect(
      AegisPortfolioRiskGuard.evaluate({
        symbol: 'BTCUSDT',
        side: 'LONG',
        currentOpenPositions: 5,
        currentLongPositions: 5,
        currentShortPositions: 0,
        walletBalance: 20,
        equityTotal: 20,
        currentMarginUsed: 20,
        currentNotional: 200,
        newTradeEstimatedMargin: 10,
        newTradeEstimatedNotional: 100,
        config: { enabled: false, max_open_positions: 1 },
      }),
    ).toMatchObject({ allowed: true, reason: 'portfolio_risk_disabled' });
  });

  it('preserves baseline enabled portfolio guard classification', () => {
    expect(
      AegisPortfolioRiskGuard.evaluate({
        symbol: 'BTCUSDT',
        side: 'LONG',
        currentOpenPositions: 1,
        currentLongPositions: 1,
        currentShortPositions: 0,
        walletBalance: 20,
        equityTotal: 20,
        currentMarginUsed: 2,
        currentNotional: 20,
        newTradeEstimatedMargin: 2,
        newTradeEstimatedNotional: 20,
        config: { enabled: true, max_open_positions: 1 },
      }),
    ).toMatchObject({ allowed: false, reason: 'max_open_positions_reached' });
  });

  it('preserves sizing, rounding, order, bracket, retry, recovery, and exit sources', () => {
    for (const path of Object.keys(baselineOperationalDigests)) {
      expect(sha256(path), path).toBe(baselineOperationalDigests[path]);
    }
  });
});
