import {
  createDurableEntryIntent,
  DurableEntryIntent,
  DurableExecutionCoordinator,
  DurableExecutionError,
  DurableExecutionRecord,
  DurableProtectionPolicy,
  PositionTruth,
} from './DurableExecutionLifecycle';

export interface DurableAegisEntryInput {
  signalId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  expectedPrice: number;
  policyId: string;
  featureHash: string;
  createdAt: string;
  protectionPolicy: DurableProtectionPolicy;
}

export interface ProtectedAegisEntry {
  intent: DurableEntryIntent;
  record: DurableExecutionRecord;
  position: PositionTruth;
}

export class DurableAegisEntryExecutor {
  constructor(private readonly coordinator: DurableExecutionCoordinator) {}

  async execute(input: DurableAegisEntryInput): Promise<ProtectedAegisEntry> {
    const intent = createDurableEntryIntent(input);
    const record = await this.coordinator.submit(intent);
    if (
      record.state !== 'PROTECTED' ||
      !record.averagePrice ||
      record.filledQuantity <= 0 ||
      !record.protection?.stopPresent ||
      !record.protection.takeProfitPresent ||
      record.protection.protectedQuantity + Number.EPSILON < record.filledQuantity
    ) {
      throw new DurableExecutionError(`ENTRY_NOT_SAFELY_MANAGED:${record.state}`);
    }
    return {
      intent,
      record,
      position: {
        symbol: intent.symbol,
        side: intent.side,
        quantity: record.filledQuantity,
        entryPrice: record.averagePrice,
      },
    };
  }

  async recover(
    policyForUnmanagedPosition: (
      position: PositionTruth,
    ) => DurableProtectionPolicy | Promise<DurableProtectionPolicy>,
  ): Promise<DurableExecutionRecord[]> {
    return this.coordinator.recover(policyForUnmanagedPosition);
  }
}
