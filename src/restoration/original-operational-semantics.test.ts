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
  'src/main.ts': '1ba31db96d39d85ba56ff4a69aa1e9cdf94fd589ac788f0c4a88f93bf2ae1a3b',
  'src/app/ports/Exchange.ts': '7f10635811493fd3b6bc7eda6fb72e272b819314a93bd6d1a079053d9e57685c',
  'src/infra/adapters/BinanceAdapter.ts':
    '54493cd95c454dfdc7baebb5e6f5cbb71404945c02efab82213b1b022b54167a',
  'src/infra/config/environment.ts':
    '3bac013429ee9828f15aa5c9266cd92c285394ec5410c0ecf6efed4e5c7e16d8',
  'src/domain/services/AegisPortfolioRiskGuard.ts':
    '1b26ce70aba7bb9bf03d43e38e9497aebc936055ed884d6cc21e012ad3c6b3bf',
  'src/domain/services/aegis-entry/AegisEntryGuardOrchestrator.ts':
    'ea2a861d0576b87bc57ef7cdb94c424d1ac23a3a0b22449cfb1362b4c3e18c41',
  'src/domain/services/ProfitGuardian.ts':
    'b362c2939238ead4d5708e3a49ceb12e6b2fa9666e07b1a88eec8dd7faea4932',
  'src/infra/logging/FsStateStore.ts':
    '282d6e7bd9e68e95f69543c80816f2b548768cdfef0031aeb16f8d860e22cab2',
};

const ownerAuthorizedCurrentBrainContractDigests: Record<string, string> = {
  'regime_config.example.yaml': '1d2a61eff556509f3c428d1b9804d4af57772a644358432044152a274c05b113',
  'regime_config.live.yaml': '42fdf81f64f95ecbb672937a7e48c288dc68e130d0a14ccffff1f584baf81d19',
  'src/app/services/TradingService.ts':
    '820e60692ba806f6b6f9e33be8db664ba17019019f59d1da4f8bdbb5f92d5fce',
  'src/app/telegram/AegisBlocksReportService.ts':
    'b2b2eb6fca14bb0d5c99729c3770f843feb98320a280efeb2d6c24c355c1d15c',
  'src/app/telegram/TelegramCommandHandlers.ts':
    '9297ad5eabe87971e7533aae42ce2cca549eae680e056f28300536fd25d38507',
  'src/domain/index.ts': '0678dbf15543c538cd1654333ac0a3546486e3bdfb499ae1dbd28e94204109a5',
  'src/domain/services/AegisStrategy.ts':
    'cdb46c3c95febceab7d61223f30d31feff5f86bd00748d28393b35654c6877ce',
  'src/domain/services/AegisCleanEntryGuard.ts':
    'dacc093a1d1636ebb6c5d1d8bad28b6cbed07e905a8d5593076b29e44b3ca183',
  'src/domain/services/AegisEntryQualityGate.ts':
    '50d5a1eba0a0618bc3b6a41eb6fe1326ffa1562235dc0380c6792c480470947d',
  'src/domain/services/AegisMicroLiveGate.ts':
    '35a30b4e03c048d74fccfe0d255a791b400ea93d17ba1be6b59a065c133efa80',
  'src/domain/services/AegisProbeMode.ts':
    'a6368796e592e89079e80128b6f907fbe6a65a368efaa2e6d16c0b243e5e5b6d',
  'src/domain/services/AegisRegimeGuard.ts':
    '86211d956b290931bd92475886645ae9cd666ca7898b9147b56f3a3150efd755',
  'src/domain/services/AegisShortGate.ts':
    'e7069d819cb5de8e4f2fab707e8eaecea03bf9795b039944774259773560ee12',
  'src/domain/services/CurrentBrainCanonicalDecision.ts':
    '554ccf13b4bb1b0077a547439b0141a0c9b7ad9add1443a8a181e182012c6337',
  'src/domain/services/aegis-entry/AegisEntryDecisionTypes.ts':
    '22ba65675509b3a2613ef7ba97b61807cb43be1925a9bdc88e11e4222bb7e92e',
  'src/domain/services/aegis-entry/guards/MomentumRideGuardAdapter.ts':
    'd4ef1cbc3f4ab42642f999bdc9f306cc1076465748074928d0ecba1c7cedac4a',
  'src/domain/services/aegis-entry/guards/ShortGateGuardAdapter.ts':
    '041aadf526f858e70ce33d15516ba012dc3aca43f68d4ca2e88df265e054f07c',
  'src/infra/config/ConfigLoader.ts':
    'd992fefd826b83b95fc4078ed284a861f69030d5bc590b7c20169082536cee13',
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
    const forbidden = /(?:from|require\()\s*['"][^'"]*(?:\/brain\/|\/prospective\/|\/audit\/)/;
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
