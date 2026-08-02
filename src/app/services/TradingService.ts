import { Exchange, PositionInfo, SymbolFilters, USDTAccountSnapshot } from '../ports/Exchange';
import { MLService } from '../ports/MLService';
import { Logger } from '../ports/Logger';
import { StateStore } from '../ports/StateStore';
import { Notifier } from '../ports/Notifier';
import { BotState, Candle, Side } from '../../domain/types';
import { DEFAULT_GUARDIAN_CONFIG, evaluateGuardianAction, GuardianConfig } from '../../domain/services/ProfitGuardian';
import { calculateATR } from '../../domain/services/TechnicalIndicators';
import { AegisTradingSignal } from '../../domain/services/AegisStrategy';
import {
    AegisMicroLiveGateDecision,
    buildAegisMicroLiveGateConfigFromEnv,
    shouldEnterAegisTurboMicroLive
} from '../../domain/services/AegisMicroLiveGate';
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
    NinjaConfigManager
} from '../../infra/config/ConfigLoader';
import {
    AegisExitEyeDecision,
    AegisExitEyeVotes,
    evaluateAegisExitEye
} from '../../domain/services/AegisExitEye';
import { evaluateAegisExitEyeV2Shadow } from '../../domain/services/AegisExitEyeV2Shadow';
import { inspectCurrentBrainCanonicalDecision } from '../../domain/services/CurrentBrainCanonicalDecision';
import { buildAegisOperationalDispositionShadow } from '../../domain/services/AegisOperationalDispositionShadow';
import { RegimeConfig } from '../ports/RegimeStrategy';
import { LiquidityVoidDetector } from './LiquidityVoidDetector';
import { CONFIG } from '../../infra/config/environment';
import {
    AegisTurboHistoryLogger,
    generateSignalId,
    generateTradeId,
    getPortfolioSessionId
} from '../../infra/logging/AegisTurboHistoryLogger';
import { formatAegisTurboEntryMessage } from './formatAegisTurboEntryMessage';
import { AegisPositionMessageInput, formatAegisStartupMessage } from '../messages/AegisMessageFormatter';
import { AegisPortfolioRiskGuard } from '../../domain/services/AegisPortfolioRiskGuard';
import { AegisEntryQualityGateDecision } from '../../domain/services/AegisEntryQualityGate';
import {
    AegisEventRiskOverlayDecision
} from '../../domain/services/AegisEventRiskOverlay';
import { AegisDecisionEnforcementDecision } from '../../domain/services/AegisDecisionEnforcement';
import {
    AegisTelegramBlockNotifier,
    DEFAULT_AEGIS_BLOCK_NOTIFICATION_CONFIG
} from './AegisTelegramBlockNotifier';
import {
    DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG,
    AegisCleanEntryGuardOutput
} from '../../domain/services/AegisCleanEntryGuard';
import {
    AegisProbeModeDecision,
    AegisProbeModeRuntimeConfig
} from '../../domain/services/AegisProbeMode';
import {
    AegisRegimeGuardConfig,
    DEFAULT_AEGIS_REGIME_GUARD_CONFIG
} from '../../domain/services/AegisRegimeGuard';
import {
    AegisEntryContext,
    AegisEntryDecisionResult,
    AegisEntryPolicyRuntimeConfig,
    AegisMomentumRideRuntimeConfig,
    AegisRegimeContextRuntimeConfig
} from '../../domain/services/aegis-entry/AegisEntryDecisionTypes';
import { AegisEntryGuardOrchestrator } from '../../domain/services/aegis-entry/AegisEntryGuardOrchestrator';
import {
    AegisClosedTradeOutcome,
    AegisConsecutiveLossTracker
} from '../../domain/services/AegisConsecutiveLossTracker';
import { readAegisClosedTradeOutcomes } from '../../infra/logging/AegisClosedTradeHistoryReader';

const INITIAL_BALANCE = 20;
const DEFAULT_AEGIS_MAX_HOLD_MS = 8 * 60 * 60 * 1000;
const EXIT_EYE_SIGNAL_TTL_MS = 15000;
const EXIT_EYE_SHADOW_ALERT_COOLDOWN_MS = 5 * 60 * 1000;


type PhaseOTurboMetadata = {
    isPhaseO: boolean;
    side: Side | null;
    entryEnabled: boolean;
    avoidOnly: boolean;
    modelFamily?: string;
    symbol?: string;
    sourcePath: string;
    raw?: Record<string, unknown>;
};

type SafeStopMoveReason = 'MOVE_SL_BE' | 'PROTECT_PROFIT' | 'MOVE_SL_TRAILING';
type SafeStopMoveSkipReason =
    | 'immediate_trigger_risk'
    | 'stop_not_improved'
    | 'missing_position'
    | 'missing_entry'
    | 'missing_leverage'
    | 'missing_quantity'
    | 'exchange_error';

type SafeStopMoveResult =
    | { moved: true; oldStopPrice?: number; newStopPrice: number; exchangeOrderId?: string; hasSLAfter?: boolean; hasTPAfter?: boolean }
    | { moved: false; reason: SafeStopMoveSkipReason; oldStopPrice?: number; newStopPrice: number; error?: string; hasSLAfter?: boolean; hasTPAfter?: boolean };

type AegisExitDescription = {
    emoji: string;
    title: string;
    reason: string;
    canonicalExitType: string;
    displayExitLabel: string;
    labelMismatch: boolean;
    mismatchReason?: string;
};

export interface TradingServiceDeps {
    exchange: Exchange;
    mlService: MLService;
    logger: Logger;
    state: StateStore;
    notifier: Notifier;
    configManager: NinjaConfigManager;
    historyLogger?: AegisTurboHistoryLogger;
    closedTradeOutcomeReader?: () => Promise<AegisClosedTradeOutcome[]>;
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
}

export class TradingService {
    private isRunning = false;
    private tradesToday = 0;
    private phaseOShortTradesToday = 0;
    private lastTradeDayReset = 0;
    private dailyStartBalance: number | null = null;
    private lastDailyPnlPct: number | undefined;
    private readonly consecutiveLossTracker = new AegisConsecutiveLossTracker();
    private lastEntryBalance = INITIAL_BALANCE;
    private peakBalance = INITIAL_BALANCE;
    private lastErrorTime: Record<string, number> = {};
    private lastLogTime: Record<string, number> = {};
    private lastAlivePulseMs = Date.now();
    private hardWatchdogTimer: NodeJS.Timeout | null = null;
    private detector: Record<string, LiquidityVoidDetector> = {};
    private readonly historyLogger: AegisTurboHistoryLogger;
    private readonly symbolStateStores = new Map<string, StateStore>();
    private readonly exitEyeSignalCache = new Map<string, { at: number; signal: AegisTradingSignal }>();
    private readonly aegisTelegramBlockNotifier = new AegisTelegramBlockNotifier();

    constructor(
        private deps: TradingServiceDeps,
        private config: TradingServiceConfig
    ) {
        this.historyLogger = deps.historyLogger ?? new AegisTurboHistoryLogger({ logger: deps.logger });
    }

    private getTradingMode(): string {
        return this.config.tradingMode || CONFIG.TRADING_MODE;
    }

    private getAegisTurboYamlConfig(): AegisTurboYamlConfig | undefined {
        const manager = this.deps.configManager as any;
        return typeof manager.getAegisTurboConfig === 'function'
            ? manager.getAegisTurboConfig()
            : undefined;
    }

    private getAegisPhaseOShortLiveConfig(): AegisPhaseOShortLiveYamlConfig | undefined {
        const manager = this.deps.configManager as any;
        return typeof manager.getAegisPhaseOShortLiveConfig === 'function'
            ? manager.getAegisPhaseOShortLiveConfig()
            : undefined;
    }

    private getAegisExitEyeConfig(): AegisExitEyeYamlConfig {
        const manager = this.deps.configManager as any;
        if (typeof manager.getAegisExitEyeConfig === 'function') {
            return manager.getAegisExitEyeConfig();
        }
        return {
            enabled: false,
            mode: 'OFF',
            min_roe_to_protect: 0.08,
            min_peak_roe_to_protect: 0.12,
            min_giveback_from_peak_roe: 0.04,
            neutral_votes_to_protect: 2,
            opposite_votes_to_close: 2,
            min_roe_to_close_on_opposite: 0.06,
            min_peak_roe_to_close_on_opposite: 0.10,
            close_on_neutral_decay: false,
            neutral_close_votes: 3,
            min_roe_to_close_on_neutral: 0.08,
            min_peak_roe_to_close_on_neutral: 0.12,
            min_giveback_to_close_on_neutral: 0.04,
            require_consecutive_neutral_close: 2,
            require_consecutive_neutral: 2,
            require_consecutive_opposite: 1,
            min_minutes_in_trade: 3
        };
    }

    private getAegisProfitProtectionConfig(): AegisProfitProtectionRuntimeConfig {
        const manager = this.deps.configManager as any;
        if (typeof manager.getAegisProfitProtectionConfig === 'function') {
            return manager.getAegisProfitProtectionConfig();
        }
        return {
            enabled: true,
            protect_profit_enabled: true,
            min_peak_roe_to_protect: 0.08,
            protect_giveback_roe: 0.05,
            min_locked_roe: 0.01,
            be_offset_pct: 0.003,
            immediate_trigger_buffer_pct: 0.001
        };
    }

    private getAegisPortfolioRiskConfig(): Required<AegisPortfolioRiskYamlConfig> {
        const manager = this.deps.configManager as any;
        if (typeof manager.getAegisPortfolioRiskConfig === 'function') {
            return manager.getAegisPortfolioRiskConfig();
        }
        return {
            enabled: false,
            max_open_positions: 0,
            max_same_direction_positions: 0,
            max_margin_used_pct: 0,
            max_notional_to_equity: 0
        };
    }

    private getAegisShortGateConfig(): Required<AegisShortGateYamlConfig> {
        const manager = this.deps.configManager as any;
        if (typeof manager.getAegisShortGateConfig === 'function') {
            return manager.getAegisShortGateConfig();
        }
        return {
            enabled: false,
            mode: 'PREMIUM_ONLY',
            position_fraction_multiplier: 1,
            max_leverage: 0,
            block_symbols: [],
            allow_if_regime_bearish: false
        };
    }

    private getAegisEventRiskConfig(): AegisEventRiskRuntimeConfig {
        const manager = this.deps.configManager as any;
        if (typeof manager.getAegisEventRiskConfig === 'function') {
            return manager.getAegisEventRiskConfig();
        }
        return {
            enabled: false,
            mode: 'NORMAL',
            enforce: false,
            manual_override_enabled: false,
            caution: {
                min_quality_score: 0.65,
                max_tail_risk_score: 0.45,
                require_btc_eth_confirmation: true
            },
            risk_off: {
                min_quality_score: 0.75,
                max_tail_risk_score: 0.35,
                allow_only_a_plus: true
            },
            manual_only: {
                block_new_entries: false
            }
        };
    }

    private getAegisDecisionEnforcementConfig(): AegisDecisionEnforcementRuntimeConfig {
        const manager = this.deps.configManager as any;
        if (typeof manager.getAegisDecisionEnforcementConfig === 'function') {
            return manager.getAegisDecisionEnforcementConfig();
        }
        return {
            enabled: false,
            mode: 'OFF',
            block_do_not_enter: false,
            block_wait_confirmation: false,
            block_manual_only: false,
            block_entry_quality_shadow_block_when_event_risk: {
                enabled: false,
                event_modes: []
            },
            event_risk_enforcement: {
                caution_blocks_weak_entries: false,
                risk_off_blocks_non_a_plus: false,
                manual_only_blocks_all_new_entries: false
            },
            block_caution_would_block_unless_a_plus: false,
            block_all_entry_quality_shadow_block: false,
            block_all_tail_risk_high: false
        };
    }

    private getAegisTelegramNotificationsConfig(): AegisTelegramNotificationsRuntimeConfig {
        const manager = this.deps.configManager as any;
        if (typeof manager.getAegisTelegramNotificationsConfig === 'function') {
            return manager.getAegisTelegramNotificationsConfig();
        }
        return {
            automatic_block_alerts_enabled: false,
            block_dedupe: DEFAULT_AEGIS_BLOCK_NOTIFICATION_CONFIG
        };
    }

    private getAegisPositionFractionOverride(symbol: string, side: Side): AegisPositionFractionOverride | undefined {
        const manager = this.deps.configManager as any;
        return typeof manager.getAegisPositionFractionOverride === 'function'
            ? manager.getAegisPositionFractionOverride(symbol, side)
            : undefined;
    }

    private getAegisCleanEntryGuardConfig(): AegisCleanEntryGuardRuntimeConfig {
        const manager = this.deps.configManager as any;
        if (typeof manager.getAegisCleanEntryGuardConfig === 'function') {
            return manager.getAegisCleanEntryGuardConfig();
        }
        return DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG;
    }

    private getAegisProbeModeConfig(): AegisProbeModeRuntimeConfig {
        const manager = this.deps.configManager as any;
        if (typeof manager.getAegisProbeModeConfig === 'function') {
            return manager.getAegisProbeModeConfig();
        }
        return {
            enabled: false,
            mode: 'OFF',
            apply_when_event_risk: ['CAUTION'],
            min_turbo_score: 0.90,
            max_tail_risk_score: 0.30,
            require_decision_brain: 'ENTER_NOW',
            require_entry_quality_allow: true,
            require_feature_status_ok: true,
            min_feature_parity_pct: 95,
            allow_if_blocked_only_by: ['clean_entry_event_risk_would_block', 'caution_btc_eth_not_confirmed'],
            max_probe_entries_per_hour: 1,
            min_minutes_between_probe_entries: 60,
            max_open_probe_positions: 1,
            max_total_open_positions_when_probe: 2,
            block_after_consecutive_losses: 2,
            block_after_recent_stop_loss_minutes: 60
        };
    }

    private getAegisRegimeGuardConfig(): AegisRegimeGuardConfig {
        const manager = this.deps.configManager as any;
        if (typeof manager.getAegisRegimeGuardConfig === 'function') {
            return manager.getAegisRegimeGuardConfig();
        }
        return DEFAULT_AEGIS_REGIME_GUARD_CONFIG;
    }

    private getAegisRegimeContextConfig(): AegisRegimeContextRuntimeConfig {
        const manager = this.deps.configManager as any;
        if (typeof manager.getAegisRegimeContextConfig === 'function') {
            return manager.getAegisRegimeContextConfig();
        }
        return {
            enabled: false,
            mode: 'SHADOW',
            timeframe: '5m',
            allowedFor: { momentumRide: true },
            indicators: {
                emaFast: 7,
                emaMid: 25,
                emaSlow: 99,
                atrWindow: 14,
                volumeWindow: 20,
                bollingerWindow: 20,
                adxWindow: 14,
                choppinessWindow: 14
            },
            thresholds: {
                maxChoppinessForMomentum: 55,
                minAdxForMomentum: 18,
                minVolumeRatioForMomentum: 1.3,
                maxAtrPercentileForAggressive: 0.8,
                maxExhaustionScore: 0.6
            }
        };
    }

    private getAegisMomentumRideConfig(): AegisMomentumRideRuntimeConfig {
        const manager = this.deps.configManager as any;
        if (typeof manager.getAegisMomentumRideConfig === 'function') {
            return manager.getAegisMomentumRideConfig();
        }
        return {
            enabled: false,
            mode: 'SHADOW',
            researchMode: false,
            regimeFilter: {
                enabled: false,
                useAsGate: false,
                recordMetadata: true,
                ignoreForEntry: true
            },
            allowWhenAegisDenied: false,
            requireAegisDirectionConfirmation: true,
            allowMomentumAgainstAegis: false,
            requireBtcEthNotContradicting: true,
            requireBtcEthConfirmation: false,
            symbols: {},
            safetyCaps: {
                maxLeverage: 50,
                maxPositionFraction: 0.03,
                maxOpenMomentumPositions: 1,
                maxTotalOpenPositionsWhenMomentum: 2,
                maxMomentumTradesPerDay: 3,
                maxConsecutiveMomentumLosses: 2,
                cooldownAfterLossMinutes: 60,
                disableSymbolAfterStopLossMinutes: 120,
                requireBrackets: true,
                requireProfitProtection: true
            }
        };
    }

    private getAegisEntryPolicyConfig(): AegisEntryPolicyRuntimeConfig {
        const manager = this.deps.configManager as any;
        if (typeof manager.getAegisEntryPolicyConfig === 'function') {
            return manager.getAegisEntryPolicyConfig();
        }
        const entryQualityGate = this.getEntryQualityGateConfig();
        const eventRisk = this.getAegisEventRiskConfig();
        const regimeGuard = this.getAegisRegimeGuardConfig();
        const regimeContext = this.getAegisRegimeContextConfig();
        const momentumRide = this.getAegisMomentumRideConfig();
        const cleanEntry = this.getAegisCleanEntryGuardConfig();
        const probeMode = this.getAegisProbeModeConfig();
        return {
            enabled: true,
            guards: {
                regime: {
                    enabled: regimeGuard.enabled,
                    mode: regimeGuard.enabled ? regimeGuard.mode : 'OFF'
                },
                regime_context: {
                    enabled: regimeContext.enabled,
                    mode: regimeContext.enabled ? regimeContext.mode : 'OFF'
                },
                momentum_ride: {
                    enabled: momentumRide.enabled,
                    mode: momentumRide.enabled ? momentumRide.mode : 'OFF'
                },
                decision_brain: {
                    enabled: this.getAegisDecisionEnforcementConfig().enabled,
                    mode: this.getAegisDecisionEnforcementConfig().enabled ? 'ENFORCE' : 'OFF'
                },
                entry_quality: {
                    enabled: entryQualityGate.enabled,
                    mode: entryQualityGate.enabled ? entryQualityGate.mode : 'OFF'
                },
                event_risk: {
                    enabled: eventRisk.enabled,
                    mode: eventRisk.enabled ? (eventRisk.enforce ? 'ENFORCE' : 'SHADOW') : 'OFF'
                },
                clean_entry: {
                    enabled: cleanEntry.enabled,
                    mode: cleanEntry.enabled ? cleanEntry.mode : 'OFF'
                },
                probe_mode: {
                    enabled: probeMode.enabled,
                    mode: probeMode.enabled ? probeMode.mode : 'OFF'
                },
                long_risk_shadow: {
                    enabled: true,
                    mode: 'ENFORCE_PROBE_LONG_CRITICAL',
                    probeLongCriticalAction: 'BLOCK',
                    probeLongHighAction: 'SHADOW',
                    aegisLongCriticalAction: 'SHADOW',
                    momentumLongCriticalAction: 'SHADOW',
                    minRiskLevelToBlockProbe: 'CRITICAL',
                    blockOnlyProbeMode: true,
                    blockOnlyLong: true
                },
                short_gate: {
                    enabled: this.getAegisShortGateConfig().enabled === true,
                    mode: this.getAegisShortGateConfig().enabled === true ? 'ENFORCE' : 'OFF'
                }
            }
        };
    }

    private asRecord(value: unknown): Record<string, any> | undefined {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value as Record<string, any>
            : undefined;
    }

    private normalizeSideValue(value: unknown): Side | null {
        const normalized = String(value ?? '').trim().toUpperCase();
        if (normalized === 'SHORT' || normalized === 'SELL') return 'SHORT';
        if (normalized === 'LONG' || normalized === 'BUY') return 'LONG';
        return null;
    }

    private isTruthyPhaseOFlag(value: unknown): boolean {
        return value === true || value === 'true' || value === 'PHASE_O' || value === 'phase_o';
    }

    private hasPhaseOModelPath(value: unknown): boolean {
        if (!value) return false;
        if (typeof value === 'string') return value.toLowerCase().includes('phase_o');
        if (Array.isArray(value)) return value.some((item) => this.hasPhaseOModelPath(item));
        const record = this.asRecord(value);
        if (!record) return false;
        return Object.values(record).some((item) => this.hasPhaseOModelPath(item));
    }

