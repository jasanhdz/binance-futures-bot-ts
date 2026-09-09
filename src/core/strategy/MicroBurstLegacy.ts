/** Read boundaries only. Never rewrite signed payloads, journals, exchange IDs or policy digests. */
export function isMicroBurstStrategy(value: unknown): value is 'MICRO_BURST' | 'MICRO_BURST_V1' {
  return value === 'MICRO_BURST' || value === 'MICRO_BURST_V1';
}

export function isMicroBurstPolicy(value: unknown): value is 'MICRO' | 'CONTEXTUAL_V3' {
  return value === 'MICRO' || value === 'CONTEXTUAL_V3';
}

export function samePersistedStrategy(left: unknown, right: unknown): boolean {
  return left === right || (isMicroBurstStrategy(left) && isMicroBurstStrategy(right));
}

export function isMicroBurstTradeId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (value.startsWith('MICRO-BURST-') || value.startsWith('MICRO-BURST-V1-'))
  );
}
