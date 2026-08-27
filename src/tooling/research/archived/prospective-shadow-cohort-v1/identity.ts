import { canonicalJson, canonicalUtc, requireSha256, sha256 } from './canonical';

export const PROSPECTIVE_PROTOCOL_VERSION = 'aegis-prospective-validation-v1' as const;
export const PROSPECTIVE_IDENTITY_SCHEME = 'aegis-prospective-signal-id-v1' as const;

export interface ProspectiveIdentityInput {
  protocolVersion: typeof PROSPECTIVE_PROTOCOL_VERSION;
  cohortId: string;
  modelArtifactHash: string;
  configurationHash: string;
  symbol: string;
  decisionCycleId: string;
  side: 'SHORT' | 'NO_TRADE';
  signalTimestampUtc: string;
  informationCutoffUtc: string;
  eventSequenceId: string;
}

const forbidden = new Set([
  'outcome',
  'pnl',
  'realized_pnl',
  'future_price',
  'funding_result',
  'future_label',
  'filesystem_path',
  'generated_at',
]);

export function deriveProspectiveSignalId(input: ProspectiveIdentityInput): string {
  for (const key of Object.keys(input as unknown as Record<string, unknown>)) {
    if (forbidden.has(key.toLowerCase())) throw new Error('PROSPECTIVE_IDENTITY_FORBIDDEN_INPUT');
  }
  if (input.protocolVersion !== PROSPECTIVE_PROTOCOL_VERSION) {
    throw new Error('PROSPECTIVE_PROTOCOL_MISMATCH');
  }
  if (!input.cohortId || !input.decisionCycleId || !input.eventSequenceId) {
    throw new Error('PROSPECTIVE_IDENTITY_REQUIRED_INPUT_MISSING');
  }
  const symbol = input.symbol.trim().toUpperCase();
  if (symbol !== input.symbol || !/^[A-Z0-9]+$/.test(symbol)) {
    throw new Error('PROSPECTIVE_IDENTITY_SYMBOL_INVALID');
  }
  if (input.side !== 'SHORT' && input.side !== 'NO_TRADE') {
    throw new Error('PROSPECTIVE_IDENTITY_SIDE_INVALID');
  }
  const signal = canonicalUtc(input.signalTimestampUtc);
  const cutoff = canonicalUtc(input.informationCutoffUtc);
  if (Date.parse(cutoff) > Date.parse(signal))
    throw new Error('PROSPECTIVE_INFORMATION_CUTOFF_INVALID');
  const tuple = [
    input.protocolVersion,
    input.cohortId,
    requireSha256(input.modelArtifactHash, 'PROSPECTIVE_MODEL_HASH_INVALID'),
    requireSha256(input.configurationHash, 'PROSPECTIVE_CONFIG_HASH_INVALID'),
    symbol,
    input.decisionCycleId,
    input.side,
    signal,
    cutoff,
    input.eventSequenceId,
  ];
  return sha256(
    Buffer.concat([
      Buffer.from(PROSPECTIVE_IDENTITY_SCHEME),
      Buffer.from([0]),
      Buffer.from(canonicalJson(tuple)),
    ]),
  );
}