    private extractPhaseOTurboMetadata(signalOrPrediction: unknown, fallbackSide?: Side): PhaseOTurboMetadata | null {
        const root = this.asRecord(signalOrPrediction);
        if (!root) return null;
        const candidates: Array<{ path: string; container?: Record<string, any>; phase?: Record<string, any> }> = [
            { path: 'signal.metadata.aegis.turbo.phase_o', container: this.asRecord(root.metadata)?.aegis?.turbo, phase: this.asRecord(this.asRecord(root.metadata)?.aegis?.turbo?.phase_o) },
            { path: 'signal.metadata.aegis.turbo.raw.phase_o', container: this.asRecord(root.metadata)?.aegis?.turbo, phase: this.asRecord(this.asRecord(root.metadata)?.aegis?.turbo?.raw?.phase_o) },
            { path: 'signal.metadata.turbo.phase_o', container: this.asRecord(root.metadata)?.turbo, phase: this.asRecord(this.asRecord(root.metadata)?.turbo?.phase_o) },
            { path: 'signal.metadata.turbo.raw.phase_o', container: this.asRecord(root.metadata)?.turbo, phase: this.asRecord(this.asRecord(root.metadata)?.turbo?.raw?.phase_o) },
            { path: 'signal.aegis.turbo.phase_o', container: this.asRecord(root.aegis)?.turbo, phase: this.asRecord(this.asRecord(root.aegis)?.turbo?.phase_o) },
            { path: 'signal.aegis.turbo.raw.phase_o', container: this.asRecord(root.aegis)?.turbo, phase: this.asRecord(this.asRecord(root.aegis)?.turbo?.raw?.phase_o) },
            { path: 'signal.turbo.phase_o', container: this.asRecord(root.turbo), phase: this.asRecord(this.asRecord(root.turbo)?.phase_o) },
            { path: 'signal.turbo.raw.phase_o', container: this.asRecord(root.turbo), phase: this.asRecord(this.asRecord(root.turbo)?.raw?.phase_o) },
            { path: 'signal.metadata.rawPrediction.aegis.turbo.phase_o', container: this.asRecord(this.asRecord(root.metadata)?.rawPrediction)?.aegis?.turbo, phase: this.asRecord(this.asRecord(this.asRecord(root.metadata)?.rawPrediction)?.aegis?.turbo?.phase_o) },
            { path: 'signal.metadata.rawPrediction.aegis.turbo.raw.phase_o', container: this.asRecord(this.asRecord(root.metadata)?.rawPrediction)?.aegis?.turbo, phase: this.asRecord(this.asRecord(this.asRecord(root.metadata)?.rawPrediction)?.aegis?.turbo?.raw?.phase_o) },
            { path: 'signal.metadata.phase_o', container: this.asRecord(root.metadata), phase: this.asRecord(this.asRecord(root.metadata)?.phase_o) },
            { path: 'signal.phase_o', container: root, phase: this.asRecord(root.phase_o) },
            { path: 'signal.phaseO', container: root, phase: this.asRecord(root.phaseO) },
            { path: 'signal.metadata.phase_o_short_live', container: this.asRecord(root.metadata), phase: this.asRecord(this.asRecord(root.metadata)?.phase_o_short_live) }
        ];

        for (const candidate of candidates) {
            const phase = candidate.phase;
            const container = candidate.container;
            if (!phase && !container) continue;
            const phaseRecord = phase ?? {};
            const isPhaseO = this.isTruthyPhaseOFlag(phaseRecord.phase_o)
                || this.isTruthyPhaseOFlag(phaseRecord.phaseO)
                || this.isTruthyPhaseOFlag(phaseRecord.is_phase_o)
                || this.isTruthyPhaseOFlag(phaseRecord.phase_o_live_enabled)
                || this.isTruthyPhaseOFlag(phaseRecord.enabled)
                || String(phaseRecord.phase_o_live_mode ?? '').toLowerCase().includes('experimental_short')
                || this.hasPhaseOModelPath(phaseRecord.phase_o_source_model_paths)
                || this.hasPhaseOModelPath(phaseRecord.model_paths)
                || this.hasPhaseOModelPath(container?.raw?.model_path)
                || this.hasPhaseOModelPath(container?.raw?.model_paths)
                || this.hasPhaseOModelPath(container?.model_paths);
            if (!isPhaseO) continue;
            const side = this.normalizeSideValue(phaseRecord.side)
                ?? this.normalizeSideValue(container?.gated?.action)
                ?? this.normalizeSideValue(container?.action)
                ?? this.normalizeSideValue(container?.raw?.action)
                ?? fallbackSide
                ?? null;
            const symbol = String(phaseRecord.symbol ?? container?.symbol ?? root.symbol ?? '').toUpperCase() || undefined;
            const avoidOnly = phaseRecord.phase_o_link_avoid_only === true
                || phaseRecord.link_avoid_only === true
                || phaseRecord.avoid_only === true
                || phaseRecord.phase_o_avoid_only === true;
            const entryEnabled = phaseRecord.entry_enabled !== false
                && phaseRecord.entryEnabled !== false
                && phaseRecord.phase_o_entry_enabled !== false
                && phaseRecord.allow_orders !== false;
            return {
                isPhaseO,
                side,
                entryEnabled,
                avoidOnly,
                modelFamily: String(phaseRecord.model_family ?? phaseRecord.modelFamily ?? phaseRecord.phase_o_live_mode ?? '').trim() || undefined,
                symbol,
                sourcePath: candidate.path,
                raw: phaseRecord
            };
        }
        return null;
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
                link_avoid_only: true
            });
            return false;
        }
        return phaseOConfig?.enabled === true
            && phaseOConfig?.allow_orders !== false
            && side === 'SHORT'
            && metadata?.isPhaseO === true
            && metadata.side === 'SHORT'
            && metadata.entryEnabled !== false;
    }

    private withPhaseOShortGuardModes(policy: AegisEntryPolicyRuntimeConfig): AegisEntryPolicyRuntimeConfig {
        return {
            ...policy,
            guards: {
                ...policy.guards,
                momentum_ride: { ...policy.guards.momentum_ride, enabled: true, mode: 'SHADOW' },
                clean_entry: { ...policy.guards.clean_entry, enabled: true, mode: 'SHADOW' },
                event_risk: { ...policy.guards.event_risk, enabled: true, mode: 'SHADOW' },
                entry_quality: { ...policy.guards.entry_quality, enabled: true, mode: 'SHADOW' },
                decision_brain: { ...policy.guards.decision_brain, enabled: true, mode: 'SHADOW' },
                regime: { ...policy.guards.regime, enabled: true, mode: 'SHADOW' },
                probe_mode: { ...policy.guards.probe_mode, enabled: true, mode: 'SHADOW' },
                short_gate: { ...policy.guards.short_gate, enabled: true, mode: 'SHADOW' },
                long_risk_shadow: { ...policy.guards.long_risk_shadow, enabled: true, mode: 'SHADOW' }
            }
        };
    }

    private getEntryQualityGateConfig(symbol?: string): AegisEntryQualityGateRuntimeConfig {
        const manager = this.deps.configManager as any;
        if (typeof manager.getEntryQualityGateConfig === 'function') {
            return manager.getEntryQualityGateConfig(symbol);
        }
        return {
            enabled: false,
            mode: 'OFF',
            config: {
                minScoreLong: 0.65,
                minScoreShort: 0.70,
                requireMomentumConfirm: false,
                antiFallingKnifeEnabled: false,
                antiFallingKnifeLookbackCandles: 3,
                maxAdverseRecentReturn: 0.003,
                overextensionEnabled: false,
                emaDistanceLimit: 0.006,
                volatilityEnabled: false,
                maxAtrPercentile: 0.75
            }
        };
    }

    private getAegisTurboRegimeConfig(symbol?: string): RegimeConfig | undefined {
        const manager = this.deps.configManager as any;
        return typeof manager.getRegimeConfig === 'function'
            ? manager.getRegimeConfig('AEGIS_TURBO', symbol)
            : undefined;
    }

    private getAegisTurboGateConfig(symbol: string) {
        return buildAegisMicroLiveGateConfigFromEnv(
            CONFIG,
            this.getAegisTurboYamlConfig(),
            this.getAegisTurboRegimeConfig(symbol)
        );
    }

    private getAegisGuardianConfig(symbol: string, regimeConfig?: RegimeConfig): GuardianConfig {
        const manager = this.deps.configManager as any;
        if (typeof manager.getGuardianConfig === 'function') {
            return manager.getGuardianConfig('AEGIS_TURBO', symbol);
        }
        return {
            ...DEFAULT_GUARDIAN_CONFIG,
            beTriggerRoe: regimeConfig?.beRoe ?? DEFAULT_GUARDIAN_CONFIG.beTriggerRoe,
            trailingActivationRoe: regimeConfig?.trailingActivationRoe ?? DEFAULT_GUARDIAN_CONFIG.trailingActivationRoe,
            trailingCallbackRoe: regimeConfig?.trailingCallbackRoe ?? DEFAULT_GUARDIAN_CONFIG.trailingCallbackRoe,
            atrMultiplier: 1.5
        };
    }

    private getSymbolMode(symbol: string): AegisSymbolMode {
        const manager = this.deps.configManager as any;
        return typeof manager.getSymbolMode === 'function'
            ? manager.getSymbolMode(symbol)
            : 'LIVE';
    }

    private getLiveAegisSymbols(): string[] {
        const manager = this.deps.configManager as any;
        return typeof manager.getLiveAegisSymbols === 'function'
            ? manager.getLiveAegisSymbols()
            : [this.config.symbols[0]].filter(Boolean);
    }

    private canExecuteLive(symbol: string): boolean {
        const turbo = this.getAegisTurboYamlConfig();
        return this.getTradingMode() === 'AEGIS_TURBO_MICRO_LIVE'
            && CONFIG.AEGIS_LIVE_ENABLED === true
            && this.getSymbolMode(symbol) === 'LIVE'
            && turbo?.enabled === true
            && turbo?.live_enabled === true;
    }

    private normalizeSymbol(symbol: string): string {
        return String(symbol || '').trim().toUpperCase();
    }

    private finiteNumber(value: unknown): value is number {
        return typeof value === 'number' && Number.isFinite(value);
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

    private async migrateLegacyGlobalStateToFirstLiveSymbol(): Promise<void> {
        if (typeof this.deps.state.forSymbol !== 'function') return;
        const legacyState = this.deps.state.get();
        if (legacyState.mode === 'IDLE') return;
        const symbol = this.getLiveAegisSymbols()[0] ?? this.config.symbols[0];
        if (!symbol) return;

        const symbolState = this.stateForSymbol(symbol);
        if (symbolState.get().mode !== 'IDLE') return;

        symbolState.set(legacyState);
        this.deps.state.set({
            mode: 'IDLE',
            lastExitAt: legacyState.lastExitAt ?? Date.now(),
            lastExitReason: 'MIGRATED_TO_SYMBOL_STATE'
        });
        this.deps.logger.warn('aegis_legacy_global_state_migrated_to_symbol', {
            symbol,
            stateMode: legacyState.mode,
            lastSide: legacyState.lastSide
        });
    }

    private async attachOpenExchangePositionsToSymbolState(): Promise<void> {
        if (typeof this.deps.state.forSymbol !== 'function') return;
        for (const symbol of this.getLiveAegisSymbols()) {
            const symbolState = this.stateForSymbol(symbol);
            if (symbolState.get().mode !== 'IDLE') continue;

            for (const side of ['LONG', 'SHORT'] as Side[]) {
                const position = await this.deps.exchange.readActivePosition(symbol, side).catch(() => null);
                if (!position) continue;

                const regimeConfig = this.getAegisTurboRegimeConfig(symbol);
                const leverage = position.leverage || this.getAegisTurboGateConfig(symbol).leverageCap;
                const entryPrice = position.entryPrice || await this.deps.exchange.getMarkPrice(symbol);
                const margin = position.isolatedMargin
                    ?? (entryPrice > 0 && leverage > 0 && position.qtyAbs > 0 ? (entryPrice * position.qtyAbs) / leverage : undefined);
                const tradeId = generateTradeId(symbol);

                symbolState.set({
                    mode: side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE',
                    lastSide: side,
                    lastEntryPrice: entryPrice,
                    lastLeverage: leverage,
                    lastActualLeverage: leverage,
                    lastEntryAt: Date.now(),
                    lastEntryQty: position.qtyAbs,
                    lastEntryMargin: margin,
                    posSideMode: position.sideMode,
                    currentRegime: 'AEGIS_TURBO',
                    lastStrategy: 'AEGIS_TURBO',
                    lastTradeId: tradeId,
                    lastPeakPrice: entryPrice,
                    peakRoe: 0,
                    lowestRoe: 0,
                    lastStopRoe: regimeConfig?.hardStopRoe ?? -0.15,
                    lastTakeProfitRoe: regimeConfig?.tpRoe ?? 0.25,
                    lastTrailingActivationRoe: regimeConfig?.trailingActivationRoe ?? 0.15,
                    lastTrailingCallbackRoe: regimeConfig?.trailingCallbackRoe ?? 0.08,
                    lastBracketStatus: 'PENDING',
                    exitEyeNeutralCount: 0,
                    exitEyeOppositeCount: 0
                });
                this.deps.logger.warn('aegis_attached_symbol_state_to_open_position', {
                    symbol,
                    side,
                    qtyAbs: position.qtyAbs,
                    entryPrice,
                    leverage
                });
                break;
            }
        }
    }

    getAegisRuntimeSnapshot(): AegisRuntimeSnapshot {
        const liquidityStressBySymbol: Record<string, number> = {};
        for (const symbol of Object.keys(this.detector)) {
            liquidityStressBySymbol[symbol] = this.detector[symbol]?.getLiquidityStress() ?? 0;
        }
        return {
            tradingMode: this.getTradingMode(),
            isRunning: this.isRunning,
            tradesToday: this.tradesToday,
            consecutiveLosses: this.consecutiveLossTracker.value,
            dailyStartBalance: this.dailyStartBalance,
            dailyPnlPct: this.lastDailyPnlPct,
            lastTradeDayReset: this.lastTradeDayReset,
            liquidityStressBySymbol
        };
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
        await this.restoreConsecutiveLossState();

        logger.info(isTurbo ? '⚡ AEGIS TURBO MICRO-LIVE MODE' : '🛡️ AEGIS SHADOW MODE', {
            initial: INITIAL_BALANCE,
            walletBalance: startupWalletBalance,
            mode: tradingMode,
            liveEnabled: CONFIG.AEGIS_LIVE_ENABLED,
            yamlLiveEnabled: this.getAegisTurboYamlConfig()?.live_enabled === true
        });

        const liveSymbols = this.getLiveAegisSymbols();
        const startupSymbols = liveSymbols.length > 0 ? liveSymbols : this.config.symbols;
        const firstSymbol = startupSymbols[0] ?? this.config.symbols[0];
        const gateConfig = this.getAegisTurboGateConfig(firstSymbol);
        const regimeConfig = this.getAegisTurboRegimeConfig(firstSymbol);
        const momentumRideConfig = this.getAegisMomentumRideConfig();
        const probeModeConfig = this.getAegisProbeModeConfig();
        const entryThreshold = gateConfig.minScore;
        const maxHoldMs = (gateConfig as any).maxHoldMs ?? regimeConfig?.maxHoldMs ?? DEFAULT_AEGIS_MAX_HOLD_MS;
        const trailingActivation = (gateConfig as any).trailingActivationRoe ?? regimeConfig?.trailingActivationRoe ?? 0.15;
        const trailingCallback = (gateConfig as any).trailingCallbackRoe ?? regimeConfig?.trailingCallbackRoe ?? 0.08;

        for (let i = 0; i < 5; i++) {
            try {
                await mlService.getSignal(firstSymbol);
                break;
            } catch (e) {
                logger.info(`Waiting for Aegis API (${i + 1}/5)`);
                await this.sleep(3000);
            }
        }

        await this.migrateLegacyGlobalStateToFirstLiveSymbol();
        await this.attachOpenExchangePositionsToSymbolState();

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
            const leverage = symbolState.lastLeverage || position?.leverage || symbolGateConfig.leverageCap;
            const qtyAbs = symbolState.lastEntryQty || position?.qtyAbs || 0;
            const marginUsed = symbolState.lastEntryMargin
                || position?.isolatedMargin
                || (entryPrice > 0 && leverage > 0 && qtyAbs > 0 ? (entryPrice * qtyAbs) / leverage : 0);
            const durationMs = symbolState.lastEntryAt ? Date.now() - symbolState.lastEntryAt : 0;
            const roi = side === 'SHORT'
                ? (entryPrice - markPrice) / entryPrice * leverage
                : (markPrice - entryPrice) / entryPrice * leverage;
            const pnl = typeof position?.unrealizedPnl === 'number' && Number.isFinite(position.unrealizedPnl)
                ? position.unrealizedPnl
                : this.pnlFromRoe(marginUsed, roi);
            const approximateBalance = startupWalletBalance !== null ? startupWalletBalance + marginUsed + pnl : null;
            const openOrders = await exchange.listCloseOrdersForSide(symbol, side);
            const tpOrder = openOrders.find(order => order.type.includes('TAKE_PROFIT'));
            const slOrder = openOrders.find(order => order.type.includes('STOP'));
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
                slRoe: stopRoe
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
                metadata: { event: 'startup' }
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
                metadata: { event: 'startup' }
            });
        }

        const momentumExamples = Object.entries(momentumRideConfig.symbols ?? {})
            .flatMap(([symbol, symbolConfig]) => {
                const config = symbolConfig as any;
                const examples: Array<{ symbol: string; side: Side; positionFraction?: number }> = [];
                if (config.long?.enabled) {
                    examples.push({ symbol, side: 'LONG', positionFraction: config.long.positionFraction });
                }
                if (config.short?.enabled) {
                    examples.push({ symbol, side: 'SHORT', positionFraction: config.short.positionFraction });
                }
                return examples;
            });

        const startupMsg = formatAegisStartupMessage({
            mode: {
                tradingMode,
                liveEnabled: CONFIG.AEGIS_LIVE_ENABLED === true && this.getAegisTurboYamlConfig()?.live_enabled === true,
                strategy: 'AEGIS_TURBO+MOMENTUM_RIDE',
                shortsEnabled: gateConfig.allowShort === true,
                activeSymbols: startupSymbols
            },
            account: {
                walletBalance: startupAccount.walletBalance ?? startupWalletBalance ?? undefined,
                equityTotal: startupAccount.equityTotal,
                availableBalance: startupAccount.availableBalance
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
                requireBrackets: gateConfig.requireBrackets
            },
            aegisTurbo: {
                enabled: this.getAegisTurboYamlConfig()?.enabled === true,
                mode: CONFIG.AEGIS_LIVE_ENABLED === true && this.getAegisTurboYamlConfig()?.live_enabled === true ? 'LIVE' : 'SHADOW',
                fallbackEnabled: true,
                leverage: gateConfig.leverageCap,
                entryThreshold: Number(entryThreshold),
                trailingActivationRoe: trailingActivation,
                trailingCallbackRoe: trailingCallback,
                stopRoe: gateConfig.stopRoe,
                takeProfitRoe: gateConfig.takeProfitRoe,
                requireBrackets: gateConfig.requireBrackets
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
                examples: momentumExamples
            },
            regimeEngineV2: {
                metadataEnabled: momentumRideConfig.regimeFilter.recordMetadata,
                useAsGate: momentumRideConfig.regimeFilter.useAsGate,
                ignoreForEntry: momentumRideConfig.regimeFilter.ignoreForEntry
            },
            probeMode: {
                enabled: probeModeConfig.enabled,
                mode: probeModeConfig.enabled ? probeModeConfig.mode : 'OFF',
                maxOpenProbePositions: probeModeConfig.max_open_probe_positions,
                maxProbeEntriesPerHour: probeModeConfig.max_probe_entries_per_hour
            },
            activePositions: startupPositions
        });
        await notifier.sendMessage(startupMsg);
        for (const symbol of this.config.symbols) {
            this.deps.exchange.subscribeToCandles(symbol);
            this.detector[symbol] = new LiquidityVoidDetector(this.deps.logger);
            if (this.deps.exchange.subscribeToPartialDepth) {
                this.deps.exchange.subscribeToPartialDepth(symbol, 50, '100ms', (depth: any) => {
                    if (!depth?.bids || !depth?.asks) return;
                    const mapper = (arr: any[]) => arr.map(row => Array.isArray(row)
                        ? { price: Number(row[0]), qty: Number(row[1]) }
                        : { price: Number(row.price), qty: Number(row.quantity) });
                    this.detector[symbol].processDepthUpdate({
                        bidDepth: mapper(depth.bids),
                        askDepth: mapper(depth.asks)
                    });
                });
            }
        }

        this.isRunning = true;
        this.hardWatchdogTimer = setInterval(() => {
            if (this.isRunning && (Date.now() - this.lastAlivePulseMs > 180000)) {
                this.deps.logger.error('system_deadlock_detected');
                process.exit(1);
            }
        }, 10000);

        if (startLoop) await this.runLoop();
    }

    stop(): void {
        this.isRunning = false;
        this.deps.logger.info('Aegis bot stopped');
        if (this.hardWatchdogTimer) clearInterval(this.hardWatchdogTimer);
    }

    async tick(symbol: string): Promise<void> {
        await this.processSymbol(symbol);
    }

    private async runLoop(): Promise<void> {
        while (this.isRunning) {
            try {
                this.checkDailyReset();
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
                await this.managePosition(symbol, botState, symbolState);
                if (symbolState.get().mode === 'IDLE') {
                    await this.lookForEntry(symbol);
                }
            } else {
                await this.lookForEntry(symbol);
            }
        } catch (error) {
            this.deps.logger.warn('Process error', { symbol, error: String(error) });
        }
    }

    private async scanShadowOnly(symbol: string): Promise<void> {
        const signal = await this.deps.mlService.getSignal(symbol);
        const signalId = generateSignalId(symbol);
        this.logAegisScan(symbol, signal);
        await this.logAegisTradeEvent(symbol, 'SIGNAL_RECEIVED', {
            metadata: { signalId, symbolMode: this.getSymbolMode(symbol), shadowOnly: true }
        });
        await this.logAegisTurboSignal(symbol, signal, {
            signalId,
            executed: false,
            metadata: {
                symbol_mode: this.getSymbolMode(symbol),
                shadow_only: true,
                ignored_reason: 'symbol_not_live'
            }
        });
    }

    private logAegisScan(symbol: string, signal: AegisTradingSignal): void {
        const aegis = signal.metadata?.aegis ?? signal.aegis;
        this.deps.logger.info('aegis_scan', {
            symbol,
            mode: this.getTradingMode(),
            safeAction: aegis?.shadow?.action,
            safeReason: aegis?.shadow?.reason,
            turboRawAction: aegis?.turbo?.raw?.action,
            turboRawScore: aegis?.turbo?.raw?.turbo_score,
            turboRawWouldExecute: aegis?.turbo?.raw?.would_execute,
            turboGatedAction: aegis?.turbo?.gated?.action,
            turboGatedReason: aegis?.turbo?.gated?.reason,
            turboBlockedBy: aegis?.turbo?.gated?.blocked_by,
            execute: aegis?.turbo?.execute,
            smartLeverage: signal.smart_leverage ?? 0,
            prodExecute: aegis?.prod?.execute
        });
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
            metadata?: Record<string, unknown>;
        } = {}
    ): Promise<void> {
        const aegis = signal.metadata?.aegis ?? signal.aegis;
        const turbo = aegis?.turbo as any;
        const raw = turbo?.raw;
        const gated = turbo?.gated;
        await this.historyLogger.logSignal({
            signal_id: extras.signalId ?? generateSignalId(symbol),
            portfolio_session_id: getPortfolioSessionId(),
            symbol,
            strategy: 'AEGIS_TURBO',
            mode: this.getTradingMode(),
            price: extras.price,
            raw_action: raw?.action,
            gated_action: gated?.action,
            final_action: turbo?.action ?? gated?.action ?? raw?.action,
            reason: turbo?.reason ?? gated?.reason ?? raw?.reason,
            turbo_score: raw?.turbo_score ?? turbo?.turbo_score ?? extras.gate?.turboScore,
            confidence: typeof signal.confidence === 'number' ? `${signal.confidence}` : undefined,
            votes: raw?.votes ?? extras.gate?.votes,
            recent_scores: raw?.recent_scores ?? turbo?.recent_scores,
            freshness: raw?.freshness ?? turbo?.freshness,
            gate_allowed: extras.gate?.allowed,
            gate_reason: extras.gate?.reason,
            gated_blocked_by: extras.gate?.gatedBlockedBy,
            executed: extras.executed ?? false,
            trade_id: extras.tradeId,
            leverage: extras.gate?.leverage,
            position_fraction: extras.gate?.positionFraction,
            stop_roe: extras.gate?.stopRoe,
            take_profit_roe: extras.gate?.takeProfitRoe,
            trailing_activation_roe: extras.gate?.trailingActivationRoe,
            trailing_callback_roe: extras.gate?.trailingCallbackRoe,
            metadata: {
                source: signal.source,
                safe_action: aegis?.shadow?.action,
                safe_reason: aegis?.shadow?.reason,
                prod_execute: aegis?.prod?.execute,
                ...extras.metadata
            }
        });
    }

    private async logAegisTradeEvent(
        symbol: string,
        event: string,
        input: {
            tradeId?: string;
            price?: number;
            roe?: number;
            oldStop?: number;
            newStop?: number;
            oldTp?: number;
            newTp?: number;
            reason?: string;
            metadata?: Record<string, unknown>;
        } = {}
    ): Promise<void> {
        await this.historyLogger.logTradeEvent({
            trade_id: input.tradeId,
            portfolio_session_id: getPortfolioSessionId(),
            symbol,
            strategy: 'AEGIS_TURBO',
            mode: this.getTradingMode(),
            event,
            price: input.price,
            roe: input.roe,
            old_stop: input.oldStop,
            new_stop: input.newStop,
            old_tp: input.oldTp,
            new_tp: input.newTp,
            reason: input.reason,
            metadata: input.metadata
        });
    }

    private async logEntryIntelligenceDispositionShadow(
        symbol: string,
        signal: AegisTradingSignal,
        stage: 'MICRO_GATE' | 'ENTRY_POLICY',
        operationalAllowed: boolean,
        operationalReason: string,
        deniedBy?: string,
        signalId?: string,
        tradeId?: string
    ): Promise<void> {
        const aegis = this.getAegisSignalBlock(signal);
        const record = buildAegisOperationalDispositionShadow({
            symbol,
            stage,
            intelligence: aegis?.entry_intelligence_shadow,
            operationalAllowed,
            operationalReason,
            deniedBy
        });
        if (!record) return;
        try {
            await this.logAegisTradeEvent(symbol, 'ENTRY_INTELLIGENCE_OPERATIONAL_DISPOSITION_SHADOW', {
                tradeId,
                reason: operationalReason,
                metadata: { ...record, signalId }
            });
        } catch (error) {
            this.deps.logger.warn('entry_intelligence_shadow_log_failed', {
                symbol,
                stage,
                error: String(error)
            });
        }
    }

    private async logAegisAccountSnapshot(input: {
        symbol?: string;
        walletBalance?: number;
        availableBalance?: number;
        unrealizedPnl?: number;
        dailyPnlPct?: number;
        positionOpen?: boolean;
        side?: Side;
        entryPrice?: number;
        markPrice?: number;
        roe?: number;
        marginUsed?: number;
        quantity?: number;
        leverage?: number;
        metadata?: Record<string, unknown>;
    } = {}): Promise<void> {
        const notional = input.entryPrice && input.quantity
            ? input.entryPrice * input.quantity
            : undefined;
        await this.historyLogger.logAccountSnapshot({
            portfolio_session_id: getPortfolioSessionId(),
            mode: this.getTradingMode(),
            wallet_balance: input.walletBalance,
            available_balance: input.availableBalance ?? input.walletBalance,
            unrealized_pnl: input.unrealizedPnl,
            daily_pnl_pct: input.dailyPnlPct,
            trades_today: this.tradesToday,
            consecutive_losses: this.consecutiveLossTracker.value,
            open_positions_count: input.positionOpen ? 1 : 0,
            total_margin_used: input.marginUsed,
            total_notional: notional,
            symbols: input.symbol ? [{
                symbol: input.symbol,
                position_open: input.positionOpen,
                side: input.side,
                entry_price: input.entryPrice,
                mark_price: input.markPrice,
                roe: input.roe,
                unrealized_pnl: input.unrealizedPnl,
                margin_used: input.marginUsed,
                notional
            }] : undefined,
            portfolio_exposure: {
                long_symbols: input.positionOpen && input.side === 'LONG' ? 1 : 0,
                short_symbols: input.positionOpen && input.side === 'SHORT' ? 1 : 0,
                total_symbols: input.positionOpen ? 1 : 0,
                total_margin_used: input.marginUsed,
                total_notional: notional
            },
            metadata: input.metadata
        });
    }

    private evaluateAegisTurboGate(
        symbol: string,
        signal: AegisTradingSignal,
        dailyPnlPct?: number
    ): AegisMicroLiveGateDecision {
        const botState = this.stateForSymbol(symbol).get();
        const timeSinceLastExitMs = Date.now() - (botState.lastExitAt || 0);
        const liquidityStress = this.detector[symbol]?.getLiquidityStress() || 0;

        return shouldEnterAegisTurboMicroLive(
            {
                symbol,
                signal: { aegis: signal.metadata?.aegis ?? signal.aegis },
                hasOpenPosition: botState.mode !== 'IDLE',
                tradesToday: this.tradesToday,
                consecutiveLosses: this.consecutiveLossTracker.value,
                timeSinceLastExitMs,
                liquidityStress,
                dailyPnlPct
            },
            this.getAegisTurboGateConfig(symbol)
        );
    }

    private async lookForEntry(symbol: string): Promise<void> {
        const { mlService, exchange, logger } = this.deps;
        const symbolState = this.stateForSymbol(symbol);
        const tradingMode = this.getTradingMode();

        try {
            const signal = await mlService.getSignal(symbol);
            const signalId = generateSignalId(symbol);
            this.logAegisScan(symbol, signal);
            await this.logAegisTradeEvent(symbol, 'SIGNAL_RECEIVED', { metadata: { signalId } });

            if (tradingMode === 'AEGIS_SHADOW') {
                await this.logAegisTurboSignal(symbol, signal, { signalId, executed: false });
                return;
            }
            if (tradingMode !== 'AEGIS_TURBO_MICRO_LIVE') {
                logger.warn('aegis_unknown_trading_mode', { symbol, tradingMode });
                await this.logAegisTurboSignal(symbol, signal, {
                    signalId,
                    executed: false,
                    metadata: { ignored_reason: 'unknown_trading_mode' }
                });
                return;
            }

            if (this.getSymbolMode(symbol) !== 'LIVE') {
                await this.logAegisTurboSignal(symbol, signal, {
                    signalId,
                    executed: false,
                    metadata: { ignored_reason: 'symbol_not_live', symbol_mode: this.getSymbolMode(symbol) }
                });
                return;
            }

            const balance = await exchange.getUSDTBalance();
            const accountSnapshot = await this.readEntryAccountSnapshot(balance);
            const dailyEquity = accountSnapshot.equityTotal
                ?? accountSnapshot.walletBalance
                ?? balance;
            if (this.dailyStartBalance === null || this.dailyStartBalance <= 0) {
                this.dailyStartBalance = dailyEquity;
            }
            const dailyPnlPct = this.dailyStartBalance > 0
                ? (dailyEquity - this.dailyStartBalance) / this.dailyStartBalance
                : undefined;
            this.lastDailyPnlPct = dailyPnlPct;
            const gateConfig = this.getAegisTurboGateConfig(symbol);
            const gateDecision = this.evaluateAegisTurboGate(symbol, signal, dailyPnlPct);
            await this.logEntryIntelligenceDispositionShadow(
                symbol,
                signal,
                'MICRO_GATE',
                gateDecision.allowed,
                gateDecision.reason,
                gateDecision.allowed ? undefined : 'micro_gate',
                signalId
            );
            if (!gateDecision.allowed) {
                await this.logAegisTurboSignal(symbol, signal, { signalId, gate: gateDecision, executed: false });
                await this.logAegisTradeEvent(symbol, 'GATE_DENIED', {
                    reason: gateDecision.reason,
                    metadata: {
                        turboScore: gateDecision.turboScore,
                        votes: gateDecision.votes,
                        gatedReason: gateDecision.gatedReason,
                        gatedBlockedBy: gateDecision.gatedBlockedBy
                    }
                });
                await this.logAegisAccountSnapshot({
                    symbol,
                    walletBalance: balance,
                    availableBalance: balance,
                    dailyPnlPct,
                    positionOpen: false,
                    metadata: { reason: gateDecision.reason }
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
                    dailyStartBalance: this.dailyStartBalance,
                    dailyPnlPct,
                    dailyEquity,
                    availableBalance: balance,
                    dailyLossStopPct: gateConfig.dailyLossStopPct,
                    tradingMode
                });
                return;
            }

            if (CONFIG.AEGIS_LIVE_ENABLED !== true) {
                this.logAllowedDryRun(symbol, gateDecision);
                await this.logAegisTurboSignal(symbol, signal, { signalId, gate: gateDecision, executed: false });
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
                        trailingCallbackRoe: gateDecision.trailingCallbackRoe
                    }
                });
                return;
            }

            const turboYaml = this.getAegisTurboYamlConfig();
            if (turboYaml && turboYaml.enabled !== true) {
                await this.logAegisTurboSignal(symbol, signal, {
                    signalId,
                    gate: { ...gateDecision, allowed: false, reason: 'aegis_turbo_yaml_disabled' },
                    executed: false,
                    metadata: { ignored_reason: 'aegis_turbo_yaml_disabled' }
                });
                await this.logAegisTradeEvent(symbol, 'GATE_DENIED', {
                    reason: 'aegis_turbo_yaml_disabled'
                });
                return;
            }

            if (this.getAegisTurboYamlConfig()?.live_enabled !== true) {
                await this.logAegisTurboSignal(symbol, signal, {
                    signalId,
                    gate: { ...gateDecision, allowed: false, reason: 'aegis_turbo_yaml_live_disabled' },
                    executed: false
                });
                await this.logAegisTradeEvent(symbol, 'GATE_DENIED', {
                    reason: 'aegis_turbo_yaml_live_disabled',
                    metadata: {
                        turboScore: gateDecision.turboScore,
                        votes: gateDecision.votes,
                        gatedReason: gateDecision.gatedReason,
                        gatedBlockedBy: gateDecision.gatedBlockedBy
                    }
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
                    dailyStartBalance: this.dailyStartBalance,
                    dailyPnlPct,
                    dailyEquity,
                    availableBalance: balance,
                    dailyLossStopPct: gateConfig.dailyLossStopPct,
                    tradingMode
                });
                return;
            }

            if (!this.canExecuteLive(symbol)) {
                await this.logAegisTurboSignal(symbol, signal, {
                    signalId,
                    gate: { ...gateDecision, allowed: false, reason: 'symbol_live_execution_disabled' },
                    executed: false,
                    metadata: { symbol_mode: this.getSymbolMode(symbol) }
                });
                return;
            }

            if (!gateDecision.side || symbolState.get().mode !== 'IDLE') return;
            if (this.tradesToday >= gateConfig.maxTradesPerDay) return;
            if (await exchange.hasOpenPosition(symbol, 'ANY')) {
                logger.warn('aegis_real_position_already_open', { symbol });
                return;
            }

            const tradeId = generateTradeId(symbol);
            await this.openAegisTurboPosition(symbol, signal, gateDecision, tradeId, signalId);
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
            message: 'Gate allowed but live execution is disabled by env'
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
                const position = await this.deps.exchange.readActivePosition(symbol, side).catch(() => null);
                if (!position) continue;
                openPositions++;
                if (side === 'LONG') longPositions++;
                if (side === 'SHORT') shortPositions++;
                const markPrice = await this.deps.exchange.getMarkPrice(symbol).catch(() => position.entryPrice);
                const positionMargin = position.isolatedMargin
                    ?? (position.entryPrice > 0 && position.leverage > 0 && position.qtyAbs > 0
                        ? (position.entryPrice * position.qtyAbs) / position.leverage
                        : 0);
                marginUsed += positionMargin;
                notional += (markPrice || position.entryPrice || 0) * position.qtyAbs;
            }
        }

        return { openPositions, longPositions, shortPositions, marginUsed, notional };
    }

    private getCachedEntryQualityCandles(symbol: string): Candle[] {
        const cachedCandles = this.deps.exchange.getCachedCandles?.(symbol, '5m', 40);
        return Array.isArray(cachedCandles) ? cachedCandles : [];
    }

    private buildEntryQualityMarketContext(symbol: string): {
        recentCandles: Candle[];
        currentPrice?: number;
        emaFast?: number;
        atrPct?: number;
        atrPercentile?: number;
    } {
        const recentCandles = this.getCachedEntryQualityCandles(symbol)
            .filter((candle) => this.isValidCandle(candle));
        const currentPrice = recentCandles.length > 0
            ? recentCandles[recentCandles.length - 1].close
            : undefined;
        const emaFast = this.calculateEmaFast(recentCandles, 9);
        const atr = calculateATR(recentCandles, 14);
        const atrPct = atr !== null && currentPrice && currentPrice > 0
            ? atr / currentPrice
            : undefined;
        const atrPercentile = this.calculateAtrPercentile(recentCandles);

        return {
            recentCandles,
            currentPrice,
            emaFast,
            atrPct,
            atrPercentile
        };
    }

    private isValidCandle(candle: Candle): boolean {
        return Number.isFinite(candle.open)
            && Number.isFinite(candle.high)
            && Number.isFinite(candle.low)
            && Number.isFinite(candle.close)
            && candle.close > 0;
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
                Math.abs(current.low - previous.close)
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
        tradeId?: string
    ): Promise<void> {
        const event = decision.action === 'SHADOW_BLOCK'
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
            shadowDidNotBlock: decision.action === 'SHADOW_BLOCK' ? true : undefined
        };

        await this.logAegisTradeEvent(symbol, event, {
            tradeId,
            reason: decision.reason,
            metadata
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

    private isAltSymbol(symbol: string): boolean {
        const normalized = this.normalizeSymbol(symbol);
        return normalized !== 'BTCUSDT' && normalized !== 'ETHUSDT';
    }

    private async logAegisEventRiskDecision(
        symbol: string,
        decision: AegisEventRiskOverlayDecision,
        tradeId?: string
    ): Promise<void> {
        const event = decision.action === 'BLOCK'
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
            shadowDidNotBlock: decision.wouldBlock && decision.allowed ? true : undefined
        };

        await this.logAegisTradeEvent(symbol, event, {
            tradeId,
            reason: decision.reason,
            metadata
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
        tradeId?: string
    ): Promise<void> {
        const metadata = {
            ...decision.metadata,
            reason: decision.reason,
            allowed: decision.allowed
        };
        await this.logAegisTradeEvent(symbol, 'DECISION_ENFORCEMENT_DENIED', {
            tradeId,
            reason: decision.reason,
            metadata
        });
        this.deps.logger.warn('aegis_decision_enforcement_denied', metadata);
    }

    private async notifyDecisionEnforcementDenied(symbol: string, decision: AegisDecisionEnforcementDecision): Promise<void> {
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
                entryQualityGateAction: decision.metadata.entryQualityGateAction
            });
            return;
        }

        const blockDedupeConfig = telegramNotificationsConfig.block_dedupe;
        const notification = this.aegisTelegramBlockNotifier.decide({
            timestamp: now,
            symbol,
            side: decision.metadata.side,
            reason: decision.reason,
            eventRiskMode: decision.metadata.eventRiskMode,
            setupGrade: decision.metadata.setupGrade,
            decisionBrain: decision.metadata.decisionBrainDecision,
            entryQuality: decision.metadata.entryQualityRecommendation ?? decision.metadata.entryQualityGateAction,
            tailRiskScore: decision.metadata.tailRiskScore ?? undefined,
            turboScore: decision.metadata.turboScore,
            source: 'DECISION_ENFORCEMENT_DENIED'
        }, blockDedupeConfig);

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
            entryQualityGateAction: decision.metadata.entryQualityGateAction
        };

        if (!notification.shouldNotify) {
            this.deps.logger.info('telegram_block_notification_suppressed', notificationMetadata);
            await this.logAegisTradeEvent(symbol, 'telegram_block_notification_suppressed', {
                reason: decision.reason,
                metadata: notificationMetadata
            });
            return;
        }

        if (notification.notificationType === 'SUMMARY') {
            this.deps.logger.info('telegram_block_notification_summary_sent', notificationMetadata);
            await this.logAegisTradeEvent(symbol, 'telegram_block_notification_summary_sent', {
                reason: decision.reason,
                metadata: notificationMetadata
            });
        }

        await this.deps.notifier.sendMessage(
            notification.message ?? (
                `🛡️ Entrada bloqueada\n` +
                `${symbol} ${decision.metadata.side}\n` +
                `Motivo: ${decision.reason}`
            )
        ).catch((error) => {
            this.deps.logger.warn('aegis_decision_enforcement_telegram_failed', {
                symbol,
                reason: decision.reason,
                error: error instanceof Error ? error.message : String(error)
            });
        });
    }

    private async logAegisCleanEntryGuardDecision(
        symbol: string,
        decision: AegisCleanEntryGuardOutput,
        tradeId: string
    ): Promise<void> {
        const shouldLog = decision.metadata.enabled
            && (
                decision.metadata.dirty
                || decision.metadata.mode === 'ENFORCE'
                || decision.metadata.decision === 'ALLOW_CLEAN'
            );
        if (!shouldLog) return;

        const event = decision.decision === 'ALLOW_CLEAN'
            ? (decision.mode === 'SHADOW' ? 'CLEAN_ENTRY_GUARD_SHADOW_ALLOW' : 'CLEAN_ENTRY_GUARD_ALLOW')
            : (decision.mode === 'SHADOW' ? 'CLEAN_ENTRY_GUARD_SHADOW_WAIT' : 'CLEAN_ENTRY_GUARD_WAIT_CONFIRMATION');
        const reason = decision.decision === 'WAIT_CONFIRMATION'
            ? 'clean_entry_wait_confirmation'
            : decision.decision === 'SHADOW_WAIT_CONFIRMATION'
                ? 'clean_entry_shadow_wait'
                : 'clean_entry_allow';

        await this.logAegisTradeEvent(symbol, event, {
            tradeId,
            reason,
            metadata: {
                ...decision.metadata,
                cleanEntryGuard: decision.metadata
            }
        });
    }

    private countStateOpenPositions(): { totalOpenPositions: number; openMomentumPositions: number; openProbePositions: number } {
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
        tradeId: string
    ): Promise<void> {
        const event = decision.allowed ? 'PROBE_MODE_ALLOWED' : 'PROBE_MODE_DENIED';
        await this.logAegisTradeEvent(symbol, event, {
            tradeId,
            reason: decision.reason,
            metadata: {
                probeMode: decision.metadata
            }
        });

        if (decision.allowed) {
            this.deps.logger.warn('aegis_probe_mode_allowed', decision.metadata);
            return;
        }
        this.deps.logger.info('aegis_probe_mode_denied', decision.metadata);
    }

    private async notifyProbeModeAllowed(symbol: string, side: Side, decision: AegisProbeModeDecision): Promise<void> {
        await Promise.resolve(this.deps.notifier.sendMessage(
            `🧪 Probe Mode permitió entrada\n` +
            `${symbol} ${side}\n` +
            `Score: ${this.formatScore(decision.metadata.turboScore ?? 0)} | TailRisk: ${this.formatScore(decision.metadata.tailRiskScore ?? 0)}\n` +
            `DB: ${decision.metadata.decisionBrain ?? 'N/D'} | EQ: ${decision.metadata.entryQualityRecommendation ?? 'N/D'}\n` +
            `Motivo: ${decision.reason}`
        )).catch((error) => {
            this.deps.logger.warn('aegis_probe_mode_telegram_failed', {
                symbol,
                side,
                reason: decision.reason,
                error: error instanceof Error ? error.message : String(error)
            });
        });
    }

    private recordProbeModeEntry(openedAtMs: number, tradeId: string): void {
        const globalState = this.deps.state.get();
        const cutoff = openedAtMs - 60 * 60 * 1000;
        const recent = (globalState.probeEntryTimestamps ?? [])
            .filter((timestamp) => this.finiteNumber(timestamp) && timestamp >= cutoff && timestamp <= openedAtMs);
        this.deps.state.set({
            lastProbeAt: openedAtMs,
            lastProbeTradeId: tradeId,
            probeEntryTimestamps: [...recent, openedAtMs]
        });
    }

    private contextAction(context: Record<string, unknown> | undefined): string | undefined {
        const value = context?.action ?? context?.turbo_action ?? context?.suggested_action;
        return value === undefined ? undefined : String(value).trim().toUpperCase();
    }

    private contextScore(context: Record<string, unknown> | undefined): number | undefined {
        const value = context?.score ?? context?.turbo_score ?? context?.confidence;
        return this.finiteNumber(value) ? Number(value) : undefined;
    }

    private contextVotes(context: Record<string, unknown> | undefined): { long?: number; short?: number; neutral?: number } | undefined {
        const value = context?.votes;
        if (!value || typeof value !== 'object') return undefined;
        const votes = value as Record<string, unknown>;
        return {
            long: this.finiteNumber(votes.long) ? Number(votes.long) : undefined,
            short: this.finiteNumber(votes.short) ? Number(votes.short) : undefined,
            neutral: this.finiteNumber(votes.neutral) ? Number(votes.neutral) : undefined
        };
    }

    private contextSnapshotAgeSeconds(eventRiskAuto: Record<string, unknown> | undefined): number | undefined {
        const direct = eventRiskAuto?.snapshot_age_seconds ?? eventRiskAuto?.snapshotAgeSeconds;
        if (this.finiteNumber(direct)) return Number(direct);
        const snapshotTs = eventRiskAuto?.snapshot_timestamp_ms ?? eventRiskAuto?.snapshotTimestampMs ?? eventRiskAuto?.generated_at_ms;
        if (this.finiteNumber(snapshotTs)) {
            return Math.max(0, (Date.now() - Number(snapshotTs)) / 1000);
        }
        return undefined;
    }

    private async buildAegisEntryContext(input: {
        symbol: string;
        side: Side;
        signal: AegisTradingSignal;
        gate: AegisMicroLiveGateDecision;
        baseGate: AegisMicroLiveGateDecision;
    }): Promise<AegisEntryContext> {
        const aegis = this.getAegisSignalBlock(input.signal);
        const entryQualityRuntimeConfig = this.getEntryQualityGateConfig(input.symbol);
        const eventRiskConfig = this.getAegisEventRiskConfig();
        const eventRiskAuto = aegis?.event_risk_auto;
        const eventRiskAutoRecord = eventRiskAuto as Record<string, unknown> | undefined;
        const btcContext = eventRiskAuto?.btc_context as Record<string, unknown> | undefined;
        const ethContext = eventRiskAuto?.eth_context as Record<string, unknown> | undefined;
        const globalState = this.deps.state.get();
        const stateExposure = this.countStateOpenPositions();
        const lastStopLossAt = this.mostRecentStopLossAt();
        const now = Date.now();
        const sameSymbolPositionExists = this.stateForSymbol(input.symbol).get().mode !== 'IDLE'
            || await this.deps.exchange.hasOpenPosition(input.symbol, 'ANY').catch(() => false);

        return {
            symbol: input.symbol,
            side: input.side,
            rawAction: aegis?.turbo?.raw?.action ?? input.signal.action,
            finalAction: aegis?.turbo?.gated?.action ?? aegis?.turbo?.action ?? input.signal.action,
            turboScore: input.gate.turboScore ?? 0,
            votes: input.gate.votes,
            setupGrade: (aegis?.clean_entry_guard as any)?.setupGrade
                ?? ((aegis as any)?.decision_enforcement)?.setupGrade
                ?? (aegis?.turbo as any)?.setupGrade
                ?? (aegis?.turbo as any)?.setup_grade,
            leverage: input.gate.leverage,
            requestedPositionFraction: input.gate.positionFraction,
            basePositionFraction: input.baseGate.positionFraction,
            signal: input.signal,
            gate: input.gate,
            decisionBrain: {
                decision: aegis?.decision_brain?.decision,
                confidence: aegis?.decision_brain?.enter_now_prob ?? undefined,
                reason: aegis?.decision_brain?.reason,
                block: aegis?.decision_brain
            },
            entryQuality: {
                model: aegis?.entry_quality_model,
                recommendation: aegis?.entry_quality_model?.recommendation,
                entryQualityScore: aegis?.entry_quality_model?.entry_quality_score,
                tailRiskScore: aegis?.entry_quality_model?.tail_risk_score,
                featureStatus: aegis?.entry_quality_model?.feature_status,
                featureParityPct: aegis?.entry_quality_model?.feature_parity_pct,
                missingFeaturesCount: aegis?.entry_quality_model?.missing_features_count,
                modelScope: aegis?.entry_quality_model?.model_scope,
                modelVersion: aegis?.entry_quality_model?.model_version,
                ruleGate: {
                    enabled: entryQualityRuntimeConfig.enabled,
                    mode: entryQualityRuntimeConfig.mode,
                    config: entryQualityRuntimeConfig.config,
                    ...this.buildEntryQualityMarketContext(input.symbol)
                }
            },
            eventRisk: {
                enabled: eventRiskConfig.enabled,
                mode: eventRiskConfig.mode,
                enforce: eventRiskConfig.enforce,
                reason: undefined,
                wouldBlock: undefined,
                confidence: eventRiskAuto?.confidence ?? undefined,
                auto: eventRiskAuto,
                btcAction: this.contextAction(btcContext),
                btcScore: this.contextScore(btcContext),
                ethAction: this.contextAction(ethContext),
                ethScore: this.contextScore(ethContext),
                isAltSymbol: this.isAltSymbol(input.symbol),
                config: {
                    caution: {
                        minQualityScore: eventRiskConfig.caution.min_quality_score,
                        maxTailRiskScore: eventRiskConfig.caution.max_tail_risk_score,
                        requireBtcEthConfirmation: eventRiskConfig.caution.require_btc_eth_confirmation
                    },
                    riskOff: {
                        minQualityScore: eventRiskConfig.risk_off.min_quality_score,
                        maxTailRiskScore: eventRiskConfig.risk_off.max_tail_risk_score,
                        allowOnlyAPlus: eventRiskConfig.risk_off.allow_only_a_plus
                    },
                    manualOnly: {
                        blockNewEntries: eventRiskConfig.manual_only.block_new_entries
                    }
                }
            },
            regime: {
                config: this.getAegisRegimeGuardConfig(),
                contextConfig: this.getAegisRegimeContextConfig(),
                btcAction: this.contextAction(btcContext),
                btcScore: this.contextScore(btcContext),
                btcVotes: this.contextVotes(btcContext),
                ethAction: this.contextAction(ethContext),
                ethScore: this.contextScore(ethContext),
                ethVotes: this.contextVotes(ethContext),
                marketDistribution: undefined,
                snapshotAgeSeconds: this.contextSnapshotAgeSeconds(eventRiskAutoRecord)
            },
            momentumRideConfig: this.getAegisMomentumRideConfig(),
            cleanEntry: {
                metadata: aegis?.clean_entry_guard as AegisCleanEntryGuardOutput['metadata'] | undefined,
                config: this.getAegisCleanEntryGuardConfig()
            },
            probe: {
                config: this.getAegisProbeModeConfig()
            },
            shortGate: {
                config: this.getAegisShortGateConfig()
            },
            decisionEnforcement: {
                config: this.getAegisDecisionEnforcementConfig(),
                riskOffTailMax: eventRiskConfig.risk_off.max_tail_risk_score
            },
            operational: {
                consecutiveLosses: this.consecutiveLossTracker.value,
                tradesToday: this.tradesToday,
                openPositionsCount: stateExposure.totalOpenPositions,
                openMomentumPositions: stateExposure.openMomentumPositions,
                openProbePositions: stateExposure.openProbePositions,
                sameSymbolPositionExists,
                recentStopLossMinutes: this.finiteNumber(lastStopLossAt) ? (now - lastStopLossAt) / 60000 : undefined,
                lastStopLossAt,
                lastProbeAt: globalState.lastProbeAt,
                probeEntryTimestamps: globalState.probeEntryTimestamps,
                timestamp: now
            }
        };
    }

    private async openAegisTurboPosition(
        symbol: string,
        signal: AegisTradingSignal,
        gate: AegisMicroLiveGateDecision,
        tradeId: string,
        signalId?: string
    ): Promise<void> {
        const { exchange, logger, notifier, configManager } = this.deps;
        const symbolState = this.stateForSymbol(symbol);
            const yaml = this.getAegisTurboYamlConfig();
            let opened = false;
            let openedSide: Side | null = null;
            let probeModeDecision: AegisProbeModeDecision | undefined;

        try {
            if (!this.canExecuteLive(symbol)) {
                logger.warn('aegis_live_execution_blocked_by_symbol_mode', {
                    symbol,
                    symbolMode: this.getSymbolMode(symbol),
                    tradingMode: this.getTradingMode(),
                    liveEnabled: CONFIG.AEGIS_LIVE_ENABLED,
                    yamlEnabled: yaml?.enabled === true,
                    yamlLiveEnabled: yaml?.live_enabled === true
                });
                return;
            }
            if (!gate.allowed || (gate.side !== 'LONG' && gate.side !== 'SHORT')) return;
            const side = gate.side;
            const positionFractionOverride = this.getAegisPositionFractionOverride(symbol, side);
            const gateAfterPositionOverride: AegisMicroLiveGateDecision = positionFractionOverride
                ? { ...gate, positionFraction: positionFractionOverride.positionFraction }
                : gate;
            if (positionFractionOverride) {
                await this.logAegisTradeEvent(symbol, 'POSITION_FRACTION_OVERRIDE_APPLIED', {
                    tradeId,
                    reason: 'configured_position_fraction_override',
                    metadata: {
                        symbol,
                        side,
                        mlPositionFraction: gate.positionFraction,
                        overriddenPositionFraction: positionFractionOverride.positionFraction,
                        ruleIndex: positionFractionOverride.ruleIndex,
                        ruleName: positionFractionOverride.ruleName
                    }
                });
                logger.warn('aegis_position_fraction_override_applied', {
                    symbol,
                    side,
                    mlPositionFraction: gate.positionFraction,
                    overriddenPositionFraction: positionFractionOverride.positionFraction,
                    ruleIndex: positionFractionOverride.ruleIndex,
                    ruleName: positionFractionOverride.ruleName
                });
            }
            const entryContext = await this.buildAegisEntryContext({
                symbol,
                side,
                signal,
                gate: gateAfterPositionOverride,
                baseGate: gate
            });
            const baseEntryPolicy = this.getAegisEntryPolicyConfig();
            const phaseOMetadata = this.extractPhaseOTurboMetadata(signal, side);
            const phaseOShortLive = this.isPhaseOShortLiveSignal(signal, side);
            const entryPolicy = phaseOShortLive
                ? this.withPhaseOShortGuardModes(baseEntryPolicy)
                : baseEntryPolicy;
            if (phaseOShortLive) {
                const phaseOConfig = this.getAegisPhaseOShortLiveConfig();
                const phaseOLimit = phaseOConfig?.max_phase_o_trades_per_day;
                if (typeof phaseOLimit === 'number' && this.phaseOShortTradesToday >= phaseOLimit) {
                    await this.logAegisTurboSignal(symbol, signal, {
                        signalId,
                        tradeId,
                        gate: { ...gateAfterPositionOverride, allowed: false, reason: 'risk_guard_max_phase_o_trades_per_day' },
                        executed: false
                    });
                    await this.logAegisTradeEvent(symbol, 'GATE_DENIED', {
                        tradeId,
                        reason: 'risk_guard_max_phase_o_trades_per_day',
                        metadata: {
                            countSource: 'trade_opened',
                            currentCount: this.phaseOShortTradesToday,
                            limit: phaseOLimit,
                            phaseOOnly: true,
                            side,
                            symbol,
                            phase_o_short_detected: true,
                            phase_o_metadata_source_path: phaseOMetadata?.sourcePath,
                            blocked_by_hard_safety: true,
                            blocked_by_secondary_guard: false
                        }
                    });
                    logger.warn('risk_guard_max_phase_o_trades_per_day', {
                        symbol,
                        side,
                        countSource: 'trade_opened',
                        currentCount: this.phaseOShortTradesToday,
                        limit: phaseOLimit,
                        phaseOOnly: true
                    });
                    return;
                }
                const phaseOGuardMetadata = {
                    symbol,
                    side,
                    phase_o_short_detected: true,
                    phase_o_short_recognized: true,
                    phase_o_metadata_source_path: phaseOMetadata?.sourcePath,
                    phase_o_short_guard_modes_applied: true,
                    guardMode: 'SHADOW',
                    guard_modes: {
                        momentum_ride: 'SHADOW',
                        clean_entry: 'SHADOW',
                        event_risk: 'SHADOW',
                        entry_quality: 'SHADOW',
                        decision_brain: 'SHADOW',
                        regime_engine: 'SHADOW',
                        probe_mode: 'SHADOW',
                        short_gate: 'SHADOW',
                        long_risk_shadow: 'SHADOW'
                    },
                    hard_safety_enforced: {
                        brackets: true,
                        max_open: true,
                        max_trades: true,
                        daily_loss: true,
                        min_notional: true,
                        link_no_entry: true
                    },
                    shadowGuards: ['momentum_ride', 'clean_entry', 'event_risk', 'entry_quality', 'decision_brain', 'regime', 'probe_mode', 'short_gate', 'long_risk_shadow'],
                    enforcedGuards: ['phase_o_ml', 'brackets', 'max_trades_per_day', 'daily_loss_stop', 'exchange_min_notional', 'link_no_entry'],
                    ignoredForPhaseO: true
                };
                logger.info('phase_o_short_guard_modes_applied', phaseOGuardMetadata);
                await this.logAegisTradeEvent(symbol, 'PHASE_O_SHORT_GUARD_MODES_APPLIED', {
                    tradeId,
                    reason: 'phase_o_short_guard_modes_applied',
                    metadata: phaseOGuardMetadata
                });
            }
            const entryDecision = AegisEntryGuardOrchestrator.evaluate(
                entryContext,
                entryPolicy
            );
            const shortGateDecision = entryDecision.decisions.shortGate;
            const entryQualityDecision = entryDecision.decisions.entryQuality;
            const eventRiskDecision = entryDecision.decisions.eventRisk;
            const decisionEnforcement = entryDecision.decisions.decisionEnforcement;
            const cleanEntryGuard = entryDecision.decisions.cleanEntry;
            probeModeDecision = entryDecision.decisions.probeMode;
            await this.logAegisTradeEvent(symbol, 'ENTRY_POLICY_DECISION', {
                tradeId,
                reason: entryDecision.finalReason,
                metadata: {
                    ...entryDecision.metadata,
                    trace: entryDecision.trace
                }
            });
            await this.logEntryIntelligenceDispositionShadow(
                symbol,
                signal,
                'ENTRY_POLICY',
                entryDecision.shouldOpen,
                entryDecision.finalReason,
                entryDecision.deniedBy,
                signalId,
                tradeId
            );

            if (shortGateDecision && !shortGateDecision.allowed && entryDecision.deniedBy === 'short_gate') {
                const deniedGate = { ...gateAfterPositionOverride, allowed: false, reason: shortGateDecision.reason };
                await this.logAegisTurboSignal(symbol, signal, { signalId, tradeId, gate: deniedGate, executed: false });
                await this.logAegisTradeEvent(symbol, 'SHORT_GATE_DENIED', {
                    tradeId,
                    reason: shortGateDecision.reason,
                    metadata: {
                        symbol,
                        score: gate.turboScore,
                        votes: gate.votes,
                        reason: shortGateDecision.reason,
                        canonicalDecisionAuthorized: shortGateDecision.metadata.canonicalDecisionAuthorized,
                        entryPolicy: entryDecision.metadata
                    }
                });
                logger.warn('aegis_short_gate_denied', {
                    symbol,
                    side,
                    reason: shortGateDecision.reason,
                    turboScore: gate.turboScore,
                    votes: gate.votes,
                    metadata: shortGateDecision.metadata
                });
                return;
            }

            if (!entryDecision.shouldOpen && entryDecision.deniedBy === 'regime') {
                const deniedGate = { ...gateAfterPositionOverride, allowed: false, reason: entryDecision.finalReason };
                await this.logAegisTurboSignal(symbol, signal, {
                    signalId,
                    tradeId,
                    gate: deniedGate,
                    executed: false,
                    metadata: { entryPolicy: entryDecision.metadata }
                });
                return;
            }

            if (!entryDecision.shouldOpen && entryDecision.deniedBy === 'long_risk_shadow') {
                const deniedGate = { ...gateAfterPositionOverride, allowed: false, reason: entryDecision.finalReason };
                await this.logAegisTurboSignal(symbol, signal, {
                    signalId,
                    tradeId,
                    gate: deniedGate,
                    executed: false,
                    metadata: { entryPolicy: entryDecision.metadata }
                });
                logger.warn('aegis_long_risk_shadow_blocked_probe_long', {
                    symbol,
                    side,
                    reason: entryDecision.finalReason,
                    metadata: entryDecision.metadata.longRiskShadow
                });
                return;
            }

            const leverage = entryDecision.adjustedLeverage;
            const positionFraction = entryDecision.adjustedPositionFraction;
            const effectiveGate: AegisMicroLiveGateDecision = {
                ...gateAfterPositionOverride,
                leverage,
                positionFraction
            };
            if (leverage <= 0 || positionFraction <= 0) return;

            if (entryQualityDecision) {
                await this.logEntryQualityGateDecision(symbol, side, entryQualityDecision, this.getEntryQualityGateConfig(symbol).mode, tradeId);
            }
            if (entryQualityDecision && !entryQualityDecision.allowed && entryDecision.deniedBy === 'entry_quality') {
                const deniedGate = { ...effectiveGate, allowed: false, reason: entryQualityDecision.reason };
                await this.logAegisTurboSignal(symbol, signal, {
                    signalId,
                    tradeId,
                    gate: deniedGate,
                    executed: false,
                    metadata: { entryPolicy: entryDecision.metadata }
                });
                return;
            }

            if (eventRiskDecision) {
                await this.logAegisEventRiskDecision(symbol, eventRiskDecision, tradeId);
            }
            if (eventRiskDecision && !eventRiskDecision.allowed && entryDecision.deniedBy === 'event_risk') {
                const deniedGate = { ...effectiveGate, allowed: false, reason: eventRiskDecision.reason };
                await this.logAegisTurboSignal(symbol, signal, {
                    signalId,
                    tradeId,
                    gate: deniedGate,
                    executed: false,
                    metadata: {
                        event_risk_mode: eventRiskDecision.mode,
                        event_risk_action: eventRiskDecision.action,
                        entryPolicy: entryDecision.metadata
                    }
                });
                return;
            }

            if (decisionEnforcement && !decisionEnforcement.allowed && entryDecision.deniedBy === 'decision_brain') {
                const deniedGate = { ...effectiveGate, allowed: false, reason: decisionEnforcement.reason };
                await this.logAegisTurboSignal(symbol, signal, {
                    signalId,
                    tradeId,
                    gate: deniedGate,
                    executed: false,
                    metadata: {
                        decision_enforcement_reason: decisionEnforcement.reason,
                        decision_brain_decision: decisionEnforcement.metadata.decisionBrainDecision,
                        entry_quality_recommendation: decisionEnforcement.metadata.entryQualityRecommendation,
                        event_risk_mode: decisionEnforcement.metadata.eventRiskMode,
                        event_risk_reason: decisionEnforcement.metadata.eventRiskReason,
                        event_risk_would_block: decisionEnforcement.metadata.eventRiskWouldBlock,
                        is_a_plus: decisionEnforcement.metadata.aPlus,
                        setup_grade: decisionEnforcement.metadata.setupGrade,
                        entryPolicy: entryDecision.metadata
                    }
                });
                await this.logAegisDecisionEnforcementDenied(symbol, decisionEnforcement, tradeId);
                await this.notifyDecisionEnforcementDenied(symbol, decisionEnforcement);
                if (probeModeDecision) {
                    await this.logAegisProbeModeDecision(symbol, probeModeDecision, tradeId);
                }
                return;
            }

            if (shortGateDecision && side === 'SHORT' && shortGateDecision.reason === 'short_allowed_current_brain_canonical') {
                await this.logAegisTradeEvent(symbol, 'SHORT_GATE_ADJUSTED', {
                    tradeId,
                    reason: shortGateDecision.reason,
                    metadata: {
                        originalLeverage: gateAfterPositionOverride.leverage,
                        adjustedLeverage: leverage,
                        originalPositionFraction: gateAfterPositionOverride.positionFraction,
                        adjustedPositionFraction: positionFraction
                    }
                });
                logger.warn('aegis_short_gate_adjusted', {
                    symbol,
                    originalLeverage: gateAfterPositionOverride.leverage,
                    adjustedLeverage: leverage,
                    originalPositionFraction: gateAfterPositionOverride.positionFraction,
                    adjustedPositionFraction: positionFraction
                });
            }

            if (cleanEntryGuard) {
                await this.logAegisCleanEntryGuardDecision(symbol, cleanEntryGuard, tradeId);
            }
            if (cleanEntryGuard && !cleanEntryGuard.allowed) {
                if (probeModeDecision) {
                    await this.logAegisProbeModeDecision(symbol, probeModeDecision, tradeId);
                }
                logger.info('aegis_clean_entry_guard_wait_confirmation', {
                    symbol,
                    side,
                    reasons: cleanEntryGuard.reasons,
                    metadata: {
                        ...cleanEntryGuard.metadata,
                        probeMode: probeModeDecision?.metadata,
                        entryPolicy: entryDecision.metadata
                    }
                });
                if (!probeModeDecision?.allowed) {
                    const deniedGate = { ...effectiveGate, allowed: false, reason: entryDecision.finalReason };
                    await this.logAegisTurboSignal(symbol, signal, {
                        signalId,
                        tradeId,
                        gate: deniedGate,
                        executed: false,
                        metadata: {
                            cleanEntryGuard: cleanEntryGuard.metadata,
                            clean_entry_guard_decision: cleanEntryGuard.decision,
                            clean_entry_guard_reasons: cleanEntryGuard.reasons,
                            probeMode: probeModeDecision?.metadata,
                            entryPolicy: entryDecision.metadata
                        }
                    });
                    return;
                }
                await this.notifyProbeModeAllowed(symbol, side, probeModeDecision);
            }

            const decisionMetadata = decisionEnforcement?.metadata;
            const cleanEntryMetadata = cleanEntryGuard?.metadata;
            const wallet = await exchange.getUSDTBalance();
            const entryAccount = await this.readEntryAccountSnapshot(wallet);
            const feeBufferPct = configManager.trading?.fee_buffer_pct ?? CONFIG.FEE_BUFFER_PCT ?? 0.05;
            const effectiveWallet = wallet * (1 - feeBufferPct);
            const markPrice = await exchange.getMarkPrice(symbol);
            const filters = await exchange.getSymbolFilters(symbol, leverage);
            const margin = effectiveWallet * positionFraction;
            const notional = margin * leverage;
            const quantity = this.roundQuantity(notional / markPrice, filters);

            const portfolioRiskConfig = this.getAegisPortfolioRiskConfig();
            if (portfolioRiskConfig.enabled === true) {
                const exposure = await this.readAegisPortfolioExposure();
                const portfolioDecision = AegisPortfolioRiskGuard.evaluate({
                    symbol,
                    side,
                    currentOpenPositions: exposure.openPositions,
                    currentLongPositions: exposure.longPositions,
                    currentShortPositions: exposure.shortPositions,
                    walletBalance: entryAccount.walletBalance ?? wallet,
                    equityTotal: entryAccount.equityTotal ?? entryAccount.walletBalance ?? wallet,
                    currentMarginUsed: exposure.marginUsed,
                    currentNotional: exposure.notional,
                    newTradeEstimatedMargin: margin,
                    newTradeEstimatedNotional: notional,
                    config: portfolioRiskConfig
                });
                if (!portfolioDecision.allowed) {
                    const deniedGate = { ...effectiveGate, allowed: false, reason: portfolioDecision.reason };
                    await this.logAegisTurboSignal(symbol, signal, { signalId, tradeId, gate: deniedGate, executed: false });
                    await this.logAegisTradeEvent(symbol, 'PORTFOLIO_RISK_DENIED', {
                        tradeId,
                        reason: portfolioDecision.reason,
                        metadata: {
                            symbol,
                            side,
                            reason: portfolioDecision.reason,
                            openPositions: portfolioDecision.metadata.openPositions,
                            sameDirectionPositions: portfolioDecision.metadata.sameDirectionPositions,
                            marginUsedPct: portfolioDecision.metadata.marginUsedPct,
                            notionalToEquity: portfolioDecision.metadata.notionalToEquity,
                            limits: portfolioDecision.metadata.limits
                        }
                    });
                    logger.warn('aegis_portfolio_risk_denied', {
                        symbol,
                        side,
                        reason: portfolioDecision.reason,
                        metadata: portfolioDecision.metadata
                    });
                    return;
                }
            }

            if (quantity <= 0 || quantity * markPrice < filters.minNotional) {
                logger.warn('aegis_position_too_small', {
                    symbol,
                    quantity,
                    markPrice,
                    notional: quantity * markPrice,
                    minNotional: filters.minNotional
                });
                return;
            }

            await this.logAegisTurboSignal(symbol, signal, {
                signalId,
                tradeId,
                gate: effectiveGate,
                executed: true,
                metadata: {
                    decision_enforcement_reason: decisionEnforcement?.reason,
                    cleanEntryGuard: cleanEntryMetadata,
                    setup_grade: decisionMetadata?.setupGrade,
                    is_a_plus: decisionMetadata?.aPlus,
                    decision_brain_decision: decisionMetadata?.decisionBrainDecision,
                    entry_quality_recommendation: decisionMetadata?.entryQualityRecommendation,
                    event_risk_mode: decisionMetadata?.eventRiskMode,
                    event_risk_reason: decisionMetadata?.eventRiskReason,
                    event_risk_would_block: decisionMetadata?.eventRiskWouldBlock,
                    probeMode: probeModeDecision?.metadata,
                    entryPolicy: entryDecision.metadata
                }
            });
            await this.logAegisTradeEvent(symbol, 'GATE_ALLOWED', {
                tradeId,
                reason: probeModeDecision?.allowed ? 'probe_mode_allowed' : effectiveGate.reason,
                metadata: {
                    side: effectiveGate.side,
                    leverage: effectiveGate.leverage,
                    positionFraction: effectiveGate.positionFraction,
                    stopRoe: effectiveGate.stopRoe,
                    takeProfitRoe: effectiveGate.takeProfitRoe,
                    trailingActivationRoe: effectiveGate.trailingActivationRoe,
                    trailingCallbackRoe: effectiveGate.trailingCallbackRoe,
                    decisionEnforcementReason: decisionEnforcement?.reason,
                    cleanEntryGuard: cleanEntryMetadata,
                    setupGrade: decisionMetadata?.setupGrade,
                    aPlus: decisionMetadata?.aPlus,
                    decisionBrainDecision: decisionMetadata?.decisionBrainDecision,
                    entryQualityRecommendation: decisionMetadata?.entryQualityRecommendation,
                    tailRiskScore: decisionMetadata?.tailRiskScore,
                    eventRiskMode: decisionMetadata?.eventRiskMode,
                    eventRiskReason: decisionMetadata?.eventRiskReason,
                    eventRiskWouldBlock: decisionMetadata?.eventRiskWouldBlock,
                    probeMode: probeModeDecision?.metadata,
                    entryPolicy: entryDecision.metadata
                }
            });

            await exchange.setLeverage(symbol, leverage);
            await exchange.ensureMarginType(symbol, 'ISOLATED');

            await this.logAegisTradeEvent(symbol, 'ORDER_SUBMITTED', {
                tradeId,
                price: markPrice,
                metadata: {
                    side,
                    quantity,
                    leverage,
                    positionFraction,
                    cleanEntryGuard: cleanEntryMetadata,
                    probeMode: probeModeDecision?.metadata,
                    entryPolicy: entryDecision.metadata,
                    marginEstimated: margin,
                    notionalEstimated: notional
                }
            });
            const result = await exchange.marketOpen(symbol, side, quantity);
            opened = true;
            openedSide = side;

            const positionData = await this.confirmAegisPositionWithRetries(symbol, side);
            if (!positionData) {
                logger.error('aegis_position_verify_failed_after_market_open', {
                    symbol,
                    side,
                    quantity,
                    avgPrice: result?.avgPrice,
                    orderId: result?.orderId
                });
                await this.emergencyCloseUnverifiedAegisPosition(symbol, side, quantity, 'AEGIS_POSITION_VERIFY_FAILED', tradeId);
                throw new Error('AEGIS_POSITION_VERIFY_FAILED_AFTER_MARKET_OPEN');
            }
            await this.logAegisTradeEvent(symbol, 'POSITION_CONFIRMED', {
                tradeId,
                price: positionData.entryPrice || result.avgPrice,
                metadata: {
                    side,
                    quantity: positionData.qtyAbs || quantity,
                    sideMode: positionData.sideMode,
                    orderId: result?.orderId
                }
            });

            const entryPrice = positionData.entryPrice || result.avgPrice;
            const marginUsed = positionData.isolatedMargin || margin;
            const stopPrice = this.roundPrice(this.bracketPrice(side, entryPrice, effectiveGate.stopRoe, leverage, 'STOP'), filters);
            const tpPrice = this.roundPrice(this.bracketPrice(side, entryPrice, effectiveGate.takeProfitRoe, leverage, 'TP'), filters);

            const requireBrackets = yaml?.require_brackets !== false;
            const closeIfBracketFails = yaml?.close_if_bracket_fails !== false;
            let slOk = false;
            let tpOk = false;
            try {
                slOk = await exchange.placeStopClose(symbol, side, stopPrice);
                if (requireBrackets && !slOk) throw new Error('AEGIS_STOP_BRACKET_REJECTED');
                tpOk = await exchange.placeTpClose(symbol, side, tpPrice);
                if (requireBrackets && !tpOk) throw new Error('AEGIS_TP_BRACKET_REJECTED');
            } catch (bracketError) {
                logger.error('aegis_bracket_creation_failed', {
                    symbol,
                    side,
                    stopPrice,
                    tpPrice,
                    slOk,
                    tpOk,
                    error: String(bracketError)
                });
                await this.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_ATTEMPT', {
                    tradeId,
                    reason: String(bracketError).includes('TP') ? 'TAKE_PROFIT_BRACKET_FAILED' : 'STOP_BRACKET_FAILED',
                    metadata: { stopPrice, tpPrice, slOk, tpOk, error: String(bracketError) }
                });
                if (closeIfBracketFails) {
                    await exchange.closeSideMarketSafe(symbol, side, positionData.qtyAbs, positionData.sideMode, 'AEGIS_BRACKET_FAILED');
                    await this.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_SUCCESS', {
                        tradeId,
                        reason: 'AEGIS_BRACKET_FAILED',
                        metadata: { stopPrice, tpPrice, slOk, tpOk }
                    });
                    symbolState.set({
                        mode: 'IDLE',
                        lastExitAt: Date.now(),
                        lastExitReason: 'AEGIS_BRACKET_FAILED',
                        lastBracketStatus: 'FAILED_CLOSED'
                    });
                    await notifier.sendMessage(
                        `⚠️ **BRACKET FAILED**\n` +
                        `Symbol: ${symbol}\n` +
                        `Error: ${String(bracketError)}\n` +
                        `ACTION REQUIRED: Check Open Orders!`
                    );
                    return;
                }
                throw bracketError;
            }

            const bracketStatus = requireBrackets
                ? await this.validateAegisBrackets(symbol, side)
                : { hasSL: slOk, hasTP: tpOk };

            if (requireBrackets && (!slOk || !tpOk || !bracketStatus.hasSL || !bracketStatus.hasTP)) {
                logger.error('aegis_bracket_validation_failed', {
                    symbol,
                    side,
                    stopPrice,
                    tpPrice,
                    slOk,
                    tpOk,
                    hasSL: bracketStatus.hasSL,
                    hasTP: bracketStatus.hasTP
                });
                await this.logAegisTradeEvent(symbol, 'BRACKET_MISSING', {
                    tradeId,
                    reason: 'AEGIS_REQUIRED_BRACKETS_MISSING',
                    metadata: { stopPrice, tpPrice, slOk, tpOk, bracketStatus }
                });
                if (closeIfBracketFails) {
                    await exchange.closeSideMarketSafe(symbol, side, positionData.qtyAbs, positionData.sideMode, 'AEGIS_BRACKET_FAILED');
                    await this.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_SUCCESS', {
                        tradeId,
                        reason: 'AEGIS_BRACKET_FAILED',
                        metadata: { stopPrice, tpPrice, slOk, tpOk, bracketStatus }
                    });
                    symbolState.set({
                        mode: 'IDLE',
                        lastExitAt: Date.now(),
                        lastExitReason: 'AEGIS_BRACKET_FAILED',
                        lastBracketStatus: 'FAILED_CLOSED'
                    });
                    await notifier.sendMessage(
                        `⚠️ **BRACKET FAILED**\n` +
                        `Symbol: ${symbol}\n` +
                        `Error: AEGIS_REQUIRED_BRACKETS_MISSING\n` +
                        `ACTION REQUIRED: Check Open Orders!`
                    );
                    return;
                }
                throw new Error('AEGIS_REQUIRED_BRACKETS_MISSING');
            }

            await this.logAegisTradeEvent(symbol, 'BRACKETS_CONFIRMED', {
                tradeId,
                metadata: { stopPrice, tpPrice, slOk, tpOk, bracketStatus }
            });
            const openedAtMs = await exchange.getServerTime();
            const regimeConfig = this.getAegisTurboRegimeConfig(symbol);
            const guardianConfig = this.getAegisGuardianConfig(symbol, regimeConfig);
            const finalStrategyLabel = entryDecision.finalStrategy === 'momentum_ride' ? 'MOMENTUM_RIDE' : 'AEGIS_TURBO';
            symbolState.set({
                mode: side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE',
                lastSide: side,
                lastEntryPrice: entryPrice,
                lastLeverage: leverage,
                lastEntryAt: openedAtMs,
                peakRoe: 0,
                lowestRoe: 0,
                currentRegime: 'AEGIS_TURBO',
                lastStrategy: finalStrategyLabel,
                lastTradeId: tradeId,
                lastPeakPrice: entryPrice,
                lastEntryWallet: wallet,
                lastEntryMargin: marginUsed,
                lastEntryQty: positionData.qtyAbs || quantity,
                lastMlProb: effectiveGate.turboScore,
                lastAegisTurboScore: effectiveGate.turboScore,
                lastAegisRawReason: effectiveGate.rawReason,
                lastAegisGatedReason: effectiveGate.gatedReason,
                lastAegisGatedBlockedBy: effectiveGate.gatedBlockedBy,
                lastStopRoe: effectiveGate.stopRoe,
                lastStopPrice: stopPrice,
                lastBreakEvenRoe: guardianConfig.beTriggerRoe,
                breakEvenArmed: false,
                breakEvenExecuted: false,
                lastBreakEvenStop: undefined,
                lastBreakEvenAt: undefined,
                lastTakeProfitRoe: effectiveGate.takeProfitRoe,
                lastTrailingActivationRoe: effectiveGate.trailingActivationRoe,
                lastTrailingCallbackRoe: effectiveGate.trailingCallbackRoe,
                lastPositionFraction: positionFraction,
                lastRequestedLeverage: effectiveGate.leverage,
                lastActualLeverage: leverage,
                lastBracketStatus: 'OK',
                probeModeActive: probeModeDecision?.allowed === true,
                lastProbeAt: probeModeDecision?.allowed === true ? openedAtMs : symbolState.get().lastProbeAt,
                lastProbeTradeId: probeModeDecision?.allowed === true ? tradeId : symbolState.get().lastProbeTradeId,
                exitEyeNeutralCount: 0,
                exitEyeOppositeCount: 0
            });
            if (probeModeDecision?.allowed) {
                this.recordProbeModeEntry(openedAtMs, tradeId);
            }
            await this.historyLogger.logTradeOpen({
                trade_id: tradeId,
                portfolio_session_id: getPortfolioSessionId(),
                symbol,
                strategy: finalStrategyLabel,
                mode: this.getTradingMode(),
                side,
                opened_at: new Date(openedAtMs).toISOString(),
                entry_price: entryPrice,
                quantity: positionData.qtyAbs || quantity,
                leverage,
                position_fraction: positionFraction,
                margin_estimated: marginUsed,
                notional_estimated: (positionData.qtyAbs || quantity) * entryPrice,
                turbo_score: effectiveGate.turboScore,
                votes: effectiveGate.votes,
                stop_roe: effectiveGate.stopRoe,
                take_profit_roe: effectiveGate.takeProfitRoe,
                trailing_activation_roe: effectiveGate.trailingActivationRoe,
                trailing_callback_roe: effectiveGate.trailingCallbackRoe,
                sl_price: stopPrice,
                tp_price: tpPrice,
                brackets_confirmed: true,
                status: 'OPEN',
                metadata: {
                    rawReason: effectiveGate.rawReason,
                    gatedReason: effectiveGate.gatedReason,
                    gatedBlockedBy: effectiveGate.gatedBlockedBy,
                    originalLeverage: gate.leverage,
                    originalPositionFraction: gate.positionFraction,
                    positionFractionOverride: positionFractionOverride ? {
                        ruleIndex: positionFractionOverride.ruleIndex,
                        ruleName: positionFractionOverride.ruleName,
                        overriddenPositionFraction: positionFractionOverride.positionFraction
                    } : undefined,
                    cleanEntryGuard: cleanEntryMetadata,
                    probeMode: probeModeDecision?.metadata,
                    entryPolicy: entryDecision.metadata,
                    orderId: result?.orderId,
                    estimated: true
                }
            });
            await this.logAegisAccountSnapshot({
                symbol,
                walletBalance: entryAccount.walletBalance ?? wallet,
                availableBalance: entryAccount.availableBalance,
                unrealizedPnl: entryAccount.unrealizedPnlTotal,
                positionOpen: true,
                side,
                entryPrice,
                markPrice,
                marginUsed,
                quantity: positionData.qtyAbs || quantity,
                leverage,
                metadata: { event: 'trade_open', tradeId }
            });

            this.tradesToday++;
            if (phaseOShortLive) this.phaseOShortTradesToday++;
            this.lastEntryBalance = wallet;
            if (wallet > this.peakBalance) this.peakBalance = wallet;

            logger.warn('aegis_turbo_micro_live_entry', {
                symbol,
                side,
                entryPrice,
                quantity: positionData.qtyAbs || quantity,
                margin: marginUsed,
                leverage,
                positionFraction,
                finalStrategy: entryDecision.finalStrategy,
                turboScore: effectiveGate.turboScore,
                votes: effectiveGate.votes,
                rawReason: effectiveGate.rawReason
            });
            logger.info('aegis_turbo_brackets_created', { symbol, side, stopPrice, tpPrice });

            await notifier.sendMessage(
                this.buildAegisEntryMessage({
                    symbol,
                    side,
                    entryPrice,
                    quantity: positionData.qtyAbs || quantity,
                    marginUsed,
                    wallet,
                    account: entryAccount,
                    leverage,
                    stopPrice,
                    tpPrice,
                    gate: effectiveGate,
                    filters
                })
            );
            logger.info('📱 [TELEGRAM_REPORT] AEGIS ENTRY SENT', {
                message: `🔥 AEGIS TURBO ENTRY\n${symbol} | ${side}\n...score: ${this.formatScore(effectiveGate.turboScore)}`
            });
        } catch (error) {
            logger.error('aegis_entry_error_closed', { symbol, error: String(error) });
            if (opened && openedSide) {
                try {
                    const position = await exchange.readActivePosition(symbol, openedSide);
                    if (position) {
                        await exchange.closeSideMarketSafe(symbol, openedSide, position.qtyAbs, position.sideMode, 'AEGIS_ENTRY_ERROR_CLOSED');
                        await this.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_SUCCESS', {
                            tradeId,
                            reason: 'AEGIS_ENTRY_ERROR_CLOSED',
                            metadata: { error: String(error), qtyAbs: position.qtyAbs }
                        });
                        symbolState.set({ mode: 'IDLE', lastExitAt: Date.now(), lastExitReason: 'AEGIS_ENTRY_ERROR_CLOSED', probeModeActive: false });
                        await notifier.sendMessage(
                            `⚠️ **AEGIS ENTRY FAILED**\n` +
                            `Symbol: ${symbol}\n` +
                            `Error: ${String(error).slice(0, 180)}`
                        );
                    }
                } catch (closeError) {
                    logger.error('aegis_entry_error_close_failed', { symbol, error: String(closeError) });
                    await this.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_FAILED', {
                        tradeId,
                        reason: 'AEGIS_ENTRY_ERROR_CLOSED',
                        metadata: { error: String(closeError) }
                    });
                }
            }
        }
    }

    private async confirmAegisPositionWithRetries(
        symbol: string,
        side: Side,
        attempts = 3
    ): Promise<PositionInfo | null> {
        const delays = [300, 500, 1000];
        for (let i = 0; i < attempts; i++) {
            await this.sleep(delays[i] ?? delays[delays.length - 1]);
            this.deps.logger.info('aegis_position_confirm_retry', {
                symbol,
                side,
                attempt: i + 1
            });
            const position = await this.deps.exchange.readActivePosition(symbol, side);
            if (position) return position;
        }
        return null;
    }

    private async emergencyCloseUnverifiedAegisPosition(
        symbol: string,
        side: Side,
        quantity: number,
        reason: string,
        tradeId?: string
    ): Promise<void> {
        const { exchange, logger, notifier } = this.deps;
        logger.error('aegis_emergency_close_attempt', { symbol, side, quantity, reason });
        await this.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_ATTEMPT', {
            tradeId,
            reason,
            metadata: { side, quantity }
        });
        try {
            const position = await exchange.readActivePosition(symbol, side);
            const qtyAbs = position?.qtyAbs ?? quantity;
            const sideMode = position?.sideMode ?? 'BOTH';
            await exchange.closeSideMarketSafe(symbol, side, qtyAbs, sideMode, reason);
            logger.error('aegis_emergency_close_success', { symbol, side, qtyAbs, sideMode, reason });
            await this.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_SUCCESS', {
                tradeId,
                reason,
                metadata: { side, qtyAbs, sideMode }
            });
            await notifier.sendMessage(
                `⚠️ **AEGIS EMERGENCY CLOSE**\n` +
                `Symbol: ${symbol}\n` +
                `Side: ${side}\n` +
                `Reason: ${reason}\n` +
                `Qty: ${qtyAbs}`
            );
        } catch (error) {
            logger.error('aegis_emergency_close_failed', { symbol, side, quantity, reason, error: String(error) });
            await this.logAegisTradeEvent(symbol, 'EMERGENCY_CLOSE_FAILED', {
                tradeId,
                reason,
                metadata: { side, quantity, error: String(error) }
            });
            await notifier.sendMessage(
                `⚠️ **AEGIS EMERGENCY CLOSE FAILED**\n` +
                `Symbol: ${symbol}\n` +
                `Side: ${side}\n` +
                `Reason: ${reason}\n` +
                `Error: ${String(error).slice(0, 180)}`
            );
            throw error;
        }
    }

    private async validateAegisBrackets(symbol: string, side: Side): Promise<{ hasSL: boolean; hasTP: boolean }> {
        const orders = await this.deps.exchange.listCloseOrdersForSide(symbol, side);
        return {
            hasSL: orders.some(order => order.type.includes('STOP')),
            hasTP: orders.some(order => order.type.includes('TAKE_PROFIT'))
        };
    }

    private async getExitEyeSignal(symbol: string): Promise<AegisTradingSignal | null> {
        const cached = this.exitEyeSignalCache.get(symbol);
        const now = Date.now();
        if (cached && now - cached.at < EXIT_EYE_SIGNAL_TTL_MS) {
            return cached.signal;
        }
        try {
            const signal = await this.deps.mlService.getSignal(symbol);
            this.exitEyeSignalCache.set(symbol, { at: now, signal });
            return signal;
        } catch (error) {
            this.deps.logger.warn('aegis_exit_eye_signal_unavailable', { symbol, error: String(error) });
            return null;
        }
    }

    private extractExitEyeSignal(signal: AegisTradingSignal | null): {
        currentTurboAction?: string;
        rawAction?: string;
        gatedAction?: string;
        turboScore?: number;
        votes?: AegisExitEyeVotes;
        reason?: string;
    } {
        const aegis = signal?.metadata?.aegis ?? signal?.aegis;
        const turbo = aegis?.turbo as any;
        const raw = turbo?.raw;
        const gated = turbo?.gated;
        return {
            currentTurboAction: turbo?.action ?? gated?.action ?? raw?.action,
            rawAction: raw?.action,
            gatedAction: gated?.action,
            turboScore: raw?.turbo_score ?? turbo?.turbo_score,
            votes: raw?.votes ?? turbo?.votes,
            reason: gated?.reason ?? raw?.reason ?? turbo?.reason,
        };
    }

    private updateExitEyeCounters(
        side: Side,
        botState: BotState,
        symbolState: StateStore,
        signal: {
            currentTurboAction?: string;
            rawAction?: string;
            gatedAction?: string;
            turboScore?: number;
            votes?: AegisExitEyeVotes;
            reason?: string;
        },
        config: AegisExitEyeYamlConfig
    ): { neutralCount: number; neutralCloseCount: number; oppositeCount: number } {
        const action = String(signal.currentTurboAction || '').toUpperCase();
        const rawAction = String(signal.rawAction || '').toUpperCase();
        const gatedAction = String(signal.gatedAction || '').toUpperCase();
        const votes = signal.votes || {};
        const neutralCondition = action !== side && Number(votes.neutral ?? 0) >= config.neutral_votes_to_protect;
        const neutralCloseCondition = action !== side && Number(votes.neutral ?? 0) >= config.neutral_close_votes;
        const oppositeAction = side === 'LONG' ? 'SHORT' : 'LONG';
        const oppositeVotes = side === 'LONG' ? Number(votes.short ?? 0) : Number(votes.long ?? 0);
        const oppositeCondition = (
            action === oppositeAction
            || rawAction === oppositeAction
            || gatedAction === oppositeAction
        ) && oppositeVotes >= config.opposite_votes_to_close;
        const neutralCount = neutralCondition ? (botState.exitEyeNeutralCount || 0) + 1 : 0;
        const neutralCloseCount = neutralCloseCondition ? (botState.exitEyeNeutralCloseCount || 0) + 1 : 0;
        const oppositeCount = oppositeCondition ? (botState.exitEyeOppositeCount || 0) + 1 : 0;
        symbolState.set({
            exitEyeNeutralCount: neutralCount,
            exitEyeNeutralCloseCount: neutralCloseCount,
            exitEyeOppositeCount: oppositeCount
        });
        return { neutralCount, neutralCloseCount, oppositeCount };
    }

    private async evaluateExitEyeForPosition(input: {
        symbol: string;
        side: Side;
        botState: BotState;
        symbolState: StateStore;
        position: PositionInfo;
        markPrice: number;
        currentRoe: number;
        peakRoe: number;
        lowestRoe: number;
        tradeDurationMs: number;
    }): Promise<boolean> {
        const config = this.getAegisExitEyeConfig();
        const signal = await this.getExitEyeSignal(input.symbol);
        const exitSignal = this.extractExitEyeSignal(signal);
        const signalAegis = signal?.metadata?.aegis ?? signal?.aegis;
        const canonicalDecision = inspectCurrentBrainCanonicalDecision(
            signalAegis,
            input.symbol
        );
        const exitEyeV2Shadow = evaluateAegisExitEyeV2Shadow({
            symbol: input.symbol,
            positionSide: input.side,
            currentRoe: input.currentRoe,
            peakRoe: input.peakRoe,
            canonical: canonicalDecision,
            minimumPeakRoeToStudyProtection: config.min_peak_roe_to_protect,
            minimumGivebackRoeToStudyProtection: config.min_giveback_from_peak_roe
        });
        try {
            await this.logAegisTradeEvent(
                input.symbol,
                'EXIT_EYE_V2_SHADOW_OBSERVATION',
                {
                    tradeId: input.botState.lastTradeId,
                    price: input.markPrice,
                    roe: input.currentRoe,
                    reason: exitEyeV2Shadow.reason,
                    metadata: {
                        ...exitEyeV2Shadow,
                        trailingChanged: false,
                        callbackChanged: false,
                        bracketChanged: false
                    }
                }
            );
        } catch (error) {
            this.deps.logger.warn('aegis_exit_eye_v2_shadow_log_failed', {
                symbol: input.symbol,
                error: String(error)
            });
        }
        if (!config.enabled || config.mode === 'OFF') return false;
        const counters = this.updateExitEyeCounters(input.side, input.botState, input.symbolState, exitSignal, config);
        const decision = evaluateAegisExitEye({
            enabled: config.enabled,
            mode: config.mode,
            symbol: input.symbol,
            positionSide: input.side,
            currentRoe: input.currentRoe,
            peakRoe: input.peakRoe,
            lowestRoe: input.lowestRoe,
            minutesInTrade: input.tradeDurationMs / 60000,
            currentTurboAction: exitSignal.currentTurboAction,
            rawAction: exitSignal.rawAction,
            gatedAction: exitSignal.gatedAction,
            turboScore: exitSignal.turboScore,
            votes: exitSignal.votes,
            entryThreshold: this.getAegisTurboGateConfig(input.symbol).minScore,
            currentReason: exitSignal.reason,
            minRoeToProtect: config.min_roe_to_protect,
            minPeakRoeToProtect: config.min_peak_roe_to_protect,
            minGivebackFromPeakRoe: config.min_giveback_from_peak_roe,
            neutralVotesToProtect: config.neutral_votes_to_protect,
            oppositeVotesToClose: config.opposite_votes_to_close,
            minRoeToCloseOnOpposite: config.min_roe_to_close_on_opposite,
            minPeakRoeToCloseOnOpposite: config.min_peak_roe_to_close_on_opposite,
            closeOnNeutralDecay: config.close_on_neutral_decay,
            neutralCloseVotes: config.neutral_close_votes,
            minRoeToCloseOnNeutral: config.min_roe_to_close_on_neutral,
            minPeakRoeToCloseOnNeutral: config.min_peak_roe_to_close_on_neutral,
            minGivebackToCloseOnNeutral: config.min_giveback_to_close_on_neutral,
            requireConsecutiveNeutralClose: config.require_consecutive_neutral_close,
            requireConsecutiveNeutral: config.require_consecutive_neutral,
            requireConsecutiveOpposite: config.require_consecutive_opposite,
            consecutiveNeutralCount: counters.neutralCount,
            consecutiveNeutralCloseCount: counters.neutralCloseCount,
            consecutiveOppositeCount: counters.oppositeCount,
            minMinutesInTrade: config.min_minutes_in_trade
        });

        if (decision.action === 'NONE') return false;

        await this.handleExitEyeDecision(input, decision);
        return decision.action === 'CLOSE_POSITION' && decision.shouldClose;
    }

    private wouldStopTriggerImmediately(side: Side, stopPrice: number, markPrice: number, bufferPct: number): boolean {
        if (!Number.isFinite(stopPrice) || !Number.isFinite(markPrice) || markPrice <= 0) return true;
        return side === 'LONG'
            ? stopPrice >= markPrice * (1 - bufferPct)
            : stopPrice <= markPrice * (1 + bufferPct);
    }

    private async safeMoveCloseStop(params: {
        symbol: string;
        side: Side;
        tradeId?: string;
        entryPrice: number;
        markPrice: number;
        leverage: number;
        quantity: number;
        position: PositionInfo;
        newStopPrice: number;
        currentRoe: number;
        peakRoe: number;
        protectedRoe?: number;
        reason: SafeStopMoveReason;
    }): Promise<SafeStopMoveResult> {
        const { exchange, logger } = this.deps;
        const profitConfig = this.getAegisProfitProtectionConfig();
        const baseMetadata = {
            symbol: params.symbol,
            side: params.side,
            tradeId: params.tradeId,
            entryPrice: params.entryPrice,
            markPrice: params.markPrice,
            newStopPrice: params.newStopPrice,
            peakRoe: params.peakRoe,
            currentRoe: params.currentRoe,
            protectedRoe: params.protectedRoe,
            reason: params.reason
        };

        const skip = async (
            reason: SafeStopMoveSkipReason,
            oldStopPrice?: number,
            extra: Record<string, unknown> = {}
        ): Promise<SafeStopMoveResult> => {
            const metadata = { ...baseMetadata, oldStopPrice, skipReason: reason, ...extra };
            logger.warn('aegis_safe_stop_move_skipped', metadata);
            await this.logAegisTradeEvent(params.symbol, 'SAFE_STOP_MOVE_SKIPPED', {
                tradeId: params.tradeId,
                price: params.markPrice,
                roe: params.currentRoe,
                oldStop: oldStopPrice,
                newStop: params.newStopPrice,
                reason,
                metadata
            });
            return { moved: false, reason, oldStopPrice, newStopPrice: params.newStopPrice };
        };

        if (!Number.isFinite(params.entryPrice) || params.entryPrice <= 0) {
            return skip('missing_entry');
        }
        if (!Number.isFinite(params.leverage) || params.leverage <= 0) {
            return skip('missing_leverage');
        }
        if (!Number.isFinite(params.quantity) || params.quantity <= 0 || !params.position?.qtyAbs) {
            return skip('missing_quantity');
        }

        const livePosition = await exchange.readActivePosition(params.symbol, params.side);
        if (!livePosition || livePosition.qtyAbs <= 0) {
            return skip('missing_position');
        }

        const beforeOrders = await exchange.listCloseOrdersForSide(params.symbol, params.side);
        const oldStops = beforeOrders.filter((order) => order.type === 'STOP_MARKET' || order.type === 'STOP');
        const oldStopPrice = oldStops.length
            ? (params.side === 'LONG'
                ? Math.max(...oldStops.map((order) => order.stopPrice))
                : Math.min(...oldStops.map((order) => order.stopPrice)))
            : undefined;

        const stopImproved = this.isBetterStop(params.side, params.newStopPrice, oldStopPrice);
        if (!stopImproved) {
            return skip('stop_not_improved', oldStopPrice, { stopImproved });
        }

        const immediateTriggerRisk = this.wouldStopTriggerImmediately(
            params.side,
            params.newStopPrice,
            params.markPrice,
            profitConfig.immediate_trigger_buffer_pct
        );
        if (immediateTriggerRisk) {
            return skip('immediate_trigger_risk', oldStopPrice, { immediateTriggerRisk });
        }

        try {
            await exchange.placeStopClose(params.symbol, params.side, params.newStopPrice, livePosition.qtyAbs);
            for (const stop of oldStops) {
                if (typeof exchange.cancelOrderById === 'function') {
                    await exchange.cancelOrderById(params.symbol, stop.orderId);
                }
            }

            const afterOrders = await exchange.listCloseOrdersForSide(params.symbol, params.side);
            const hasSLAfter = afterOrders.some((order) => order.type === 'STOP_MARKET' || order.type === 'STOP');
            const hasTPAfter = afterOrders.some((order) => order.type === 'TAKE_PROFIT_MARKET' || order.type === 'TAKE_PROFIT');
            if (!hasSLAfter || !hasTPAfter) {
                logger.warn('aegis_safe_stop_move_bracket_verify_warning', {
                    ...baseMetadata,
                    oldStopPrice,
                    hasSLAfter,
                    hasTPAfter
                });
            }

            logger.info('aegis_safe_stop_moved', {
                ...baseMetadata,
                oldStopPrice,
                hasSLAfter,
                hasTPAfter
            });
            await this.logAegisTradeEvent(params.symbol, 'SL_MOVED', {
                tradeId: params.tradeId,
                price: params.markPrice,
                roe: params.currentRoe,
                oldStop: oldStopPrice,
                newStop: params.newStopPrice,
                reason: params.reason,
                metadata: {
                    ...baseMetadata,
                    oldStopPrice,
                    hasSLAfter,
                    hasTPAfter,
                    stopImproved: true,
                    immediateTriggerRisk: false
                }
            });
            return { moved: true, oldStopPrice, newStopPrice: params.newStopPrice, hasSLAfter, hasTPAfter };
        } catch (error) {
            const metadata = { ...baseMetadata, oldStopPrice, error: String(error) };
            logger.error('aegis_safe_stop_move_failed', metadata);
            await this.logAegisTradeEvent(params.symbol, 'SAFE_STOP_MOVE_FAILED', {
                tradeId: params.tradeId,
                price: params.markPrice,
                roe: params.currentRoe,
                oldStop: oldStopPrice,
                newStop: params.newStopPrice,
                reason: 'exchange_error',
                metadata
            });
            return {
                moved: false,
                reason: 'exchange_error',
                oldStopPrice,
                newStopPrice: params.newStopPrice,
                error: String(error)
            };
        }
    }

    private protectedStopPrice(input: {
        side: Side;
        entryPrice: number;
        leverage: number;
        currentRoe: number;
        peakRoe: number;
    }): { protectedRoe: number; stopPrice: number } {
        const config = this.getAegisProfitProtectionConfig();
        const targetProtectedRoe = Math.max(
            config.min_locked_roe,
            input.peakRoe - config.protect_giveback_roe
        );
        const maxSafeRoeAtCurrentPrice = input.currentRoe - (config.immediate_trigger_buffer_pct * input.leverage);
        const protectedRoe = Math.max(
            config.min_locked_roe,
            Math.min(targetProtectedRoe, maxSafeRoeAtCurrentPrice)
        );
        const move = protectedRoe / input.leverage;
        const stopPrice = input.side === 'LONG'
            ? input.entryPrice * (1 + move)
            : input.entryPrice * (1 - move);
        return { protectedRoe, stopPrice };
    }

    private async executeProtectProfitStopMove(input: {
        symbol: string;
        side: Side;
        botState: BotState;
        symbolState: StateStore;
        position: PositionInfo;
        markPrice: number;
        currentRoe: number;
        peakRoe: number;
        decision: AegisExitEyeDecision;
    }): Promise<SafeStopMoveResult> {
        const config = this.getAegisProfitProtectionConfig();
        const entryPrice = input.botState.lastEntryPrice || input.position.entryPrice || 0;
        const leverage = input.botState.lastLeverage || input.position.leverage || this.getAegisTurboGateConfig(input.symbol).leverageCap;
        const filters = await this.deps.exchange.getSymbolFilters(input.symbol, leverage);
        const tradeId = input.botState.lastTradeId;

        if (!config.enabled || !config.protect_profit_enabled || input.peakRoe < config.min_peak_roe_to_protect) {
            const result: SafeStopMoveResult = {
                moved: false,
                reason: 'stop_not_improved',
                newStopPrice: input.botState.lastStopPrice || 0
            };
            await this.logAegisTradeEvent(input.symbol, 'PROTECT_PROFIT_SKIPPED', {
                tradeId,
                price: input.markPrice,
                roe: input.currentRoe,
                reason: 'profit_protection_disabled_or_peak_too_low',
                metadata: {
                    symbol: input.symbol,
                    side: input.side,
                    currentRoe: input.currentRoe,
                    peakRoe: input.peakRoe,
                    enabled: config.enabled,
                    protectProfitEnabled: config.protect_profit_enabled,
                    minPeakRoeToProtect: config.min_peak_roe_to_protect
                }
            });
            return result;
        }

        const protectedStop = this.protectedStopPrice({
            side: input.side,
            entryPrice,
            leverage,
            currentRoe: input.currentRoe,
            peakRoe: input.peakRoe
        });
        let newStopPrice = this.roundPrice(protectedStop.stopPrice, filters);
        const buffer = config.immediate_trigger_buffer_pct;
        const tickSize = filters.tickSize > 0 ? filters.tickSize : 10 ** -filters.pricePrecision;
        if (input.side === 'LONG') {
            const maxSafeStop = input.markPrice * (1 - buffer);
            if (newStopPrice >= maxSafeStop) {
                newStopPrice = this.roundPrice(maxSafeStop - tickSize, filters);
            }
        } else {
            const minSafeStop = input.markPrice * (1 + buffer);
            if (newStopPrice <= minSafeStop) {
                newStopPrice = this.roundPrice(minSafeStop + tickSize, filters);
            }
        }
        const actualProtectedRoe = input.side === 'LONG'
            ? ((newStopPrice - entryPrice) / entryPrice) * leverage
            : ((entryPrice - newStopPrice) / entryPrice) * leverage;
        const result = await this.safeMoveCloseStop({
            symbol: input.symbol,
            side: input.side,
            tradeId,
            entryPrice,
            markPrice: input.markPrice,
            leverage,
            quantity: input.position.qtyAbs,
            position: input.position,
            newStopPrice,
            currentRoe: input.currentRoe,
            peakRoe: input.peakRoe,
            protectedRoe: actualProtectedRoe,
            reason: 'PROTECT_PROFIT'
        });

        if (result.moved) {
            input.symbolState.set({
                lastTrailStop: result.newStopPrice,
                lastStopPrice: result.newStopPrice,
                lastExitEyeAction: input.decision.action,
                lastExitEyeReason: input.decision.reason,
                lastExitEyeAt: Date.now()
            });
            await this.logAegisTradeEvent(input.symbol, 'AEGIS_EXIT_EYE_PROTECT_PROFIT_EXECUTED', {
                tradeId,
                price: input.markPrice,
                roe: input.currentRoe,
                oldStop: result.oldStopPrice,
                newStop: result.newStopPrice,
                reason: input.decision.reason,
                metadata: {
                    protectedRoe: actualProtectedRoe,
                    peakRoe: input.peakRoe,
                    currentRoe: input.currentRoe,
                    oldStopPrice: result.oldStopPrice,
                    newStopPrice: result.newStopPrice
                }
            });
            await this.logAegisTradeEvent(input.symbol, 'PROTECT_PROFIT_EXECUTED', {
                tradeId,
                price: input.markPrice,
                roe: input.currentRoe,
                oldStop: result.oldStopPrice,
                newStop: result.newStopPrice,
                reason: input.decision.reason,
                metadata: {
                    protectedRoe: actualProtectedRoe,
                    peakRoe: input.peakRoe,
                    currentRoe: input.currentRoe,
                    oldStopPrice: result.oldStopPrice,
                    newStopPrice: result.newStopPrice
                }
            });
            await this.logAegisTradeEvent(input.symbol, 'PROTECT_PROFIT_STOP_MOVED', {
                tradeId,
                price: input.markPrice,
                roe: input.currentRoe,
                oldStop: result.oldStopPrice,
                newStop: result.newStopPrice,
                reason: 'PROTECT_PROFIT',
                metadata: {
                    protectedRoe: actualProtectedRoe,
                    peakRoe: input.peakRoe,
                    currentRoe: input.currentRoe
                }
            });
            await this.deps.notifier.sendMessage(
                `🛡️ **Ganancia protegida**\n` +
                `${input.symbol} ${input.side}\n` +
                `Peak: ${this.formatRoe(input.peakRoe)}\n` +
                `Actual: ${this.formatRoe(input.currentRoe)}\n` +
                `SL movido a: $${result.newStopPrice}\n` +
                `Ganancia protegida aprox: ${this.formatRoe(actualProtectedRoe)}`
            );
        } else {
            await this.logAegisTradeEvent(input.symbol, 'AEGIS_EXIT_EYE_PROTECT_PROFIT_SKIPPED', {
                tradeId,
                price: input.markPrice,
                roe: input.currentRoe,
                oldStop: result.oldStopPrice,
                newStop: result.newStopPrice,
                reason: result.reason,
                metadata: {
                    protectedRoe: actualProtectedRoe,
                    peakRoe: input.peakRoe,
                    currentRoe: input.currentRoe,
                    error: result.error
                }
            });
            await this.logAegisTradeEvent(input.symbol, 'PROTECT_PROFIT_SKIPPED', {
                tradeId,
                price: input.markPrice,
                roe: input.currentRoe,
                oldStop: result.oldStopPrice,
                newStop: result.newStopPrice,
                reason: result.reason,
                metadata: {
                    protectedRoe: actualProtectedRoe,
                    peakRoe: input.peakRoe,
                    currentRoe: input.currentRoe,
                    error: result.error
                }
            });
            if (result.reason === 'exchange_error') {
                await this.deps.notifier.sendAlert(
                    'AEGIS PROTECT PROFIT FAILED',
                    `${input.symbol} ${input.side}\nSL protegido: ${result.newStopPrice}\n${String(result.error || '').slice(0, 180)}`
                );
            }
        }

        return result;
    }

    private async handleExitEyeDecision(input: {
        symbol: string;
        side: Side;
        botState: BotState;
        symbolState: StateStore;
        position: PositionInfo;
        markPrice: number;
        currentRoe: number;
        peakRoe: number;
        lowestRoe: number;
    }, decision: AegisExitEyeDecision): Promise<void> {
        const event = this.exitEyeEventName(decision.action);
        const metadata = {
            decision,
            currentRoe: input.currentRoe,
            peakRoe: input.peakRoe,
            givebackRoe: decision.metadata.givebackRoe,
            currentTurboAction: decision.metadata.currentTurboAction,
            rawAction: decision.metadata.rawAction,
            gatedAction: decision.metadata.gatedAction,
            turboScore: decision.metadata.turboScore,
            votes: decision.metadata.votes,
            reason: decision.reason
        };
        input.symbolState.set({
            lastExitEyeAction: decision.action,
            lastExitEyeReason: decision.reason,
            lastExitEyeAt: Date.now()
        });
        await this.logAegisTradeEvent(input.symbol, event, {
            tradeId: input.botState.lastTradeId,
            price: input.markPrice,
            roe: input.currentRoe,
            reason: decision.reason,
            metadata
        });
        const logPayload = {
            symbol: input.symbol,
            side: input.side,
            action: decision.action,
            shouldClose: decision.shouldClose,
            shouldProtect: decision.shouldProtect,
            reason: decision.reason,
            currentRoe: input.currentRoe,
            peakRoe: input.peakRoe,
            givebackRoe: decision.metadata.givebackRoe,
            mode: this.getAegisExitEyeConfig().mode
        };
        if (decision.action === 'CLOSE_POSITION') {
            this.deps.logger.warn('aegis_exit_eye_decision', logPayload);
        } else {
            this.deps.logger.info('aegis_exit_eye_decision', logPayload);
        }

        if (decision.action === 'PROTECT_PROFIT' && decision.shouldProtect) {
            await this.executeProtectProfitStopMove({
                ...input,
                decision
            });
            return;
        }

        if (decision.action === 'CLOSE_POSITION' && decision.shouldClose && input.currentRoe > 0) {
            const exitReason = decision.reason === 'neutral_momentum_decay_profit_exit'
                ? 'AEGIS_EXIT_EYE_NEUTRAL_DECAY'
                : 'AEGIS_EXIT_EYE_OPPOSITE_SIGNAL';
            await this.deps.exchange.closeSideMarketSafe(
                input.symbol,
                input.side,
                input.position.qtyAbs,
                input.position.sideMode,
                exitReason
            );
            input.symbolState.set({
                mode: 'IDLE',
                lastExitAt: Date.now(),
                lastExitReason: exitReason
            });
            const pnl = this.pnlFromRoe(this.entryMargin(input.botState), input.currentRoe);
            await this.notifyExit(input.symbol, input.side, exitReason, input.botState, {
                exitPrice: input.markPrice,
                finalRoe: input.currentRoe,
                pnl
            });
            await this.sendExitEyeTelegram(input.symbol, input.side, decision, true);
            return;
        }

        await this.sendExitEyeTelegram(input.symbol, input.side, decision, false, input.symbolState);
    }

    private exitEyeEventName(action: AegisExitEyeDecision['action']): string {
        return `AEGIS_EXIT_EYE_${action}`;
    }

    private async sendExitEyeTelegram(
        symbol: string,
        side: Side,
        decision: AegisExitEyeDecision,
        force: boolean,
        symbolState?: StateStore
    ): Promise<void> {
        const state = symbolState?.get();
        const now = Date.now();
        if (!force && state?.lastExitEyeTelegramAt && now - state.lastExitEyeTelegramAt < EXIT_EYE_SHADOW_ALERT_COOLDOWN_MS) {
            return;
        }
        if (symbolState) symbolState.set({ lastExitEyeTelegramAt: now });
        const votes = decision.metadata.votes || {};
        if (force && decision.reason === 'neutral_momentum_decay_profit_exit') {
            await this.deps.notifier.sendMessage(
                `👁️ **AEGIS EXIT EYE**\n` +
                `${symbol} ${side} ${side === 'LONG' ? '📈' : '📉'}\n` +
                `Cierre por pérdida de momentum\n` +
                `ROE: ${this.formatRoe(decision.metadata.currentRoe)} | Peak: ${this.formatRoe(decision.metadata.peakRoe)}\n` +
                `Señal actual: ${decision.metadata.currentTurboAction ?? 'N/D'} | Votes L=${votes.long ?? 0} S=${votes.short ?? 0} N=${votes.neutral ?? 0}\n` +
                `Motivo: neutralidad fuerte + devolución de profit`
            );
            return;
        }
        const suggested = decision.action.includes('CLOSE') ? 'CERRAR' : 'PROTEGER GANANCIA';
        const modeLine = force ? 'CLOSE ejecutado' : `Modo: ${this.getAegisExitEyeConfig().mode}, no se cerró`;
        await this.deps.notifier.sendMessage(
            `👁️ **AEGIS EXIT EYE**\n` +
            `${symbol} ${side} ${side === 'LONG' ? '📈' : '📉'}\n` +
            `Acción sugerida: ${suggested}\n` +
            `ROE actual: ${this.formatRoe(decision.metadata.currentRoe)} | Peak: ${this.formatRoe(decision.metadata.peakRoe)}\n` +
            `Señal actual: ${decision.metadata.currentTurboAction ?? 'N/D'} | Votes L=${votes.long ?? 0} S=${votes.short ?? 0} N=${votes.neutral ?? 0}\n` +
            `Motivo: ${decision.reason}\n` +
            modeLine
        );
    }

    private async managePosition(symbol: string, botState: BotState, symbolState: StateStore): Promise<void> {
        const { exchange, logger, notifier } = this.deps;
        const side = botState.lastSide as Side;
        const entryPrice = botState.lastEntryPrice || 0;
        const leverage = botState.lastLeverage || this.getAegisTurboGateConfig(symbol).leverageCap;

        try {
            const position = await exchange.readActivePosition(symbol, side);
            if (!position) {
                const balance = await exchange.getUSDTBalance();
                const markPrice = await exchange.getMarkPrice(symbol);
                const finalRoe = this.calculateRoe(side, botState.lastEntryPrice || markPrice, markPrice, leverage);
                const pnl = this.pnlFromRoe(this.entryMargin(botState), finalRoe);
                logger.info('aegis_position_closed', {
                    symbol,
                    pnl: pnl.toFixed(2),
                    balance: balance.toFixed(2),
                    consecutiveLosses: this.consecutiveLossTracker.value
                });
                await this.notifyExit(symbol, side, 'SL/TP', botState, { exitPrice: markPrice, finalRoe, pnl });
                symbolState.set({
                    mode: 'IDLE',
                    lastExitAt: Date.now(),
                    lastExitReason: pnl < 0 ? 'STOP_LOSS' : 'SL/TP',
                    lastStopLossAt: pnl < 0 ? Date.now() : botState.lastStopLossAt,
                    probeModeActive: false
                });
                return;
            }

            if (this.getAegisTurboYamlConfig()?.require_brackets !== false) {
                try {
                    await this.ensureAegisBrackets(symbol, side, entryPrice, leverage, position, botState);
                } catch (bracketError) {
                    logger.error('aegis_bracket_recreate_failed', { symbol, side, error: String(bracketError) });
                    await notifier.sendAlert(
                        'AEGIS BRACKET RECREATE FAILED',
                        `${symbol} | ${side}\n${String(bracketError).slice(0, 180)}`
                    );
                }
            }

            const markPrice = await exchange.getMarkPrice(symbol);
            const candle = await exchange.getLastCandle(symbol);
            let peakPrice = botState.lastPeakPrice || entryPrice;
            if (candle) {
                peakPrice = side === 'SHORT' ? Math.min(peakPrice, candle.low) : Math.max(peakPrice, candle.high);
            }
            if (peakPrice !== botState.lastPeakPrice) symbolState.set({ lastPeakPrice: peakPrice });

            const currentRoe = side === 'SHORT'
                ? (entryPrice - markPrice) / entryPrice * leverage
                : (markPrice - entryPrice) / entryPrice * leverage;
            const updatedPeakRoe = Math.max(botState.peakRoe || 0, currentRoe);
            const updatedLowestRoe = Math.min(botState.lowestRoe || 0, currentRoe);
            if (updatedPeakRoe !== botState.peakRoe || updatedLowestRoe !== botState.lowestRoe) {
                symbolState.set({ peakRoe: updatedPeakRoe, lowestRoe: updatedLowestRoe });
            }

            const serverNow = await exchange.getServerTime();
            const tradeDuration = botState.lastEntryAt ? serverNow - botState.lastEntryAt : 0;
            const regimeConfig = this.getAegisTurboRegimeConfig(symbol);
            const exitEyeClosed = await this.evaluateExitEyeForPosition({
                symbol,
                side,
                botState: symbolState.get(),
                symbolState,
                position,
                markPrice,
                currentRoe,
                peakRoe: updatedPeakRoe,
                lowestRoe: updatedLowestRoe,
                tradeDurationMs: tradeDuration
            });
            if (exitEyeClosed) return;

            const maxHoldMs = regimeConfig?.maxHoldMs ?? DEFAULT_AEGIS_MAX_HOLD_MS;
            if (tradeDuration > maxHoldMs && currentRoe > 0.02) {
                await exchange.closeSideMarketSafe(symbol, side, position.qtyAbs, position.sideMode, 'AEGIS_TIME_LIMIT');
                symbolState.set({ mode: 'IDLE', lastExitAt: Date.now(), lastExitReason: 'AEGIS_TIME_LIMIT', probeModeActive: false });
                const pnl = this.pnlFromRoe(this.entryMargin(botState), currentRoe);
                await this.notifyExit(symbol, side, 'TIME_LIMIT', botState, { exitPrice: markPrice, finalRoe: currentRoe, pnl });
                return;
            }

            const now = Date.now();
            let currentAtr = botState.lastAtrValue;
            if (now - (botState.lastAtrFetchedAt || 0) > 60000) {
                try {
                    const klines = await exchange.getCandles(symbol, '5m', 15);
                    const atr = calculateATR(klines, 14);
                    if (atr) {
                        currentAtr = atr;
                        symbolState.set({ lastAtrFetchedAt: now, lastAtrValue: atr });
                    }
                } catch { }
            }

            const baseGuardianConfig = this.getAegisGuardianConfig(symbol, regimeConfig);
            const guardianConfig: GuardianConfig = {
                ...baseGuardianConfig,
                beTriggerRoe: botState.lastBreakEvenRoe
                    ?? baseGuardianConfig.beTriggerRoe
                    ?? DEFAULT_GUARDIAN_CONFIG.beTriggerRoe,
                trailingActivationRoe: botState.lastTrailingActivationRoe
                    ?? baseGuardianConfig.trailingActivationRoe
                    ?? 0.15,
                trailingCallbackRoe: botState.lastTrailingCallbackRoe
                    ?? baseGuardianConfig.trailingCallbackRoe
                    ?? 0.08,
                useAtrTrailing: true,
                atrMultiplier: 1.5
            };
            const previousPeakRoe = botState.peakRoe ?? 0;
            if (previousPeakRoe < guardianConfig.beTriggerRoe && updatedPeakRoe >= guardianConfig.beTriggerRoe) {
                symbolState.set({
                    breakEvenArmed: true,
                    lastBreakEvenRoe: guardianConfig.beTriggerRoe
                });
                await this.logAegisTradeEvent(symbol, 'BREAK_EVEN_ARMED', {
                    tradeId: botState.lastTradeId,
                    price: markPrice,
                    roe: currentRoe,
                    metadata: { peakRoe: updatedPeakRoe, beRoe: guardianConfig.beTriggerRoe }
                });
            }
            if (
                guardianConfig.trailingActivationRoe !== undefined
                && previousPeakRoe < guardianConfig.trailingActivationRoe
                && updatedPeakRoe >= guardianConfig.trailingActivationRoe
            ) {
                await this.logAegisTradeEvent(symbol, 'TRAILING_ACTIVATED', {
                    tradeId: botState.lastTradeId,
                    price: markPrice,
                    roe: currentRoe,
                    metadata: { peakRoe: updatedPeakRoe }
                });
            }
            const action = evaluateGuardianAction({
                entryPrice,
                currentPrice: markPrice,
                peakPrice,
                positionSide: side,
                leverage,
                peakRoe: updatedPeakRoe,
                atrValue: currentAtr
            }, guardianConfig, botState.lastTrailStop ?? botState.lastBreakEvenStop ?? botState.lastStopPrice);

            if (action.type === 'MOVE_SL_BE' && action.price) {
                const filters = await exchange.getSymbolFilters(symbol, leverage);
                const breakEvenPrice = this.roundPrice(action.price, filters);
                const existingStop = botState.lastTrailStop ?? botState.lastBreakEvenStop ?? botState.lastStopPrice;
                const shouldMoveBreakEven = !botState.breakEvenExecuted && this.isBetterStop(side, breakEvenPrice, existingStop);
                if (shouldMoveBreakEven) {
                    const moveResult = await this.safeMoveCloseStop({
                        symbol,
                        side,
                        tradeId: botState.lastTradeId,
                        entryPrice,
                        markPrice,
                        leverage,
                        quantity: position.qtyAbs,
                        position,
                        newStopPrice: breakEvenPrice,
                        currentRoe,
                        peakRoe: updatedPeakRoe,
                        protectedRoe: guardianConfig.beTriggerRoe,
                        reason: 'MOVE_SL_BE'
                    });
                    if (moveResult.moved) {
                        symbolState.set({
                            breakEvenArmed: true,
                            breakEvenExecuted: true,
                            lastBreakEvenAt: Date.now(),
                            lastBreakEvenRoe: guardianConfig.beTriggerRoe,
                            lastBreakEvenStop: breakEvenPrice,
                            lastTrailStop: breakEvenPrice,
                            lastStopPrice: breakEvenPrice
                        });
                        logger.info('aegis_break_even_stop_moved', {
                            symbol,
                            side,
                            entryPrice,
                            oldStopPrice: moveResult.oldStopPrice ?? existingStop,
                            newStopPrice: breakEvenPrice,
                            currentRoe,
                            peakRoe: updatedPeakRoe,
                            beRoe: guardianConfig.beTriggerRoe
                        });
                        await this.logAegisTradeEvent(symbol, 'BREAK_EVEN_EXECUTED', {
                            tradeId: botState.lastTradeId,
                            price: markPrice,
                            roe: currentRoe,
                            oldStop: moveResult.oldStopPrice ?? existingStop,
                            newStop: breakEvenPrice,
                            reason: 'MOVE_SL_BE',
                            metadata: {
                                symbol,
                                side,
                                entryPrice,
                                oldStopPrice: moveResult.oldStopPrice ?? existingStop,
                                newStopPrice: breakEvenPrice,
                                currentRoe,
                                peakRoe: updatedPeakRoe,
                                beRoe: guardianConfig.beTriggerRoe,
                                reason: 'MOVE_SL_BE'
                            }
                        });
                        await notifier.sendMessage(
                            `🟢 **BREAK-EVEN ACTIVADO**\n` +
                            `${symbol} ${side}\n` +
                            `SL movido a BE: $${breakEvenPrice}\n` +
                            `ROE: ${this.formatRoe(currentRoe)}`
                        );
                    } else if (moveResult.reason === 'exchange_error') {
                        logger.error('aegis_break_even_stop_move_failed', {
                            symbol,
                            side,
                            entryPrice,
                            attemptedStopPrice: breakEvenPrice,
                            currentRoe,
                            peakRoe: updatedPeakRoe,
                            beRoe: guardianConfig.beTriggerRoe,
                            error: moveResult.error
                        });
                        await this.logAegisTradeEvent(symbol, 'BREAK_EVEN_FAILED', {
                            tradeId: botState.lastTradeId,
                            price: markPrice,
                            roe: currentRoe,
                            oldStop: moveResult.oldStopPrice ?? existingStop,
                            newStop: breakEvenPrice,
                            reason: 'MOVE_SL_BE_FAILED',
                            metadata: {
                                symbol,
                                side,
                                entryPrice,
                                oldStopPrice: moveResult.oldStopPrice ?? existingStop,
                                newStopPrice: breakEvenPrice,
                                currentRoe,
                                peakRoe: updatedPeakRoe,
                                beRoe: guardianConfig.beTriggerRoe,
                                error: moveResult.error
                            }
                        });
                        await notifier.sendAlert(
                            'AEGIS BREAK-EVEN FAILED',
                            `${symbol} ${side}\nSL BE: ${breakEvenPrice}\n${String(moveResult.error || '').slice(0, 180)}`
                        );
                    }
                }
            } else if (action.type === 'MOVE_SL_TRAILING' && action.price) {
                const filters = await exchange.getSymbolFilters(symbol, leverage);
                const trailingPrice = this.roundPrice(action.price, filters);
                if (this.isBetterStop(side, trailingPrice, botState.lastTrailStop)) {
                    if (typeof (exchange as any).cancelStopOrdersForSide === 'function') {
                        await (exchange as any).cancelStopOrdersForSide(symbol, side);
                    }
                    await exchange.placeStopClose(symbol, side, trailingPrice);
                    symbolState.set({ lastTrailStop: trailingPrice, lastStopPrice: trailingPrice });
                    logger.info('aegis_trailing_stop_updated', { symbol, side, trailingPrice });
                    await this.logAegisTradeEvent(symbol, 'SL_MOVED', {
                        tradeId: botState.lastTradeId,
                        price: markPrice,
                        roe: currentRoe,
                        oldStop: botState.lastTrailStop,
                        newStop: trailingPrice,
                        reason: 'MOVE_SL_TRAILING'
                    });
                }
            } else if (action.type === 'CLOSE_MARKET') {
                await exchange.closeSideMarketSafe(symbol, side, position.qtyAbs, position.sideMode, action.reason);
                symbolState.set({ mode: 'IDLE', lastExitAt: Date.now(), lastExitReason: action.reason, probeModeActive: false });
                const pnl = this.pnlFromRoe(this.entryMargin(botState), currentRoe);
                await this.notifyExit(symbol, side, action.reason, botState, { exitPrice: markPrice, finalRoe: currentRoe, pnl });
            }
        } catch (error) {
            logger.warn('Aegis management error', { symbol, error: String(error) });
        }
    }

    private async notifyExit(
        symbol: string,
        side: Side,
        reason: string,
        botState: BotState,
        exit?: { exitPrice?: number; finalRoe?: number; pnl?: number }
    ): Promise<void> {
        const { exchange, notifier, logger } = this.deps;
        const entryPrice = botState.lastEntryPrice || 0;
        const leverage = botState.lastLeverage || botState.lastActualLeverage || this.getAegisTurboGateConfig(symbol).leverageCap;
        const exitPrice = exit?.exitPrice ?? await exchange.getMarkPrice(symbol);
        const finalRoe = exit?.finalRoe ?? this.calculateRoe(side, entryPrice || exitPrice, exitPrice, leverage);
        const pnl = exit?.pnl ?? this.pnlFromRoe(this.entryMargin(botState), finalRoe);
        const durationMs = Date.now() - (botState.lastEntryAt || Date.now());
        const durationHrs = (durationMs / 3600000).toFixed(2);
        const exitType = this.describeAegisExit(reason, pnl, botState, side, exitPrice);
        const margin = this.entryMargin(botState);
        const pnlStr = this.formatSignedUsd(pnl);
        const tradeId = botState.lastTradeId ?? generateTradeId(symbol, new Date(botState.lastEntryAt ?? Date.now()));
        const durationMinutes = durationMs / 60000;

        await this.historyLogger.logTradeClose({
            trade_id: tradeId,
            portfolio_session_id: getPortfolioSessionId(),
            symbol,
            strategy: 'AEGIS_TURBO',
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
                estimated: true,
                exit_type: exitType.canonicalExitType,
                canonical_exit_type: exitType.canonicalExitType,
                display_exit_label: exitType.displayExitLabel,
                reason_detail: exitType.reason,
                exit_reason_label_mismatch: exitType.labelMismatch,
                mismatch_reason: exitType.mismatchReason
            }
        });
        const streakUpdate = this.consecutiveLossTracker.record(tradeId, pnl);
        if (streakUpdate.applied) {
            logger.info('aegis_consecutive_loss_streak_updated', {
                symbol,
                tradeId,
                reason,
                outcome: pnl < 0 ? 'LOSS' : 'NON_LOSS',
                previous: streakUpdate.previous,
                current: streakUpdate.current
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
                exitType: exitType.canonicalExitType,
                canonicalExitType: exitType.canonicalExitType,
                displayExitLabel: exitType.displayExitLabel,
                exitReasonLabelMismatch: exitType.labelMismatch,
                mismatchReason: exitType.mismatchReason
            }
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
            metadata: { event: 'trade_close', tradeId, exitReason: reason }
        });

        await notifier.sendMessage(
            `${exitType.emoji} **${exitType.title}**\n` +
            `${symbol} | ${side}\n` +
            `Entrada: $${entryPrice.toFixed(2)} → Salida: $${exitPrice.toFixed(2)}\n` +
            `ROE Final: **${this.formatRoe(finalRoe)}**\n` +
            `PnL: **${pnlStr}**\n` +
            `Margen: **$${margin.toFixed(2)} USDT**\n` +
            `Duración: ${durationHrs}h\n` +
            `MFE Pico: ${this.formatRoe(botState.peakRoe || 0)}\n` +
            `MAE: ${this.formatRoe(botState.lowestRoe || 0)}\n` +
            `Balance: **$${currentBalance.toFixed(2)}**\n` +
            `Razón: ${exitType.reason}`
        );
        logger.info('📱 [TELEGRAM_REPORT] AEGIS EXIT SENT', {
            message: `${exitType.emoji} **${exitType.title}** PnL: ${pnlStr} ROE: ${this.formatRoe(finalRoe)}`
        });
    }

    private async restoreConsecutiveLossState(): Promise<void> {
        try {
            const outcomes = await (
                this.deps.closedTradeOutcomeReader?.()
                ?? readAegisClosedTradeOutcomes(undefined, this.getTradingMode())
            );
            this.consecutiveLossTracker.restore(outcomes);
            this.deps.logger.info('aegis_consecutive_loss_streak_restored', {
                consecutiveLosses: this.consecutiveLossTracker.value,
                processedClosedTrades: this.consecutiveLossTracker.processedCount
            });
        } catch (error) {
            this.deps.logger.error('aegis_consecutive_loss_streak_recovery_failed', { error: String(error) });
            throw new Error('AEGIS_CONSECUTIVE_LOSS_RECOVERY_FAILED');
        }
    }

    private async ensureAegisBrackets(
        symbol: string,
        side: Side,
        entryPrice: number,
        leverage: number,
        position: PositionInfo,
        botState: BotState
    ): Promise<void> {
        const { exchange, logger } = this.deps;
        const openOrders = await exchange.listCloseOrdersForSide(symbol, side);
        const hasSL = openOrders.some(order => order.type.includes('STOP'));
        const hasTP = openOrders.some(order => order.type.includes('TAKE_PROFIT'));
        if (hasSL && hasTP) return;
        await this.logAegisTradeEvent(symbol, 'BRACKET_MISSING', {
            tradeId: botState.lastTradeId,
            reason: !hasSL && !hasTP ? 'SL_AND_TP_MISSING' : !hasSL ? 'SL_MISSING' : 'TP_MISSING',
            metadata: { hasSL, hasTP }
        });

        const filters = await exchange.getSymbolFilters(symbol, leverage);
        const regimeConfig = this.getAegisTurboRegimeConfig(symbol);
        if (!hasSL) {
            const stopPrice = this.roundPrice(
                this.bracketPrice(
                    side,
                    entryPrice,
                    botState.lastStopRoe ?? regimeConfig?.hardStopRoe ?? -0.15,
                    leverage,
                    'STOP'
                ),
                filters
            );
            await exchange.placeStopClose(symbol, side, stopPrice);
            logger.info('aegis_turbo_brackets_created', { symbol, side, stopPrice, recreated: true });
            await this.logAegisTradeEvent(symbol, 'BRACKET_RECREATED', {
                tradeId: botState.lastTradeId,
                newStop: stopPrice,
                reason: 'SL_RECREATED'
            });
        }
        if (!hasTP) {
            const tpPrice = this.roundPrice(
                this.bracketPrice(
                    side,
                    entryPrice,
                    botState.lastTakeProfitRoe ?? regimeConfig?.tpRoe ?? 0.25,
                    leverage,
                    'TP'
                ),
                filters
            );
            await exchange.placeTpClose(symbol, side, tpPrice);
            logger.info('aegis_turbo_brackets_created', { symbol, side, tpPrice, recreated: true });
            await this.logAegisTradeEvent(symbol, 'BRACKET_RECREATED', {
                tradeId: botState.lastTradeId,
                newTp: tpPrice,
                reason: 'TP_RECREATED'
            });
        }
    }

    private bracketPrice(side: Side, entryPrice: number, roe: number, leverage: number, kind: 'STOP' | 'TP'): number {
        const move = Math.abs(roe) / leverage;
        if (kind === 'STOP') {
            return side === 'LONG' ? entryPrice * (1 - move) : entryPrice * (1 + move);
        }
        return side === 'LONG' ? entryPrice * (1 + move) : entryPrice * (1 - move);
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
        const { symbol, side, entryPrice, quantity, marginUsed, wallet, account, leverage, stopPrice, tpPrice, gate, filters } = input;
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
            quantityPrecision: filters?.qtyPrecision
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
                equityTotal: this.finiteOrUndefined(snapshot.equityTotal)
            };
        } catch (error) {
            this.deps.logger.warn('aegis_entry_account_snapshot_unavailable', { error: String(error) });
            return walletFallback !== undefined ? { walletBalance: walletFallback } : {};
        }
    }

    private finiteOrUndefined(value: unknown): number | undefined {
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    }

    private calculateRoe(side: Side, entryPrice: number, markPrice: number, leverage: number): number {
        if (entryPrice <= 0 || leverage <= 0) return 0;
        return side === 'SHORT'
            ? (entryPrice - markPrice) / entryPrice * leverage
            : (markPrice - entryPrice) / entryPrice * leverage;
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

    private formatScore(value?: number): string {
        const score = typeof value === 'number' && Number.isFinite(value) ? value : 0;
        return `${(score * 100).toFixed(1)}%`;
    }

    private formatRoe(value: number): string {
        const roe = Number.isFinite(value) ? value * 100 : 0;
        return `${roe >= 0 ? '+' : ''}${roe.toFixed(2)}% ROE`;
    }

    private formatSignedUsd(value: number): string {
        const safe = Number.isFinite(value) ? value : 0;
        return safe >= 0 ? `+$${safe.toFixed(2)}` : `-$${Math.abs(safe).toFixed(2)}`;
    }

    private formatBracketLine(price: number | undefined, roe: number): string {
        const priceText = typeof price === 'number' && Number.isFinite(price)
            ? `$${price.toFixed(2)}`
            : '$—';
        return `${priceText} (${this.formatRoe(roe)})`;
    }

    private describeAegisExit(
        reason: string,
        pnl: number,
        botState: BotState,
        side: Side,
        exitPrice: number
    ): AegisExitDescription {
        const normalized = String(reason || '').toUpperCase();
        const build = (
            emoji: string,
            canonicalExitType: string,
            detail: string,
            displayExitLabel = canonicalExitType,
            mismatchReason?: string
        ): AegisExitDescription => ({
            emoji,
            title: displayExitLabel,
            reason: detail,
            canonicalExitType,
            displayExitLabel,
            labelMismatch: Boolean(mismatchReason),
            mismatchReason
        });

        if (normalized.includes('AEGIS_EXIT_EYE_OPPOSITE_SIGNAL')) {
            return build('👁️', 'EXIT_EYE_OPPOSITE_SIGNAL', 'Cierre por ExitEye: señal opuesta en profit');
        }
        if (normalized.includes('AEGIS_EXIT_EYE_NEUTRAL_DECAY')) {
            return build('👁️', 'EXIT_EYE_NEUTRAL_DECAY', 'Cierre por ExitEye: pérdida de momentum en profit');
        }
        if (normalized.includes('AEGIS_EXIT_EYE_PROTECT_PROFIT')) {
            return build('👁️', 'EXIT_EYE_PROTECT_PROFIT', 'Cierre/protección por ExitEye: protección de ganancia');
        }
        if (normalized.includes('TIME_LIMIT')) {
            return build('⏰', 'TIME_LIMIT_EXIT', 'Cierre por límite de tiempo con posición en ganancia');
        }
        if (normalized.includes('BREAK') || normalized.includes('BE_')) {
            return build('🟰', 'BREAK_EVEN_EXIT', 'Cierre por protección de break even');
        }
        if (normalized.includes('TRAIL') || normalized.includes('CALLBACK')) {
            return build('🛡️', 'TRAILING_STOP_EXIT', `Cierre por trailing/callback (${reason})`);
        }
        if (normalized.includes('AI') || normalized.includes('IA') || normalized.includes('GUARDIAN') || normalized.includes('SMART') || normalized.includes('CLOSE')) {
            return build('🤖', 'AI_GUARDIAN_EXIT', `Cierre decidido por IA/guardian (${reason})`);
        }
        if (normalized.includes('BRACKET') || normalized.includes('EMERGENCY') || normalized.includes('FAILED')) {
            return build('⚠️', 'RISK_CONTROL_EXIT', `Cierre por control de riesgo (${reason})`);
        }

        const entryPrice = botState.lastEntryPrice || 0;
        const leverage = botState.lastLeverage || botState.lastActualLeverage || 20;
        const stopRoe = botState.lastStopRoe ?? -0.15;
        const takeProfitRoe = botState.lastTakeProfitRoe ?? 0.25;
        const stopPrice = entryPrice > 0 ? this.bracketPrice(side, entryPrice, stopRoe, leverage, 'STOP') : undefined;
        const tpPrice = entryPrice > 0 ? this.bracketPrice(side, entryPrice, takeProfitRoe, leverage, 'TP') : undefined;
        const near = (target?: number) =>
            typeof target === 'number' && target > 0 && Math.abs(exitPrice - target) / target < 0.004;

        if (near(botState.lastTrailStop)) {
            return build('🛡️', 'TRAILING_STOP_EXIT', 'Cierre por trailing stop ejecutado');
        }
        if (near(tpPrice)) {
            return build('💰', 'TAKE_PROFIT', 'Cierre por take profit', 'TAKE PROFIT (TP)');
        }
        if (near(stopPrice)) {
            return build('💸', 'STOP_LOSS', 'Cierre por stop loss', 'STOP LOSS (SL)');
        }
        if (pnl >= 0) {
            return build('💰', 'PROFIT_EXIT_UNCLASSIFIED', 'Cierre en ganancia; no se pudo distinguir TP/trailing con precisión', 'TAKE PROFIT (TP)');
        }
        return build('💸', 'LOSS_EXIT_UNCLASSIFIED', 'Cierre en pérdida; no se pudo distinguir SL/trailing con precisión', 'STOP LOSS (SL)');
    }

    private roundQuantity(quantity: number, filters: SymbolFilters): number {
        const scale = 10 ** filters.qtyPrecision;
        return Number((Math.floor(quantity * scale) / scale).toFixed(filters.qtyPrecision));
    }

    private roundPrice(price: number, filters: SymbolFilters): number {
        const precision = Number.isInteger(filters.pricePrecision) ? filters.pricePrecision : 2;
        return Number(price.toFixed(precision));
    }

    private isBetterStop(side: Side, next: number, previous?: number): boolean {
        if (previous === undefined) return true;
        return side === 'LONG' ? next > previous : next < previous;
    }

    private checkDailyReset(): void {
        const today = Math.floor(Date.now() / 86400000);
        if (today > this.lastTradeDayReset) {
            this.tradesToday = 0;
            this.phaseOShortTradesToday = 0;
            this.dailyStartBalance = null;
            this.lastDailyPnlPct = undefined;
            this.lastTradeDayReset = today;
        }
    }

    private async notifyError(symbol: string, type: string, error: unknown): Promise<void> {
        const now = Date.now();
        const errorKey = `${symbol}:${type}`;
        if (this.lastErrorTime[errorKey] && now - this.lastErrorTime[errorKey] < 3600000) return;
        this.lastErrorTime[errorKey] = now;
        try {
            await this.deps.notifier.sendMessage(`🚨 **${type}**\nSymbol: ${symbol}\nError: \`${String(error).slice(0, 150)}\``);
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
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
