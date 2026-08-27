import {
  AmbiguousExchangeResult,
  DefinitiveExchangeRejection,
  DurableEntryIntent,
  DurableExecutionExchange,
  EntryOrderStatus,
  ExecutionTruth,
  PositionTruth,
  ProtectionPlan,
  ProtectionTruth,
} from './DurableExecutionLifecycle';

export interface DurableTransportOrder {
  status?: string;
  clientOrderId?: string;
  orderId?: string;
  originalQuantity?: number;
  executedQuantity?: number;
  averagePrice?: number;
}

export interface DurableTransportProtection {
  kind: 'STOP' | 'TAKE_PROFIT';
  stopPrice: number;
  quantity: number;
  closePosition: boolean;
}

export interface DurableExecutionPorts {
  submitEntry(intent: DurableEntryIntent): Promise<void>;
  readEntry(clientOrderId: string, symbol: string): Promise<DurableTransportOrder | null>;
  readFills(exchangeOrderId: string | undefined, symbol: string): Promise<number>;
  readPosition(symbol: string, side: 'LONG' | 'SHORT'): Promise<PositionTruth | null>;
  readProtection(symbol: string, side: 'LONG' | 'SHORT'): Promise<DurableTransportProtection[]>;
  readClose(closeClientOrderId: string, symbol: string): Promise<boolean>;
  placeStop(intent: DurableEntryIntent, position: PositionTruth, stopPrice: number): Promise<void>;
  placeTakeProfit(
    intent: DurableEntryIntent,
    position: PositionTruth,
    takeProfitPrice: number,
  ): Promise<void>;
  submitReduceOnlyClose(intent: DurableEntryIntent, position: PositionTruth): Promise<void>;
  discoverPositions(): Promise<PositionTruth[]>;
}

const AMBIGUOUS_LOOKUP_DELAYS_MS = [150, 300, 600, 1000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function status(value: string | undefined): EntryOrderStatus {
  if (value === 'NEW') return 'NEW';
  if (value === 'PARTIALLY_FILLED') return 'PARTIALLY_FILLED';
  if (value === 'FILLED') return 'FILLED';
  if (value === 'CANCELED' || value === 'EXPIRED') return 'CANCELED';
  if (value === 'REJECTED') return 'REJECTED';
  return 'NOT_FOUND';
}

export class DurableExecutionTransport implements DurableExecutionExchange {
  constructor(private readonly ports: DurableExecutionPorts) {}

  async submitEntry(intent: DurableEntryIntent): Promise<void> {
    try {
      await this.ports.submitEntry(intent);
    } catch (error: any) {
      const code = Number(error?.code);
      if ([-2010, -2018, -2019, -2021].includes(code)) {
        throw new DefinitiveExchangeRejection(String(error?.message ?? error));
      }
      throw new AmbiguousExchangeResult(String(error?.message ?? error));
    }
  }

  async readTruth(intent: DurableEntryIntent, lookupAmbiguous = false): Promise<ExecutionTruth> {
    try {
      let order: DurableTransportOrder | null = null;
      let lookupFailed = false;
      const delays = lookupAmbiguous ? AMBIGUOUS_LOOKUP_DELAYS_MS : [0];
      for (const delay of delays) {
        if (delay) await sleep(delay);
        try {
          order = await this.ports.readEntry(intent.clientOrderId, intent.symbol);
          if (order) break;
        } catch {
          // Includes Binance -2013: a recent submission is not proven absent.
          lookupFailed = true;
        }
      }
      if (!order && lookupFailed) throw new Error('ENTRY_LOOKUP_AMBIGUOUS');
      const exchangeOrderId = order?.orderId;
      const [fillsQuantity, position, protection, closeOrderFound] = await Promise.all([
        this.ports.readFills(exchangeOrderId, intent.symbol),
        this.ports.readPosition(intent.symbol, intent.side),
        this.readProtection(intent, 0),
        this.ports.readClose(intent.closeClientOrderId, intent.symbol),
      ]);
      const resolvedProtection = position
        ? await this.readProtection(intent, position.quantity)
        : protection;
      return {
        order: {
          status: status(order?.status),
          clientOrderId: order?.clientOrderId ?? intent.clientOrderId,
          exchangeOrderId,
          originalQuantity: order?.originalQuantity ?? intent.quantity,
          executedQuantity: order?.executedQuantity ?? 0,
          averagePrice: order?.averagePrice,
        },
        fillsQuantity,
        position,
        protection: resolvedProtection,
        closeOrderFound,
        conclusive: true,
      };
    } catch {
      return {
        order: {
          status: 'NOT_FOUND',
          clientOrderId: intent.clientOrderId,
          originalQuantity: intent.quantity,
          executedQuantity: 0,
        },
        fillsQuantity: 0,
        position: null,
        protection: { stopPresent: false, takeProfitPresent: false, protectedQuantity: 0 },
        closeOrderFound: false,
        conclusive: false,
      };
    }
  }

  async ensureProtection(
    intent: DurableEntryIntent,
    position: PositionTruth,
    plan: ProtectionPlan,
  ): Promise<ProtectionTruth> {
    const current = await this.readProtection(intent, position.quantity);
    if (
      !current.stopPresent ||
      current.stopPrice !== plan.stopPrice ||
      current.protectedQuantity + Number.EPSILON < position.quantity
    ) {
      await this.ports.placeStop(intent, position, plan.stopPrice);
    }
    if (
      !current.takeProfitPresent ||
      current.takeProfitPrice !== plan.takeProfitPrice ||
      current.protectedQuantity + Number.EPSILON < position.quantity
    ) {
      await this.ports.placeTakeProfit(intent, position, plan.takeProfitPrice);
    }
    return this.readProtection(intent, position.quantity);
  }

  submitReduceOnlyClose(intent: DurableEntryIntent, position: PositionTruth): Promise<void> {
    return this.ports.submitReduceOnlyClose(intent, position);
  }

  discoverUnmanagedPositions(): Promise<PositionTruth[]> {
    return this.ports.discoverPositions();
  }

  private async readProtection(
    intent: DurableEntryIntent,
    positionQuantity: number,
  ): Promise<ProtectionTruth> {
    const orders = await this.ports.readProtection(intent.symbol, intent.side);
    const stop = orders.find((order) => order.kind === 'STOP');
    const takeProfit = orders.find((order) => order.kind === 'TAKE_PROFIT');
    const coverage = (order: DurableTransportProtection | undefined): number => {
      if (!order) return 0;
      return order.closePosition ? positionQuantity : Math.min(order.quantity, positionQuantity);
    };
    return {
      stopPresent: Boolean(stop),
      takeProfitPresent: Boolean(takeProfit),
      protectedQuantity: Math.min(coverage(stop), coverage(takeProfit)),
      stopPrice: stop?.stopPrice,
      takeProfitPrice: takeProfit?.stopPrice,
    };
  }
}
