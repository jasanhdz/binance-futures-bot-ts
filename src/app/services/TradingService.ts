import { Exchange, PositionInfo, SymbolFilters, USDTAccountSnapshot } from '../ports/Exchange';
import { MLService } from '../ports/MLService';
import { Logger } from '../ports/Logger';
import { StateStore } from '../ports/StateStore';
import { Notifier } from '../ports/Notifier';
import { BotState, Candle, Side } from '../../core/types';
import { DEFAULT_GUARDIAN_CONFIG, GuardianConfig } from '../../domain/services/ProfitGuardian';
import { calculateATR } from '../../domain/services/TechnicalIndicators';
import { AegisTradingSignal } from '../../strategies/aegis/domain/AegisStrategy';
import {
  AegisMicroLiveGateDecision,
  buildAegisMicroLiveGateConfigFromEnv,
  shouldEnterAegisTurboMicroLive,
} from '../../strategies/aegis/domain/services/AegisMicroLiveGate';
import {
  AegisExitEyeYamlConfig,
  AegisEntryQualityGateRuntimeConfig,
  AegisEventRiskRuntimeConfig,
  AegisDecisionEnforcementRuntimeConfig,
  AegisCleanEntryGuardRuntimeConfig,
  AegisPositionFractionOverride,
  AegisPhaseOShortLiveYamlConfig,
  AegisPortfolioRiskYamlConfig,
  AegisProfitProtectionRuntimeConfig,
  AegisShortGateYamlConfig,
  AegisSymbolMode,
  AegisTelegramNotificationsRuntimeConfig,
  AegisTurboYamlConfig,
  NinjaConfigManager,
} from '../../infra/config/ConfigLoader';
import { buildAegisOperationalDispositionShadow } from '../../strategies/aegis/domain/services/AegisOperationalDispositionShadow';
import { RegimeConfig } from '../ports/RegimeStrategy';
import { LiquidityVoidDetector, LIQUIDITY_STRESS_INPUT_VERSION } from './LiquidityVoidDetector';
import { CONFIG } from '../../infra/config/environment';
import {
  AegisResearchStrategy,
  AegisTurboHistoryLogger,
  generateSignalId,
  generateStrategyTradeId,
  generateTradeId,
  getPortfolioSessionId,
} from '../../infra/logging/AegisTurboHistoryLogger';
import { formatAegisTurboEntryMessage } from '../telegram/presentation/AegisTurboEntryMessageFormatter';
import {
  describeAegisExit,
  formatRoe,
  formatScore,
  formatSignedUsd,
} from '../telegram/presentation/AegisExitMessageFormatter';
import {
  AegisPositionMessageInput,
  formatAegisStartupMessage,
} from '../messages/AegisMessageFormatter';
import { AegisEntryQualityGateDecision } from '../../strategies/aegis/domain/services/AegisEntryQualityGate';
import { AegisEventRiskOverlayDecision } from '../../strategies/aegis/domain/services/AegisEventRiskOverlay';
import { AegisDecisionEnforcementDecision } from '../../strategies/aegis/domain/services/AegisDecisionEnforcement';
import {
  AegisTelegramBlockNotifier,
  DEFAULT_AEGIS_BLOCK_NOTIFICATION_CONFIG,
} from './AegisTelegramBlockNotifier';
import {
  DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG,
  AegisCleanEntryGuardOutput,
} from '../../strategies/aegis/domain/services/AegisCleanEntryGuard';
import {
  AegisProbeModeDecision,
  AegisProbeModeRuntimeConfig,
} from '../../strategies/aegis/domain/services/AegisProbeMode';
import {
  AegisRegimeGuardConfig,
  DEFAULT_AEGIS_REGIME_GUARD_CONFIG,
} from '../../strategies/aegis/domain/services/AegisRegimeGuard';
import {
  AegisEntryGuardPolicy,
  AegisEntryPolicyRuntimeConfig,
  AegisMomentumRideRuntimeConfig,
  AegisRegimeContextRuntimeConfig,
} from '../../strategies/aegis/domain/entry/AegisEntryDecisionTypes';
import { AegisClosedTradeOutcome } from '../../strategies/aegis/domain/services/AegisConsecutiveLossTracker';
import {
  readAegisClosedTradeOutcomes,
  readStrategyClosedTradeOutcomes,
} from '../../infra/logging/AegisClosedTradeHistoryReader';
import { VERIFIED_AEGIS_TRADE_OWNERSHIP } from '../../infra/logging/AegisTradeOwnership';
import type { StrategyLossStateStorePort } from '../../infra/state/StrategyLossStateStore';
import type { StrategyLossStateRegistry } from '../../infra/state/StrategyLossStateRegistry';
import { PositionManagerRouter } from '../../core/strategy/PositionManagerRouter';
import {
  AegisPositionManager,
  MomentumRidePositionManager,
} from '../strategy/OwnedPositionManagers';
import { MicroBurstPositionManager } from '../../strategies/micro-burst/application/MicroBurstPositionManager';
import { StrategyIdentity } from '../../core/strategy/StrategyIdentity';
import { resolveStrategyOwnership } from '../../core/strategy/StrategyPositionOwnership';
import { createAegisMigrationIdentity } from '../../strategies/aegis/domain/AegisIdentity';
import { createMomentumRideLegacyIdentity } from '../../strategies/momentum/domain/MomentumRideIdentity';
import { SharedStrategyExecutionService } from '../execution/SharedStrategyExecutionService';
import { StrategyRouter } from '../../core/strategy/StrategyRouter';
import { MomentumEntryCoordinator } from '../../strategies/momentum/application/MomentumEntryCoordinator';
import {
  MomentumRideStrategy,
  MomentumRideStrategyContext,
} from '../../strategies/momentum/domain/MomentumRideStrategy';
import {
  MicroBurstStrategy,
  MicroBurstStrategyContext,
} from '../../strategies/micro-burst/domain/MicroBurstStrategy';
import { createMicroBurstV1Identity } from '../../strategies/micro-burst/domain/MicroBurstIdentity';
import type { MicroBurstRuntimeReadiness } from '../../strategies/micro-burst/application/MicroBurstRuntime';
import {
  parseMicroBurstConfig,
  isMicroBurstShadowMode,
} from '../../strategies/micro-burst/application/MicroBurstConfigLoader';
import {
  externalLifecyclePolicy,
  strategyLifecyclePolicy,
} from '../../core/strategy/StrategyLifecyclePolicy';
import { StrategyPositionLifecycleCore } from '../position/StrategyPositionLifecycleCore';
import { PositionRecoveryService } from '../position/PositionRecoveryService';
import { PositionProtectionService } from '../position/PositionProtectionService';
import { TradingRuntimeConfigService } from '../config/TradingRuntimeConfigService';
import {
  StrategyHistoryService,
  type HistoryAccountSnapshotInput,
  type HistoryTradeEventInput,
} from '../logging/StrategyHistoryService';
import { JsonlDecisionEvidenceSink } from '../../infra/logging/JsonlDecisionEvidenceSink';
import { JsonlMarketSnapshotSink } from '../../infra/logging/JsonlMarketSnapshotSink';
import { JsonlStrategyTelemetrySink } from '../../infra/logging/JsonlStrategyTelemetrySink';
import { StrategyTelemetryBus } from '../../core/telemetry/StrategyTelemetryBus';
import { DecisionEvidenceTelemetrySink } from '../../core/telemetry/DecisionEvidenceTelemetrySink';
import { TelemetryStrategyExecutionPort } from '../../core/telemetry/TelemetryStrategyExecutionPort';
import type { StrategyExecutionPort } from '../../core/strategy/StrategyExecution';
import {
  extractAegisPhaseOMetadata,
  type AegisPhaseOMetadata,
} from '../../strategies/aegis/application/AegisPhaseOMetadataParser';
import { StrategyRuntimeCoordinator } from '../runtime/StrategyRuntimeCoordinator';
import { AegisEntryCoordinator } from '../../strategies/aegis/application/AegisEntryCoordinator';
import { AegisEntryContextBuilder } from '../../strategies/aegis/application/AegisEntryContextBuilder';
import { AegisEntryWorkflow } from '../../strategies/aegis/application/AegisEntryWorkflow';
import { AegisExecutionCoordinator } from '../../strategies/aegis/application/AegisExecutionCoordinator';
import { AegisExitManagementService } from '../../strategies/aegis/application/AegisExitManagementService';
import { AegisProfitProtectionService } from '../../strategies/aegis/application/AegisProfitProtectionService';
import { StrategyRiskSessionService } from '../risk/StrategyRiskSessionService';

const INITIAL_BALANCE = 20;
const LIQUIDITY_STRESS_FRESHNESS_WINDOW_MS = 30_000;
const DEFAULT_AEGIS_MAX_HOLD_MS = 8 * 60 * 60 * 1000;

export interface TradingServiceDeps {
  exchange: Exchange;
  mlService: MLService;
  logger: Logger;
  state: StateStore;
  notifier: Notifier;
  configManager: NinjaConfigManager;
  historyLogger?: AegisTurboHistoryLogger;
  closedTradeOutcomeReader?: () => Promise<AegisClosedTradeOutcome[]>;
  consecutiveLossStateStore?: StrategyLossStateStorePort;
  strategyLossStateRegistry?: StrategyLossStateRegistry;
}

export interface TradingServiceConfig {
  symbols: string[];
  tickIntervalMs: number;
  maxTradesPerDay: number;
  tradingMode?: string;
}

export interface AegisRuntimeSnapshot {
  tradingMode: string;
  isRunning: boolean;
  tradesToday: number;
  consecutiveLosses: number;
  dailyStartBalance: number | null;
  dailyPnlPct?: number;
  lastTradeDayReset: number;
  liquidityStressBySymbol: Record<string, number>;
  liquidityStressStatusBySymbol: Record<string, 'NO_DATA' | 'FRESH' | 'STALE'>;
  liquidityStressAgeMsBySymbol: Record<string, number | undefined>;
  liquidityStressInputVersionBySymbol: Record<string, typeof LIQUIDITY_STRESS_INPUT_VERSION>;
  microBurstReadiness: MicroBurstRuntimeReadiness | null;
}

