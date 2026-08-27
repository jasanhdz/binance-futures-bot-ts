import { Logger } from '../../app/ports/Logger';

export interface OrderBookLevel {
  price: number;
  qty: number;
}

export interface WsDepthUpdate {
  bidDepth: OrderBookLevel[];
  askDepth: OrderBookLevel[];
  receivedAtMs?: number;
}

export interface LiquidityStressStatus {
  stress: number;
  status: 'NO_DATA' | 'FRESH' | 'STALE';
  lastReceivedAtMs?: number;
  receiveAgeMs?: number;
}

export class LiquidityVoidDetector {
  private bidDepth: OrderBookLevel[] = [];
  private askDepth: OrderBookLevel[] = [];

  // Configuración
  private readonly VOID_THRESHOLD = 0.3; // 30% de concentración en primer nivel = peligro
  private readonly IMBALANCE_THRESHOLD = 3; // Ratio 3:1 entre bid/ask = manipulación

  private previousBidTotal = 0;
  private previousAskTotal = 0;
  private currentStress = 0;
  private lastReceivedAtMs?: number;

  constructor(private logger: Logger) {}

  public processDepthUpdate(data: WsDepthUpdate): void {
    this.bidDepth = data.bidDepth;
    this.askDepth = data.askDepth;
    this.lastReceivedAtMs = data.receivedAtMs ?? Date.now();

    const metrics = this.calculateMetrics();
    let stressScore = 0;

    // Factor 1: Concentración en primer nivel (spoofing)
    const topLevelConcentration =
      metrics.bidTotalQty > 0 ? metrics.bidTopQty / metrics.bidTotalQty : 0;
    if (topLevelConcentration > this.VOID_THRESHOLD) {
      stressScore += 0.4 * (topLevelConcentration / this.VOID_THRESHOLD);
    }

    // Factor 2: Imbalance extremo (paredes falsas)
    const imbalance = metrics.askTotalQty > 0 ? metrics.bidTotalQty / metrics.askTotalQty : 1;
    if (imbalance > this.IMBALANCE_THRESHOLD || imbalance < 1 / this.IMBALANCE_THRESHOLD) {
      stressScore += 0.3;
    }

    // Factor 3: Desaparición repentina de liquidez (velocidad de cambio)
    if (this.previousBidTotal > 0) {
      const liquidityVelocity =
        (metrics.bidTotalQty - this.previousBidTotal) / this.previousBidTotal;
      if (liquidityVelocity < -0.5) {
        // 50% de liquidez bid desapareció -> vacío repentino
        stressScore += 0.3;
      }
    }

    if (this.previousAskTotal > 0) {
      const liquidityVelocity =
        (metrics.askTotalQty - this.previousAskTotal) / this.previousAskTotal;
      if (liquidityVelocity < -0.5) {
        stressScore += 0.3;
      }
    }

    this.previousBidTotal = metrics.bidTotalQty;
    this.previousAskTotal = metrics.askTotalQty;

    this.currentStress = Math.min(stressScore, 1.0);
  }

  public getLiquidityStress(): number {
    return this.currentStress;
  }

  public getLiquidityStressStatus(
    nowMs = Date.now(),
    freshnessWindowMs?: number,
  ): LiquidityStressStatus {
    if (this.lastReceivedAtMs === undefined) {
      return { stress: this.currentStress, status: 'NO_DATA' };
    }
    const receiveAgeMs = Math.max(0, nowMs - this.lastReceivedAtMs);
    return {
      stress: this.currentStress,
      status:
        freshnessWindowMs === undefined || receiveAgeMs <= freshnessWindowMs ? 'FRESH' : 'STALE',
      lastReceivedAtMs: this.lastReceivedAtMs,
      receiveAgeMs,
    };
  }

  private calculateMetrics() {
    const bidTotal = this.bidDepth.reduce((sum, lvl) => sum + lvl.qty, 0);
    const askTotal = this.askDepth.reduce((sum, lvl) => sum + lvl.qty, 0);

    return {
      bidTotalQty: bidTotal,
      askTotalQty: askTotal,
      bidTopQty: this.bidDepth[0]?.qty || 0,
      askTopQty: this.askDepth[0]?.qty || 0,
    };
  }
}
