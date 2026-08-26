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
  'src/main.ts': '3b531c0e98916975b0e0e22cd735ce88cb786027cdb5a739362849cb0c76bf7d',
  'src/app/ports/Exchange.ts': '94bf506268595083231ae8604f5acdff318e08d1ade8a8ba74b382e3357697d9',
  'src/infra/adapters/BinanceAdapter.ts':
    'bd1aa00888b4204b8ca3f76cf1efa67535f70eae07664911717d3f6740e947ef',
  'src/infra/config/environment.ts':
    '3bac013429ee9828f15aa5c9266cd92c285394ec5410c0ecf6efed4e5c7e16d8',
  'src/domain/services/AegisPortfolioRiskGuard.ts':
    '1b26ce70aba7bb9bf03d43e38e9497aebc936055ed884d6cc21e012ad3c6b3bf',
  'src/domain/services/ProfitGuardian.ts':
    'ec0f9273f74925cbdbc5acd40942377e3e3c5c18bdb6b42d1995f1b53dc552b7',
  'src/infra/logging/FsStateStore.ts':
    '282d6e7bd9e68e95f69543c80816f2b548768cdfef0031aeb16f8d860e22cab2',
};

const ownerAuthorizedCurrentBrainContractDigests: Record<string, string> = {
  'regime_config.example.yaml': '1d2a61eff556509f3c428d1b9804d4af57772a644358432044152a274c05b113',
  'regime_config.live.yaml': '09e1d9d621b576b61eca3717b0c51cfdd4006af2ad2dbfd1004e27c699cdce6b',
  'src/app/services/TradingService.ts':
    'a014d642319df074af7545f352c03e0daf8e01e6e289e2c7878c9089812660be',
  'src/app/telegram/AegisBlocksReportService.ts':
    'b2b2eb6fca14bb0d5c99729c3770f843feb98320a280efeb2d6c24c355c1d15c',
  'src/app/telegram/TelegramCommandHandlers.ts':
    'd3c80274735bf8810681e00dc503158b7f43e5947c5e4066bccdb34c80f72211',
  'src/domain/index.ts': '0678dbf15543c538cd1654333ac0a3546486e3bdfb499ae1dbd28e94204109a5',
  'src/domain/services/AegisStrategy.ts':
    '13ed0714ec4c7e00cf9814d1761e478b0dd349e4f024a81ae3277395202cc51f',
  'src/domain/services/AegisOperationalDispositionShadow.ts':
    '57c414c834890fec401ddf0cff66dbc9ee66767cf473aee2cf93f65e5d2c176c',
  'src/domain/services/AegisExitEyeV2Shadow.ts':
    'c42df7df36033370442b24d0c49ccbfaf40745cbbe25380c508536f34f084172',
  'src/domain/services/AegisCleanEntryGuard.ts':
    'dacc093a1d1636ebb6c5d1d8bad28b6cbed07e905a8d5593076b29e44b3ca183',
  'src/domain/services/AegisEntryQualityGate.ts':
    '50d5a1eba0a0618bc3b6a41eb6fe1326ffa1562235dc0380c6792c480470947d',
  'src/domain/services/AegisMicroLiveGate.ts':
    'a18fda3291baa07066492fd9f9b4085b784fdf7b1abb1cdab485310a2d596f58',
  'src/domain/services/AegisProbeMode.ts':
    'fa2e593f982326fcfb64831538179c05972f2d9325aad617398df26174a5b351',
  'src/domain/services/AegisRegimeGuard.ts':
    '86211d956b290931bd92475886645ae9cd666ca7898b9147b56f3a3150efd755',
  'src/domain/services/AegisShortGate.ts':
    'e7069d819cb5de8e4f2fab707e8eaecea03bf9795b039944774259773560ee12',
  'src/domain/services/CurrentBrainCanonicalDecision.ts':
    'a32681b0c93eb9990ec942013196c213cb0487922e4045baa9ab13d2979b2bca',
  'src/domain/services/aegis-entry/AegisEntryDecisionTypes.ts':
    '6b2fe511cc2faa68f859bb8883213147f68ae4217b13b7cef32d57e64bf54a0f',
  'src/domain/services/aegis-entry/AegisEntryGuardOrchestrator.ts':
    '2e9f078e18c41d6af3893bb94e201713bf2e9febf7b0cbcad86c8eb2de276273',
  'src/domain/services/aegis-entry/guards/ProbeModeGuardAdapter.ts':
    '95e0d011bd5e8db6a97c46238697ee3376415080c5c1503e0aeb793ff00d3858',
  'src/domain/services/aegis-entry/guards/ShortGateGuardAdapter.ts':
    '041aadf526f858e70ce33d15516ba012dc3aca43f68d4ca2e88df265e054f07c',
  'src/infra/config/ConfigLoader.ts':
    'cb4f38e1dba3f3e66fb52af2dc857230d829b3b31917f88ee1bee9ab2122086d',
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
