/**
 * Minimal Gen2ExchangePort implementation over binance-api-node USD-M futures.
 *
 * Only constructed when GEN2_EXECUTION_ENABLED=true AND credentials exist —
 * otherwise the bridge answers ACCEPTED_DRYRUN and never touches Binance.
 * The deterministic client_order_id from Aegis is forwarded as
 * newClientOrderId so idempotency also holds at the exchange level.
 */
import Binance from 'binance-api-node';
import { Gen2ExchangePort } from './Gen2Bridge';

export class BinanceGen2ExchangeAdapter implements Gen2ExchangePort {
  private cli: ReturnType<typeof Binance>;

  constructor(apiKey: string, apiSecret: string) {
    this.cli = Binance({ apiKey, apiSecret });
  }

  async ensureMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<void> {
    try {
      await (this.cli as any).futuresMarginType({ symbol, marginType });
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (!msg.includes('No need to change margin type')) throw err;
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await (this.cli as any).futuresLeverage({ symbol, leverage });
  }

  async marketOpen(
    symbol: string,
    side: 'LONG' | 'SHORT',
    quantity: number,
    clientOrderId?: string,
  ): Promise<{ orderId?: string | number; avgPrice?: number; executedQty?: number }> {
    const payload: Record<string, unknown> = {
      symbol,
      type: 'MARKET',
      quantity: String(quantity),
      side: side === 'LONG' ? 'BUY' : 'SELL',
      newOrderRespType: 'RESULT',
    };
    if (clientOrderId) payload.newClientOrderId = clientOrderId;
    const res = await (this.cli as any).futuresOrder(payload);
    return { orderId: String(res.orderId), avgPrice: +(res.avgPrice || 0), executedQty: +(res.executedQty || 0) };
  }

  async placeStopClose(symbol: string, side: 'LONG' | 'SHORT', stopPrice: number, _qty?: number): Promise<boolean> {
    try {
      await (this.cli as any).futuresOrder({
        symbol,
        type: 'STOP_MARKET',
        side: side === 'LONG' ? 'SELL' : 'BUY',
        stopPrice: String(stopPrice),
        closePosition: 'true',
        workingType: 'MARK_PRICE',
        newOrderRespType: 'RESULT',
      });
      return true;
    } catch {
      return false; // bridge engages the kill switch on bracket failure
    }
  }

  async getUSDTBalance(): Promise<number> {
    const balances: any[] = await (this.cli as any).futuresAccountBalance();
    const usdt = balances.find((b) => b.asset === 'USDT');
    return usdt ? +usdt.availableBalance : 0;
  }

  async hasOpenPosition(symbol: string, _side: 'LONG' | 'SHORT' | 'ANY'): Promise<boolean> {
    const risks: any[] = await (this.cli as any).futuresPositionRisk({ symbol });
    return risks.some((r) => Math.abs(+r.positionAmt) > 0);
  }
}
