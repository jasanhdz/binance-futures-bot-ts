export interface MicroBurstReadinessChecks {
  code: boolean;
  config: boolean;
  version: boolean;
  cohort: boolean;
  manifest: boolean;
  archive: boolean;
  db: boolean;
  storage: boolean;
  gaps: boolean;
  books: boolean;
  BTC: boolean;
  AggTrade: boolean;
  mutation: boolean;
  liveFlags: boolean;
  preregistration: boolean;
  schema: boolean;
  episode: boolean;
  gap: boolean;
  cost: boolean;
  outcomeJournal: boolean;
}

export interface MicroBurstReadinessInput {
  codeSha?: string;
  configHash?: string;
  strategyVersion?: string;
  cohortId?: string;
  officialCohortReady?: boolean;
  mode: 'OFF' | 'SHADOW' | 'LIVE';
  enabled: boolean;
  enabledSymbolCount: number;
  healthyBookCount?: number;
  btcHealthy?: boolean;
  aggTradeHealthy?: boolean;
  archiveEnabled: boolean;
  archiveAvailable: boolean;
  archiveHealthy?: boolean;
  storageHealthy?: boolean;
  storageErrors?: number;
  unresolvedTradeGaps?: number;
  mutationAuditAvailable?: boolean;
  preregistrationEnabled: boolean;
  manifestValid?: boolean;
  databaseValid?: boolean;
  schemaValid?: boolean;
  episodeDefinitionValid?: boolean;
  gapSemanticsValid?: boolean;
  costSemanticsValid?: boolean;
  outcomeJournalHealthy?: boolean;
}

export interface MicroBurstReadinessResult {
  ready: boolean;
  official: false;
  liveAuthority: false;
  checks: MicroBurstReadinessChecks;
  blockers: string[];
  warnings: string[];
}

const known = (value: string | undefined): boolean =>
  typeof value === 'string' && value.length > 0 && value !== 'UNKNOWN' && value !== 'UNFROZEN';

export function assessMicroBurstReadiness(input: MicroBurstReadinessInput): MicroBurstReadinessResult {
  const cohortId = input.cohortId;
  const checks: MicroBurstReadinessChecks = {
    code: known(input.codeSha),
    config: known(input.configHash),
    version: known(input.strategyVersion),
    cohort:
      input.officialCohortReady === true &&
      known(cohortId) &&
      cohortId?.startsWith('MBV1-M3_2-') === true,
    manifest: input.manifestValid === true,
    archive: input.archiveEnabled && input.archiveAvailable && input.archiveHealthy === true,
    db: input.databaseValid === true,
    storage: input.storageHealthy === true && (input.storageErrors ?? Number.MAX_SAFE_INTEGER) === 0,
    gaps: input.unresolvedTradeGaps !== undefined && input.unresolvedTradeGaps === 0,
    books: input.healthyBookCount !== undefined && input.healthyBookCount === input.enabledSymbolCount && input.enabledSymbolCount > 0,
    BTC: input.btcHealthy === true,
    AggTrade: input.aggTradeHealthy === true,
    mutation: input.mutationAuditAvailable === true,
    liveFlags: input.mode === 'SHADOW',
    preregistration: input.enabled && input.preregistrationEnabled,
    schema: input.schemaValid === true,
    episode: input.episodeDefinitionValid === true,
    gap: input.gapSemanticsValid === true,
    cost: input.costSemanticsValid === true,
    outcomeJournal: input.outcomeJournalHealthy !== false,
  };
  const blockers = Object.entries(checks).filter(([, value]) => !value).map(([name]) => `${name.toUpperCase()}_NOT_READY`);
  const warnings: string[] = [];
  if (input.officialCohortReady !== true) warnings.push('Official cohort authority was not asserted.');
  if (input.mode === 'LIVE') warnings.push('LIVE mode is rejected; no exchange authority is granted.');
  return { ready: blockers.length === 0, official: false, liveAuthority: false, checks, blockers, warnings };
}