export class TradingService {
  private isRunning = false;
  private lastEntryBalance = INITIAL_BALANCE;
  private peakBalance = INITIAL_BALANCE;
  private lastErrorTime: Record<string, number> = {};
  private lastLogTime: Record<string, number> = {};
  private lastAlivePulseMs = Date.now();
  private hardWatchdogTimer: NodeJS.Timeout | null = null;
  private detector: Record<string, LiquidityVoidDetector> = {};
  private readonly historyLogger: AegisTurboHistoryLogger;
  private readonly symbolStateStores = new Map<string, StateStore>();
  private readonly aegisTelegramBlockNotifier = new AegisTelegramBlockNotifier();
  private readonly positionManagerRouter = new PositionManagerRouter<{
    symbol: string;
    botState: BotState;
    symbolState: StateStore;
  }>();
  private readonly positionLifecycleCore: StrategyPositionLifecycleCore;
  private readonly positionRecovery: PositionRecoveryService;
  private readonly positionProtection: PositionProtectionService;
  private readonly runtimeConfig: TradingRuntimeConfigService;
  private readonly strategyHistory: StrategyHistoryService;
  private readonly riskSession: StrategyRiskSessionService;
  private readonly aegisStrategyIdentity: StrategyIdentity;
  private readonly momentumStrategyIdentity: StrategyIdentity;
  private readonly strategyTelemetry = new StrategyTelemetryBus([
    new JsonlStrategyTelemetrySink('data/strategy-telemetry/events-v1.jsonl'),
  ]);
  private readonly decisionEvidenceSink = new DecisionEvidenceTelemetrySink(
    new JsonlDecisionEvidenceSink('data/strategy-blackbox/strategy-decisions/decisions-v1.jsonl'),
    this.strategyTelemetry,
  );
  private readonly marketSnapshotEvidenceSink = new JsonlMarketSnapshotSink(
    'data/strategy-blackbox/market-snapshots/snapshots-v1.jsonl',
  );
  private readonly sharedStrategyExecution: StrategyExecutionPort;
  private readonly momentumStrategyRouter = new StrategyRouter<MomentumRideStrategyContext>();
  private readonly microBurstStrategyRouter = new StrategyRouter<MicroBurstStrategyContext>();
  private readonly microBurstIdentity: StrategyIdentity;
  private readonly strategyRuntimeCoordinator: StrategyRuntimeCoordinator;
  private readonly aegisEntryCoordinator = new AegisEntryCoordinator();
  private readonly aegisEntryContextBuilder: AegisEntryContextBuilder;
  private readonly aegisEntryWorkflow: AegisEntryWorkflow;
  private readonly aegisExecutionCoordinator: AegisExecutionCoordinator;
  private readonly aegisExitManagementService: AegisExitManagementService;
  private readonly aegisProfitProtectionService: AegisProfitProtectionService;
  private readonly momentumEntryCoordinator: MomentumEntryCoordinator;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private deps: TradingServiceDeps,
    private config: TradingServiceConfig,
  ) {
    this.historyLogger = deps.historyLogger ?? new AegisTurboHistoryLogger({ logger: deps.logger });
    this.runtimeConfig = new TradingRuntimeConfigService(deps.configManager);
    this.riskSession = new StrategyRiskSessionService({
      state: deps.state,
      logger: deps.logger,
      getTradingMode: () => this.getTradingMode(),
      readClosedOutcomes: async () => {
        const aegisOutcomes = await (deps.closedTradeOutcomeReader?.() ??
          readAegisClosedTradeOutcomes(undefined, this.getTradingMode()));
        const strategyOutcomes = deps.closedTradeOutcomeReader
          ? aegisOutcomes
          : await readStrategyClosedTradeOutcomes(undefined, this.getTradingMode());
        return { aegisOutcomes, strategyOutcomes };
      },
      consecutiveLossStateStore: deps.consecutiveLossStateStore,
      now: () => Date.now(),
    });
    this.aegisStrategyIdentity = createAegisMigrationIdentity();
    this.momentumStrategyIdentity = createMomentumRideLegacyIdentity();
    this.microBurstIdentity = createMicroBurstV1Identity();
    this.positionProtection = new PositionProtectionService({
      exchange: deps.exchange,
      logger: deps.logger,
      getRegimeConfig: (symbol) => this.getAegisTurboRegimeConfig(symbol),
      getImmediateTriggerBufferPct: () =>
        this.getAegisProfitProtectionConfig().immediate_trigger_buffer_pct,
      logTradeEvent: (symbol, event, input) => this.logAegisTradeEvent(symbol, event, input),
    });
    this.aegisEntryContextBuilder = new AegisEntryContextBuilder({
      logger: deps.logger,
      now: () => Date.now(),
      getEntryQualityConfig: (symbol) => this.getEntryQualityGateConfig(symbol),
      getEventRiskConfig: () => this.getAegisEventRiskConfig(),
      getGlobalState: () => this.deps.state.get(),
      countStateOpenPositions: () => this.countStateOpenPositions(),
      mostRecentStopLossAt: () => this.mostRecentStopLossAt(),
      readAegisRisk: (now) => this.riskSession.strategySnapshot('AEGIS_TURBO', now),
      stateForSymbol: (symbol) => this.stateForSymbol(symbol),
      hasOpenPosition: (symbol) => this.deps.exchange.hasOpenPosition(symbol, 'ANY'),
      buildEntryQualityMarketContext: (symbol) => this.buildEntryQualityMarketContext(symbol),
      getRegimeGuardConfig: () => this.getAegisRegimeGuardConfig(),
      getRegimeContextConfig: () => this.getAegisRegimeContextConfig(),
      getCleanEntryConfig: () => this.getAegisCleanEntryGuardConfig(),
      getProbeModeConfig: () => this.getAegisProbeModeConfig(),
      getShortGateConfig: () => this.getAegisShortGateConfig(),
      getDecisionEnforcementConfig: () => this.getAegisDecisionEnforcementConfig(),
    });
    this.positionRecovery = new PositionRecoveryService({
      exchange: deps.exchange,
      logger: deps.logger,
      notifier: deps.notifier,
      globalState: deps.state,
      configSymbols: this.config.symbols,
      getLiveSymbols: () => this.getLiveAegisSymbols(),
      stateForSymbol: (symbol) => this.stateForSymbol(symbol),
      isVerifiedBotOwnedState: (state) => this.isVerifiedBotOwnedState(state),
      isLegacyBotOwnedState: (state) => this.isLegacyBotOwnedState(state),
      requireBrackets: () => this.getAegisTurboYamlConfig()?.require_brackets !== false,
      ensureBrackets: (symbol, side, entryPrice, leverage, position, state, overrides) =>
        this.positionProtection.ensureBrackets(
          symbol,
          side,
          entryPrice,
          leverage,
          position,
          state,
          overrides,
        ),
    });
    this.strategyHistory = new StrategyHistoryService({
      logger: deps.logger,
      historyLogger: this.historyLogger,
      tradingMode: () => this.getTradingMode(),
      strategyIdentity: (strategy) => this.strategyIdentity(strategy),
      strategyForSymbol: (symbol, tradeId) => this.strategyForSymbol(symbol, tradeId),
      tradesToday: () => this.riskSession.snapshot().tradesToday,
      consecutiveLosses: () => this.riskSession.snapshot().consecutiveLosses,
    });
    this.sharedStrategyExecution = new TelemetryStrategyExecutionPort(
      new SharedStrategyExecutionService(deps.exchange, deps.logger, {
        feeBufferPct: deps.configManager.trading?.fee_buffer_pct ?? CONFIG.FEE_BUFFER_PCT ?? 0.05,
        confirmationAttempts: 3,
        confirmationDelaysMs: [300, 500, 1000],
        maxMarketOpenAttempts: 6,
        isMarketOpenAmbiguous: (symbol) =>
          this.stateForSymbol(symbol).get().marketOpenAmbiguous === true,
        markMarketOpenAmbiguous: (symbol, clientOrderId) =>
          this.stateForSymbol(symbol).set({
            marketOpenAmbiguous: true,
            marketOpenClientOrderId: clientOrderId,
          }),
        clearMarketOpenAmbiguity: (symbol) =>
          this.stateForSymbol(symbol).set({
            marketOpenAmbiguous: false,
            marketOpenClientOrderId: undefined,
          }),
      }),
      this.strategyTelemetry,
    );
    this.aegisExecutionCoordinator = new AegisExecutionCoordinator(this.sharedStrategyExecution);
    this.aegisProfitProtectionService = new AegisProfitProtectionService({
      logger: deps.logger,
      notifier: deps.notifier,
      now: () => Date.now(),
      getConfig: () => this.getAegisProfitProtectionConfig(),
      getFallbackLeverage: (symbol) => this.getAegisTurboGateConfig(symbol).leverageCap,
      getSymbolFilters: (symbol, leverage) => this.deps.exchange.getSymbolFilters(symbol, leverage),
      roundPrice: (price, filters) => this.positionProtection.roundPrice(price, filters),
      useClosePosition: (state) =>
        !this.isVerifiedBotOwnedState(state) && !this.isLegacyBotOwnedState(state),
      moveCloseStop: (input) => this.positionProtection.moveCloseStop(input),
      logTradeEvent: (symbol, event, payload) =>
        this.logAegisTradeEvent(symbol, event, payload as HistoryTradeEventInput),
      formatRoe,
    });
    this.aegisExitManagementService = new AegisExitManagementService({
      logger: deps.logger,
      notifier: deps.notifier,
      now: () => Date.now(),
      getSignal: (symbol) => this.deps.mlService.getSignal(symbol),
      getExitEyeConfig: () => this.getAegisExitEyeConfig(),
      getEntryThreshold: (symbol) => this.getAegisTurboGateConfig(symbol).minScore,
      logTradeEvent: (symbol, event, payload) =>
        this.logAegisTradeEvent(symbol, event, payload as HistoryTradeEventInput),
      protectProfit: (input) => this.aegisProfitProtectionService.execute(input),
      executePositionClose: (input) =>
        this.deps.exchange.closeSideMarketSafe(
          input.symbol,
          input.side,
          input.qtyAbs,
          input.sideMode,
          input.reason,
        ),
      notifyExit: (symbol, side, reason, state, exit) =>
        this.notifyExit(symbol, side, reason, state, exit),
      formatRoe,
    });
    this.momentumEntryCoordinator = new MomentumEntryCoordinator({
      logger: deps.logger,
      notifier: deps.notifier,
      identity: this.momentumStrategyIdentity,
      strategyRouter: this.momentumStrategyRouter,
      execution: this.sharedStrategyExecution,
      historyLogger: this.historyLogger,
      now: () => Date.now(),
      getConfig: () => this.getAegisMomentumRideConfig(),
      readRuntimeCandles: (symbol, limit) =>
        this.strategyRuntimeCoordinator.readMomentumCandles(symbol, limit),
      readRealtimeMarket: (symbol) =>
        this.strategyRuntimeCoordinator.readMomentumRealtimeMarket(symbol),
      getCachedCandles: (symbol) => this.getCachedEntryQualityCandles(symbol),
      getRestCandles: (symbol, interval, limit) =>
        this.deps.exchange.getCandles(symbol, interval, limit),
      isValidCandle: (candle) => this.isValidCandle(candle),
      isFiniteNumber: (value): value is number => this.finiteNumber(value),
      getUSDTBalance: () => this.deps.exchange.getUSDTBalance(),
      readEntryAccountSnapshot: (walletFallback) => this.readEntryAccountSnapshot(walletFallback),
      initializeDailyStartBalance: (balance, now) =>
        this.riskSession.initializeDailyStartBalance(balance, now),
      getDailyStartBalance: () => this.riskSession.snapshot().dailyStartBalance,
      setLastDailyPnlPct: (value) => this.riskSession.setDailyPnlPct(value),
      readClosedOutcomes: () =>
        this.deps.closedTradeOutcomeReader?.() ??
        readStrategyClosedTradeOutcomes(undefined, this.getTradingMode()),
      getTradingMode: () => this.getTradingMode(),
      getSymbolMode: (symbol) => this.getSymbolMode(symbol),
      isLiveEnabled: () => CONFIG.AEGIS_LIVE_ENABLED === true,
      readStrategyRisk: (now) => this.riskSession.strategySnapshot('MOMENTUM_RIDE', now),
      timeSinceLastLossMs: (now) => this.riskSession.timeSinceLastLossMs('MOMENTUM_RIDE', now),
      readPortfolioExposure: () => this.readAegisPortfolioExposure(),
      getLiveSymbols: () => this.getLiveAegisSymbols(),
      stateForSymbol: (symbol) => this.stateForSymbol(symbol),
      hasOpenPosition: (symbol) => this.deps.exchange.hasOpenPosition(symbol, 'ANY'),
      readLiquidityStatus: (symbol, now) =>
        this.detector[symbol]?.getLiquidityStressStatus(now, LIQUIDITY_STRESS_FRESHNESS_WINDOW_MS),
      liquidityInputVersion: LIQUIDITY_STRESS_INPUT_VERSION,
      logTradeEvent: (symbol, event, payload) =>
        this.logAegisTradeEvent(symbol, event, payload as HistoryTradeEventInput),
      recordConfirmedOpen: (openedAt) => {
        this.riskSession.recordConfirmedOpen({ strategyId: 'MOMENTUM_RIDE', openedAt });
      },
    });
    const momentumRuntimeConfig = this.getAegisMomentumRideConfig();
    const momentumRuntimeMode =
      momentumRuntimeConfig.enabled !== true || momentumRuntimeConfig.mode === 'OFF'
        ? 'OFF'
        : momentumRuntimeConfig.mode === 'ENFORCE'
          ? 'LIVE'
          : 'SHADOW';
    this.momentumStrategyRouter.register(
      new MomentumRideStrategy(this.momentumStrategyIdentity, momentumRuntimeMode),
    );
    const mbConfig = this.getMicroBurstConfig();
    this.microBurstStrategyRouter.register(
      new MicroBurstStrategy(
        this.microBurstIdentity,
        isMicroBurstShadowMode(mbConfig) ? 'SHADOW' : 'OFF',
      ),
    );
    this.strategyRuntimeCoordinator = new StrategyRuntimeCoordinator({
      exchange: deps.exchange,
      logger: deps.logger,
      clock: { now: () => Date.now() },
      aegisIdentity: this.aegisStrategyIdentity,
      momentumStrategyRouter: this.momentumStrategyRouter,
      microBurstStrategyRouter: this.microBurstStrategyRouter,
      decisionSink: this.decisionEvidenceSink,
      marketSnapshotSink: this.marketSnapshotEvidenceSink,
    });
    const thisService = this;
    this.aegisEntryWorkflow = new AegisEntryWorkflow({
      exchange: deps.exchange,
      logger: deps.logger,
      notifier: deps.notifier,
      configManager: deps.configManager,
      canExecuteLive: (symbol) => this.canExecuteLive(symbol),
      getSymbolMode: (symbol) => this.getSymbolMode(symbol),
      getTradingMode: () => this.getTradingMode(),
      getAegisTurboYamlConfig: () => this.getAegisTurboYamlConfig(),
      stateForSymbol: (symbol) => this.stateForSymbol(symbol),
      getAegisPositionFractionOverride: (symbol, side) =>
        this.getAegisPositionFractionOverride(symbol, side),
      logAegisTradeEvent: (symbol, event, input) => this.logAegisTradeEvent(symbol, event, input),
      buildAegisEntryContext: (input) => this.aegisEntryContextBuilder.build(input),
      getAegisEntryPolicyConfig: () => this.getAegisEntryPolicyConfig(),
      extractPhaseOTurboMetadata: (signal, side) => this.extractPhaseOTurboMetadata(signal, side),
      isPhaseOShortLiveSignal: (signal, side) => this.isPhaseOShortLiveSignal(signal, side),
      withPhaseOShortGuardModes: (policy) => this.withPhaseOShortGuardModes(policy),
      getAegisPhaseOShortLiveConfig: () => this.getAegisPhaseOShortLiveConfig(),
      getPhaseOShortTradesToday: () => this.riskSession.snapshot().phaseOShortTradesToday,
      logAegisTurboSignal: (symbol, signal, extras) =>
        this.logAegisTurboSignal(symbol, signal, extras),
      shouldLogError: (symbol, key, intervalMs) => this.shouldLogError(symbol, key, intervalMs),
      aegisEntryCoordinator: this.aegisEntryCoordinator,
      strategyRuntimeCoordinator: this.strategyRuntimeCoordinator,
      finiteNumber: (value): value is number => this.finiteNumber(value),
      logEntryIntelligenceDispositionShadow: (...args) =>
        (this.logEntryIntelligenceDispositionShadow as any)(...args),
      logEntryQualityGateDecision: (...args) => (this.logEntryQualityGateDecision as any)(...args),
      logAegisEventRiskDecision: (...args) => (this.logAegisEventRiskDecision as any)(...args),
      logAegisDecisionEnforcementDenied: (...args) =>
        (this.logAegisDecisionEnforcementDenied as any)(...args),
      notifyDecisionEnforcementDenied: (...args) =>
        (this.notifyDecisionEnforcementDenied as any)(...args),
      logAegisProbeModeDecision: (...args) => (this.logAegisProbeModeDecision as any)(...args),
      logAegisCleanEntryGuardDecision: (...args) =>
        (this.logAegisCleanEntryGuardDecision as any)(...args),
      notifyProbeModeAllowed: (...args) => (this.notifyProbeModeAllowed as any)(...args),
      getEntryQualityGateConfig: (symbol) => this.getEntryQualityGateConfig(symbol),
      readEntryAccountSnapshot: (walletFallback) => this.readEntryAccountSnapshot(walletFallback),
      roundQuantity: (quantity, filters) =>
        this.positionProtection.roundQuantity(quantity, filters),
      getAegisPortfolioRiskConfig: () => this.getAegisPortfolioRiskConfig(),
      readAegisPortfolioExposure: () => this.readAegisPortfolioExposure(),
      notifyError: (symbol, title, error) => this.notifyError(symbol, title, error),
      strategyIdentity: (strategy) => this.strategyIdentity(strategy),
      aegisExecutionCoordinator: this.aegisExecutionCoordinator,
      getAegisTurboRegimeConfig: (symbol) => this.getAegisTurboRegimeConfig(symbol),
      getAegisGuardianConfig: (symbol, regimeConfig) =>
        this.getAegisGuardianConfig(symbol, regimeConfig),
      recordProbeModeEntry: (openedAtMs, tradeId) => this.recordProbeModeEntry(openedAtMs, tradeId),
      historyLogger: this.historyLogger,
      logAegisAccountSnapshot: (input) => this.logAegisAccountSnapshot(input),
      recordConfirmedOpen: (strategyId, openedAt, phaseOShortLive) =>
        this.riskSession.recordConfirmedOpen({ strategyId, openedAt, phaseOShortLive }),
      buildAegisEntryMessage: (input) => this.buildAegisEntryMessage(input),
      formatScore,
      get lastEntryBalance() {
        return thisService.lastEntryBalance;
      },
      set lastEntryBalance(value) {
        thisService.lastEntryBalance = value;
      },
      get peakBalance() {
        return thisService.peakBalance;
      },
      set peakBalance(value) {
        thisService.peakBalance = value;
      },
    });

    this.positionLifecycleCore = new StrategyPositionLifecycleCore({
      exchange: deps.exchange,
      logger: deps.logger,
      notifier: deps.notifier,
      defaultLeverage: (symbol) => this.getAegisTurboGateConfig(symbol).leverageCap,
      requireBrackets: (policy) =>
        policy.strategyId === 'AEGIS_TURBO'
          ? this.getAegisTurboYamlConfig()?.require_brackets !== false
          : policy.strategyId === 'MOMENTUM_RIDE'
            ? this.getAegisMomentumRideConfig().safetyCaps.requireBrackets
            : true,
      getRegimeConfig: (symbol) => this.getAegisTurboRegimeConfig(symbol),
      getGuardianConfig: (symbol, regimeConfig) =>
        this.getAegisGuardianConfig(symbol, regimeConfig),
      isVerifiedBotOwnedState: (state) => this.isVerifiedBotOwnedState(state),
      isLegacyBotOwnedState: (state) => this.isLegacyBotOwnedState(state),
      consecutiveLosses: () => this.riskSession.snapshot().consecutiveLosses,
      calculateRoe: (side, entryPrice, markPrice, leverage) =>
        this.calculateRoe(side, entryPrice, markPrice, leverage),
      entryMargin: (state) => this.entryMargin(state),
      pnlFromRoe: (margin, roe) => this.pnlFromRoe(margin, roe),
      roundPrice: (price, filters) => this.positionProtection.roundPrice(price, filters),
      isBetterStop: (side, next, previous) =>
        this.positionProtection.isBetterStop(side, next, previous),
      formatRoe,
      notifyExit: (symbol, side, reason, state, exit) =>
        this.notifyExit(symbol, side, reason, state, exit),
      logTradeEvent: async (strategyId, symbol, event, input) => {
        await this.logAegisTradeEvent(symbol, event, input);
        const state = this.stateForSymbol(symbol).get();
        const upper = event.toUpperCase();
        const eventType =
          upper.includes('EXIT') || upper.includes('CLOSED')
            ? 'EXIT'
            : upper.includes('GUARD') ||
                upper.includes('STOP') ||
                upper.includes('TRAIL') ||
                upper.includes('BREAK_EVEN') ||
                upper.includes('PROTECT')
              ? 'GUARD_RESULT'
              : 'POSITION_EVENT';
        if (strategyId !== 'EXTERNAL') {
          await this.strategyTelemetry.publish({
            eventType,
            strategyId,
            symbol,
            occurredAtMs: Date.now(),
            tradeId: input?.tradeId ?? state.lastTradeId,
            side: state.lastSide as Side | undefined,
            status: event,
            reason: input?.reason,
            details: { ...input, lifecycleEvent: event },
          });
        }
      },
      safeMoveCloseStop: (input) => this.positionProtection.moveCloseStop(input),
      ensureBrackets: (symbol, side, entryPrice, leverage, position, state, overrides) =>
        this.positionProtection.ensureBrackets(
          symbol,
          side,
          entryPrice,
          leverage,
          position,
          state,
          overrides,
        ),
      replaceBracketsForNewEntryPrice: (symbol, side, entryPrice, leverage, position, state) =>
        this.positionProtection.replaceBracketsForNewEntryPrice(
          symbol,
          side,
          entryPrice,
          leverage,
          position,
          state,
        ),
      reconcilePositionSize: (input) => this.positionProtection.reconcilePositionSize(input),
    });
    const aegisLifecycle = this.positionLifecycleCore.createAegisLifecycle(
      strategyLifecyclePolicy('AEGIS_TURBO'),
      (input) => this.aegisExitManagementService.evaluate(input),
    );
    this.positionManagerRouter.register(new AegisPositionManager(aegisLifecycle));
    this.positionManagerRouter.register(
      new MomentumRidePositionManager(this.positionLifecycleCore),
    );
    this.positionManagerRouter.register(new MicroBurstPositionManager(this.positionLifecycleCore));
  }

  private getTradingMode(): string {
    return this.config.tradingMode || CONFIG.TRADING_MODE;
  }

  private getMicroBurstConfig(): ReturnType<typeof parseMicroBurstConfig> {
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

  private extractPhaseOTurboMetadata(
    signalOrPrediction: unknown,
    fallbackSide?: Side,
  ): AegisPhaseOMetadata | null {
    return extractAegisPhaseOMetadata(signalOrPrediction, fallbackSide);
  }

  private isPhaseOShortLiveSignal(signal: AegisTradingSignal, side: Side): boolean {
    const phaseOConfig = this.getAegisPhaseOShortLiveConfig() as any;
    const metadata = this.extractPhaseOTurboMetadata(signal, side);
    const symbol = this.normalizeSymbol(signal.symbol);
    if (symbol === 'LINKUSDT' || metadata?.avoidOnly === true) {
      this.deps.logger.info('phase_o_link_avoid_only_no_entry', {
        symbol,
        side,
        phase_o_short_detected: metadata?.isPhaseO === true,
        phase_o_metadata_source_path: metadata?.sourcePath,
        link_avoid_only: true,
      });
      return false;
    }
    return (
      phaseOConfig?.enabled === true &&
      phaseOConfig?.allow_orders !== false &&
      side === 'SHORT' &&
      metadata?.isPhaseO === true &&
      metadata.side === 'SHORT' &&
      metadata.entryEnabled !== false
    );
  }

  private withPhaseOShortGuardModes(
    policy: AegisEntryPolicyRuntimeConfig,
  ): AegisEntryPolicyRuntimeConfig {
    return {
      ...policy,
      guards: {
        ...policy.guards,
        clean_entry: { ...policy.guards.clean_entry, enabled: true, mode: 'SHADOW' },
        event_risk: { ...policy.guards.event_risk, enabled: true, mode: 'SHADOW' },
        entry_quality: { ...policy.guards.entry_quality, enabled: true, mode: 'SHADOW' },
        decision_brain: { ...policy.guards.decision_brain, enabled: true, mode: 'SHADOW' },
        regime: { ...policy.guards.regime, enabled: true, mode: 'SHADOW' },
        probe_mode: { ...policy.guards.probe_mode, enabled: true, mode: 'SHADOW' },
        short_gate: { ...policy.guards.short_gate, enabled: true, mode: 'SHADOW' },
        long_risk_shadow: { ...policy.guards.long_risk_shadow, enabled: true, mode: 'SHADOW' },
      },
    };
  }

  private getEntryQualityGateConfig(symbol?: string): AegisEntryQualityGateRuntimeConfig {
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

  private normalizeSymbol(symbol: string): string {
    return String(symbol || '')
      .trim()
      .toUpperCase();
  }

  private finiteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
  }

  private isVerifiedBotOwnedState(state: BotState): boolean {
    return (
      (state.positionOwner === 'BOT' || state.positionOwner === 'AEGIS') &&
      state.tradeOrigin === 'BOT' &&
      state.ownershipStatus === 'VERIFIED' &&
      state.eligibleForBotMetrics === true
    );
  }

  private isLegacyBotOwnedState(state: BotState): boolean {
    return (
      !this.isVerifiedBotOwnedState(state) &&
      state.mode !== 'IDLE' &&
      typeof state.lastTradeId === 'string' &&
      state.lastTradeId.startsWith('AEGIS-TURBO-')
    );
  }

  private stateForSymbol(symbol: string): StateStore {
    const normalized = this.normalizeSymbol(symbol);
    const scopedFactory = this.deps.state.forSymbol;
    if (typeof scopedFactory !== 'function') return this.deps.state;
    const cached = this.symbolStateStores.get(normalized);
    if (cached) return cached;
    const scoped = scopedFactory.call(this.deps.state, normalized);
    this.symbolStateStores.set(normalized, scoped);
    return scoped;
  }

  getAegisRuntimeSnapshot(): AegisRuntimeSnapshot {
    const riskSession = this.riskSession.snapshot();
    const liquidityStressBySymbol: Record<string, number> = {};
    const liquidityStressStatusBySymbol: Record<string, 'NO_DATA' | 'FRESH' | 'STALE'> = {};
    const liquidityStressAgeMsBySymbol: Record<string, number | undefined> = {};
    const liquidityStressInputVersionBySymbol: Record<
      string,
      typeof LIQUIDITY_STRESS_INPUT_VERSION
    > = {};
    for (const symbol of Object.keys(this.detector)) {
      const status = this.detector[symbol]?.getLiquidityStressStatus(
        Date.now(),
        LIQUIDITY_STRESS_FRESHNESS_WINDOW_MS,
      );
      liquidityStressBySymbol[symbol] = status?.stress ?? 0;
      liquidityStressStatusBySymbol[symbol] = status?.status ?? 'NO_DATA';
      liquidityStressAgeMsBySymbol[symbol] = status?.receiveAgeMs;
      liquidityStressInputVersionBySymbol[symbol] =
        status?.inputVersion ?? LIQUIDITY_STRESS_INPUT_VERSION;
    }
    return {
      tradingMode: this.getTradingMode(),
      isRunning: this.isRunning,
      tradesToday: riskSession.tradesToday,
      consecutiveLosses: riskSession.consecutiveLosses,
      dailyStartBalance: riskSession.dailyStartBalance,
      dailyPnlPct: riskSession.dailyPnlPct,
      lastTradeDayReset: riskSession.lastTradeDayReset,
      liquidityStressBySymbol,
      liquidityStressStatusBySymbol,
      liquidityStressAgeMsBySymbol,
      liquidityStressInputVersionBySymbol,
      microBurstReadiness: this.strategyRuntimeCoordinator.getMicroBurstReadiness(),
    };
  }

  getMicroBurstReadiness(): MicroBurstRuntimeReadiness | null {
    return this.strategyRuntimeCoordinator.getMicroBurstReadiness();
  }

  async start(startLoop = true): Promise<void> {
    const { logger, notifier, mlService, configManager, exchange } = this.deps;
    const manager = configManager as any;
    if (typeof manager.validateSingleLiveAegisSymbol === 'function') {
      manager.validateSingleLiveAegisSymbol();
    }
    const tradingMode = this.getTradingMode();
    const isTurbo = tradingMode === 'AEGIS_TURBO_MICRO_LIVE';
    let startupWalletBalance: number | null = null;
    try {
      startupWalletBalance = await exchange.getUSDTBalance();
    } catch (error) {
      logger.warn('startup_wallet_balance_unavailable', { error });
    }
    const startupAccount = await this.readEntryAccountSnapshot(startupWalletBalance ?? undefined);
    await this.riskSession.restore();

    logger.info(isTurbo ? '⚡ AEGIS TURBO MICRO-LIVE MODE' : '🛡️ AEGIS SHADOW MODE', {
      initial: INITIAL_BALANCE,
      walletBalance: startupWalletBalance,
      mode: tradingMode,
      liveEnabled: CONFIG.AEGIS_LIVE_ENABLED,
      yamlLiveEnabled: this.getAegisTurboYamlConfig()?.live_enabled === true,
    });

    const liveSymbols = this.getLiveAegisSymbols();
    const startupSymbols = liveSymbols.length > 0 ? liveSymbols : this.config.symbols;
    const firstSymbol = startupSymbols[0] ?? this.config.symbols[0];
    const gateConfig = this.getAegisTurboGateConfig(firstSymbol);
    const regimeConfig = this.getAegisTurboRegimeConfig(firstSymbol);
    const momentumRideConfig = this.getAegisMomentumRideConfig();
    const probeModeConfig = this.getAegisProbeModeConfig();
    const entryThreshold = gateConfig.minScore;
    const maxHoldMs =
      (gateConfig as any).maxHoldMs ?? regimeConfig?.maxHoldMs ?? DEFAULT_AEGIS_MAX_HOLD_MS;
    const trailingActivation =
      (gateConfig as any).trailingActivationRoe ?? regimeConfig?.trailingActivationRoe ?? 0.15;
    const trailingCallback =
      (gateConfig as any).trailingCallbackRoe ?? regimeConfig?.trailingCallbackRoe ?? 0.08;

    for (let i = 0; i < 5; i++) {
      try {
        await mlService.getSignal(firstSymbol);
        break;
      } catch (e) {
        logger.info(`Waiting for Aegis API (${i + 1}/5)`);
        await this.sleep(3000);
      }
    }

    await this.positionRecovery.migrateLegacyGlobalStateToFirstLiveSymbol();
    await this.positionRecovery.attachOpenExchangePositionsToSymbolState();

    const startupPositions: AegisPositionMessageInput[] = [];
    for (const symbol of liveSymbols) {
      const symbolState = this.stateForSymbol(symbol).get();
      if (symbolState.mode === 'IDLE') continue;

      const side = symbolState.lastSide as Side;
      const symbolGateConfig = this.getAegisTurboGateConfig(symbol);
      const symbolRegimeConfig = this.getAegisTurboRegimeConfig(symbol);
      const markPrice = await exchange.getMarkPrice(symbol);
      const position = await exchange.readActivePosition(symbol, side);
      const entryPrice = symbolState.lastEntryPrice || position?.entryPrice || markPrice;
      const leverage =
        position?.leverage ||
        symbolState.lastActualLeverage ||
        symbolState.lastLeverage ||
        symbolGateConfig.leverageCap;
      const qtyAbs = position?.qtyAbs || symbolState.lastEntryQty || 0;
      const marginUsed =
        position?.isolatedMargin ||
        symbolState.lastEntryMargin ||
        (entryPrice > 0 && leverage > 0 && qtyAbs > 0 ? (entryPrice * qtyAbs) / leverage : 0);
      const durationMs = symbolState.lastEntryAt ? Date.now() - symbolState.lastEntryAt : 0;
      const roi =
        side === 'SHORT'
          ? ((entryPrice - markPrice) / entryPrice) * leverage
          : ((markPrice - entryPrice) / entryPrice) * leverage;
      const pnl =
        typeof position?.unrealizedPnl === 'number' && Number.isFinite(position.unrealizedPnl)
          ? position.unrealizedPnl
          : this.pnlFromRoe(marginUsed, roi);
      const approximateBalance =
        startupWalletBalance !== null ? startupWalletBalance + marginUsed + pnl : null;
      const openOrders = await exchange.listCloseOrdersForSide(symbol, side);
      const ownedOpenOrders = openOrders.filter((order) => order.owner === 'BOT');
      const tpOrder = ownedOpenOrders.find((order) => order.type.includes('TAKE_PROFIT'));
      const slOrder = ownedOpenOrders.find((order) => order.type.includes('STOP'));
      const stopRoe = symbolState.lastStopRoe ?? symbolRegimeConfig?.hardStopRoe ?? -0.15;
      const takeProfitRoe = symbolState.lastTakeProfitRoe ?? symbolRegimeConfig?.tpRoe ?? 0.25;

      startupPositions.push({
        symbol,
        side,
        strategy: (symbolState as any).lastStrategy,
        size: qtyAbs,
        margin: marginUsed,
        leverage,
        roi,
        pnl,
        durationHours: durationMs / 3600000,
        tpPrice: tpOrder?.stopPrice,
        slPrice: slOrder?.stopPrice,
        tpRoe: takeProfitRoe,
        slRoe: stopRoe,
      });
      await this.logAegisAccountSnapshot({
        symbol,
        walletBalance: startupAccount.walletBalance ?? startupWalletBalance ?? undefined,
        availableBalance: startupAccount.availableBalance,
        unrealizedPnl: pnl,
        positionOpen: true,
        side,
        entryPrice,
        markPrice,
        roe: roi,
        marginUsed,
        quantity: qtyAbs,
        leverage,
        metadata: { event: 'startup' },
      });
      if (approximateBalance !== null && startupAccount.equityTotal === undefined) {
        logger.debug('startup_approximate_balance', { symbol, approximateBalance });
      }
    }

    if (startupPositions.length === 0) {
      await this.logAegisAccountSnapshot({
        symbol: firstSymbol,
        walletBalance: startupAccount.walletBalance ?? startupWalletBalance ?? undefined,
        availableBalance: startupAccount.availableBalance,
        positionOpen: false,
        metadata: { event: 'startup' },
      });
    }

    const momentumExamples = Object.entries(momentumRideConfig.symbols ?? {}).flatMap(
      ([symbol, symbolConfig]) => {
        const config = symbolConfig as any;
        const examples: Array<{ symbol: string; side: Side; positionFraction?: number }> = [];
        if (config.long?.enabled) {
          examples.push({ symbol, side: 'LONG', positionFraction: config.long.positionFraction });
        }
        if (config.short?.enabled) {
          examples.push({ symbol, side: 'SHORT', positionFraction: config.short.positionFraction });
        }
        return examples;
      },
    );

    const startupMsg = formatAegisStartupMessage({
      mode: {
        tradingMode,
        liveEnabled:
          CONFIG.AEGIS_LIVE_ENABLED === true &&
          this.getAegisTurboYamlConfig()?.live_enabled === true,
        strategy: 'AEGIS_TURBO+MOMENTUM_RIDE',
        shortsEnabled: gateConfig.allowShort === true,
        activeSymbols: startupSymbols,
      },
      account: {
        walletBalance: startupAccount.walletBalance ?? startupWalletBalance ?? undefined,
        equityTotal: startupAccount.equityTotal,
        availableBalance: startupAccount.availableBalance,
      },
      config: {
        leverage: gateConfig.leverageCap,
        entryThreshold: Number(entryThreshold),
        maxHoldHours: Number(maxHoldMs) / 3600000,
        trailingEnabled: trailingActivation > 0,
        trailingActivationRoe: trailingActivation,
        trailingCallbackRoe: trailingCallback,
        stopRoe: gateConfig.stopRoe,
        takeProfitRoe: gateConfig.takeProfitRoe,
        maxTradesPerDay: gateConfig.maxTradesPerDay,
        dailyLossStopPct: gateConfig.dailyLossStopPct,
        maxConsecutiveLosses: gateConfig.maxConsecutiveLosses,
        requireBrackets: gateConfig.requireBrackets,
      },
      aegisTurbo: {
        enabled: this.getAegisTurboYamlConfig()?.enabled === true,
        mode:
          CONFIG.AEGIS_LIVE_ENABLED === true &&
          this.getAegisTurboYamlConfig()?.live_enabled === true
            ? 'LIVE'
            : 'SHADOW',
        fallbackEnabled: true,
        leverage: gateConfig.leverageCap,
        entryThreshold: Number(entryThreshold),
        trailingActivationRoe: trailingActivation,
        trailingCallbackRoe: trailingCallback,
        stopRoe: gateConfig.stopRoe,
        takeProfitRoe: gateConfig.takeProfitRoe,
        requireBrackets: gateConfig.requireBrackets,
      },
      momentumRide: {
        enabled: momentumRideConfig.enabled,
        mode: momentumRideConfig.enabled ? momentumRideConfig.mode : 'OFF',
        researchMode: momentumRideConfig.researchMode,
        maxPositionFraction: momentumRideConfig.safetyCaps.maxPositionFraction,
        maxOpenMomentumPositions: momentumRideConfig.safetyCaps.maxOpenMomentumPositions,
        maxMomentumTradesPerDay: momentumRideConfig.safetyCaps.maxMomentumTradesPerDay,
        maxConsecutiveMomentumLosses: momentumRideConfig.safetyCaps.maxConsecutiveMomentumLosses,
        cooldownAfterLossMinutes: momentumRideConfig.safetyCaps.cooldownAfterLossMinutes,
        requireAegisDirectionConfirmation: momentumRideConfig.requireAegisDirectionConfirmation,
        requireBtcEthNotContradicting: momentumRideConfig.requireBtcEthNotContradicting,
        examples: momentumExamples,
      },
      regimeEngineV2: {
        metadataEnabled: momentumRideConfig.regimeFilter.recordMetadata,
        useAsGate: momentumRideConfig.regimeFilter.useAsGate,
        ignoreForEntry: momentumRideConfig.regimeFilter.ignoreForEntry,
      },
      probeMode: {
        enabled: probeModeConfig.enabled,
        mode: probeModeConfig.enabled ? probeModeConfig.mode : 'OFF',
        maxOpenProbePositions: probeModeConfig.max_open_probe_positions,
        maxProbeEntriesPerHour: probeModeConfig.max_probe_entries_per_hour,
      },
      activePositions: startupPositions,
    });
    await notifier.sendMessage(startupMsg);
    for (const symbol of this.config.symbols) {
      if (!this.strategyRuntimeCoordinator.hasAegisRealtimeMarketState()) {
        this.deps.exchange.subscribeToCandles(symbol);
      }
      this.detector[symbol] =
        this.strategyRuntimeCoordinator.aegisDetectorFor(symbol) ??
        new LiquidityVoidDetector(this.deps.logger);
      if (
        !this.strategyRuntimeCoordinator.hasAegisRealtimeMarketState() &&
        this.deps.exchange.subscribeToPartialDepth
      ) {
        this.deps.exchange.subscribeToPartialDepth(symbol, 20, '100ms', (depth: any) => {
          if (!depth?.bids || !depth?.asks) return;
          const mapper = (arr: any[]) =>
            arr.map((row) =>
              Array.isArray(row)
                ? { price: Number(row[0]), qty: Number(row[1]) }
                : { price: Number(row.price), qty: Number(row.quantity) },
            );
          this.detector[symbol].processDepthUpdate({
            bidDepth: mapper(depth.bids),
            askDepth: mapper(depth.asks),
          });
        });
      }
    }

    this.isRunning = true;

    const mbConfig = this.getMicroBurstConfig();
    await this.strategyRuntimeCoordinator.start({
      symbols: startupSymbols,
      microBurstConfig: mbConfig,
      loadMicroBurstProvenance:
        mbConfig.enabled && mbConfig.mode !== 'OFF'
          ? () => this.getMicroBurstProvenance(mbConfig)
          : undefined,
    });

    this.hardWatchdogTimer = setInterval(() => {
      if (this.isRunning && Date.now() - this.lastAlivePulseMs > 180000) {
        this.deps.logger.error('system_deadlock_detected');
        process.exit(1);
      }
    }, 10000);

    if (startLoop) await this.runLoop();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.isRunning = false;
    this.deps.logger.info('Aegis bot stopped');
    if (this.hardWatchdogTimer) clearInterval(this.hardWatchdogTimer);
    this.stopPromise = (async () => {
      await this.strategyRuntimeCoordinator.stop();
      const stores = [this.deps.state, ...this.symbolStateStores.values()];
      await Promise.all(stores.map((store) => store.flush?.()));
    })().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  async tick(symbol: string): Promise<void> {
    await this.processSymbol(symbol);
  }

  private async runLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        this.riskSession.checkDailyReset();
        for (const symbol of this.config.symbols) {
          if (!this.isRunning) break;
          await this.processSymbol(symbol);
        }
        await this.sleep(this.config.tickIntervalMs);
      } catch (error) {
        this.deps.logger.error('Loop error', { error: String(error) });
        await this.sleep(1000);
      }
    }
  }

  private async processSymbol(symbol: string): Promise<void> {
    this.lastAlivePulseMs = Date.now();
    const symbolState = this.stateForSymbol(symbol);
    const botState = symbolState.get();
    const symbolMode = this.getSymbolMode(symbol);

    try {
      if (symbolMode === 'OFF') {
        return;
      }

      if (symbolMode !== 'LIVE') {
        await this.scanShadowOnly(symbol);
        return;
      }

      if (botState.mode !== 'IDLE') {
        await this.managePositionByOwner(symbol, botState, symbolState);
        if (symbolState.get().mode === 'IDLE') {
          const adopted = await this.positionRecovery.tryAdoptManualPositionRuntime(symbol);
          if (!adopted) {
            await this.lookForEntry(symbol);
          }
        }
      } else {
        const adopted = await this.positionRecovery.tryAdoptManualPositionRuntime(symbol);
        if (!adopted) {
          await this.lookForEntry(symbol);
        }
      }
    } catch (error) {
      this.deps.logger.warn('Process error', { symbol, error: String(error) });
    }
  }

  private strategyIdentityForState(botState: BotState): StrategyIdentity | null {
    const ownership = resolveStrategyOwnership(botState);
    if (ownership.status !== 'OWNED' && ownership.status !== 'LEGACY_MIGRATABLE') return null;
    if (ownership.strategyId === 'AEGIS_TURBO') return this.aegisStrategyIdentity;
    if (ownership.strategyId === 'MOMENTUM_RIDE') return this.momentumStrategyIdentity;
    return null;
  }

  private async managePositionByOwner(
    symbol: string,
    botState: BotState,
    symbolState: StateStore,
  ): Promise<void> {
    const ownership = resolveStrategyOwnership(botState);
    if (ownership.status === 'EXTERNAL') {
      // Manual/external positions retain protective mechanics without
      // receiving Aegis strategy authority such as ExitEye.
      await this.positionLifecycleCore.manage(externalLifecyclePolicy(), {
        symbol,
        botState,
        symbolState,
      });
      return;
    }

    const identity = this.strategyIdentityForState(botState);
    if (!identity) {
      this.deps.logger.error('strategy_position_ownership_recovery_required', {
        symbol,
        tradeId: botState.lastTradeId,
        ownership,
      });
      return;
    }

    const routed = await this.positionManagerRouter.route(identity, {
      symbol,
      botState,
      symbolState,
    });
    if (routed.status === 'RECOVERY_REQUIRED') {
      this.deps.logger.error('strategy_position_manager_recovery_required', {
        symbol,
        tradeId: botState.lastTradeId,
        strategyId: identity.strategyId,
        reason: routed.reason,
      });
      return;
    }
  }

  private strategyFromTradeId(tradeId?: string): AegisResearchStrategy | undefined {
    if (!tradeId) return undefined;
    if (tradeId.startsWith('MOMENTUM-RIDE-')) return 'MOMENTUM_RIDE';
    if (tradeId.startsWith('AEGIS-TURBO-')) return 'AEGIS_TURBO';
    return undefined;
  }

  private strategyIdentity(strategy: AegisResearchStrategy): StrategyIdentity {
    return strategy === 'MOMENTUM_RIDE'
      ? this.momentumStrategyIdentity
      : this.aegisStrategyIdentity;
  }

  private strategyForSymbol(symbol: string, tradeId?: string): AegisResearchStrategy {
    const fromTrade = this.strategyFromTradeId(tradeId);
    if (fromTrade) return fromTrade;
    const stateStrategy = this.stateForSymbol(symbol).get().lastStrategy;
    return stateStrategy === 'MOMENTUM_RIDE' ? 'MOMENTUM_RIDE' : 'AEGIS_TURBO';
  }

  private async scanShadowOnly(symbol: string): Promise<void> {
    const signal = await this.deps.mlService.getSignal(symbol);
    const signalId = generateSignalId(symbol);
    this.logAegisScan(symbol, signal);
    await this.logAegisTradeEvent(symbol, 'SIGNAL_RECEIVED', {
      metadata: { signalId, symbolMode: this.getSymbolMode(symbol), shadowOnly: true },
    });
    await this.logAegisTurboSignal(symbol, signal, {
      signalId,
      executed: false,
      metadata: {
        symbol_mode: this.getSymbolMode(symbol),
        shadow_only: true,
        ignored_reason: 'symbol_not_live',
      },
    });
  }

  private logAegisScan(symbol: string, signal: AegisTradingSignal): void {
    this.strategyHistory.logScan(symbol, signal);
  }

  private async logAegisTurboSignal(
    symbol: string,
    signal: AegisTradingSignal,
    extras: {
      signalId?: string;
      tradeId?: string;
      price?: number;
      gate?: AegisMicroLiveGateDecision;
      executed?: boolean;
      strategy?: AegisResearchStrategy;
      identity?: StrategyIdentity;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    await this.strategyHistory.logTurboSignal(symbol, signal, extras);
  }

  private async logAegisTradeEvent(
    symbol: string,
    event: string,
    input: HistoryTradeEventInput = {},
  ): Promise<void> {
    await this.strategyHistory.logTradeEvent(symbol, event, input);
  }

  private async logEntryIntelligenceDispositionShadow(
    symbol: string,
    signal: AegisTradingSignal,
    stage: 'MICRO_GATE' | 'ENTRY_POLICY',
    operationalAllowed: boolean,
    operationalReason: string,
    deniedBy?: string,
    signalId?: string,
    tradeId?: string,
  ): Promise<void> {
    const aegis = this.getAegisSignalBlock(signal);
    const record = buildAegisOperationalDispositionShadow({
      symbol,
      stage,
      intelligence: aegis?.entry_intelligence_shadow,
      operationalAllowed,
      operationalReason,
      deniedBy,
    });
    if (!record) return;
    try {
      await this.logAegisTradeEvent(symbol, 'ENTRY_INTELLIGENCE_OPERATIONAL_DISPOSITION_SHADOW', {
        tradeId,
        reason: operationalReason,
        metadata: { ...record, signalId },
      });
    } catch (error) {
      this.deps.logger.warn('entry_intelligence_shadow_log_failed', {
        symbol,
        stage,
        error: String(error),
      });
    }
  }

  private async logAegisAccountSnapshot(input: HistoryAccountSnapshotInput = {}): Promise<void> {
    await this.strategyHistory.logAccountSnapshot(input);
  }

  private evaluateAegisTurboGate(
    symbol: string,
    signal: AegisTradingSignal,
    dailyPnlPct?: number,
  ): AegisMicroLiveGateDecision {
    const botState = this.stateForSymbol(symbol).get();
    const now = Date.now();
    const aegisRisk = this.riskSession.strategySnapshot('AEGIS_TURBO', now);
    const timeSinceLastExitMs = this.riskSession.timeSinceLastExitMs('AEGIS_TURBO', now);
    const liquidity = this.detector[symbol]?.getLiquidityStressStatus(
      now,
      LIQUIDITY_STRESS_FRESHNESS_WINDOW_MS,
    ) ?? {
      stress: 0,
      status: 'NO_DATA' as const,
      inputVersion: LIQUIDITY_STRESS_INPUT_VERSION,
    };

    return shouldEnterAegisTurboMicroLive(
      {
        symbol,
        signal: { aegis: signal.metadata?.aegis ?? signal.aegis },
        hasOpenPosition: botState.mode !== 'IDLE',
        tradesToday: aegisRisk.tradesToday,
        consecutiveLosses: aegisRisk.consecutiveLosses,
        timeSinceLastExitMs,
        liquidityStress: liquidity.stress,
        liquidityStressStatus: liquidity.status,
        liquidityStressAgeMs: liquidity.receiveAgeMs,
        liquidityStressInputVersion: liquidity.inputVersion,
        dailyPnlPct,
      },
      this.getAegisTurboGateConfig(symbol),
    );
  }

  private async lookForEntry(symbol: string): Promise<void> {
    const { mlService, exchange, logger } = this.deps;
    const symbolState = this.stateForSymbol(symbol);
    const tradingMode = this.getTradingMode();

    try {
      const momentumConfig = this.getAegisMomentumRideConfig();
      const standaloneMomentumHandled = await this.momentumEntryCoordinator.evaluate(symbol);
      if (standaloneMomentumHandled) return;
      if (
        momentumConfig.standaloneMainReplica === true &&
        momentumConfig.aegisFallbackEnabled === false
      ) {
        return;
      }

      const realtimeMarket = this.strategyRuntimeCoordinator.readAegisRealtimeMarket(symbol);
      if (realtimeMarket && realtimeMarket.status !== 'FRESH') {
        this.deps.logger.warn('aegis_realtime_market_not_fresh', {
          symbol,
          status: realtimeMarket.status,
          orderBookHealth: realtimeMarket.orderBookHealth,
          orderBookAgeMs: realtimeMarket.ageMs,
          aggTradeAgeMs: realtimeMarket.aggTradeAgeMs,
          aggTradeGapFree: realtimeMarket.aggTradeGapFree,
        });
        return;
      }

      const signal = await mlService.getSignal(symbol);
      const selectedStrategy: AegisResearchStrategy = 'AEGIS_TURBO';
      const signalId = generateSignalId(symbol);
      this.logAegisScan(symbol, signal);
      await this.logAegisTradeEvent(symbol, 'SIGNAL_RECEIVED', {
        strategy: selectedStrategy,
        identity: this.strategyIdentity(selectedStrategy),
        metadata: { signalId },
      });

      if (tradingMode === 'AEGIS_SHADOW') {
        await this.logAegisTurboSignal(symbol, signal, { signalId, executed: false });
        return;
      }
      if (tradingMode !== 'AEGIS_TURBO_MICRO_LIVE') {
        logger.warn('aegis_unknown_trading_mode', { symbol, tradingMode });
        await this.logAegisTurboSignal(symbol, signal, {
          signalId,
          executed: false,
          metadata: { ignored_reason: 'unknown_trading_mode' },
        });
        return;
      }

      if (this.getSymbolMode(symbol) !== 'LIVE') {
        await this.logAegisTurboSignal(symbol, signal, {
          signalId,
          executed: false,
          metadata: { ignored_reason: 'symbol_not_live', symbol_mode: this.getSymbolMode(symbol) },
        });
        return;
      }

      const balance = await exchange.getUSDTBalance();
      const accountSnapshot = await this.readEntryAccountSnapshot(balance);
      const dailyEquity = accountSnapshot.equityTotal ?? accountSnapshot.walletBalance ?? balance;
      this.riskSession.initializeDailyStartBalance(dailyEquity);
      const dailyStartBalance = this.riskSession.snapshot().dailyStartBalance;
      const accountWideDailyPnlPct =
        dailyStartBalance && dailyStartBalance > 0
          ? (dailyEquity - dailyStartBalance) / dailyStartBalance
          : undefined;
      const dayStart = Math.floor(Date.now() / 86400000) * 86400000;
      const verifiedOutcomes = await (this.deps.closedTradeOutcomeReader?.() ??
        readStrategyClosedTradeOutcomes(undefined, this.getTradingMode()));
      const botDailyPnlUsdt = verifiedOutcomes.reduce((total, outcome) => {
        const closedAt = Date.parse(outcome.closedAt);
        return Number.isFinite(closedAt) && closedAt >= dayStart ? total + outcome.pnlUsdt : total;
      }, 0);
      const dailyPnlPct =
        dailyStartBalance && dailyStartBalance > 0
          ? botDailyPnlUsdt / dailyStartBalance
          : undefined;
      this.riskSession.setDailyPnlPct(dailyPnlPct);
      const gateConfig = this.getAegisTurboGateConfig(symbol);
      const gateDecision = this.evaluateAegisTurboGate(symbol, signal, dailyPnlPct);
      await this.logEntryIntelligenceDispositionShadow(
        symbol,
        signal,
        'MICRO_GATE',
        gateDecision.allowed,
        gateDecision.reason,
        gateDecision.allowed ? undefined : 'micro_gate',
        signalId,
      );
      if (!gateDecision.allowed) {
        await this.logAegisTurboSignal(symbol, signal, {
          signalId,
          gate: gateDecision,
          executed: false,
        });
        await this.logAegisTradeEvent(symbol, 'GATE_DENIED', {
          reason: gateDecision.reason,
          metadata: {
            turboScore: gateDecision.turboScore,
            votes: gateDecision.votes,
            gatedReason: gateDecision.gatedReason,
            gatedBlockedBy: gateDecision.gatedBlockedBy,
          },
        });
        await this.logAegisAccountSnapshot({
          symbol,
          walletBalance: balance,
          availableBalance: balance,
          dailyPnlPct,
          positionOpen: false,
          metadata: {
            reason: gateDecision.reason,
            dailyPnlScope: 'VERIFIED_BOT_CLOSED_OUTCOMES',
            botDailyPnlUsdt,
            accountWideDailyPnlPct,
          },
        });
        logger.info('aegis_micro_live_gate_denied', {
          symbol,
          reason: gateDecision.reason,
          turboScore: gateDecision.turboScore,
          votes: gateDecision.votes,
          rawReason: gateDecision.rawReason,
          gatedReason: gateDecision.gatedReason,
          gatedBlockedBy: gateDecision.gatedBlockedBy,
          liveEnabled: CONFIG.AEGIS_LIVE_ENABLED,
          yamlLiveEnabled: this.getAegisTurboYamlConfig()?.live_enabled === true,
          balance,
          dailyStartBalance: this.riskSession.snapshot().dailyStartBalance,
          dailyPnlPct,
          dailyPnlScope: 'VERIFIED_BOT_CLOSED_OUTCOMES',
          botDailyPnlUsdt,
          accountWideDailyPnlPct,
          dailyEquity,
          availableBalance: balance,
          dailyLossStopPct: gateConfig.dailyLossStopPct,
          tradingMode,
        });
        return;
      }

      if (CONFIG.AEGIS_LIVE_ENABLED !== true) {
        this.logAllowedDryRun(symbol, gateDecision);
        await this.logAegisTurboSignal(symbol, signal, {
          signalId,
          gate: gateDecision,
          executed: false,
        });
        await this.logAegisTradeEvent(symbol, 'GATE_ALLOWED', {
          reason: gateDecision.reason,
          metadata: {
            dryRun: true,
            side: gateDecision.side,
            leverage: gateDecision.leverage,
            positionFraction: gateDecision.positionFraction,
            stopRoe: gateDecision.stopRoe,
            takeProfitRoe: gateDecision.takeProfitRoe,
            trailingActivationRoe: gateDecision.trailingActivationRoe,
            trailingCallbackRoe: gateDecision.trailingCallbackRoe,
          },
        });
        return;
      }

      const turboYaml = this.getAegisTurboYamlConfig();
      if (turboYaml && turboYaml.enabled !== true) {
        await this.logAegisTurboSignal(symbol, signal, {
          signalId,
          gate: { ...gateDecision, allowed: false, reason: 'aegis_turbo_yaml_disabled' },
          executed: false,
          metadata: { ignored_reason: 'aegis_turbo_yaml_disabled' },
        });
        await this.logAegisTradeEvent(symbol, 'GATE_DENIED', {
          reason: 'aegis_turbo_yaml_disabled',
        });
        return;
      }

      if (this.getAegisTurboYamlConfig()?.live_enabled !== true) {
        await this.logAegisTurboSignal(symbol, signal, {
          signalId,
          gate: { ...gateDecision, allowed: false, reason: 'aegis_turbo_yaml_live_disabled' },
          executed: false,
        });
        await this.logAegisTradeEvent(symbol, 'GATE_DENIED', {
          reason: 'aegis_turbo_yaml_live_disabled',
          metadata: {
            turboScore: gateDecision.turboScore,
            votes: gateDecision.votes,
            gatedReason: gateDecision.gatedReason,
            gatedBlockedBy: gateDecision.gatedBlockedBy,
          },
        });
        logger.info('aegis_micro_live_gate_denied', {
          symbol,
          reason: 'aegis_turbo_yaml_live_disabled',
          turboScore: gateDecision.turboScore,
          votes: gateDecision.votes,
          rawReason: gateDecision.rawReason,
          gatedReason: gateDecision.gatedReason,
          gatedBlockedBy: gateDecision.gatedBlockedBy,
          liveEnabled: CONFIG.AEGIS_LIVE_ENABLED,
          yamlLiveEnabled: false,
          balance,
          dailyStartBalance: this.riskSession.snapshot().dailyStartBalance,
          dailyPnlPct,
          dailyEquity,
          availableBalance: balance,
          dailyLossStopPct: gateConfig.dailyLossStopPct,
          tradingMode,
        });
        return;
      }

      if (!this.canExecuteLive(symbol)) {
        await this.logAegisTurboSignal(symbol, signal, {
          signalId,
          gate: { ...gateDecision, allowed: false, reason: 'symbol_live_execution_disabled' },
          executed: false,
          metadata: { symbol_mode: this.getSymbolMode(symbol) },
        });
        return;
      }

      if (!gateDecision.side || symbolState.get().mode !== 'IDLE') return;
      if (this.riskSession.snapshot().tradesToday >= gateConfig.maxTradesPerDay) return;
      if (await exchange.hasOpenPosition(symbol, 'ANY')) {
        logger.warn('aegis_real_position_already_open', { symbol });
        return;
      }

      const tradeId = generateStrategyTradeId(selectedStrategy, symbol);
      await this.aegisEntryWorkflow.execute(symbol, signal, gateDecision, tradeId, signalId);
    } catch (error) {
      if (this.shouldLogError(symbol, 'AEGIS_LOOK_FOR_ENTRY', 60000)) {
        logger.error('Aegis lookForEntry error', { error: String(error) });
      }
      await this.notifyError(symbol, 'AEGIS LOOK FOR ENTRY', error);
    }
  }

  private logAllowedDryRun(symbol: string, gateDecision: AegisMicroLiveGateDecision): void {
    this.deps.logger.warn('aegis_micro_live_gate_allowed_dry_run', {
      symbol,
      side: gateDecision.side,
      leverage: gateDecision.leverage,
      positionFraction: gateDecision.positionFraction,
      stopRoe: gateDecision.stopRoe,
      takeProfitRoe: gateDecision.takeProfitRoe,
      trailingActivationRoe: gateDecision.trailingActivationRoe,
      trailingCallbackRoe: gateDecision.trailingCallbackRoe,
      turboScore: gateDecision.turboScore,
      votes: gateDecision.votes,
      rawReason: gateDecision.rawReason,
      gatedReason: gateDecision.gatedReason,
      gatedBlockedBy: gateDecision.gatedBlockedBy,
      dryRun: true,
      message: 'Gate allowed but live execution is disabled by env',
    });
  }

  private async readAegisPortfolioExposure(): Promise<{
    openPositions: number;
    longPositions: number;
    shortPositions: number;
    marginUsed: number;
    notional: number;
  }> {
    let openPositions = 0;
    let longPositions = 0;
    let shortPositions = 0;
    let marginUsed = 0;
    let notional = 0;

    for (const symbol of this.getLiveAegisSymbols()) {
      for (const side of ['LONG', 'SHORT'] as Side[]) {
        const position = await this.deps.exchange
          .readActivePosition(symbol, side)
          .catch(() => null);
        if (!position) continue;
        // Defensive adapter validation: a LONG object returned for a SHORT lookup
        // (or vice versa) must not be counted as a second position. Hedge-mode
        // adapters may still return BOTH and remain authoritative for their lookup.
        if (
          (position.sideMode === 'LONG' || position.sideMode === 'SHORT') &&
          position.sideMode !== side
        ) {
          continue;
        }
        openPositions++;
        if (side === 'LONG') longPositions++;
        if (side === 'SHORT') shortPositions++;
        const markPrice = await this.deps.exchange
          .getMarkPrice(symbol)
          .catch(() => position.entryPrice);
        const positionMargin =
          position.isolatedMargin ??
          (position.entryPrice > 0 && position.leverage > 0 && position.qtyAbs > 0
            ? (position.entryPrice * position.qtyAbs) / position.leverage
            : 0);
        marginUsed += positionMargin;
        notional += (markPrice || position.entryPrice || 0) * position.qtyAbs;
      }
    }

    return { openPositions, longPositions, shortPositions, marginUsed, notional };
  }

  private getCachedEntryQualityCandles(symbol: string): Candle[] {
    // RegimeEngineV2 needs 120 observations for EMA99 and regime stability.
    // Keep this cache-only so technical telemetry cannot add REST latency to entry.
    const sharedCandles = this.strategyRuntimeCoordinator.getAegisCandles(symbol, 160);
    const cachedCandles =
      sharedCandles.length > 0
        ? sharedCandles
        : this.deps.exchange.getCachedCandles?.(symbol, '5m', 160);
    if (!Array.isArray(cachedCandles)) return [];
    const now = Date.now();
    const intervalMs = 5 * 60 * 1000;
    return cachedCandles.filter((candle) => {
      const openTime = this.finiteNumber(candle.openTime)
        ? Number(candle.openTime)
        : this.finiteNumber(candle.timestamp)
          ? Number(candle.timestamp)
          : undefined;
      // Historical/test candles without a usable timestamp remain eligible. A
      // known in-progress websocket candle must never drive a regime decision.
      return openTime === undefined || openTime + intervalMs <= now;
    });
  }

  private buildEntryQualityMarketContext(symbol: string): {
    recentCandles: Candle[];
    currentPrice?: number;
    emaFast?: number;
    atrPct?: number;
    atrPercentile?: number;
  } {
    const recentCandles = this.getCachedEntryQualityCandles(symbol).filter((candle) =>
      this.isValidCandle(candle),
    );
    const currentPrice =
      recentCandles.length > 0 ? recentCandles[recentCandles.length - 1].close : undefined;
    const emaFast = this.calculateEmaFast(recentCandles, 9);
    const atr = calculateATR(recentCandles, 14);
    const atrPct =
      atr !== null && currentPrice && currentPrice > 0 ? atr / currentPrice : undefined;
    const atrPercentile = this.calculateAtrPercentile(recentCandles);

    return {
      recentCandles,
      currentPrice,
      emaFast,
      atrPct,
      atrPercentile,
    };
  }

  private isValidCandle(candle: Candle): boolean {
    return (
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close) &&
      candle.close > 0
    );
  }

  private calculateEmaFast(candles: Candle[], period: number): number | undefined {
    if (candles.length < period) return undefined;
    const multiplier = 2 / (period + 1);
    const closes = candles.map((candle) => candle.close);
    let ema = closes.slice(0, period).reduce((sum, close) => sum + close, 0) / period;
    for (const close of closes.slice(period)) {
      ema = (close - ema) * multiplier + ema;
    }
    return ema;
  }

  private calculateAtrPercentile(candles: Candle[]): number | undefined {
    if (candles.length < 15) return undefined;
    const trPctValues: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const current = candles[i];
      const previous = candles[i - 1];
      if (!previous.close || previous.close <= 0) continue;
      const trueRange = Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      );
      trPctValues.push(trueRange / previous.close);
    }
    if (trPctValues.length < 2) return undefined;
    const current = trPctValues[trPctValues.length - 1];
    const belowOrEqual = trPctValues.filter((value) => value <= current).length;
    return belowOrEqual / trPctValues.length;
  }

  private async logEntryQualityGateDecision(
    symbol: string,
    side: Side,
    decision: AegisEntryQualityGateDecision,
    mode: string,
    tradeId?: string,
  ): Promise<void> {
    const event =
      decision.action === 'SHADOW_BLOCK'
        ? 'ENTRY_QUALITY_GATE_SHADOW_BLOCK'
        : decision.action === 'SHADOW_ALLOW'
          ? 'ENTRY_QUALITY_GATE_SHADOW_ALLOW'
          : decision.action === 'BLOCK'
            ? 'ENTRY_QUALITY_GATE_DENIED'
            : 'ENTRY_QUALITY_GATE_ALLOW';
    const metadata = {
      ...decision.metadata,
      symbol,
      side,
      action: decision.action,
      reason: decision.reason,
      mode,
      shadowDidNotBlock: decision.action === 'SHADOW_BLOCK' ? true : undefined,
    };

    await this.logAegisTradeEvent(symbol, event, {
      tradeId,
      reason: decision.reason,
      metadata,
    });

    if (decision.action === 'SHADOW_BLOCK') {
      this.deps.logger.info('aegis_entry_quality_shadow_block', metadata);
      return;
    }
    if (decision.action === 'SHADOW_ALLOW') {
      this.deps.logger.debug('aegis_entry_quality_shadow_allow', metadata);
      return;
    }
    if (decision.action === 'BLOCK') {
      this.deps.logger.info('aegis_entry_quality_denied', metadata);
    }
  }

  private getAegisSignalBlock(signal: AegisTradingSignal) {
    return signal.metadata?.aegis ?? signal.aegis;
  }

  private async logAegisEventRiskDecision(
    symbol: string,
    decision: AegisEventRiskOverlayDecision,
    tradeId?: string,
  ): Promise<void> {
    const event =
      decision.action === 'BLOCK'
        ? 'EVENT_RISK_DENIED'
        : decision.action === 'SHADOW_CAUTION'
          ? 'EVENT_RISK_SHADOW_CAUTION'
          : decision.action === 'ALLOW'
            ? 'EVENT_RISK_SHADOW_ALLOW'
            : 'EVENT_RISK_SHADOW_BLOCK';
    const metadata = {
      ...decision.metadata,
      action: decision.action,
      reason: decision.reason,
      wouldBlock: decision.wouldBlock,
      allowed: decision.allowed,
      shadowDidNotBlock: decision.wouldBlock && decision.allowed ? true : undefined,
    };

    await this.logAegisTradeEvent(symbol, event, {
      tradeId,
      reason: decision.reason,
      metadata,
    });

    if (decision.action === 'BLOCK') {
      this.deps.logger.warn('aegis_event_risk_denied', metadata);
      return;
    }
    if (decision.wouldBlock) {
      this.deps.logger.info('aegis_event_risk_shadow_block', metadata);
      return;
    }
    this.deps.logger.debug('aegis_event_risk_shadow_allow', metadata);
  }

  private async logAegisDecisionEnforcementDenied(
    symbol: string,
    decision: AegisDecisionEnforcementDecision,
    tradeId?: string,
  ): Promise<void> {
    const metadata = {
      ...decision.metadata,
      reason: decision.reason,
      allowed: decision.allowed,
    };
    await this.logAegisTradeEvent(symbol, 'DECISION_ENFORCEMENT_DENIED', {
      tradeId,
      reason: decision.reason,
      metadata,
    });
    this.deps.logger.warn('aegis_decision_enforcement_denied', metadata);
  }

  private async notifyDecisionEnforcementDenied(
    symbol: string,
    decision: AegisDecisionEnforcementDecision,
  ): Promise<void> {
    const now = Date.now();
    const telegramNotificationsConfig = this.getAegisTelegramNotificationsConfig();
    if (!telegramNotificationsConfig.automatic_block_alerts_enabled) {
      this.deps.logger.debug('telegram_block_notification_auto_disabled', {
        symbol,
        side: decision.metadata.side,
        reason: decision.reason,
        eventRiskMode: decision.metadata.eventRiskMode,
        setupGrade: decision.metadata.setupGrade,
        decisionBrainDecision: decision.metadata.decisionBrainDecision,
        entryQualityRecommendation: decision.metadata.entryQualityRecommendation,
        entryQualityGateAction: decision.metadata.entryQualityGateAction,
      });
      return;
    }

    const blockDedupeConfig = telegramNotificationsConfig.block_dedupe;
    const notification = this.aegisTelegramBlockNotifier.decide(
      {
        timestamp: now,
        symbol,
        side: decision.metadata.side,
        reason: decision.reason,
        eventRiskMode: decision.metadata.eventRiskMode,
        setupGrade: decision.metadata.setupGrade,
        decisionBrain: decision.metadata.decisionBrainDecision,
        entryQuality:
          decision.metadata.entryQualityRecommendation ?? decision.metadata.entryQualityGateAction,
        tailRiskScore: decision.metadata.tailRiskScore ?? undefined,
        turboScore: decision.metadata.turboScore,
        source: 'DECISION_ENFORCEMENT_DENIED',
      },
      blockDedupeConfig,
    );

    const notificationMetadata = {
      dedupeKey: notification.dedupeKey,
      symbol,
      side: decision.metadata.side,
      reason: decision.reason,
      notificationType: notification.notificationType,
      suppressedCount: notification.suppressedCount,
      lastNotifiedAt: notification.lastNotifiedAt,
      cooldownMinutes: blockDedupeConfig.cooldown_minutes,
      eventRiskMode: decision.metadata.eventRiskMode,
      setupGrade: decision.metadata.setupGrade,
      decisionBrainDecision: decision.metadata.decisionBrainDecision,
      entryQualityRecommendation: decision.metadata.entryQualityRecommendation,
      entryQualityGateAction: decision.metadata.entryQualityGateAction,
    };

    if (!notification.shouldNotify) {
      this.deps.logger.info('telegram_block_notification_suppressed', notificationMetadata);
      await this.logAegisTradeEvent(symbol, 'telegram_block_notification_suppressed', {
        reason: decision.reason,
        metadata: notificationMetadata,
      });
      return;
    }

    if (notification.notificationType === 'SUMMARY') {
      this.deps.logger.info('telegram_block_notification_summary_sent', notificationMetadata);
      await this.logAegisTradeEvent(symbol, 'telegram_block_notification_summary_sent', {
        reason: decision.reason,
        metadata: notificationMetadata,
      });
    }

    await this.deps.notifier
      .sendMessage(
        notification.message ??
          `🛡️ Entrada bloqueada\n` +
            `${symbol} ${decision.metadata.side}\n` +
            `Motivo: ${decision.reason}`,
      )
      .catch((error) => {
        this.deps.logger.warn('aegis_decision_enforcement_telegram_failed', {
          symbol,
          reason: decision.reason,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async logAegisCleanEntryGuardDecision(
    symbol: string,
    decision: AegisCleanEntryGuardOutput,
    tradeId: string,
  ): Promise<void> {
    const shouldLog =
      decision.metadata.enabled &&
      (decision.metadata.dirty ||
        decision.metadata.mode === 'ENFORCE' ||
        decision.metadata.decision === 'ALLOW_CLEAN');
    if (!shouldLog) return;

    const event =
      decision.decision === 'ALLOW_CLEAN'
        ? decision.mode === 'SHADOW'
          ? 'CLEAN_ENTRY_GUARD_SHADOW_ALLOW'
          : 'CLEAN_ENTRY_GUARD_ALLOW'
        : decision.mode === 'SHADOW'
          ? 'CLEAN_ENTRY_GUARD_SHADOW_WAIT'
          : 'CLEAN_ENTRY_GUARD_WAIT_CONFIRMATION';
    const reason =
      decision.decision === 'WAIT_CONFIRMATION'
        ? 'clean_entry_wait_confirmation'
        : decision.decision === 'SHADOW_WAIT_CONFIRMATION'
          ? 'clean_entry_shadow_wait'
          : 'clean_entry_allow';

    await this.logAegisTradeEvent(symbol, event, {
      tradeId,
      reason,
      metadata: {
        ...decision.metadata,
        cleanEntryGuard: decision.metadata,
      },
    });
  }

  private countStateOpenPositions(): {
    totalOpenPositions: number;
    openMomentumPositions: number;
    openProbePositions: number;
  } {
    let totalOpenPositions = 0;
    let openMomentumPositions = 0;
    let openProbePositions = 0;
    const symbols = this.getLiveAegisSymbols();
    const scanSymbols = symbols.length > 0 ? symbols : this.config.symbols;
    const seen = new Set<string>();

    for (const rawSymbol of scanSymbols) {
      const symbol = this.normalizeSymbol(rawSymbol);
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      const state = this.stateForSymbol(symbol).get();
      if (state.mode === 'IDLE') continue;
      totalOpenPositions++;
      if (state.lastStrategy === 'MOMENTUM_RIDE') openMomentumPositions++;
      if (state.probeModeActive === true) openProbePositions++;
    }

    return { totalOpenPositions, openMomentumPositions, openProbePositions };
  }

  private mostRecentStopLossAt(): number | undefined {
    const timestamps: number[] = [];
    const symbols = this.getLiveAegisSymbols();
    const scanSymbols = symbols.length > 0 ? symbols : this.config.symbols;
    const seen = new Set<string>();

    for (const rawSymbol of scanSymbols) {
      const symbol = this.normalizeSymbol(rawSymbol);
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      const state = this.stateForSymbol(symbol).get();
      if (this.finiteNumber(state.lastStopLossAt)) timestamps.push(state.lastStopLossAt);
    }

    return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
  }

  private async logAegisProbeModeDecision(
    symbol: string,
    decision: AegisProbeModeDecision,
    tradeId: string,
  ): Promise<void> {
    const event = decision.allowed ? 'PROBE_MODE_ALLOWED' : 'PROBE_MODE_DENIED';
    await this.logAegisTradeEvent(symbol, event, {
      tradeId,
      reason: decision.reason,
      metadata: {
        probeMode: decision.metadata,
      },
    });

    if (decision.allowed) {
      this.deps.logger.warn('aegis_probe_mode_allowed', decision.metadata);
      return;
    }
    this.deps.logger.info('aegis_probe_mode_denied', decision.metadata);
  }

  private async notifyProbeModeAllowed(
    symbol: string,
    side: Side,
    decision: AegisProbeModeDecision,
  ): Promise<void> {
    await Promise.resolve(
      this.deps.notifier.sendMessage(
        `🧪 Probe Mode permitió entrada\n` +
          `${symbol} ${side}\n` +
          `Score: ${formatScore(decision.metadata.turboScore ?? 0)} | TailRisk: ${formatScore(decision.metadata.tailRiskScore ?? 0)}\n` +
          `DB: ${decision.metadata.decisionBrain ?? 'N/D'} | EQ: ${decision.metadata.entryQualityRecommendation ?? 'N/D'}\n` +
          `Motivo: ${decision.reason}`,
      ),
    ).catch((error) => {
      this.deps.logger.warn('aegis_probe_mode_telegram_failed', {
        symbol,
        side,
        reason: decision.reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private recordProbeModeEntry(openedAtMs: number, tradeId: string): void {
    const globalState = this.deps.state.get();
    const cutoff = openedAtMs - 60 * 60 * 1000;
    const recent = (globalState.probeEntryTimestamps ?? []).filter(
      (timestamp) => this.finiteNumber(timestamp) && timestamp >= cutoff && timestamp <= openedAtMs,
    );
    this.deps.state.set({
      lastProbeAt: openedAtMs,
      lastProbeTradeId: tradeId,
      probeEntryTimestamps: [...recent, openedAtMs],
    });
  }

  private async notifyExit(
    symbol: string,
    side: Side,
    reason: string,
    botState: BotState,
    exit?: { exitPrice?: number; finalRoe?: number; pnl?: number },
  ): Promise<void> {
    const { exchange, notifier, logger } = this.deps;
    if (!this.isVerifiedBotOwnedState(botState)) {
      logger.warn('aegis_excluded_position_close_not_recorded', {
        symbol,
        side,
        reason,
        tradeId: botState.lastTradeId,
        ownershipStatus: botState.ownershipStatus ?? 'UNKNOWN',
        exclusionReason: botState.metricsExclusionReason ?? 'UNVERIFIED_OWNERSHIP',
        metricsUpdated: false,
      });
      return;
    }
    const entryPrice = botState.lastEntryPrice || 0;
    const leverage =
      botState.lastLeverage ||
      botState.lastActualLeverage ||
      this.getAegisTurboGateConfig(symbol).leverageCap;
    const exitPrice = exit?.exitPrice ?? (await exchange.getMarkPrice(symbol));
    const finalRoe =
      exit?.finalRoe ?? this.calculateRoe(side, entryPrice || exitPrice, exitPrice, leverage);
    const pnl = exit?.pnl;
    const durationMs = Date.now() - (botState.lastEntryAt || Date.now());
    const durationHrs = (durationMs / 3600000).toFixed(2);
    const exitType = describeAegisExit({
      reason,
      pnl,
      botState,
      side,
      exitPrice,
      computeBracketPrice: (exitSide, entry, roe, leverage, type) =>
        this.positionProtection.bracketPrice(exitSide, entry, roe, leverage, type),
    });
    const margin = this.entryMargin(botState);
    const pnlStr = pnl === undefined ? 'UNKNOWN (exact close unavailable)' : formatSignedUsd(pnl);
    const closeStrategy: AegisResearchStrategy =
      botState.lastStrategy === 'MOMENTUM_RIDE' ? 'MOMENTUM_RIDE' : 'AEGIS_TURBO';
    const closeIdentity = this.strategyIdentity(closeStrategy);
    const tradeId =
      botState.lastTradeId ??
      generateStrategyTradeId(closeStrategy, symbol, new Date(botState.lastEntryAt ?? Date.now()));
    const durationMinutes = durationMs / 60000;

    await this.historyLogger.logTradeClose({
      ...VERIFIED_AEGIS_TRADE_OWNERSHIP,
      trade_id: tradeId,
      portfolio_session_id: getPortfolioSessionId(),
      symbol,
      strategy: closeStrategy,
      strategy_version: botState.lastStrategyVersion ?? closeIdentity.strategyVersion,
      strategy_hash: botState.lastStrategyHash ?? closeIdentity.strategyHash,
      config_hash: botState.lastConfigHash ?? closeIdentity.configHash,
      code_commit_sha: botState.lastCodeCommitSha ?? closeIdentity.codeCommitSha,
      mode: this.getTradingMode(),
      side,
      opened_at: botState.lastEntryAt ? new Date(botState.lastEntryAt).toISOString() : undefined,
      closed_at: new Date().toISOString(),
      entry_price: entryPrice || undefined,
      exit_price: exitPrice,
      quantity: botState.lastEntryQty,
      leverage,
      position_fraction: botState.lastPositionFraction,
      exit_reason: reason,
      pnl_usdt: pnl,
      roe: finalRoe,
      fees_estimated: botState.lastCommissionEstimate,
      duration_minutes: durationMinutes,
      mfe_roe: botState.peakRoe,
      mae_roe: botState.lowestRoe,
      max_drawdown_roe: botState.lowestRoe,
      status: 'CLOSED',
      metadata: {
        estimated: pnl === undefined,
        pnl_status: pnl === undefined ? 'UNKNOWN_EXACT_CLOSE_UNAVAILABLE' : 'EXACT_SUPPLIED',
        mark_price_close_reference: true,
        exit_type: exitType.canonicalExitType,
        canonical_exit_type: exitType.canonicalExitType,
        display_exit_label: exitType.displayExitLabel,
        reason_detail: exitType.reason,
        exit_reason_label_mismatch: exitType.labelMismatch,
        mismatch_reason: exitType.mismatchReason,
      },
    });
    const closedAt = Date.now();
    if (pnl !== undefined) {
      this.riskSession.recordStrategyClose({
        strategyId: closeStrategy,
        symbol,
        tradeId,
        pnlUsdt: pnl,
        closedAt,
        reason,
      });
    }
    if (pnl !== undefined && this.deps.strategyLossStateRegistry) {
      const lossStrategyId =
        botState.positionOwner === 'EXTERNAL' ||
        botState.tradeOrigin === 'MANUAL_EXTERNAL' ||
        tradeId.startsWith('MANUAL-')
          ? 'MANUAL'
          : closeStrategy;
      if (lossStrategyId !== 'AEGIS_TURBO') {
        await this.deps.strategyLossStateRegistry.record(lossStrategyId, this.getTradingMode(), {
          tradeId,
          closedAt: new Date().toISOString(),
          pnlUsdt: pnl,
        });
        logger.info('strategy_loss_streak_updated', {
          symbol,
          tradeId,
          strategyId: lossStrategyId,
          consecutiveLosses: this.deps.strategyLossStateRegistry.trackerValue(lossStrategyId),
        });
      }
    }
    if (closeStrategy === 'AEGIS_TURBO' && pnl !== undefined) {
      await this.riskSession.recordAegisLossOutcome({
        strategyId: closeStrategy,
        symbol,
        tradeId,
        pnlUsdt: pnl,
        closedAt,
        reason,
      });
    }
    const currentBalance = await exchange.getUSDTBalance();
    await this.logAegisTradeEvent(symbol, 'TRADE_CLOSED', {
      tradeId,
      price: exitPrice,
      roe: finalRoe,
      reason,
      metadata: {
        pnl,
        pnlStatus: pnl === undefined ? 'UNKNOWN_EXACT_CLOSE_UNAVAILABLE' : 'EXACT_SUPPLIED',
        exitType: exitType.canonicalExitType,
        canonicalExitType: exitType.canonicalExitType,
        displayExitLabel: exitType.displayExitLabel,
        exitReasonLabelMismatch: exitType.labelMismatch,
        mismatchReason: exitType.mismatchReason,
      },
    });
    await this.logAegisAccountSnapshot({
      symbol,
      walletBalance: currentBalance,
      availableBalance: currentBalance,
      unrealizedPnl: 0,
      positionOpen: false,
      side,
      entryPrice,
      markPrice: exitPrice,
      roe: finalRoe,
      marginUsed: margin,
      quantity: botState.lastEntryQty,
      leverage,
      metadata: { event: 'trade_close', tradeId, exitReason: reason },
    });

    await notifier.sendMessage(
      `${exitType.emoji} **${exitType.title}**\n` +
        `${symbol} | ${side}\n` +
        `Entrada: $${entryPrice.toFixed(2)} → Salida: $${exitPrice.toFixed(2)}\n` +
        `ROE Final: **${formatRoe(finalRoe)}**\n` +
        `PnL: **${pnlStr}**\n` +
        `Margen: **$${margin.toFixed(2)} USDT**\n` +
        `Duración: ${durationHrs}h\n` +
        `MFE Pico: ${formatRoe(botState.peakRoe || 0)}\n` +
        `MAE: ${formatRoe(botState.lowestRoe || 0)}\n` +
        `Balance: **$${currentBalance.toFixed(2)}**\n` +
        `Razón: ${exitType.reason}`,
    );
    logger.info('📱 [TELEGRAM_REPORT] AEGIS EXIT SENT', {
      message: `${exitType.emoji} **${exitType.title}** PnL: ${pnlStr} ROE: ${formatRoe(finalRoe)}`,
    });
  }

  private buildAegisEntryMessage(input: {
    symbol: string;
    side: Side;
    entryPrice: number;
    quantity: number;
    marginUsed: number;
    wallet: number;
    account?: USDTAccountSnapshot;
    leverage: number;
    stopPrice: number;
    tpPrice: number;
    gate: AegisMicroLiveGateDecision;
    filters?: SymbolFilters;
  }): string {
    const {
      symbol,
      side,
      entryPrice,
      quantity,
      marginUsed,
      wallet,
      account,
      leverage,
      stopPrice,
      tpPrice,
      gate,
      filters,
    } = input;
    const threshold = this.getAegisTurboGateConfig(symbol).minScore;
    return formatAegisTurboEntryMessage({
      symbol,
      side,
      entryPrice,
      quantity,
      marginUsed,
      walletFallback: wallet,
      account,
      leverage,
      stopPrice,
      tpPrice,
      turboScore: gate.turboScore,
      threshold,
      votes: gate.votes,
      reason: gate.gatedReason ?? gate.rawReason ?? gate.reason,
      stopRoe: gate.stopRoe,
      takeProfitRoe: gate.takeProfitRoe,
      trailingActivationRoe: gate.trailingActivationRoe,
      trailingCallbackRoe: gate.trailingCallbackRoe,
      pricePrecision: filters?.pricePrecision,
      quantityPrecision: filters?.qtyPrecision,
    });
  }

  private async readEntryAccountSnapshot(walletFallback?: number): Promise<USDTAccountSnapshot> {
    const reader = this.deps.exchange.getUSDTAccountSnapshot;
    if (typeof reader !== 'function') {
      return walletFallback !== undefined ? { walletBalance: walletFallback } : {};
    }

    try {
      const snapshot = await reader.call(this.deps.exchange);
      return {
        walletBalance: this.finiteOrUndefined(snapshot.walletBalance) ?? walletFallback,
        availableBalance: this.finiteOrUndefined(snapshot.availableBalance),
        unrealizedPnlTotal: this.finiteOrUndefined(snapshot.unrealizedPnlTotal),
        equityTotal: this.finiteOrUndefined(snapshot.equityTotal),
      };
    } catch (error) {
      this.deps.logger.warn('aegis_entry_account_snapshot_unavailable', { error: String(error) });
      return walletFallback !== undefined ? { walletBalance: walletFallback } : {};
    }
  }

  private finiteOrUndefined(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private calculateRoe(
    side: Side,
    entryPrice: number,
    markPrice: number,
    leverage: number,
  ): number {
    if (entryPrice <= 0 || leverage <= 0) return 0;
    return side === 'SHORT'
      ? ((entryPrice - markPrice) / entryPrice) * leverage
      : ((markPrice - entryPrice) / entryPrice) * leverage;
  }

  private entryMargin(botState: BotState): number {
    if (typeof botState.lastEntryMargin === 'number' && Number.isFinite(botState.lastEntryMargin)) {
      return botState.lastEntryMargin;
    }
    if (botState.lastEntryPrice && botState.lastEntryQty && botState.lastLeverage) {
      return (botState.lastEntryPrice * botState.lastEntryQty) / botState.lastLeverage;
    }
    return 0;
  }

  private pnlFromRoe(margin: number, roe: number): number {
    if (!Number.isFinite(margin) || !Number.isFinite(roe)) return 0;
    return margin * roe;
  }

  private async notifyError(symbol: string, type: string, error: unknown): Promise<void> {
    const now = Date.now();
    const errorKey = `${symbol}:${type}`;
    if (this.lastErrorTime[errorKey] && now - this.lastErrorTime[errorKey] < 3600000) return;
    this.lastErrorTime[errorKey] = now;
    try {
      await this.deps.notifier.sendMessage(
        `🚨 **${type}**\nSymbol: ${symbol}\nError: \`${String(error).slice(0, 150)}\``,
      );
    } catch (e) {
      this.deps.logger.error('Failed to notify error', { error: String(e) });
    }
  }

  private shouldLogError(symbol: string, type: string, intervalMs: number): boolean {
    const now = Date.now();
    const logKey = `${symbol}:${type}`;
    if (this.lastLogTime[logKey] && now - this.lastLogTime[logKey] < intervalMs) return false;
    this.lastLogTime[logKey] = now;
    return true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
