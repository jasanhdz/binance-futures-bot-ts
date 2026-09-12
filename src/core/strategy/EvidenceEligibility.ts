export interface EvidenceEligibility {
  category: 'MARKET_RESEARCH' | 'SYNTHETIC' | 'INSUFFICIENT_PROVENANCE';
  reason: string;
  researchEligible: boolean;
  /** Journal declarations, including mode=LIVE, never prove account fills. */
  liveEconomicsEligible: false;
}

/** Read-only classification. UNOFFICIAL and liveExecution=false are not synthetic markers. */
export function classifyEvidence(value: object): EvidenceEligibility {
  const original = value as Record<string, unknown>;
  const provenance = original.provenance as Record<string, unknown> | undefined;
  const row = { ...provenance, ...original };
  const origin = row.evidenceOrigin ?? provenance?.origin;
  const result = (
    category: EvidenceEligibility['category'],
    reason: string,
  ): EvidenceEligibility => ({
    category,
    reason,
    researchEligible: category === 'MARKET_RESEARCH',
    liveEconomicsEligible: false,
  });
  if (origin === 'TEST' || origin === 'SYNTHETIC')
    return result('SYNTHETIC', 'EXPLICIT_SYNTHETIC_ORIGIN');
  if (
    row.schemaVersion === 1 &&
    row.cohortId === 'UNOFFICIAL' &&
    row.codeCommitSha === 'UNKNOWN' &&
    row.configHash === 'UNKNOWN' &&
    row.snapshotAtMs === 1000 &&
    row.observedAtMs === 1000 &&
    row.liveExecution === false &&
    ((row.shadowSignalId === 'live-signal' &&
      row.strategyVersion === '0.8.0-expected-continuation-shadow') ||
      (row.shadowSignalId === 'runtime-golden' && row.strategyVersion === 'golden'))
  )
    return result('SYNTHETIC', 'KNOWN_LEGACY_RUNTIME_FIXTURE');
  const timestamp = row.signalAtMs ?? row.snapshotAtMs ?? row.openedAtMs ?? row.openedReceivedAtMs;
  const id = row.shadowSignalId ?? row.parentSignalId ?? row.tradeId;
  if (
    !Number.isInteger(row.schemaVersion) ||
    typeof row.codeCommitSha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(row.codeCommitSha) ||
    typeof row.configHash !== 'string' ||
    !/^(sha256:)?[a-f0-9]{64}$/.test(row.configHash) ||
    typeof row.strategyVersion !== 'string' ||
    !row.strategyVersion ||
    row.strategyVersion === 'UNKNOWN' ||
    typeof row.strategyId !== 'string' ||
    !row.strategyId ||
    typeof id !== 'string' ||
    !id ||
    typeof row.symbol !== 'string' ||
    !row.symbol ||
    !['LONG', 'SHORT'].includes(String(row.side)) ||
    typeof timestamp !== 'number' ||
    !Number.isFinite(timestamp) ||
    timestamp < 0 ||
    (origin !== undefined && origin !== 'MARKET')
  )
    return result('INSUFFICIENT_PROVENANCE', 'INSUFFICIENT_PROVENANCE');
  return result(
    'MARKET_RESEARCH',
    origin === 'MARKET' ? 'DECLARED_MARKET_PROVENANCE' : 'LEGACY_COMPLETE_PROVENANCE',
  );
}

export function summarizeEvidence(rows: readonly object[]): {
  rowsSeen: number;
  eligibleRows: number;
  excludedRows: number;
  reasons: Record<string, number>;
} {
  const reasons: Record<string, number> = {};
  let eligibleRows = 0;
  for (const row of rows) {
    const eligibility = classifyEvidence(row);
    if (eligibility.researchEligible) eligibleRows++;
    else reasons[eligibility.reason] = (reasons[eligibility.reason] ?? 0) + 1;
  }
  return { rowsSeen: rows.length, eligibleRows, excludedRows: rows.length - eligibleRows, reasons };
}
