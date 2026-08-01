export type AegisExitEyeV2ShadowAction =
  | 'KEEP_MANAGING'
  | 'PROTECT_PROFIT'
  | 'EXIT_RECOMMENDED'
  | 'UNKNOWN';

export interface AegisExitEyeV2CanonicalInput {
  recognized: boolean;
  valid: boolean;
  selected: boolean;
  side?: 'LONG' | 'SHORT';
  reason: string;
}

export interface AegisExitEyeV2ShadowInput {
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  currentRoe: number;
  peakRoe: number;
  canonical: AegisExitEyeV2CanonicalInput;
  minimumPeakRoeToStudyProtection: number;
  minimumGivebackRoeToStudyProtection: number;
}

export interface AegisExitEyeV2ShadowDecision {
  schemaId: 'aegis-exit-eye-v2-shadow-v1';
  mode: 'SHADOW';
  action: AegisExitEyeV2ShadowAction;
  reason: string;
  wouldProtectProfit: boolean;
  wouldRecommendExit: boolean;
  legacyVoteCountUsed: false;
  persistenceState: 'NOT_IMPLEMENTED_V1';
  selectionEffect: 'NONE';
  exchangeAuthority: false;
  exchangeMutations: 0;
  context: {
    symbol: string;
    positionSide: 'LONG' | 'SHORT';
    currentRoe: number;
    peakRoe: number;
    givebackRoe: number;
    canonicalSelected: boolean;
    canonicalSide?: 'LONG' | 'SHORT';
    canonicalReason: string;
  };
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function evaluateAegisExitEyeV2Shadow(
  input: AegisExitEyeV2ShadowInput,
): AegisExitEyeV2ShadowDecision {
  const currentRoe = finite(input.currentRoe);
  const peakRoe = finite(input.peakRoe);
  const givebackRoe = Math.max(0, peakRoe - currentRoe);
  let action: AegisExitEyeV2ShadowAction = 'UNKNOWN';
  let reason = 'canonical_direction_unavailable';

  if (input.canonical.recognized && input.canonical.valid) {
    if (input.canonical.selected && input.canonical.side === input.positionSide) {
      action = 'KEEP_MANAGING';
      reason = 'canonical_direction_still_supports_position';
    } else if (
      input.canonical.selected &&
      input.canonical.side !== undefined &&
      input.canonical.side !== input.positionSide &&
      currentRoe > 0
    ) {
      action = 'EXIT_RECOMMENDED';
      reason = 'canonical_opposite_direction_while_profitable';
    } else if (
      !input.canonical.selected &&
      currentRoe > 0 &&
      peakRoe >= input.minimumPeakRoeToStudyProtection &&
      givebackRoe >= input.minimumGivebackRoeToStudyProtection
    ) {
      action = 'PROTECT_PROFIT';
      reason = 'canonical_support_absent_after_profitable_giveback';
    } else {
      reason = 'insufficient_validated_exit_evidence';
    }
  }

  return {
    schemaId: 'aegis-exit-eye-v2-shadow-v1',
    mode: 'SHADOW',
    action,
    reason,
    wouldProtectProfit: action === 'PROTECT_PROFIT',
    wouldRecommendExit: action === 'EXIT_RECOMMENDED',
    legacyVoteCountUsed: false,
    persistenceState: 'NOT_IMPLEMENTED_V1',
    selectionEffect: 'NONE',
    exchangeAuthority: false,
    exchangeMutations: 0,
    context: {
      symbol: input.symbol,
      positionSide: input.positionSide,
      currentRoe,
      peakRoe,
      givebackRoe,
      canonicalSelected: input.canonical.selected,
      canonicalSide: input.canonical.side,
      canonicalReason: input.canonical.reason,
    },
  };
}
