import { createHash } from 'node:crypto';
import type { BotState } from '../../core/types';

export const HISTORICAL_EXTERNAL_SYMBOLS = [
  'SOLUSDT',
  'SUIUSDT',
  'LINKUSDT',
  'BNBUSDT',
  'LTCUSDT',
  'AVAXUSDT',
  'XRPUSDT',
  'DOGEUSDT',
] as const;

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function retireHistoricalExternalState(
  state: BotState,
  input: {
    migrationId: string;
    authorizedAt: string;
    evidenceSha256: string;
    previousStateSha256: string;
  },
): BotState {
  if (
    state.mode !== 'IDLE' ||
    state.marketOpenAmbiguous !== true ||
    state.positionOwner !== 'EXTERNAL' ||
    state.tradeOrigin !== 'MANUAL_EXTERNAL'
  )
    throw new Error('HISTORICAL_EXTERNAL_STATE_NOT_ELIGIBLE');
  return {
    ...state,
    marketOpenAmbiguous: false,
    marketOpenClientOrderId: undefined,
    historicalAccountingStatus: 'UNRESOLVED',
    historicalResolution: {
      kind: 'HISTORICAL_EXTERNAL_STATE_RETIRED_BY_OPERATOR',
      migrationId: input.migrationId,
      authorizedAt: input.authorizedAt,
      evidenceSha256: input.evidenceSha256,
      previousStateSha256: input.previousStateSha256,
    },
    eligibleForBotMetrics: false,
  };
}
