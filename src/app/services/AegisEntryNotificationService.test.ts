import { describe, expect, it, vi } from 'vitest';
import { AegisEntryNotificationService } from './AegisEntryNotificationService';
import { AegisTelegramBlockNotifier } from './AegisTelegramBlockNotifier';

function fixture(config: any = { automatic_block_alerts_enabled: true, block_dedupe: {} }) {
  const sendMessage = vi.fn(async () => undefined);
  const sendAlert = vi.fn(async () => undefined);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const logTradeEvent = vi.fn(async () => undefined);
  const service = new AegisEntryNotificationService({
    notifier: { sendMessage, sendAlert },
    logger,
    blockNotifier: new AegisTelegramBlockNotifier(),
    getConfig: () => config,
    logTradeEvent,
  });
  return { service, sendMessage, logger, logTradeEvent };
}

const decision = (overrides: Record<string, unknown> = {}) =>
  ({
    allowed: false,
    reason: 'decision_brain_do_not_enter',
    metadata: {
      symbol: 'ETHUSDT',
      side: 'LONG',
      mode: 'CONSERVATIVE',
      eventRiskMode: 'NORMAL',
      isAltSymbol: false,
      aPlus: false,
      setupGrade: 'WEAK',
      checks: {},
      ...overrides,
    },
  }) as any;

describe('AegisEntryNotificationService', () => {
  it('fails open without sending when automatic block alerts are disabled', async () => {
    const { service, sendMessage, logger } = fixture({ automatic_block_alerts_enabled: false });

    await service.notifyDecisionEnforcementDenied('ETHUSDT', decision());

    expect(sendMessage).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      'telegram_block_notification_auto_disabled',
      expect.objectContaining({ symbol: 'ETHUSDT' }),
    );
  });

  it('deduplicates repeated decision blocks and records the suppressed event', async () => {
    const { service, sendMessage, logTradeEvent } = fixture({
      automatic_block_alerts_enabled: true,
      block_dedupe: { cooldown_minutes: 15, summary_threshold: 25 },
    });

    await service.notifyDecisionEnforcementDenied('ETHUSDT', decision());
    await service.notifyDecisionEnforcementDenied('ETHUSDT', decision());

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(logTradeEvent).toHaveBeenCalledWith(
      'ETHUSDT',
      'telegram_block_notification_suppressed',
      expect.objectContaining({ reason: 'decision_brain_do_not_enter' }),
    );
  });

  it('sends a probe-mode notification with the canonical score formatting', async () => {
    const { service, sendMessage } = fixture();

    await service.notifyProbeModeAllowed('ETHUSDT', 'LONG', {
      allowed: true,
      reason: 'probe_allowed',
      metadata: {
        turboScore: 0.91,
        tailRiskScore: 0.12,
        decisionBrain: 'ENTER_NOW',
        entryQualityRecommendation: 'ALLOW',
      },
    } as any);

    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining('Score: 91.0%'));
  });

  it('swallows Telegram failures and logs the notification error', async () => {
    const { service, logger } = fixture();
    const failing = fixture();
    failing.sendMessage.mockRejectedValueOnce(new Error('telegram unavailable'));

    await failing.service.notifyProbeModeAllowed('ETHUSDT', 'LONG', {
      allowed: true,
      reason: 'probe_allowed',
      metadata: { turboScore: 0.9, tailRiskScore: 0.1 },
    } as any);

    expect(failing.logger.warn).toHaveBeenCalledWith(
      'aegis_probe_mode_telegram_failed',
      expect.objectContaining({ error: 'telegram unavailable' }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
