import { describe, expect, it } from 'vitest';
import { createMicroBurstExecutionIntent } from './MicroBurstExecutionIntentFactory';
import { createMicroBurstV1Identity } from './MicroBurstIdentity';
import { MicroBurstApprovedEntry } from './MicroBurstTypes';

describe('MicroBurstExecutionIntentFactory determinism', () => {
  it('produces the same intent for the same approved entry without reading a clock', () => {
    const approved: MicroBurstApprovedEntry = {
      identity: createMicroBurstV1Identity('deadbeef'),
      symbol: 'ETHUSDT',
      side: 'LONG',
      leverage: 20,
      positionFraction: 0.05,
      stopInvalidationPrice: 99.8,
      targetPrice: 102,
      requestedAt: 1_700_000_000_000,
      tradeId: 'MICRO-BURST-V1-ETHUSDT-1700000000000',
      signalId: 'signal-1',
    };
    const first = createMicroBurstExecutionIntent(approved);
    const second = createMicroBurstExecutionIntent(approved);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      requestedAt: approved.requestedAt,
      tradeId: approved.tradeId,
      structuralStopPrice: approved.stopInvalidationPrice,
      destinationPrice: approved.targetPrice,
      leverage: approved.leverage,
      positionFraction: approved.positionFraction,
    });
  });
});
