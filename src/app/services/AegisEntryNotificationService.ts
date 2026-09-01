import type { Logger } from '../ports/Logger';
import type { Notifier } from '../ports/Notifier';
import type { HistoryTradeEventInput } from '../logging/StrategyHistoryService';
import type { Side } from '../../core/types';
import type { AegisDecisionEnforcementDecision } from '../../strategies/aegis/domain/services/AegisDecisionEnforcement';
import type { AegisProbeModeDecision } from '../../strategies/aegis/domain/services/AegisProbeMode';
import type { AegisTelegramNotificationsRuntimeConfig } from '../../infra/config/ConfigLoader';
import { formatScore } from '../telegram/presentation/AegisExitMessageFormatter';
import { AegisTelegramBlockNotifier } from './AegisTelegramBlockNotifier';

export interface AegisEntryNotificationServiceDeps {
  notifier: Notifier;
  logger: Logger;
  blockNotifier: AegisTelegramBlockNotifier;
  getConfig(): AegisTelegramNotificationsRuntimeConfig;
  logTradeEvent(symbol: string, event: string, input: HistoryTradeEventInput): Promise<void>;
}

/** Owns entry-related Telegram presentation and notification deduplication. */
export class AegisEntryNotificationService {
  constructor(private readonly deps: AegisEntryNotificationServiceDeps) {}

  async notifyDecisionEnforcementDenied(
    symbol: string,
    decision: AegisDecisionEnforcementDecision,
  ): Promise<void> {
    const telegramNotificationsConfig = this.deps.getConfig();
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
    const notification = this.deps.blockNotifier.decide(
      {
        timestamp: Date.now(),
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
      await this.deps.logTradeEvent(symbol, 'telegram_block_notification_suppressed', {
        reason: decision.reason,
        metadata: notificationMetadata,
      });
      return;
    }

    if (notification.notificationType === 'SUMMARY') {
      this.deps.logger.info('telegram_block_notification_summary_sent', notificationMetadata);
      await this.deps.logTradeEvent(symbol, 'telegram_block_notification_summary_sent', {
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

  async notifyProbeModeAllowed(
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
}
