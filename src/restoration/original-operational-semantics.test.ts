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

const BASELINE = '7f47abd216e7ac419e3d54006ce945bafcc83d90';
const repoRoot = resolve(__dirname, '../..');

function sha256(path: string): string {
  return createHash('sha256')
    .update(readFileSync(resolve(repoRoot, path)))
    .digest('hex');
}

const baselineOperationalDigests: Record<string, string> = {
  'src/main.ts': '1ba31db96d39d85ba56ff4a69aa1e9cdf94fd589ac788f0c4a88f93bf2ae1a3b',
  'src/app/services/TradingService.ts':
    'dc624a5134088e70b7ba5a37dc874af1b66b911da7ec4f175f72ec4cd81272bc',
  'src/app/ports/Exchange.ts': '7f10635811493fd3b6bc7eda6fb72e272b819314a93bd6d1a079053d9e57685c',
  'src/infra/adapters/BinanceAdapter.ts':
    '54493cd95c454dfdc7baebb5e6f5cbb71404945c02efab82213b1b022b54167a',
  'src/infra/config/ConfigLoader.ts':
    '23119a604363e4d9bcacb431952121bb2a57ed0de5eb5fb512c0f552b99624e4',
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
  'src/domain/index.ts': '0678dbf15543c538cd1654333ac0a3546486e3bdfb499ae1dbd28e94204109a5',
  'src/domain/services/AegisStrategy.ts':
    'cdb46c3c95febceab7d61223f30d31feff5f86bd00748d28393b35654c6877ce',
  'src/domain/services/AegisMicroLiveGate.ts':
    'e986786212d8916e84d980f6e9249003236f905abfcaaa16d80b8986a32c90e1',
  'src/domain/services/AegisShortGate.ts':
    'bcb58f7025325de93fca9c7c0654bc72a6ff4712c2779f7490b118354cc0b8c5',
  'src/domain/services/CurrentBrainCanonicalDecision.ts':
    '554ccf13b4bb1b0077a547439b0141a0c9b7ad9add1443a8a181e182012c6337',
  'src/domain/services/aegis-entry/guards/ShortGateGuardAdapter.ts':
    'e7334e32612ea2a020f4852588a7d0d8a560baad268cc69e1312c4a23724d58a',
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
  ['missing_aegis_turbo_raw', { context: { signal: {} } }],
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
      turbo: {
        raw: {
          action: 'LONG',
          would_execute: true,
          turbo_score: 0.8,
          votes: { long: 3, short: 0, neutral: 0 },
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

  it('preserves baseline leverage and position-fraction capping', () => {
    expect(shouldEnterAegisTurboMicroLive(baseContext, baseConfig)).toMatchObject({
      allowed: true,
      reason: 'allowed_aegis_turbo_micro_live',
      leverage: 10,
      positionFraction: 0.1,
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
