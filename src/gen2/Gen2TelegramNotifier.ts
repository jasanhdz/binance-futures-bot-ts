/**
 * GEN2 Telegram notifier (TS side) — bridge execution events.
 *
 * Reuses the SINGLE existing Telegram client (TelegramService.sendAlert): same
 * bot token, same chat, same secrets. It does NOT import TradingService or any
 * Phase O strategy code — the only coupling is the shared notifier transport.
 *
 * Severity + anti-spam: identical (severity, fingerprint) pairs are throttled by
 * a per-severity cooldown; a brand-new CRITICAL fingerprint always goes out.
 * Sending never throws into the caller (execution must not depend on Telegram).
 */
export type Gen2Severity = 'INFO' | 'WARNING' | 'CRITICAL';

export type Gen2SendFn = (message: string) => Promise<void>;

const COOLDOWN_MS: Record<Gen2Severity, number> = {
  CRITICAL: 10 * 60 * 1000,
  WARNING: 30 * 60 * 1000,
  INFO: 6 * 60 * 60 * 1000,
};
const ICON: Record<Gen2Severity, string> = { INFO: '🟢', WARNING: '🟠', CRITICAL: '🔴' };

// Bridge event type -> severity. Anything unmapped is INFO.
const EVENT_SEVERITY: Record<string, Gen2Severity> = {
  FILL: 'INFO',
  BRACKET_CONFIRMED: 'INFO',
  TIME_EXIT_EXECUTED: 'INFO',
  TIME_EXIT_SKIPPED_NO_POSITION: 'INFO',
  POSITION_CLOSED: 'INFO',
  ORDER_REJECTED: 'WARNING',
  BRACKET_FAILED: 'CRITICAL',
  INCIDENT: 'CRITICAL',
};

export class Gen2TelegramNotifier {
  private lastSent = new Map<string, number>();

  constructor(
    private send: Gen2SendFn,
    private now: () => number = () => Date.now(),
    private redactValues: string[] = [],
  ) {}

  private redact(text: string): string {
    let out = text;
    for (const v of this.redactValues) {
      if (v && v.length >= 8) out = out.split(v).join('<REDACTED>');
    }
    return out;
  }

  private shouldSend(severity: Gen2Severity, fingerprint: string): boolean {
    const now = this.now();
    const key = `${severity}|${fingerprint}`;
    const last = this.lastSent.get(key) ?? 0;
    if (now - last < COOLDOWN_MS[severity]) return false;
    this.lastSent.set(key, now);
    for (const [k, ts] of this.lastSent) {
      if (now - ts > 24 * 60 * 60 * 1000) this.lastSent.delete(k);
    }
    return true;
  }

  async notify(severity: Gen2Severity, title: string, body = '', fingerprint?: string): Promise<{ sent: boolean; reason: string }> {
    try {
      if (!this.shouldSend(severity, fingerprint ?? title)) return { sent: false, reason: 'COOLDOWN_DEDUP' };
      const text = this.redact(`${ICON[severity]} [GEN2 ${severity}] ${title}${body ? '\n' + body : ''}`);
      await this.send(text);
      return { sent: true, reason: 'SENT' };
    } catch (err: any) {
      // never propagate: Telegram outage must not affect execution
      return { sent: false, reason: `NOTIFY_FAILED:${String(err?.message || err).slice(0, 120)}` };
    }
  }

  /** Notify from a bridge execution event (see Gen2Bridge.emitEvent). */
  async notifyEvent(event: { type: string; client_order_id?: string; payload?: Record<string, unknown> }): Promise<{ sent: boolean; reason: string }> {
    const severity = EVENT_SEVERITY[event.type] ?? 'INFO';
    const coid = event.client_order_id ?? '?';
    const body = this.redact(JSON.stringify(event.payload ?? {}).slice(0, 500));
    return this.notify(severity, `${event.type} · ${coid}`, body, `event-${event.type}-${coid}`);
  }
}
