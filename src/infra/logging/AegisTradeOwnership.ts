export const VERIFIED_AEGIS_TRADE_OWNERSHIP = {
  owner: 'AEGIS',
  origin: 'BOT',
  ownership_status: 'VERIFIED',
  eligible_for_bot_metrics: true,
  exclusion_reason: null,
} as const;

export function isVerifiedAegisMetricRecord(record: Record<string, unknown>): boolean {
  return (
    record.owner === 'AEGIS' &&
    record.origin === 'BOT' &&
    record.ownership_status === 'VERIFIED' &&
    record.eligible_for_bot_metrics === true
  );
}
