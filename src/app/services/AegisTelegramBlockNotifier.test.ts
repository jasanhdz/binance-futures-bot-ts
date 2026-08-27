import { describe, expect, it } from 'vitest';
import {
  AegisBlockNotificationInput,
  AegisTelegramBlockNotifier,
  buildAegisBlockDedupeKey,
} from './AegisTelegramBlockNotifier';

const baseInput: AegisBlockNotificationInput = {
  timestamp: 1_000,
  symbol: 'LINKUSDT',
  side: 'LONG',
  reason: 'event_risk_caution_denied_weak_setup',
  eventRiskMode: 'CAUTION',
  setupGrade: 'WEAK',
  decisionBrain: 'WAIT_CONFIRMATION',
  entryQuality: 'BLOCK_SHADOW',
  tailRiskScore: 0.42,
  turboScore: 0.956,
  votes: { long: 2, short: 0, neutral: 1 },
};

const config = {
  enabled: true,
  cooldown_minutes: 15,
  summary_threshold: 3,
  max_cache_entries: 1000,
  include_suppressed_count: true,
};

function input(overrides: Partial<AegisBlockNotificationInput> = {}): AegisBlockNotificationInput {
  return { ...baseInput, ...overrides };
}

describe('AegisTelegramBlockNotifier', () => {
  it('notifies the first block', () => {
    const notifier = new AegisTelegramBlockNotifier();

    const decision = notifier.decide(baseInput, config);

    expect(decision.shouldNotify).toBe(true);
    expect(decision.notificationType).toBe('FIRST');
    expect(decision.suppressedCount).toBe(0);
  });

  it('suppresses the same block inside cooldown', () => {
    const notifier = new AegisTelegramBlockNotifier();
    notifier.decide(baseInput, config);

    const decision = notifier.decide(input({ timestamp: 2_000 }), config);

    expect(decision.shouldNotify).toBe(false);
    expect(decision.notificationType).toBe('SUPPRESSED');
    expect(decision.suppressedCount).toBe(1);
  });

  it('notifies the same block after cooldown', () => {
    const notifier = new AegisTelegramBlockNotifier();
    notifier.decide(baseInput, config);
    notifier.decide(input({ timestamp: 2_000 }), config);

    const decision = notifier.decide(input({ timestamp: 16 * 60 * 1000 }), config);

    expect(decision.shouldNotify).toBe(true);
    expect(decision.notificationType).toBe('REPEATED_AFTER_COOLDOWN');
    expect(decision.suppressedCount).toBe(2);
    expect(decision.message).toContain('Repeticiones silenciadas: 2 en 15m');
  });

  it('notifies when reason changes', () => {
    const notifier = new AegisTelegramBlockNotifier();
    notifier.decide(baseInput, config);

    const decision = notifier.decide(input({ reason: 'decision_brain_wait_confirmation' }), config);

    expect(decision.shouldNotify).toBe(true);
    expect(decision.notificationType).toBe('CHANGED');
    expect(decision.reasonChanged).toBe(true);
  });

  it('notifies when EventRisk mode changes', () => {
    const notifier = new AegisTelegramBlockNotifier();
    notifier.decide(baseInput, config);

    const decision = notifier.decide(input({ eventRiskMode: 'RISK_OFF' }), config);

    expect(decision.shouldNotify).toBe(true);
    expect(decision.notificationType).toBe('CHANGED');
    expect(decision.importantChange).toBe(true);
  });

  it('notifies when DecisionBrain changes', () => {
    const notifier = new AegisTelegramBlockNotifier();
    notifier.decide(baseInput, config);

    const decision = notifier.decide(input({ decisionBrain: 'DO_NOT_ENTER' }), config);

    expect(decision.shouldNotify).toBe(true);
    expect(decision.notificationType).toBe('CHANGED');
  });

  it('notifies when EntryQuality changes', () => {
    const notifier = new AegisTelegramBlockNotifier();
    notifier.decide(baseInput, config);

    const decision = notifier.decide(input({ entryQuality: 'ALLOW_SHADOW' }), config);

    expect(decision.shouldNotify).toBe(true);
    expect(decision.notificationType).toBe('CHANGED');
  });

  it('notifies when setupGrade changes', () => {
    const notifier = new AegisTelegramBlockNotifier();
    notifier.decide(baseInput, config);

    const decision = notifier.decide(input({ setupGrade: 'A' }), config);

    expect(decision.shouldNotify).toBe(true);
    expect(decision.notificationType).toBe('CHANGED');
  });

  it('sends a summary when the threshold is reached', () => {
    const notifier = new AegisTelegramBlockNotifier();
    notifier.decide(baseInput, config);
    notifier.decide(input({ timestamp: 2_000 }), config);
    notifier.decide(input({ timestamp: 3_000 }), config);

    const decision = notifier.decide(input({ timestamp: 4_000 }), config);

    expect(decision.shouldNotify).toBe(true);
    expect(decision.notificationType).toBe('SUMMARY');
    expect(decision.suppressedCount).toBe(3);
    expect(decision.message).toContain('Repetido 3 veces en 15m');
  });

  it('accumulates suppressedCount correctly', () => {
    const notifier = new AegisTelegramBlockNotifier();
    notifier.decide(baseInput, { ...config, summary_threshold: 10 });

    expect(
      notifier.decide(input({ timestamp: 2_000 }), { ...config, summary_threshold: 10 })
        .suppressedCount,
    ).toBe(1);
    expect(
      notifier.decide(input({ timestamp: 3_000 }), { ...config, summary_threshold: 10 })
        .suppressedCount,
    ).toBe(2);
  });

  it('evicts oldest entries after max_cache_entries', () => {
    const notifier = new AegisTelegramBlockNotifier();
    const smallConfig = { ...config, max_cache_entries: 2 };
    const firstKey = buildAegisBlockDedupeKey(baseInput);

    notifier.decide(baseInput, smallConfig);
    notifier.decide(input({ symbol: 'ETHUSDT', timestamp: 2_000 }), smallConfig);
    notifier.decide(input({ symbol: 'SOLUSDT', timestamp: 3_000 }), smallConfig);

    expect(notifier.size()).toBe(2);
    expect(notifier.hasKey(firstKey)).toBe(false);
  });

  it('bypasses suppression when disabled', () => {
    const notifier = new AegisTelegramBlockNotifier();
    const disabledConfig = { ...config, enabled: false };

    notifier.decide(baseInput, disabledConfig);
    const decision = notifier.decide(input({ timestamp: 2_000 }), disabledConfig);

    expect(decision.shouldNotify).toBe(true);
    expect(decision.notificationType).toBe('FIRST');
  });

  it('does not include timestamp or price-like values in the dedupe key', () => {
    const keyA = buildAegisBlockDedupeKey(input({ timestamp: 1_000, turboScore: 0.91 }));
    const keyB = buildAegisBlockDedupeKey(input({ timestamp: 99_000, turboScore: 0.11 }));

    expect(keyA).toBe(keyB);
    expect(keyA).not.toContain('1000');
    expect(keyA).not.toContain('99000');
    expect(keyA).not.toContain('0.91');
  });

  it('does not mix symbols', () => {
    const notifier = new AegisTelegramBlockNotifier();
    notifier.decide(baseInput, config);

    const decision = notifier.decide(input({ symbol: 'ETHUSDT' }), config);

    expect(decision.shouldNotify).toBe(true);
    expect(decision.notificationType).toBe('FIRST');
  });
});
