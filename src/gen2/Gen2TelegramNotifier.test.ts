import { describe, expect, it } from 'vitest';
import { Gen2TelegramNotifier } from './Gen2TelegramNotifier';

function makeNotifier(redact: string[] = []) {
  const sent: string[] = [];
  let clock = 1_000_000_000;
  const notifier = new Gen2TelegramNotifier(
    async (m: string) => {
      sent.push(m);
    },
    () => clock,
    redact,
  );
  return { notifier, sent, tick: (ms: number) => (clock += ms) };
}

describe('Gen2TelegramNotifier', () => {
  it('classifies severity and formats the message', async () => {
    const { notifier, sent } = makeNotifier();
    await notifier.notify('CRITICAL', 'bracket failure', 'stop rejected');
    expect(sent[0]).toContain('🔴 [GEN2 CRITICAL] bracket failure');
    expect(sent[0]).toContain('stop rejected');
  });

  it('dedups identical fingerprints within cooldown, re-sends after', async () => {
    const { notifier, sent, tick } = makeNotifier();
    const a = await notifier.notify('CRITICAL', 'orphan', 'x', 'fp1');
    const b = await notifier.notify('CRITICAL', 'orphan', 'x', 'fp1');
    expect(a.sent).toBe(true);
    expect(b).toEqual({ sent: false, reason: 'COOLDOWN_DEDUP' });
    tick(11 * 60 * 1000);
    const c = await notifier.notify('CRITICAL', 'orphan', 'x', 'fp1');
    expect(c.sent).toBe(true);
    expect(sent.length).toBe(2);
  });

  it('a new CRITICAL fingerprint always goes out immediately', async () => {
    const { notifier, sent } = makeNotifier();
    await notifier.notify('CRITICAL', 'a', '', 'fp-a');
    await notifier.notify('CRITICAL', 'b', '', 'fp-b');
    expect(sent.length).toBe(2);
  });

  it('redacts secrets from title and body', async () => {
    const { notifier, sent } = makeNotifier(['supersecret-hmac-1234']);
    await notifier.notify('INFO', 'leak supersecret-hmac-1234', 'body supersecret-hmac-1234');
    expect(sent[0]).not.toContain('supersecret-hmac-1234');
    expect(sent[0]).toContain('<REDACTED>');
  });

  it('maps bridge events to severity and never throws on send failure', async () => {
    let clock = 1_000_000_000;
    const notifier = new Gen2TelegramNotifier(
      async () => {
        throw new Error('telegram down');
      },
      () => clock,
    );
    const r = await notifier.notifyEvent({ type: 'BRACKET_FAILED', client_order_id: 'GEN2-x', payload: {} });
    expect(r.sent).toBe(false);
    expect(r.reason).toContain('NOTIFY_FAILED');
  });

  it('event severity mapping: FILL=INFO, ORDER_REJECTED=WARNING, INCIDENT=CRITICAL', async () => {
    const { notifier, sent } = makeNotifier();
    await notifier.notifyEvent({ type: 'FILL', client_order_id: 'a', payload: { fill_price: 1 } });
    await notifier.notifyEvent({ type: 'ORDER_REJECTED', client_order_id: 'b', payload: {} });
    await notifier.notifyEvent({ type: 'INCIDENT', client_order_id: 'c', payload: {} });
    expect(sent[0]).toContain('[GEN2 INFO] FILL');
    expect(sent[1]).toContain('[GEN2 WARNING] ORDER_REJECTED');
    expect(sent[2]).toContain('[GEN2 CRITICAL] INCIDENT');
  });
});
